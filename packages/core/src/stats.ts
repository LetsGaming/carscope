/** Pure statistics over observed asking prices. No I/O, no formatting. */

export const MIN_SAMPLE_FOR_TREND = 5;
export const MIN_SAMPLE_FOR_FACTOR = 15;
export const MIN_SAMPLE_FOR_CONFIDENCE = 30;
/** How far back a market report looks. The client, the route and the service share it. */
export const DEFAULT_WINDOW_MONTHS = 24;
/** Mileage below which a car counts as low-mileage, in the report and in its label. */
export const LOW_MILEAGE_KM = 90_000;
/** A group difference must clear this share of the pooled spread to be worth showing. */
export const MIN_EFFECT_FRACTION = 0.35;

export interface Observation {
  readonly baseAmount: number;
  readonly observedAt: string;
}

export interface Distribution {
  readonly n: number;
  readonly p10: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
  readonly mean: number;
}

/** Linear interpolation between order statistics; matches numpy's default. */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] as number;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const low = sorted[lo] as number;
  if (lo === hi) return low;
  return low + ((sorted[hi] as number) - low) * (pos - lo);
}

export function describe(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n === 0 ? 0 : sorted.reduce((s, v) => s + v, 0) / n;
  return {
    n,
    p10: percentile(sorted, 0.1),
    p25: percentile(sorted, 0.25),
    p50: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    p90: percentile(sorted, 0.9),
    mean,
  };
}

export interface MonthlyPoint extends Distribution {
  readonly month: string;
  /** False below MIN_SAMPLE_FOR_TREND; the UI renders these months faded. */
  readonly reliable: boolean;
}

const monthOf = (iso: string): string => iso.slice(0, 7);

/** What one car asked in one month. One row per car and month, never one per sighting. */
export interface CarObservation extends Observation {
  readonly vehicleId: string;
}

export interface CarHistory {
  readonly vehicleId: string;
  /** First and last day the car was for sale, ISO. */
  readonly from: string;
  readonly to: string;
  /** Asking prices over time, oldest first. */
  readonly prices: readonly Observation[];
}

const monthEnd = (month: string): string => {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, mon, 0, 23, 59, 59, 999)).toISOString();
};

const nextMonth = (month: string): string => {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(year, mon, 1)).toISOString().slice(0, 7);
};

/**
 * The price a car asked in each month it was for sale: the last price seen up to
 * the end of that month or the end of its sale, whichever comes first. A car
 * counts once per month however often it was seen. Counting sightings made a car
 * listed for 60 days weigh as much as thirty cars listed for two, and the
 * monthly median followed whichever car stayed longest.
 */
export function monthlyObservations(
  cars: readonly CarHistory[],
  sinceIso: string,
): CarObservation[] {
  const out: CarObservation[] = [];
  for (const car of cars) {
    const first = car.prices[0];
    if (first === undefined) continue;
    // A car is priced from the day it was first seen, not from the day the portal says
    // it was listed: nothing was observed before, and a price is not carried backwards.
    const seenFrom = car.from > first.observedAt ? car.from : first.observedAt;
    const startMonth = monthOf(seenFrom < sinceIso ? sinceIso : seenFrom);
    const lastMonth = monthOf(car.to);
    for (let month = startMonth; month <= lastMonth; month = nextMonth(month)) {
      const cutoff = monthEnd(month) < car.to ? monthEnd(month) : car.to;
      let asked = first;
      for (const price of car.prices) {
        if (price.observedAt <= cutoff) asked = price;
        else break;
      }
      out.push({ vehicleId: car.vehicleId, baseAmount: asked.baseAmount, observedAt: `${month}-01T00:00:00.000Z` });
    }
  }
  return out;
}


export function monthlySeries(observations: readonly Observation[]): MonthlyPoint[] {
  const buckets = new Map<string, number[]>();
  for (const o of observations) {
    const key = monthOf(o.observedAt);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(o.baseAmount);
    else buckets.set(key, [o.baseAmount]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, values]) => ({
      month,
      ...describe(values),
      reliable: values.length >= MIN_SAMPLE_FOR_TREND,
    }));
}

export interface Band {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

export function histogram(values: readonly number[], bandSize: number): Band[] {
  if (values.length === 0 || bandSize <= 0) return [];
  const min = Math.floor(Math.min(...values) / bandSize) * bandSize;
  const max = Math.ceil(Math.max(...values) / bandSize) * bandSize;
  const bands: Band[] = [];
  for (let from = min; from < max; from += bandSize) {
    const to = from + bandSize;
    bands.push({ from, to, count: values.filter((v) => v >= from && v < to).length });
  }
  return bands;
}

export interface Factor {
  readonly key: string;
  readonly withMedian: number;
  readonly withoutMedian: number;
  readonly deltaEur: number;
  readonly nWith: number;
  readonly nWithout: number;
}

/**
 * Median difference between two groups. Deliberately unadjusted — it is a hint,
 * not a hedonic model — so it is suppressed entirely unless both groups clear
 * MIN_SAMPLE_FOR_FACTOR *and* the gap is large next to the pooled spread. A big
 * sample makes a tiny difference reportable, not meaningful.
 */
export function priceFactor<T>(
  key: string,
  items: readonly T[],
  price: (item: T) => number,
  predicate: (item: T) => boolean,
): Factor | null {
  const withIt = items.filter(predicate).map(price);
  const withoutIt = items.filter((i) => !predicate(i)).map(price);
  if (withIt.length < MIN_SAMPLE_FOR_FACTOR || withoutIt.length < MIN_SAMPLE_FOR_FACTOR) return null;
  const first = describe(withIt);
  const second = describe(withoutIt);
  const a = first.p50;
  const b = second.p50;

  const pooledSpread = ((first.p75 - first.p25) + (second.p75 - second.p25)) / 2;
  if (Math.abs(a - b) < pooledSpread * MIN_EFFECT_FRACTION) return null;

  return {
    key,
    withMedian: a,
    withoutMedian: b,
    deltaEur: Math.round(a - b),
    nWith: withIt.length,
    nWithout: withoutIt.length,
  };
}

export function relativeToMedian(price: number, median: number): number {
  if (median <= 0) return 0;
  return (price - median) / median;
}

export function confidence(n: number): 1 | 2 | 3 | 4 | 5 {
  if (n >= 400) return 5;
  if (n >= 150) return 4;
  if (n >= MIN_SAMPLE_FOR_CONFIDENCE) return 3;
  if (n >= MIN_SAMPLE_FOR_TREND) return 2;
  return 1;
}
