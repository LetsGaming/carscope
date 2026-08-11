import {
  CRITERION, CURRENCY, HOUR_MS, MARKET, ok, err, failure, FAILURE, toMarket,
  type BodyStyle, type Criteria, type ListPage, type Market, type QueryContext,
  type RawListing, type RequestSpec, type Result, type SourceAdapter,
} from "@carscope/core";
import {
  blocksBy, decodeEntities, germanNumber, powerLabelToWatt, registrationToIso, visibleText,
} from "../text.ts";
import { splitMakeModel } from "./make-model.ts";

const HOST: Readonly<Record<string, string>> = {
  DE: "https://www.autouncle.de/de", AT: "https://www.autouncle.at/de",
  NL: "https://www.autouncle.nl/nl", BE: "https://www.autouncle.be/nl",
  FR: "https://www.autouncle.fr/fr", IT: "https://www.autouncle.it/it",
  ES: "https://www.autouncle.es/es", SE: "https://www.autouncle.se/sv",
  PL: "https://www.autouncle.pl/pl", CH: "https://www.autouncle.ch/de",
};

const PATH: Readonly<Record<string, string>> = {
  DE: "gebrauchtwagen", AT: "gebrauchtwagen", CH: "gebrauchtwagen",
  NL: "occasions", BE: "occasions", FR: "voiture-occasion",
  IT: "auto-usate", ES: "coches-segunda-mano", SE: "begagnade-bilar", PL: "samochody-uzywane",
};

const BODY: Readonly<Record<string, BodyStyle>> = {
  coupe: "coupe", "coupé": "coupe", sedan: "sedan", saloon: "sedan", limousine: "sedan",
  stationwagon: "wagon", wagon: "wagon", estate: "wagon", kombi: "wagon",
  hatchback: "hatchback", kleinwagen: "hatchback", suv: "suv",
  convertible: "convertible", cabriolet: "convertible", cabrio: "convertible",
  van: "van", mpv: "van",
};

const FUEL: Readonly<Record<string, "petrol" | "diesel" | "electric" | "hybrid" | "lpg">> = {
  benzin: "petrol", diesel: "diesel", elektro: "electric", hybrid: "hybrid", autogas: "lpg",
};

/**
 * AutoUncle is a meta-search that already aggregates the portals, including ones
 * that refuse to be read directly. Its result page is a Next.js App Router
 * document, and the listings arrive complete in the RSC flight payload — make,
 * model, year, mileage, power, body, gearbox, images, days on market, and the
 * name of the portal each one came from.
 *
 * One request therefore returns mobile.de, AutoScout24 and Kleinanzeigen
 * together, which is the whole reason this adapter exists.
 */
export const autoUncle: SourceAdapter = {
  id: "autouncle",
  label: "AutoUncle",
  markets: Object.keys(HOST) as Market[],
  currency: CURRENCY.eur,
  minIntervalMs: 6 * HOUR_MS,
  unsupported: [CRITERION.text, CRITERION.excludeDamaged, CRITERION.area],
  needsBrowser: true,

  buildQuery(c: Criteria, page: number, { market }: QueryContext): RequestSpec {
    const { make, model } = splitMakeModel(c);
    if (make === null) {
      return { url: HOST[market] ?? HOST["DE"] ?? "", skip: 'keine Marke erkannt — Marke voranstellen, z. B. "VW Golf"' };
    }

    const host = HOST[market] ?? HOST["DE"] as string;
    const segment = PATH[market] ?? PATH["DE"] as string;
    const path = [host, segment, capitalise(make), model === null ? null : capitalise(model)]
      .filter(Boolean).join("/");

    const q = new URLSearchParams();
    const set = (key: string, value: number | null): void => {
      if (value !== null) q.set(`s[${key}]`, String(value));
    };
    set("min_year", c.registrationYear.min);
    set("max_year", c.registrationYear.max);
    set("min_hp", c.powerPs.min);
    set("max_hp", c.powerPs.max);
    set("min_price", c.priceEur.min);
    set("max_price", c.priceEur.max);
    set("max_km", c.mileageKm.max);
    set("min_km", c.mileageKm.min);
    if (page > 1) q.set("page", String(page));

    return { url: q.size === 0 ? path : `${path}?${q.toString()}` };
  },

  /**
   * Reads the rendered cards, then enriches them from the flight payload.
   *
   * The payload has cleaner values, but it only carries what was streamed with
   * the document: a card added during hydration appears on the page and in no
   * chunk. Taking the DOM as the set of listings and the payload as extra detail
   * means a card the browser shows can never be one we do not have.
   */
  parseList(body: string, spec: RequestSpec): Result<ListPage> {
    const origin = new URL(spec.url).origin;

    const rendered = domListings(body, origin);
    const payload = flightPayload(body);
    const streamed = carObjects(payload).flatMap((car) => toRaw(car, origin));

    const byId = new Map(rendered.map((l) => [l.sourceListingId, l]));
    for (const l of streamed) {
      const seen = byId.get(l.sourceListingId);
      byId.set(l.sourceListingId, seen === undefined ? l : {
        ...seen,
        ...l,
        photoUrls: l.photoUrls.length >= seen.photoUrls.length ? l.photoUrls : seen.photoUrls,
        attributes: { ...seen.attributes, ...l.attributes },
      });
    }

    const listings = [...byId.values()];
    if (listings.length === 0) {
      return err(failure(FAILURE.parse, "AutoUncle lieferte keine auswertbaren Inserate"));
    }

    // No count is reported, because neither candidate measured what it claimed.
    // The page's stated total counts the whole search, so comparing one page to
    // it called normal pagination a loss. Counting rendered <article> elements
    // instead counts the featured-cars carousel, which is advertising for other
    // models and never was a result. Telling the two apart needs the structure
    // around a card, not a pattern in the markup, and a wrong number sends
    // someone looking for listings that were never missing.
    return ok({ listings, hasMore: listings.length > 0 });
  },
};

