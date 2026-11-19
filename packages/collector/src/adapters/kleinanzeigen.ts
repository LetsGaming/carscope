import {
  CRITERION, CURRENCY, MARKET, HOUR_MS, ok, err, failure, FAILURE,
  type Criteria, type ListPage, type RawListing, type RequestSpec,
  type Result, type SourceAdapter,
} from "@carscope/core";
import { asString, decodeEntities, isRecord, jsonLdBlocks, slug } from "../html.ts";
import {
  attribute, blocksBy, extractDescription, germanNumber, imageUrls,
  parsePlace, postedAt, powerLabelToWatt, registrationToIso, visibleText,
} from "../text.ts";
import { normaliseMake, splitMakeModel } from "./make-model.ts";

const ORIGIN = "https://www.kleinanzeigen.de";
/** Kleinanzeigen moved its images off the shared classifieds CDN onto its own. */
const IMAGE_HOSTS = /img\.(?:kleinanzeigen|classistatic)\.de|ebayimg\.com/;
const BASE = `${ORIGIN}/s-autos`;
const CATEGORY = "c216";

/**
 * Kleinanzeigen has two filter grammars in one URL. Generic filters are path
 * segments before the keyword; category attributes are appended after the
 * `k0c216` token, joined with `+`, and their ranges use a comma.
 *
 *   /s-autos/anbieter:privat/nissan-skyline-r34/k0c216l4279+autos.power_i:280,
 */
const ATTRIBUTE = {
  make: "autos.marke_s", model: "autos.model_s", mileage: "autos.km_i",
  power: "autos.power_i", registration: "autos.ez_i", fuel: "autos.fuel_s",
  gearbox: "autos.shift_s", body: "autos.typ_s",
} as const;

const FUEL: Readonly<Record<string, string>> = {
  petrol: "benzin", diesel: "diesel", electric: "elektro",
  hybrid: "hybrid", lpg: "autogas", cng: "erdgas",
};
const GEARBOX: Readonly<Record<string, string>> = { manual: "manuell", automatic: "automatik" };
const BODY: Readonly<Record<string, string>> = {
  coupe: "coupe", sedan: "limousine", wagon: "kombi", suv: "suv",
  convertible: "cabrio", van: "van", hatchback: "kleinwagen",
};
const SELLER: Readonly<Record<string, string>> = { private: "privat", dealer: "gewerblich" };

const range = (min: number | null, max: number | null): string => `${min ?? ""},${max ?? ""}`;

export const kleinanzeigen: SourceAdapter = {
  id: "kleinanzeigen",
  label: "Kleinanzeigen",
  markets: [MARKET.de],
  currency: CURRENCY.eur,
  minIntervalMs: 6 * HOUR_MS,
  // A postal code cannot be expressed; the site wants its own numeric location id.
  unsupported: [CRITERION.area, CRITERION.excludeDamaged, CRITERION.text],
  needsBrowser: true,

  buildQuery(c: Criteria, page: number): RequestSpec {
    const { make, model } = splitMakeModel(c);
    const segments: string[] = [];
    if (make !== null) segments.push(normaliseMake(make));
    segments.push("sortierung:empfohlen");
    if (c.sellerType) segments.push(`anbieter:${SELLER[c.sellerType] ?? ""}`);
    if (c.priceEur.min !== null || c.priceEur.max !== null) {
      segments.push(`preis:${c.priceEur.min ?? ""}:${c.priceEur.max ?? ""}`);
    }
    if (page > 1) segments.push(`seite:${String(page)}`);

    const term = [c.make, c.model, c.text].filter(Boolean).join(" ").trim();
    if (term) segments.push(slug(term));

    const attributes: string[] = [];
    if (make !== null) attributes.push(`${ATTRIBUTE.make}:${normaliseMake(make)}`);
    if (model !== null) attributes.push(`${ATTRIBUTE.model}:${slug(model)}`);
    if (c.mileageKm.min !== null || c.mileageKm.max !== null) {
      attributes.push(`${ATTRIBUTE.mileage}:${range(c.mileageKm.min, c.mileageKm.max)}`);
    }
    if (c.powerPs.min !== null || c.powerPs.max !== null) {
      attributes.push(`${ATTRIBUTE.power}:${range(c.powerPs.min, c.powerPs.max)}`);
    }
    if (c.registrationYear.min !== null || c.registrationYear.max !== null) {
      attributes.push(`${ATTRIBUTE.registration}:${range(c.registrationYear.min, c.registrationYear.max)}`);
    }
    if (c.fuel) attributes.push(`${ATTRIBUTE.fuel}:${FUEL[c.fuel] ?? ""}`);
    if (c.gearbox) attributes.push(`${ATTRIBUTE.gearbox}:${GEARBOX[c.gearbox] ?? ""}`);
    if (c.bodyStyle) attributes.push(`${ATTRIBUTE.body}:${BODY[c.bodyStyle] ?? ""}`);

    const tail = `k0${CATEGORY}${attributes.length > 0 ? `+${attributes.join("+")}` : ""}`;
    return { url: [BASE, ...segments, tail].join("/") };
  },

  parseList(body: string): Result<ListPage> {
    const articles = blocksBy(body, /<article[^>]*\bdata-adid="\d+"/g);
    if (articles.length === 0) {
      return err(failure(FAILURE.parse, "no data-adid articles in kleinanzeigen list page"));
    }
    const galleries = galleriesFrom(body);
    const listings = articles
      .flatMap(toRawListing)
      .map((listing) => {
        const gallery = galleries.get(listing.sourceListingId);
        return gallery === undefined || gallery.length <= listing.photoUrls.length
          ? listing
          : { ...listing, photoUrls: gallery };
      });
    return ok({ listings, hasMore: listings.length > 0 });
  },

  /** The list article carries one thumbnail and a teaser; the ad page has both in full. */
  parseDetail(body: string): Result<Partial<RawListing>> {
    const description = extractDescription(body, "viewad-description-text");
    const photoUrls = imageUrls(body, IMAGE_HOSTS);
    const text = visibleText(body);

    return ok({
      ...(photoUrls.length > 0 ? { photoUrls } : {}),
      attributes: {
        ...(description === null ? {} : { description }),
        powerW: powerLabelToWatt(/(\d[\d.]*)\s*PS/.exec(text)?.[0]),
        gearbox: /Automatik/i.test(text) ? "automatic" : /Schaltgetriebe|Manuell/i.test(text) ? "manual" : null,
        fuel: detailFuel(text),
      },
    });
  },
};

