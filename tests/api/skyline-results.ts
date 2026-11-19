import { CURRENCY, type RawListing } from "@carscope/core";
import rows from "../fixtures/skyline-r34-results.json" with { type: "json" };

export interface Skyline {
  readonly id: string;
  readonly source: string;
  readonly listing: RawListing;
}

/** Kleinanzeigen puts the advert's title in the URL; the other portals name the car. */
function titleOf(row: (typeof rows)[number]): string {
  const slug = /\/s-anzeige\/([^/]+)\//.exec(row.url)?.[1];
  return slug === undefined
    ? [row.make, row.model, row.variant].filter(Boolean).join(" ")
    : slug.replaceAll("-", " ");
}

/** The five adverts of the Skyline R34 search, as the collector would hand them over. */
export const SKYLINE: readonly Skyline[] = rows.map((r) => ({
  id: r.id.slice(0, 8),
  source: r.sources[0] ?? "unknown",
  listing: {
    sourceListingId: r.id,
    url: r.url,
    title: titleOf(r),
    price: r.price,
    currency: CURRENCY.eur,
    photoUrls: [],
    attributes: {
      make: r.make, model: r.model, market: "DE",
      mileageKm: r.mileageKm, powerW: r.powerW,
      firstRegistration: r.firstRegistration,
      ...(r.gearbox === "manual" || r.gearbox === "automatic" ? { gearbox: r.gearbox } : {}),
      ...(r.variant === null ? {} : { variant: r.variant }),
    },
  },
}));

export const byId = (id: string): Skyline => {
  const found = SKYLINE.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no skyline fixture ${id}`);
  return found;
};
