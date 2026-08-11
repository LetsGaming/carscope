import type { Market } from "./vehicle.ts";

export interface IdentityInput {
  readonly make: string;
  readonly model: string;
  readonly firstRegistration: string | null;
  readonly mileageKm: number | null;
  readonly market: Market;
  readonly sellerName: string | null;
}

const MILEAGE_BUCKET_KM = 2_000;

export function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Coarse grouping key. Two adverts sharing it are dedup *candidates*, not
 * confirmed matches — matchScore decides. Mileage is bucketed because sellers
 * round differently across portals for the same car.
 */
export function identityKey(input: IdentityInput): string {
  const bucket =
    input.mileageKm === null ? "x" : String(Math.round(input.mileageKm / MILEAGE_BUCKET_KM));
  return [
    normaliseName(input.make),
    normaliseName(input.model),
    input.firstRegistration ?? "x",
    bucket,
    input.market,
  ].join("|");
}

export interface MatchInput extends IdentityInput {
  readonly priceBase: number;
  readonly imageHash: string | null;
  readonly powerW: number | null;
  readonly title: string;
}

export const MATCH_THRESHOLD = 0.72;

const WEIGHT = {
  imageHash: 0.34,
  identity: 0.22,
  title: 0.18,
  seller: 0.12,
  price: 0.09,
  mileage: 0.03,
  power: 0.02,
} as const;

const PRICE_TOLERANCE = 0.04;
const MILEAGE_TOLERANCE_KM = 1_500;

/**
 * Same make and model, same registration month, same mileage to the kilometre and
 * the same price to the euro is not a coincidence — it is one car advertised
 * twice. Scoring cannot reach this on its own when a portal publishes neither a
 * seller name nor more than one photo, which is exactly the duplicate-ad case.
 */
export function isCertainMatch(a: MatchInput, b: MatchInput): boolean {
  return (
    normaliseName(a.make) === normaliseName(b.make)
    && a.mileageKm !== null && a.mileageKm === b.mileageKm
    && a.priceBase === b.priceBase
    && compatibleRegistration(a.firstRegistration, b.firstRegistration)
  );
}

/**
 * Portals disagree about how a car is named — one calls it a Skyline, another an
 * R34 — and about precision, one knowing only the year where another knows the
 * month. Neither disagreement says anything about whether it is the same car,
 * so the model is not part of the test and a year is compatible with any month
 * inside it.
 */
function compatibleRegistration(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true;
  return a.startsWith(b) || b.startsWith(a);
}

/** Share of the shorter title's words that also appear in the longer one. */
export function titleOverlap(a: string, b: string): number {
  const words = (v: string): Set<string> =>
    new Set(normaliseName(v).split(" ").filter((w) => w.length > 1));
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/**
 * 0..1 confidence that two adverts describe the same physical car. A shared image
 * set carries the most weight because cross-posting dealers reuse their photos;
 * everything else corroborates.
 */
export function matchScore(a: MatchInput, b: MatchInput): number {
  let score = 0;

  if (a.imageHash !== null && a.imageHash === b.imageHash) score += WEIGHT.imageHash;
  if (identityKey(a) === identityKey(b)) score += WEIGHT.identity;
  else if (normaliseName(a.make) === normaliseName(b.make)) score += WEIGHT.identity / 2;
  score += WEIGHT.title * titleOverlap(a.title, b.title);

  if (a.sellerName !== null && b.sellerName !== null) {
    if (normaliseName(a.sellerName) === normaliseName(b.sellerName)) score += WEIGHT.seller;
  }

  const priceSpread = Math.abs(a.priceBase - b.priceBase) / Math.max(a.priceBase, b.priceBase, 1);
  if (priceSpread <= PRICE_TOLERANCE) score += WEIGHT.price * (1 - priceSpread / PRICE_TOLERANCE);

  if (a.mileageKm !== null && b.mileageKm !== null) {
    const delta = Math.abs(a.mileageKm - b.mileageKm);
    if (delta <= MILEAGE_TOLERANCE_KM) score += WEIGHT.mileage * (1 - delta / MILEAGE_TOLERANCE_KM);
  }

  if (a.powerW !== null && a.powerW === b.powerW) score += WEIGHT.power;

  return score;
}

export const isSameVehicle = (a: MatchInput, b: MatchInput): boolean =>
  isCertainMatch(a, b) || matchScore(a, b) >= MATCH_THRESHOLD;