function detailFuel(text: string): "petrol" | "diesel" | "electric" | "hybrid" | "lpg" | null {
  if (/\bBenzin\b/i.test(text)) return "petrol";
  if (/\bDiesel\b/i.test(text)) return "diesel";
  if (/\bElektro\b/i.test(text)) return "electric";
  if (/\bHybrid\b/i.test(text)) return "hybrid";
  if (/\bAutogas|LPG\b/i.test(text)) return "lpg";
  return null;
}

/**
 * The list page ships the data its own client hydrates from, and that includes
 * every advert's gallery, not just the thumbnail in the article markup. Reading
 * it here is what makes the detail page optional: fetching one per car cost
 * about seven seconds each and spent a whole run's budget on eleven of them.
 *
 * The payload is HTML-escaped and each value is wrapped in a `[0, value]` tuple
 * by the framework, so it is read by locating each advert's `imageList` and
 * taking the large variant of every image before the next advert begins.
 */
function galleriesFrom(body: string): Map<string, string[]> {
  const doc = decodeEntities(body);
  const galleries = new Map<string, string[]>();
  const marks = [...doc.matchAll(/"imageList":/g)];

  for (const mark of marks) {
    const adId = lastAdIdBefore(doc, mark.index);
    if (adId === null) continue;

    // Bounded by the array itself, not by the next advert. Stopping at the next
    // advert swept up whatever sat between them and hung another car's pictures
    // on this one.
    const list = arrayAt(doc, mark.index + mark[0].length);
    if (list === null) continue;

    const urls = [...list.matchAll(/"xLargeUrl":\[0,"([^"]+)"\]/g)]
      .map((m) => m[1])
      .filter((url): url is string => url !== undefined);
    if (urls.length > 0) galleries.set(adId, [...new Set(urls)]);
  }
  return galleries;
}

/** The bracketed array starting at or after `from`, string-aware. */
function arrayAt(doc: string, from: number): string | null {
  const start = doc.indexOf("[", from);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < doc.length; i += 1) {
    const ch = doc[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return doc.slice(start, i + 1);
    }
  }
  return null;
}

/** How far back to look for the advert an imageList belongs to. */
const AD_ID_LOOKBEHIND = 4_000;

function lastAdIdBefore(doc: string, at: number): string | null {
  const window = doc.slice(Math.max(0, at - AD_ID_LOOKBEHIND), at);
  const ids = [...window.matchAll(/"(?:adId|id)":\[0,"?(\d{9,12})"?\]/g)];
  return ids[ids.length - 1]?.[1] ?? null;
}

/** Each article embeds an ImageObject carrying the advert's own title and photo. */
function toRawListing(article: string): RawListing[] {
  const openingTag = /<article[^>]*>/.exec(article)?.[0] ?? "";
  const id = attribute(openingTag, "data-adid");
  const href = attribute(openingTag, "data-href");
  if (!id || !href) return [];

  const image = jsonLdBlocks(article).find((b) => isRecord(b) && b["@type"] === "ImageObject");
  const title = isRecord(image) ? asString(image["title"]) : null;
  const contentUrl = isRecord(image) ? asString(image["contentUrl"]) : null;

  const text = visibleText(article);
  const price = germanNumber(/(\d[\d.]*)\s*€/.exec(text)?.[1]);
  if (price === null) return [];

  // The location has its own element; in the flattened text it runs into the
  // posting date that sits next to it.
  const place = parsePlace(
    /<span>\s*(\d{5}\s+[^<]{2,60}?)\s*<\/span>/.exec(article)?.[1]
      ?? /(\d{5}\s+[^\d•|]{2,40})/.exec(text)?.[1],
  );
  const teaser = isRecord(image) ? asString(image["description"]) : null;

  return [{
    sourceListingId: id,
    url: ORIGIN + href,
    title: title ?? text.slice(0, 80),
    price,
    currency: CURRENCY.eur,
    photoUrls: contentUrl ? [contentUrl] : [],
    attributes: {
      mileageKm: germanNumber(/(\d[\d.]*)\s*km\b/.exec(text)?.[1]),
      firstRegistration: registrationToIso(/EZ\s*(\d{1,2}\/\d{4})/.exec(text)?.[1]),
      ...(teaser === null ? {} : { description: teaser }),
      firstListedAt: postedAt(/\b(Heute|Gestern|Vorgestern|\d{1,2}\.\d{1,2}\.\d{4})\b[^|]{0,12}/.exec(text)?.[0]),
      postalCode: place.postalCode,
      city: place.city,
    },
  }];
}
