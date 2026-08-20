import { Type, type Static } from "@sinclair/typebox";
import type { PricedResult } from "../../services/market.ts";
import type { FeedRow } from "../../repositories/vehicles.ts";
import { MEDIA_PREFIX } from "../media.ts";

/**
 * Deliberately its own schema, never `ResultSchema` from `routes/market.ts`.
 * The public namespace promises a stable contract to outside consumers; the
 * internal shape is free to change under it, and importing the internal
 * schema is exactly how that promise breaks silently.
 */
export const PublicSearchSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
});

export const PublicVehicleSchema = Type.Object({
  id: Type.String(),
  make: Type.String(),
  model: Type.String(),
  variant: Type.Union([Type.String(), Type.Null()]),
  firstRegistration: Type.Union([Type.String(), Type.Null()]),
  mileageKm: Type.Union([Type.Integer(), Type.Null()]),
  powerW: Type.Union([Type.Integer(), Type.Null()]),
  fuel: Type.Union([Type.String(), Type.Null()]),
  gearbox: Type.Union([Type.String(), Type.Null()]),
  market: Type.String(),
  priceEur: Type.Integer(),
  thumbnail: Type.Union([Type.String(), Type.Null()]),
  url: Type.String(),
});

export const PublicMarketSchema = Type.Object({
  current: Type.Object({
    n: Type.Integer(), p10: Type.Number(), p25: Type.Number(),
    p50: Type.Number(), p75: Type.Number(), p90: Type.Number(), mean: Type.Number(),
  }),
  activeCount: Type.Integer(),
  confidence: Type.Integer(),
});

export const PublicFeedSchema = Type.Object({
  items: Type.Array(PublicVehicleSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export function toPublicVehicle(r: PricedResult): Static<typeof PublicVehicleSchema> {
  return {
    id: r.id, make: r.make, model: r.model, variant: r.variant,
    firstRegistration: r.firstRegistration, mileageKm: r.mileageKm, powerW: r.powerW,
    fuel: null, gearbox: r.gearbox, market: r.market,
    priceEur: r.price, thumbnail: r.thumbnail, url: r.url,
  };
}

export function toPublicFeedVehicle(r: FeedRow): Static<typeof PublicVehicleSchema> {
  return {
    id: r.id, make: r.make, model: r.model, variant: r.variant,
    firstRegistration: r.first_registration, mileageKm: r.mileage_km, powerW: r.power_w,
    fuel: r.fuel, gearbox: r.gearbox, market: r.market,
    priceEur: r.current_price,
    thumbnail: r.thumb_path === null ? r.thumb_url : MEDIA_PREFIX + r.thumb_path,
    url: r.listing_url ?? "",
  };
}
