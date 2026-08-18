import {
  BASE_CURRENCY, MARKET,
  toBodyStyle, toCurrency, toFuel, toGearbox, toMarket, toSellerType,
} from "@carscope/core";
import type { Listing, Photo, PriceSnapshot, Vehicle } from "@carscope/core";
import type { SqlRow } from "../db/index.ts";

/** Raw SQLite shapes. Everything crossing out of a repository is mapped, never cast. */
export interface VehicleRow extends SqlRow {
  id: string; make: string; model: string; variant: string | null;
  body_style: string | null; first_registration: string | null;
  mileage_km: number | null; power_w: number | null; fuel: string | null;
  gearbox: string | null; seller_type: string | null; seller_name: string | null;
  market: string; postal_code: string | null; city: string | null;
  damaged: number | null; identity_key: string; image_hash: string | null;
  description: string | null; detail_fetched_at: string | null;
  first_listed_at: string | null;
  first_seen_at: string; last_seen_at: string; delisted_at: string | null;
}

export interface ListingRow extends SqlRow {
  id: string; vehicle_id: string; source_id: string; source_listing_id: string;
  url: string; title: string; first_seen_at: string; last_seen_at: string;
  delisted_at: string | null;
}

export interface PhotoRow extends SqlRow {
  vehicle_id: string; position: number; url: string;
  local_path: string | null; width: number | null; height: number | null;
}

export interface SnapshotRow extends SqlRow {
  vehicle_id: string; observed_at: string; source_id: string;
  amount: number; currency: string; base_amount: number; rate: number;
}

/**
 * A row predates whatever the domain currently allows: a column written before a
 * value was retired still has to come back as something. The core parsers decide
 * what is a member, so this file never carries its own copy of the vocabulary.
 */
export function toVehicle(row: VehicleRow): Vehicle {
  return {
    id: row.id,
    make: row.make,
    model: row.model,
    variant: row.variant,
    bodyStyle: toBodyStyle(row.body_style),
    firstRegistration: row.first_registration,
    mileageKm: row.mileage_km,
    powerW: row.power_w,
    fuel: toFuel(row.fuel),
    gearbox: toGearbox(row.gearbox),
    sellerType: toSellerType(row.seller_type),
    sellerName: row.seller_name,
    market: toMarket(row.market) ?? MARKET.de,
    postalCode: row.postal_code,
    city: row.city,
    damaged: row.damaged === null ? null : row.damaged === 1,
    firstListedAt: row.first_listed_at,
    description: row.description,
    identityKey: row.identity_key,
    imageHash: row.image_hash,
  };
}

export function toListing(row: ListingRow, photos: readonly Photo[]): Listing {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    sourceId: row.source_id,
    sourceListingId: row.source_listing_id,
    url: row.url,
    title: row.title,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    delistedAt: row.delisted_at,
    photos,
  };
}

export function toPhoto(row: PhotoRow): Photo {
  return { url: row.url, localPath: row.local_path, width: row.width, height: row.height, position: row.position };
}

export function toSnapshot(row: SnapshotRow): PriceSnapshot {
  return {
    vehicleId: row.vehicle_id,
    observedAt: row.observed_at,
    sourceId: row.source_id,
    amount: row.amount,
    currency: toCurrency(row.currency) ?? BASE_CURRENCY,
    baseAmount: row.base_amount,
    rate: row.rate,
  };
}
