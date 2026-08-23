import {
  CRITERION, CURRENCY, HOUR_MS, psToKw, toMarket, ok, err, failure, FAILURE,
  type Criteria, type ListPage, type RawListing,
  type QueryContext, type RequestSpec, type Result, type SourceAdapter,
  type Market, type Fuel, type Gearbox,
} from "@carscope/core";
import { asNumber, asString, embeddedJson, isRecord, pick, slug } from "../html.ts";
import { extractDescription, germanNumber, powerLabelToWatt, registrationToIso } from "../text.ts";
import { normaliseMake, splitMakeModel } from "./make-model.ts";

const HOST: Readonly<Record<string, string>> = {
  DE: "https://www.autoscout24.de", AT: "https://www.autoscout24.at",
  NL: "https://www.autoscout24.nl", BE: "https://www.autoscout24.be",
  LU: "https://www.autoscout24.lu", IT: "https://www.autoscout24.it",
  ES: "https://www.autoscout24.es", FR: "https://www.autoscout24.fr",
};
const COUNTRY: Readonly<Record<string, string>> = {
  DE: "D", AT: "A", NL: "NL", BE: "B", LU: "L", IT: "I", ES: "E", FR: "F",
};

const FUEL: Readonly<Record<string, string>> = {
  petrol: "B", diesel: "D", electric: "E", hybrid: "2", lpg: "L", cng: "C",
};
const GEARBOX: Readonly<Record<string, string>> = { manual: "M", automatic: "A" };
const SELLER: Readonly<Record<string, string>> = { private: "P", dealer: "D" };
const DEFAULT_RADIUS_KM = 100;

const MARKETS = Object.keys(HOST) as Market[];

export const autoScout24: SourceAdapter = {
  id: "autoscout24",
  label: "AutoScout24",
  markets: MARKETS,
  currency: CURRENCY.eur,
  minIntervalMs: 6 * HOUR_MS,
  // The path carries make and model; anything else in the query is verified
  // after fetching rather than trusted to the portal.
  unsupported: [CRITERION.bodyStyle, CRITERION.text],
  needsBrowser: true,

  buildQuery(c: Criteria, page: number, { market }: QueryContext): RequestSpec {
    const host = HOST[market] ?? HOST["DE"] as string;
    const p = new URLSearchParams({
    atype: "C", cy: COUNTRY[market] ?? "D", ustate: "N,U",
      sort: "standard", desc: "0", ocs_listing: "include", source: "detailsearch",
      page: String(page),
    });
    if (c.priceEur.min !== null) p.set("pricefrom", String(c.priceEur.min));
    if (c.priceEur.max !== null) p.set("priceto", String(c.priceEur.max));
    if (c.mileageKm.min !== null) p.set("kmfrom", String(c.mileageKm.min));
    if (c.mileageKm.max !== null) p.set("kmto", String(c.mileageKm.max));
    if (c.powerPs.min !== null || c.powerPs.max !== null) {
      // `powertype` only picks the unit shown in the UI; the value on the wire
      // is always kilowatts. Sending PS here reads as a figure a third higher
      // and quietly filters out almost everything.
      p.set("powertype", "hp");
      if (c.powerPs.min !== null) p.set("powerfrom", String(psToKw(c.powerPs.min)));
      if (c.powerPs.max !== null) p.set("powerto", String(psToKw(c.powerPs.max)));
    }
    if (c.registrationYear.min !== null) p.set("fregfrom", String(c.registrationYear.min));
    if (c.registrationYear.max !== null) p.set("fregto", String(c.registrationYear.max));
    if (c.postalCode) {
      p.set("zip", c.postalCode);
      p.set("zipr", String(c.radiusKm ?? DEFAULT_RADIUS_KM));
    }
    if (c.fuel) p.set("fuel", FUEL[c.fuel] ?? "");
    if (c.gearbox) p.set("gear", GEARBOX[c.gearbox] ?? "");
    if (c.sellerType) p.set("custtype", SELLER[c.sellerType] ?? "");
    if (c.excludeDamaged) p.set("damaged_listing", "exclude");

    const { make, model } = splitMakeModel(c);
    if (make === null) {
      // `/lst` with no make returns every car on the site. Refusing is the
      // only honest answer to a query this source cannot express.
      return { url: `${host}/lst?${p.toString()}`, skip: 'keine Marke erkannt — Marke voranstellen, z. B. "VW Golf"' };
    }
    const path = `/lst/${normaliseMake(make)}${model === null ? "" : `/${slug(model)}`}`;
    return { url: `${host}${path}?${p.toString()}` };
    },

    parseList(body: string, spec: RequestSpec): Result<ListPage> {
    const host = new URL(spec.url).origin;
    const state = embeddedJson(body, "__NEXT_DATA__");
    if (!state.ok) return state;
    const listings = pick(state.value, ["props", "pageProps", "listings"]);
    if (!Array.isArray(listings)) {
      return err(failure(FAILURE.parse, "AutoScout24 page state has no listings array"));
    }
    return ok({
      listings: listings.flatMap((l) => toRaw(l, host)),
      hasMore: listings.length > 0,
    });
    },

  /**
   * The list page's own JSON already carries every search result's full
   * `images` array (upsized to full resolution in `toRaw`, see below), so the
   * only thing worth the extra request is the free-text seller notes, which
   * the list JSON never has.
   */
  parseDetail(body: string): Result<Partial<RawListing>> {
    const description = extractDescription(body, "sellerNotesSection");
    return ok({ attributes: description === null ? {} : { description } });
  },
};