const CARD_LINK = /href="(\/[a-z]{2}\/d\/(\d+)[^"]*)"/;
const SPEC_ITEM = /<li[^>]*>([^<]{2,40})<\/li>/g;

/** The cards as the browser renders them, which is the set actually on screen. */
export function domListings(html: string, origin: string): RawListing[] {
  const found: RawListing[] = [];

  for (const article of blocksBy(html, /<article\b/g)) {
    const link = CARD_LINK.exec(article);
    if (link === null) continue;

    const text = visibleText(article);
    const price = germanNumber(/([\d.]+)\s*(?:&nbsp;|\u00a0|\s)?€/.exec(text)?.[1]);
    if (price === null) continue;

    const specs = [...article.matchAll(SPEC_ITEM)].map((m) => decodeEntities(m[1] ?? "").trim());
    const find = (test: RegExp): string | null => specs.find((v) => test.test(v)) ?? null;

    const image = /<img[^>]+src="(https:\/\/images\.autouncle\.com\/[^"]+)"/.exec(article)?.[1];
    // Matched on the element, not the flattened text, so the city does not
    // absorb whatever button follows it.
    const place = />\s*(\d{4,5}),\s*([^<]{2,40})</.exec(article);
    const laytime = /Tage inseriert\s+(\d+)/.exec(text)?.[1];

    found.push({
      sourceListingId: link[2] ?? "",
      url: origin + (link[1] ?? ""),
      title: decodeEntities(/<h3[^>]*>([^<]+)<\/h3>/.exec(article)?.[1] ?? "").trim(),
      price,
      currency: CURRENCY.eur,
      photoUrls: image === undefined ? [] : [image],
      attributes: {
        mileageKm: germanNumber(find(/\bkm\b/)),
        powerW: powerLabelToWatt(find(/\b(PS|kW)\b/)),
        firstRegistration: monthYear(find(/(?:19|20)\d{2}/)),
        gearbox: find(/Automatik/i) !== null ? "automatic"
          : find(/Schaltgetriebe|Manuell/i) !== null ? "manual" : null,
        bodyStyle: BODY[(find(/Limousine|Coup|Kombi|SUV|Cabrio|Kleinwagen|Van/i) ?? "").toLowerCase()] ?? null,
        fuel: FUEL[(find(/Benzin|Diesel|Elektro|Hybrid|Autogas/i)?.match(
          /Benzin|Diesel|Elektro|Hybrid|Autogas/i)?.[0] ?? "").toLowerCase()] ?? null,
        postalCode: place?.[1] ?? null,
        city: place?.[2]?.trim().replace(/\s+/g, " ") ?? null,
        firstListedAt: daysAgo(laytime === undefined ? null : Number.parseInt(laytime, 10)),
      },
    });
  }
  return found;
}

const CHUNK = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;

