import {
  CRITERION, CURRENCY, HOUR_MS, psToKw, ok, err, failure, FAILURE,
  type Criteria, type CriterionKey, type Currency, type ListPage, type Market,
  type QueryContext, type RawListing, type RequestSpec, type Result, type SourceAdapter,
} from "@carscope/core";
import { asNumber, asString, isRecord, jsonLdBlocks, pick, slug } from "../html.ts";
import { germanNumber, powerLabelToWatt, registrationToIso } from "../text.ts";
import { splitMakeModel } from "./make-model.ts";

export interface CustomSource {
  readonly id: string;
  readonly label: string;
  readonly markets: readonly Market[];
  readonly currency?: Currency;
  readonly needsBrowser?: boolean;
  readonly intervalHours?: number;
  /** Search URL with `{tokens}`; a parameter whose token is empty is dropped. */
  readonly url: string;
  readonly unsupported?: readonly CriterionKey[];
  /** Set when the portal cannot be searched without a make. */
  readonly requiresMake?: boolean;
}

const TOKENS = /\{(\w+)\}/g;

function values(c: Criteria, page: number, market: Market): Readonly<Record<string, string>> {
  const { make, model } = splitMakeModel(c);
  const num = (v: number | null): string => (v === null ? "" : String(v));

  return {
    make: make ?? "", model: model ?? "",
    makeSlug: make === null ? "" : slug(make),
    modelSlug: model === null ? "" : slug(model),
    text: [make, model, c.text].filter(Boolean).join(" ").trim(),
    textSlug: slug([make, model, c.text].filter(Boolean).join(" ")),
    priceMin: num(c.priceEur.min), priceMax: num(c.priceEur.max),
    kmMin: num(c.mileageKm.min), kmMax: num(c.mileageKm.max),
    yearMin: num(c.registrationYear.min), yearMax: num(c.registrationYear.max),
    psMin: num(c.powerPs.min), psMax: num(c.powerPs.max),
    kwMin: c.powerPs.min === null ? "" : String(psToKw(c.powerPs.min)),
    kwMax: c.powerPs.max === null ? "" : String(psToKw(c.powerPs.max)),
    fuel: c.fuel ?? "", gearbox: c.gearbox ?? "", seller: c.sellerType ?? "",
    zip: c.postalCode ?? "", radius: num(c.radiusKm),
    page: String(page), market,
  };
}

/** Drops query parameters left empty, so an unset filter is absent rather than blank. */
function tidy(url: string): string {
  const [base, query] = url.split("?");
  if (query === undefined) return base ?? url;
  const kept = query.split("&").filter((pair) => {
    const [, value] = pair.split("=");
    return value !== undefined && value !== "";
  });
  return kept.length === 0 ? (base ?? url) : `${base ?? ""}?${kept.join("&")}`;
}

/**
 * A portal described by configuration rather than code.
 *
 * Parsing reads schema.org data, which smaller portals still publish and the big
 * three no longer do. If a page carries none, this reports a parse failure — an
 * unsupported portal has to look different from an empty result.
 */
export function customAdapter(source: CustomSource): SourceAdapter {
  return {
    id: source.id,
    label: source.label,
    markets: source.markets,
    currency: source.currency ?? CURRENCY.eur,
    minIntervalMs: (source.intervalHours ?? 6) * HOUR_MS,
    unsupported: source.unsupported ?? [CRITERION.text],
    ...(source.needsBrowser === undefined ? {} : { needsBrowser: source.needsBrowser }),

    buildQuery(c: Criteria, page: number, { market }: QueryContext): RequestSpec {
      const token = values(c, page, market);
      if (source.requiresMake === true && token["make"] === "") {
        return { url: source.url, skip: 'keine Marke erkannt — Marke voranstellen, z. B. "VW Golf"' };
      }
      const url = tidy(source.url.replace(TOKENS, (_, key: string) =>
        encodeURIComponent(token[key] ?? "")));
      return { url };
    },

    parseList(body: string, spec: RequestSpec): Result<ListPage> {
      const blocks = jsonLdBlocks(body);
      const items = blocks.flatMap(expand);
      if (items.length === 0) {
        return err(failure(
          FAILURE.parse,
          `${source.id}: keine schema.org-Fahrzeugdaten auf der Seite`,
        ));
      }
      const origin = new URL(spec.url).origin;
      return ok({ listings: items.flatMap((i) => toRaw(i, origin)), hasMore: items.length > 0 });
    },
  };
}

const VEHICLE_TYPES = new Set(["Car", "Vehicle", "Product", "MotorizedVehicle"]);

/** Vehicles appear bare, inside an ItemList, or wrapped in a ListItem. */
function expand(block: unknown): unknown[] {
  if (!isRecord(block)) return [];
  const type = block["@type"];
  if (typeof type === "string" && VEHICLE_TYPES.has(type)) return [block];

  const elements = block["itemListElement"];
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((el) => {
    if (!isRecord(el)) return [];
    return expand(isRecord(el["item"]) ? el["item"] : el);
  });
}

function toRaw(node: unknown, origin: string): RawListing[] {
  if (!isRecord(node)) return [];
  const url = asString(node["url"]);
  const name = asString(node["name"]);
  const price = asNumber(pick(node, ["offers", "price"])) ?? germanNumber(asString(node["price"]));
  if (url === null || name === null || price === null) return [];

  const absolute = url.startsWith("http") ? url : origin + url;
  const images = node["image"];
  const power = pick(node, ["vehicleEngine", "enginePower"]);

  return [{
    sourceListingId: absolute.split("/").filter(Boolean).pop() ?? absolute,
    url: absolute,
    title: name,
    price,
    currency: CURRENCY.eur,
    photoUrls: Array.isArray(images)
      ? images.filter((i): i is string => typeof i === "string")
      : typeof images === "string" ? [images] : [],
    attributes: {
      mileageKm: asNumber(pick(node, ["mileageFromOdometer", "value"])),
      powerW: powerLabelToWatt(
        `${String(asNumber(pick(power, ["value"])) ?? "")} ${asString(pick(power, ["unitText"])) ?? "kW"}`,
      ),
      firstRegistration: registrationToIso(
        asString(node["productionDate"]) ?? asString(node["vehicleModelDate"]),
      ),
      city: asString(pick(node, ["offers", "availableAtOrFrom", "address", "addressLocality"])),
      postalCode: asString(pick(node, ["offers", "availableAtOrFrom", "address", "postalCode"])),
    },
  }];
}