/**
 * The list JSON's `images` are thumbnails — `.../250x188.webp` — while the
 * detail page renders the same assets at `.../1920x1080.webp`. Both are the
 * same resizing CDN and the same asset id, just a different size segment in
 * the path, so the full-resolution photo is a string substitution on data the
 * list page already returned rather than a second request per car.
 */
const IMAGE_SIZE = /\/\d+x\d+\.(webp|jpe?g)$/;
const FULL_SIZE = "/1920x1080.$1";

function fullSizeImage(url: string): string {
  return IMAGE_SIZE.test(url) ? url.replace(IMAGE_SIZE, FULL_SIZE) : url;
}

/** Field names verified against a captured __NEXT_DATA__ payload. */
function toRaw(node: unknown, host: string): RawListing[] {
  if (!isRecord(node)) return [];
  const id = asString(node["id"]);
  const price = asNumber(pick(node, ["price", "priceRaw"]));
  const path = asString(node["url"]);
  if (!id || price === null) return [];

  const vehicle = pick(node, ["vehicle"]);
  const details = node["vehicleDetails"];
  const power = Array.isArray(details)
    ? details.find((d) => isRecord(d) && d["iconName"] === "speedometer")
    : undefined;

  const images = node["images"];
  const make = asString(pick(vehicle, ["make"]));
  const model = asString(pick(vehicle, ["model"]));
  const title = [make, model, asString(pick(vehicle, ["modelVersionInput"]))].filter(Boolean).join(" ");

  return [{
    sourceListingId: id,
    url: path === null ? `${host}/angebote/${id}` : `${host}${path}`,
    title: title || id,
    price,
    currency: CURRENCY.eur,
    photoUrls: Array.isArray(images)
      ? images.filter((i): i is string => typeof i === "string").map(fullSizeImage)
      : [],
    attributes: {
      ...(make === null ? {} : { make }),
      ...(model === null ? {} : { model }),
      variant: asString(pick(vehicle, ["modelVersionInput"])),
      mileageKm: germanNumber(asString(pick(node, ["tracking", "mileage"]))
        ?? asString(pick(vehicle, ["mileageInKm"]))),
      powerW: powerLabelToWatt(isRecord(power) ? asString(power["data"]) : null),
      // tracking reports MM-YYYY; the domain stores YYYY-MM.
      firstRegistration: registrationToIso(asString(pick(node, ["tracking", "firstRegistration"]))),
      fuel: mapFuel(asString(pick(vehicle, ["fuel"]))),
      gearbox: mapGearbox(asString(pick(vehicle, ["transmission"]))),
      sellerType: asString(pick(node, ["seller", "type"]))?.includes("Private") ? "private" : "dealer",
      sellerName: asString(pick(node, ["seller", "companyName"])),
      ...(toMarket(asString(pick(node, ["location", "countryCode"]))) === null
        ? {}
        : { market: toMarket(asString(pick(node, ["location", "countryCode"]))) as never }),
      city: asString(pick(node, ["location", "city"])),
      postalCode: asString(pick(node, ["location", "zip"])),
    },
  }];
}

function mapFuel(raw: string | null): Fuel | null {
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (v.includes("benzin") || v.includes("petrol")) return "petrol";
  if (v.includes("diesel")) return "diesel";
  if (v.includes("elektro") || v.includes("electric")) return "electric";
  if (v.includes("hybrid")) return "hybrid";
  if (v.includes("erdgas")) return "cng";
  if (v.includes("gas")) return "lpg";
  return "other";
}

const AUTOMATIC_HINTS = ["automat", "dsg", "tiptronic", "cvt", "s tronic", "pdk", "dct", "steptronic"];

function mapGearbox(raw: string | null): Gearbox | null {
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (AUTOMATIC_HINTS.some((h) => v.includes(h))) return "automatic";
  if (v.includes("schalt") || v.includes("manual")) return "manual";
  return null;
}
