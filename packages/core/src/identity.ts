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
 * confirmed matches, matchScore decides. Mileage is bucketed because sellers
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
  /** Absent or null when the portal does not say; the attribute rule then cannot apply. */
  readonly gearbox?: string | null;
  /** Where the car stands. The same-place rules need it on both sides. */
  readonly city?: string | null;
  readonly sellerType?: string | null;
  /** Every advert title the car has; `title` alone is only the first. */
  readonly titles?: readonly string[];
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
 * the same price to the euro is not a coincidence: it is one car advertised
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
 * What "the same car" has to agree on when two portals share neither a seller
 * nor a photo and one of them rounds the figures: the odometer within a few
 * kilometres, the price within a rounding error, the registration within a
 * month or two. Each is far tighter than the gap between two genuinely
 * different cars of one model (an R34 at 86,933 km and €44,900 is not the R34
 * at 89,745 km and €44,444).
 */
export const ATTRIBUTE_MILEAGE_KM = 250;
export const ATTRIBUTE_PRICE_SPREAD = 0.01;
export const ATTRIBUTE_POWER_W = 1_000;
export const ATTRIBUTE_REGISTRATION_MONTHS = 2;

/**
 * Every attribute must be known on both sides and agree within tolerance. A
 * missing value is not agreement: a car with no gearbox on one portal is
 * left to the other rules rather than merged on four signals out of five.
 * The model is not compared, for the reason `compatibleRegistration` gives.
 */
export function isAttributeMatch(a: MatchInput, b: MatchInput): boolean {
  if (normaliseName(a.make) !== normaliseName(b.make)) return false;
  if (!a.gearbox || a.gearbox !== b.gearbox) return false;
  if (a.powerW === null || b.powerW === null) return false;
  if (Math.abs(a.powerW - b.powerW) > ATTRIBUTE_POWER_W) return false;
  if (a.mileageKm === null || b.mileageKm === null) return false;
  if (Math.abs(a.mileageKm - b.mileageKm) > ATTRIBUTE_MILEAGE_KM) return false;
  const spread = Math.abs(a.priceBase - b.priceBase) / Math.max(a.priceBase, b.priceBase, 1);
  if (spread > ATTRIBUTE_PRICE_SPREAD) return false;
  return registrationsClose(a.firstRegistration, b.firstRegistration);
}

/** "1999-06" and "1999-07" are one month apart; a bare year fits any month in it. */
function registrationsClose(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  if (a.length < 7 || b.length < 7) return a.slice(0, 4) === b.slice(0, 4);
  const months = (v: string): number => Number(v.slice(0, 4)) * 12 + Number(v.slice(5, 7));
  return Math.abs(months(a) - months(b)) <= ATTRIBUTE_REGISTRATION_MONTHS;
}

/**
 * A seller re-posts an advert when the old one runs out, and edits it on the way:
 * a cheaper price, a corrected odometer, a registration typed again. What stays
 * is where the car stands and what the advert says. So this rule leaves the
 * price out and tolerates the corrections, but needs the town and similar words.
 * Dealers are excluded: a dealer's lot holds several cars of one model.
 */
export const PLACE_MILEAGE_SHARE = 0.05;
export const PLACE_REGISTRATION_MONTHS = 12;
export const PLACE_TITLE_OVERLAP = 0.5;
/** Where a title says nothing, the price has to stay this close instead. */
export const PLACE_QUIET_PRICE_SPREAD = 0.15;
/** A card with at most this many of mileage, registration, power and gearbox is sparse. */
export const SPARSE_KNOWN_ATTRIBUTES = 1;

export function isSamePlaceMatch(a: MatchInput, b: MatchInput): boolean {
  if (!sameSeller(a, b) || a.mileageKm === null || b.mileageKm === null) return false;
  if (Math.abs(a.mileageKm - b.mileageKm) > Math.max(a.mileageKm, b.mileageKm) * PLACE_MILEAGE_SHARE) {
    return false;
  }
  const gap = registrationGapMonths(a.firstRegistration, b.firstRegistration);
  if (gap === null || gap > PLACE_REGISTRATION_MONTHS) return false;
  if (!knownAttributesAgree(a, b)) return false;
  return titlesAllow(a, b);
}

/**
 * An aggregator card that states almost nothing (no mileage, no registration)
 * cannot meet the other rules. Same town and exactly the same price is what it
 * can offer, as long as nothing it does state contradicts the other advert.
 */
export function isSparseMatch(a: MatchInput, b: MatchInput): boolean {
  if (!sameSeller(a, b)) return false;
  if (Math.min(knownAttributeCount(a), knownAttributeCount(b)) > SPARSE_KNOWN_ATTRIBUTES) return false;
  if (a.priceBase !== b.priceBase) return false;
  return knownAttributesAgree(a, b);
}