/** The flight payload arrives as a series of pushed string chunks. */
export function flightPayload(html: string): string {
  const parts: string[] = [];
  for (const match of html.matchAll(CHUNK)) {
    try {
      parts.push(JSON.parse(`"${match[1] ?? ""}"`) as string);
    } catch {
      continue;
    }
  }
  return parts.join("");
}

/**
 * The payload is not valid JSON as a whole, so each listing is recovered by
 * brace-matching outwards from a key only listings carry.
 */
export function carObjects(payload: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];

  for (const match of payload.matchAll(/"vdpPath":/g)) {
    const start = payload.lastIndexOf("{", match.index);
    if (start === -1) continue;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < payload.length; i += 1) {
      const ch = payload[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const parsed: unknown = JSON.parse(payload.slice(start, i + 1));
          if (isCar(parsed)) found.push(parsed);
        } catch {
          // A component prop that merely mentions the key; not a listing.
        }
        break;
      }
    }
  }
  return found;
}

/**
 * A listing is identified by having an id and a page of its own. Mileage and
 * year were the earlier test, which also discarded any listing the aggregator
 * had not resolved those for — a silent loss rather than an incomplete record.
 */
function isCar(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const car = value as Record<string, unknown>;
  return typeof car["carId"] === "string" && typeof car["vdpPath"] === "string";
}

const capitalise = (value: string): string =>
  value.split(/[\s-]+/).map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1)).join("-");

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

function toRaw(car: Record<string, unknown>, origin: string): RawListing[] {
  const id = text(car["carId"]);
  const path = text(car["vdpPath"]);
  const price = germanNumber(text(car["price"]));
  if (id === null || path === null || price === null) return [];

  const history = (car["modalPriceHistoryValues"] ?? {}) as Record<string, unknown>;
  // AutoUncle aggregates: each result is an advert on another portal, and which
  // one is the answer to "where is this car".
  const portal = text(car["sourceName"]);
  const images = car["imageUrls"];
  const place = text(car["location"])?.split(",") ?? [];

  return [{
    sourceListingId: id,
    url: origin + path,
    title: text(history["headline"]) ?? text(car["title"]) ?? id,
    price,
    currency: CURRENCY.eur,
    photoUrls: Array.isArray(images) ? images.filter((i): i is string => typeof i === "string") : [],
    ...(portal === null ? {} : { origin: portal }),
    attributes: {
      ...(text(car["brand"]) === null ? {} : { make: text(car["brand"]) as string }),
      ...(text(car["carModel"]) === null ? {} : { model: text(car["carModel"]) as string }),
      variant: text(car["equipmentVariant"]) ?? text(car["subtitle"]),
      // "Mär 2000" is a month AutoUncle resolved; the bare year is the fallback.
      firstRegistration: monthYear(text(history["displayableYear"]))
        ?? (typeof car["year"] === "number" ? String(car["year"]) : null),
      mileageKm: typeof car["km"] === "number" ? car["km"] : null,
      powerW: powerLabelToWatt(text(history["displayableEnginePower"])),
      gearbox: car["hasAutoGear"] === true ? "automatic" : car["hasAutoGear"] === false ? "manual" : null,
      bodyStyle: BODY[(text(car["body"]) ?? "").toLowerCase()] ?? null,
      sellerType: car["isPrivateCar"] === true ? "private" : "dealer",
      firstListedAt: daysAgo(car["laytime"]),
      postalCode: place[0]?.trim().match(/^\d{4,5}$/)?.[0] ?? null,
      city: place[1]?.trim() ?? null,
      market: toMarket(text(car["countryDefaultLocale"])?.toUpperCase()) ?? MARKET.de,
    },
  }];
}

/** `laytime` is days on market; the date it implies survives later runs. */
function daysAgo(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const day = new Date();
  day.setDate(day.getDate() - Math.round(value));
  return day.toISOString().slice(0, 10);
}

const MONTHS: Readonly<Record<string, string>> = {
  jan: "01", feb: "02", "mär": "03", mar: "03", apr: "04", mai: "05", may: "05",
  jun: "06", jul: "07", aug: "08", sep: "09", okt: "10", oct: "10", nov: "11", dez: "12", dec: "12",
};

function monthYear(value: string | null): string | null {
  if (value === null) return null;
  const match = /([A-Za-zÄäÖöÜü]{3})\.?\s+((?:19|20)\d{2})/.exec(value);
  const month = MONTHS[(match?.[1] ?? "").toLowerCase()];
  if (match === null || month === undefined) return registrationToIso(value);
  return `${match[2] ?? ""}-${month}`;
}
