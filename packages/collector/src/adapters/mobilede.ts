import {
  CRITERION, CURRENCY, MARKET, HOUR_MS, psToKw, toMarket, ok, err, failure, FAILURE,
  type Criteria, type Fuel, type Gearbox, type HintContext, type ListPage,
  type QueryContext, type QueryHints, type RawListing, type RequestSpec,
  type Result, type SourceAdapter,
} from "@carscope/core";
import {
  blocksBy, decodeEntities, elementByTestId, germanNumber, parsePlace,
  powerLabelToWatt, registrationToIso, visibleText,
} from "../text.ts";
import { extractDescription, imageUrls } from "../text.ts";
import { mobileDeMakeId } from "./mobilede-makes.ts";
import { splitMakeModel } from "./make-model.ts";

const ORIGIN = "https://suchen.mobile.de";
const BASE = `${ORIGIN}/fahrzeuge/search.html`;

const FUEL: Readonly<Record<string, string>> = {
  petrol: "PETROL", diesel: "DIESEL", electric: "ELECTRICITY", hybrid: "HYBRID", lpg: "LPG", cng: "CNG",
};
const GEARBOX: Readonly<Record<string, string>> = { manual: "MANUAL_GEAR", automatic: "AUTOMATIC_GEAR" };
const SELLER: Readonly<Record<string, string>> = { private: "FSBO", dealer: "DEALER" };

const RESULTS_PER_PAGE = 20;

export const mobileDe: SourceAdapter & { parseDetail?: SourceAdapter["parseDetail"] } = {
  id: "mobile.de",
  label: "mobile.de",
  markets: [MARKET.de],
  currency: CURRENCY.eur,
  minIntervalMs: 6 * HOUR_MS,
  unsupported: [CRITERION.bodyStyle, CRITERION.text],
  needsBrowser: true,

  buildQuery(c: Criteria, page: number, ctx: QueryContext): RequestSpec {
    const { make } = splitMakeModel(c);
    const makeId = make === null ? null : mobileDeMakeId(make);
    if (makeId === null) {
      return {
        url: BASE,
        skip: make === null
          ? 'keine Marke erkannt — Marke voranstellen, z. B. "VW Golf"'
          : `Marke "${make}" ist bei mobile.de nicht gelistet`,
      };
    }

    // Short-form parameters, ranges as `min:max` with either side optional.
    const p = new URLSearchParams({ isSearchRequest: "true", s: "Car", vc: "Car", ref: "dsp" });
    p.set("ms", `${String(makeId)};${ctx.hints["modelId"] ?? ""};;`);

    const range = (lo: number | null, hi: number | null): string | null =>
      lo === null && hi === null ? null : `${lo === null ? "" : String(lo)}:${hi === null ? "" : String(hi)}`;

    const price = range(c.priceEur.min, c.priceEur.max);
    if (price !== null) p.set("p", price);
    const mileage = range(c.mileageKm.min, c.mileageKm.max);
    if (mileage !== null) p.set("ml", mileage);
    const years = range(c.registrationYear.min, c.registrationYear.max);
    if (years !== null) p.set("fr", years);

    if (c.powerPs.min !== null || c.powerPs.max !== null) {
      // `pw` is kilowatts, and a lone minimum is sent bare.
      p.set("pw", c.powerPs.max === null
        ? String(psToKw(c.powerPs.min ?? 0))
        : `${c.powerPs.min === null ? "" : String(psToKw(c.powerPs.min))}:${String(psToKw(c.powerPs.max))}`);
    }

    if (c.postalCode) {
      p.set("zip", c.postalCode);
      if (c.radiusKm !== null) p.set("zipr", String(c.radiusKm));
    }
    if (c.fuel) p.set("ft", FUEL[c.fuel] ?? "");
    if (c.gearbox) p.set("tr", GEARBOX[c.gearbox] ?? "");
    if (c.sellerType) p.set("od", SELLER[c.sellerType] ?? "");
    if (c.excludeDamaged) p.set("dam", "false");
    if (page > 1) p.set("pageNumber", String(page));

    return { url: `${BASE}?${p.toString()}` };
  },

  /**
   * mobile.de names models numerically in `ms`, so a name has to be translated
   * before it can be searched. The model list lives in the search form and only
   * appears once a make is chosen, which is one request per make — cached,
   * because the list barely changes.
   */
  async resolveHints(c: Criteria, ctx: HintContext): Promise<QueryHints> {
    const { make, model } = splitMakeModel(c);
    if (make === null || model === null) return {};
    const makeId = mobileDeMakeId(make);
    if (makeId === null) return {};

    const key = `mobile.de:models:${String(makeId)}`;
    const raw = await ctx.cached(key, async () => {
      const page = await ctx.fetchText(`${BASE}?isSearchRequest=true&s=Car&vc=Car&ms=${String(makeId)};;;`, true);
      return page.ok ? JSON.stringify(parseModelOptions(page.value)) : null;
    });
    if (raw === null) return {};

    const models = safeParse(raw);
    const wanted = normaliseModel(model);
    const hit = models.find((m) => normaliseModel(m.label) === wanted)
      ?? models.find((m) => normaliseModel(m.label).startsWith(wanted));
    return hit === undefined ? {} : { modelId: hit.id };
  },

  /**
   * The result page carries no JSON-LD vehicle block and no state blob, so the
   * listings have to come out of the DOM. The `base-result-listing-N` ids and
   * the `data-testid` attributes are stable; the CSS class names are hashed and
   * change on every deploy, so nothing keys on them.
   */
  parseList(body: string): Result<ListPage> {
    const blocks = blocksBy(body, /<article[^>]*>(?=[\s\S]{0,6000}?id="base-result-listing-\d+")/g);
    const usable = blocks.length > 0 ? blocks : blocksBy(body, /id="base-result-listing-\d+"/g);

    if (usable.length === 0) {
      return err(failure(FAILURE.parse, "no result listings in mobile.de list page"));
    }
    const listings = usable.flatMap(toRawListing);
    if (listings.length === 0) {
      return err(failure(FAILURE.parse, "mobile.de listings present but none could be read"));
    }
    return ok({ listings, hasMore: listings.length >= RESULTS_PER_PAGE });
  },
};

