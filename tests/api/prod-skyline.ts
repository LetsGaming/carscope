import { CURRENCY, type RawListing } from "@carscope/core";
import rows from "../fixtures/prod-skyline-2026-11-19.json" with { type: "json" };

/** The Skyline R34 vehicles on prod on 2026-11-19, as the collector would hand them over. */
export const PROD = rows;
export type ProdRow = (typeof rows)[number];

/** Cars that are not listings: two buyers' adverts, a 1 EUR price, a price called a placeholder. */
export const HELD_IDS = ["2a3f48d0", "2bc75571", "f2ad0321", "a771e4ce"] as const;

/** The three pairs that are one car: a repost, a repost with corrected data, a sparse card. */
export const SAME_CAR: readonly (readonly [string, string])[] = [
  ["aff93dde", "13697373"],
  ["14195382", "b48b8325"],
  ["85c1cad9", "a372d143"],
];

/** One advert per title the car had on prod, so the car carries every title it carried there. */
export function toRaws(row: ProdRow): RawListing[] {
  return row.titles.map((title, i) => ({
    sourceListingId: `${row.id}-${String(i)}`,
    url: `https://www.kleinanzeigen.de/s-anzeige/${row.id}/${String(i)}`,
    title,
    price: row.price,
    currency: CURRENCY.eur,
    photoUrls: [],
    attributes: {
      make: row.make, model: row.model, market: "DE",
      ...(row.km === null ? {} : { mileageKm: row.km }),
      ...(row.reg === null ? {} : { firstRegistration: row.reg }),
      ...(row.powerW === null ? {} : { powerW: row.powerW }),
      ...(row.gearbox === "manual" || row.gearbox === "automatic" ? { gearbox: row.gearbox } : {}),
      ...(row.sellerType === "private" || row.sellerType === "dealer" ? { sellerType: row.sellerType } : {}),
      ...(row.city === null ? {} : { city: row.city }),
      ...("description" in row ? { description: row.description } : {}),
    },
  }));
}