/** Same make, same known town, and neither side a dealer. */
function sameSeller(a: MatchInput, b: MatchInput): boolean {
  return normaliseName(a.make) === normaliseName(b.make)
    && !!a.city && !!b.city && normaliseName(a.city) === normaliseName(b.city)
    && a.sellerType !== "dealer" && b.sellerType !== "dealer";
}

const knownAttributeCount = (v: MatchInput): number =>
  [v.mileageKm, v.firstRegistration, v.powerW, v.gearbox].filter((x) => x !== null && x !== undefined && x !== "").length;

/** What both adverts state has to agree. What only one states is not a conflict. */
function knownAttributesAgree(a: MatchInput, b: MatchInput): boolean {
  if (a.mileageKm !== null && b.mileageKm !== null
    && Math.abs(a.mileageKm - b.mileageKm) > Math.max(a.mileageKm, b.mileageKm) * PLACE_MILEAGE_SHARE) {
    return false;
  }
  const gap = registrationGapMonths(a.firstRegistration, b.firstRegistration);
  if (gap !== null && gap > PLACE_REGISTRATION_MONTHS) return false;
  if (a.powerW !== null && b.powerW !== null && Math.abs(a.powerW - b.powerW) > ATTRIBUTE_POWER_W) return false;
  return !(a.gearbox && b.gearbox && a.gearbox !== b.gearbox);
}

/** Months between two registrations; a bare year spans its twelve months. Null if either is unknown. */
function registrationGapMonths(a: string | null, b: string | null): number | null {
  if (a === null || b === null) return null;
  const span = (v: string): readonly [number, number] => {
    const year = Number(v.slice(0, 4)) * 12;
    if (v.length < 7) return [year + 1, year + 12];
    const month = year + Number(v.slice(5, 7));
    return [month, month];
  };
  const [aLow, aHigh] = span(a);
  const [bLow, bHigh] = span(b);
  return Math.max(0, aLow - bHigh, bLow - aHigh);
}

/** Words an aggregator puts in every title: "Gebraucht (1998) Nissan Skyline 280 PS | Seltenes Fahrzeug". */
const FILLER_TITLE_WORDS = new Set(["gebraucht", "ps", "kw"]);
const MIN_DISTINCTIVE_WORDS = 2;
const MIN_WORD_CHARS = 3;

/** The part of a title before an aggregator's tagline ("... | Seltenes Fahrzeug"). */
const headline = (title: string): string => title.split("|")[0] ?? title;

/**
 * A car whose every title is only make, model, year and power says nothing a
 * second advert could be compared with. Such a car neither confirms nor
 * contradicts by title.
 */
function titleIsQuiet(v: MatchInput): boolean {
  const named = new Set(textTokensOf(`${v.make} ${v.model}`));
  return !(v.titles ?? [v.title]).some((t) =>
    textTokensOf(headline(t)).filter((w) =>
      w.length >= MIN_WORD_CHARS && !/^\d+$/.test(w) && !named.has(w) && !FILLER_TITLE_WORDS.has(w),
    ).length >= MIN_DISTINCTIVE_WORDS);
}

const textTokensOf = (text: string): string[] => normaliseName(text).split(" ").filter(Boolean);

/** The best match between any title of one car and any title of the other. */
function bestTitleOverlap(a: MatchInput, b: MatchInput): number {
  const left = a.titles ?? [a.title];
  const right = b.titles ?? [b.title];
  return Math.max(0, ...left.flatMap((x) => right.map((y) => titleOverlap(headline(x), headline(y)))));
}

/** A quiet side is let through by title, and held to a close price instead. */
function titlesAllow(a: MatchInput, b: MatchInput): boolean {
  if (titleIsQuiet(a) || titleIsQuiet(b)) {
    const spread = Math.abs(a.priceBase - b.priceBase) / Math.max(a.priceBase, b.priceBase, 1);
    return spread <= PLACE_QUIET_PRICE_SPREAD;
  }
  return bestTitleOverlap(a, b) >= PLACE_TITLE_OVERLAP;
}

/**
 * Portals disagree about how a car is named (one calls it a Skyline, another an
 * R34) and about precision, one knowing only the year where another knows the
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

/** The two rules that need no scoring: one car advertised twice. */
export const isDuplicate = (a: MatchInput, b: MatchInput): boolean =>
  isCertainMatch(a, b) || isAttributeMatch(a, b) || isSamePlaceMatch(a, b) || isSparseMatch(a, b);

export const isSameVehicle = (a: MatchInput, b: MatchInput): boolean =>
  isDuplicate(a, b) || matchScore(a, b) >= MATCH_THRESHOLD;
