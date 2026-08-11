import type { BodyStyle, Fuel, Gearbox, Market, SellerType } from "./vehicle.ts";

export interface Range {
  readonly min: number | null;
  readonly max: number | null;
}

/**
 * Frozen because it is shared. An unbounded range is the same value everywhere,
 * so one object serves every reader, and freezing turns a write through a
 * shallow copy into an immediate TypeError instead of silently editing the
 * constant every other caller is holding.
 */
export const EMPTY_RANGE: Range = Object.freeze({ min: null, max: null });

/** A fresh unbounded range. Use this wherever the result will be written to. */
export const emptyRange = (): Range => ({ min: null, max: null });

/** Source-neutral search. Adapters translate it; the core filters what they cannot. */
export interface Criteria {
  readonly text: string;
  readonly make: string | null;
  readonly model: string | null;
  readonly priceEur: Range;
  readonly mileageKm: Range;
  readonly registrationYear: Range;
  readonly powerPs: Range;
  readonly fuel: Fuel | null;
  readonly gearbox: Gearbox | null;
  readonly sellerType: SellerType | null;
  readonly bodyStyle: BodyStyle | null;
  readonly excludeDamaged: boolean;
  readonly markets: readonly Market[];
  readonly postalCode: string | null;
  readonly radiusKm: number | null;
}

export const CRITERION = {
  text: "text", make: "make", model: "model", priceEur: "priceEur",
  mileageKm: "mileageKm", registrationYear: "registrationYear", powerPs: "powerPs",
  fuel: "fuel", gearbox: "gearbox", sellerType: "sellerType", bodyStyle: "bodyStyle",
  excludeDamaged: "excludeDamaged", markets: "markets", area: "area",
} as const;

export type CriterionKey = (typeof CRITERION)[keyof typeof CRITERION];

/**
 * The empty search, for comparing against and for spreading over. Frozen all the
 * way down: its four ranges are one shared object, so a caller that spreads it
 * and then writes to `priceEur.min` would otherwise reach `mileageKm`,
 * `registrationYear` and `powerPs` as well, and the constant itself.
 *
 * Anything that will be edited wants `emptyCriteria()` instead.
 */
export const EMPTY_CRITERIA: Criteria = Object.freeze({
  text: "", make: null, model: null,
  priceEur: EMPTY_RANGE, mileageKm: EMPTY_RANGE,
  registrationYear: EMPTY_RANGE, powerPs: EMPTY_RANGE,
  fuel: null, gearbox: null, sellerType: null, bodyStyle: null,
  excludeDamaged: false, markets: Object.freeze([]), postalCode: null, radiusKm: null,
});

/** An empty search with nothing shared, safe to hand to a form. */
export const emptyCriteria = (): Criteria => ({
  ...EMPTY_CRITERIA,
  priceEur: emptyRange(),
  mileageKm: emptyRange(),
  registrationYear: emptyRange(),
  powerPs: emptyRange(),
  markets: [],
});

/**
 * An independent copy. The nested ranges and the market list are rebuilt, so
 * editing the copy never reaches the original.
 */
export const copyCriteria = (criteria: Criteria): Criteria => ({
  ...criteria,
  priceEur: { ...criteria.priceEur },
  mileageKm: { ...criteria.mileageKm },
  registrationYear: { ...criteria.registrationYear },
  powerPs: { ...criteria.powerPs },
  markets: [...criteria.markets],
});

export function withinRange(value: number | null, range: Range): boolean {
  if (value === null) return range.min === null && range.max === null;
  if (range.min !== null && value < range.min) return false;
  if (range.max !== null && value > range.max) return false;
  return true;
}

export function rangeIsValid(range: Range): boolean {
  return range.min === null || range.max === null || range.min <= range.max;
}

/**
 * Countries a source should be queried for: the search's choice, or all it
 * covers. Generic over the source's own market type so callers keep it and do
 * not have to assert the result back into `Market[]`.
 */
export function marketsFor<T extends string>(
  criteria: Pick<Criteria, "markets">,
  supported: readonly T[],
): T[] {
  if (criteria.markets.length === 0) return [...supported];
  const wanted = new Set<string>(criteria.markets);
  return supported.filter((market) => wanted.has(market));
}

export function invalidRanges(c: Criteria): CriterionKey[] {
  const pairs: readonly [CriterionKey, Range][] = [
    [CRITERION.priceEur, c.priceEur],
    [CRITERION.mileageKm, c.mileageKm],
    [CRITERION.registrationYear, c.registrationYear],
    [CRITERION.powerPs, c.powerPs],
  ];
  return pairs.filter(([, r]) => !rangeIsValid(r)).map(([k]) => k);
}

/** Search words, lowercased and stripped of separators. */
export function textTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Every token must appear somewhere in the haystack. */
export function matchesText(haystack: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = haystack
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  return tokens.every((token) => hay.includes(token));
}