mobileDe.parseDetail = (body: string): Result<Partial<RawListing>> => {
  const description = extractDescription(body, "ad-description-text");
  const photoUrls = imageUrls(body, /img\.(?:classistatic|mobile)\.de/);
  return ok({
    ...(photoUrls.length > 0 ? { photoUrls } : {}),
    attributes: description === null ? {} : { description },
  });
};

export interface ModelOption { readonly id: string; readonly label: string }

/** Reads `<select name="md">` from the search form. */
export function parseModelOptions(html: string): ModelOption[] {
  const start = html.indexOf('name="md"');
  if (start === -1) return [];
  const end = html.indexOf("</select>", start);
  const block = html.slice(start, end === -1 ? undefined : end);

  return [...block.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)]
    .map((m) => ({ id: m[1] ?? "", label: decodeEntities(m[2] ?? "").trim() }))
    .filter((o) => o.id !== "" && o.label !== "" && !/auswählen/i.test(o.label));
}

const normaliseModel = (value: string): string =>
  value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");

function safeParse(raw: string): ModelOption[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ModelOption[]) : [];
  } catch {
    return [];
  }
}

const ATTRIBUTE_SEPARATOR = /\s*[•·|]\s*/;

function toRawListing(block: string): RawListing[] {
  const href = /href="([^"]*\/fahrzeuge\/details\.html\?[^"]*)"/.exec(block)?.[1];
  if (!href) return [];
  const id = new URL(decodeEntities(href), ORIGIN).searchParams.get("id");
  if (!id) return [];

  const price = germanNumber(nodeText(block, "main-price-label"));
  if (price === null) return [];

  const parts = nodeText(block, "listing-details-attributes")
    .split(ATTRIBUTE_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  const find = (test: RegExp): string | null => parts.find((p) => test.test(p)) ?? null;

  const seller = nodeText(block, "seller-info");
  const placeMatch = /((?:[A-Z]{2}-)?\d{4,5}\s+[^\d]{2,40})/.exec(seller);
  const place = parsePlace(placeMatch?.[1]);
  const isPrivate = /Privatanbieter|Privatverkäufer/i.test(seller);
  // The dealer name is whatever precedes the address in the same block.
  const dealerName = placeMatch === null ? null : seller.slice(0, placeMatch.index).trim() || null;

  const photoUrls = [...new Set(
    [...block.matchAll(/src="(https:\/\/img\.(?:classistatic|mobile)\.de\/[^"]+)"/g)]
      .map((m) => m[1])
      .filter((u): u is string => u !== undefined),
  )];

  return [{
    sourceListingId: id,
    url: `${ORIGIN}/fahrzeuge/details.html?id=${id}`,
    title: listingTitle(block) || `mobile.de ${id}`,
    price,
    currency: CURRENCY.eur,
    photoUrls,
    attributes: {
      mileageKm: germanNumber(find(/\bkm\b/)),
      powerW: powerLabelToWatt(find(/\b(kW|PS)\b/)),
      firstRegistration: registrationToIso(find(/EZ|\d{2}\/\d{4}/)),
      fuel: mapFuel(find(/Benzin|Diesel|Elektro|Hybrid|Autogas|Erdgas/i)),
      gearbox: mapGearbox(find(/Schalt|Automat|DSG|Tiptronic|PDK|CVT/i)),
      sellerType: isPrivate ? "private" : "dealer",
      sellerName: isPrivate ? null : dealerName,
      ...(toMarket(place.country) === null ? {} : { market: toMarket(place.country) as never }),
      postalCode: place.postalCode,
      city: place.city,
    },
  }];
}

function nodeText(block: string, testId: string): string {
  const element = elementByTestId(block, testId);
  return element === null ? "" : visibleText(element);
}

/**
 * Make and variant sit in two sibling spans that both carry a `title`
 * attribute. Reading those is exact; reading the rendered text runs into the
 * price element that follows.
 */
function listingTitle(block: string): string {
  const marker = block.indexOf('data-testid="listing-title-card-view"');
  if (marker === -1) return "";
  const start = block.lastIndexOf("<", marker);
  const end = block.indexOf("</h2>", marker);
  const region = block.slice(start, end === -1 ? marker + 400 : end);
  const titles = [...region.matchAll(/\stitle="([^"]*)"/g)]
    .map((m) => decodeEntities(m[1] ?? "").trim())
    .filter(Boolean);
  return [...new Set(titles)].join(" ").trim();
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
const MANUAL_HINTS = ["manual", "schalt", "handschalt"];

function mapGearbox(raw: string | null): Gearbox | null {
  if (!raw) return null;
  const v = raw.toLowerCase();
  if (AUTOMATIC_HINTS.some((h) => v.includes(h))) return "automatic";
  if (MANUAL_HINTS.some((h) => v.includes(h))) return "manual";
  return null;
}
