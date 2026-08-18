import {
  CRITERION, CURRENCY, HOUR_MS, ok, err, failure, FAILURE, toMarket,
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
 * that refuse to be read directly, so one request returns mobile.de, AutoScout24
 * and Kleinanzeigen together. That is the whole reason this adapter exists.
 *
 * The result page is a Next.js App Router document. It once carried the listings
 * in the RSC flight payload, but that payload no longer holds them — the cards
 * are only in the rendered DOM now — so this reads the DOM, which is the set of
 * cars actually on the page. Each card is attributed to AutoUncle, the source it
 * was fetched from, not to the portal the advert originated on: a listing's
 * origin is a property of the advert, not the search, and tracking it added a
 * cross-source concept no other adapter shared for no real benefit.
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

  parseList(body: string, spec: RequestSpec): Result<ListPage> {
    const listings = domListings(body, spec.url);
    if (listings.length === 0) {
      return err(failure(FAILURE.parse, "AutoUncle lieferte keine auswertbaren Inserate"));
    }

    // One page is requested and it holds the whole result set for the searches
    // this runs — a specific model in one market. Asking for a second page would
    // fetch an empty one, and an empty page reads as a parse failure that marks
    // the whole market degraded, so pagination is deliberately not followed.
    return ok({ listings, hasMore: false });
  },
};

const CARD_LINK = /href="(\/[a-z]{2}\/d\/(\d+)[^"]*)"/;
const SPEC_ITEM = /<li[^>]*>([^<]{2,40})<\/li>/g;
const TITLE = /<h3[^>]*>([^<]+)<\/h3>/;
/** The subtitle sits directly after the title; keying off that order avoids the hashed class name. */
const VARIANT = /<h3[^>]*>[^<]*<\/h3>\s*<p[^>]*>([^<]*)<\/p>/;
const IMAGE = /<img[^>]+src="(https:\/\/images\.autouncle\.com\/[^"]+)"/;
const ALT = /<img[^>]+alt="([^"]*)"/;
const PRICE = /([\d.]+)\s*(?:&nbsp;|\u00a0|\s)?€/;
/**
 * "PLZ Stadt, Region" or "PLZ, Region": the city sits between the postal code
 * and the comma, and is absent when the code is followed straight by it (a
 * listing that states only its federal state). Matched on the element so the
 * city cannot absorb whatever text follows the card.
 */
const PLACE = />\s*(\d{4,5})(?:\s+([^,<]{2,40}?))?,\s*[A-Za-zÄÖÜäöü][^<]*</;
const LAYTIME = /Tage inseriert\s+(\d+)/;

/**
 * The cards as the browser renders them, which is the set actually on the page.
 * Make and model come from the search URL rather than the card, because every
 * card on the page is that make and model and the URL states it exactly, where
 * the card's title is free text.
 */
export function domListings(html: string, searchUrl: string): RawListing[] {
  const origin = originOf(searchUrl);
  const { make, model } = searchMakeModel(searchUrl);
  const market = marketFromUrl(searchUrl);
  // A single-word model that the title must contain separates real results from
  // the featured-cars strip, which advertises other models. Multi-word models
  // are left unguarded rather than risk dropping a card that spells the model
  // differently than the URL slug does.
  const guard = model !== null && model.length >= 3 && !/[\s-]/.test(model)
    ? model.toLowerCase() : null;

  const found: RawListing[] = [];
  for (const article of blocksBy(html, /<article\b/g)) {
    const link = CARD_LINK.exec(article);
    if (link === null) continue;

    const flat = visibleText(article);
    const price = germanNumber(PRICE.exec(flat)?.[1]);
    if (price === null) continue;

    const title = decodeEntities(TITLE.exec(article)?.[1] ?? "").trim();
    const alt = decodeEntities(ALT.exec(article)?.[1] ?? "");
    if (guard !== null && !`${title} ${alt}`.toLowerCase().includes(guard)) continue;

    const specs = [...article.matchAll(SPEC_ITEM)].map((m) => decodeEntities(m[1] ?? "").trim());
    const find = (test: RegExp): string | null => specs.find((v) => test.test(v)) ?? null;

    const image = IMAGE.exec(article)?.[1];
    const variant = decodeEntities(VARIANT.exec(article)?.[1] ?? "").trim();
    const place = PLACE.exec(article);
    const laytime = LAYTIME.exec(flat)?.[1];

    found.push({
      sourceListingId: link[2] ?? "",
      url: origin + (link[1] ?? ""),
      title,
      price,
      currency: CURRENCY.eur,
      photoUrls: image === undefined ? [] : [image],
      attributes: {
        ...(make === null ? {} : { make }),
        ...(model === null ? {} : { model }),
        ...(variant === "" ? {} : { variant }),
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
        ...(market === null ? {} : { market }),
      },
    });
  }
  return found;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * `buildQuery` builds `/{locale}/{listing-segment}/{Make}[/{Model}]`, so the
 * make and model are the third and fourth path segments. Reading them back is
 * exact, where parsing them out of a card's free-text title would not be.
 */
function searchMakeModel(url: string): { make: string | null; model: string | null } {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    return { make: segs[2] ?? null, model: segs[3] ?? null };
  } catch {
    return { make: null, model: null };
  }
}

function marketFromUrl(url: string): Market | null {
  for (const [key, prefix] of Object.entries(HOST)) {
    if (url.startsWith(prefix)) return toMarket(key) ?? null;
  }
  return null;
}

const capitalise = (value: string): string =>
  value.split(/[\s-]+/).map((w) => (w[0]?.toUpperCase() ?? "") + w.slice(1)).join("-");

/** `laytime` is days on market; the date it implies survives later runs. */
function daysAgo(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
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
