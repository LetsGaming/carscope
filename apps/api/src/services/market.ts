import type { Period } from "@carscope/core";
import {
  BODY, GEARBOX, SELLER, confidence, describe, histogram, monthlySeries, priceFactor,
  relativeToMedian, DEFAULT_WINDOW_MONTHS, LOW_MILEAGE_KM, MIN_SAMPLE_FOR_TREND,
  type Band, type Criteria, type Distribution, type Factor, type MonthlyPoint,
} from "@carscope/core";
import type { VehicleRepository } from "../repositories/vehicles.ts";
import type { ResultRow } from "../repositories/filter.ts";
import { MEDIA_PREFIX } from "../routes/media.ts";

const BAND_SIZE_EUR = 4_000;

export interface MarketReport {
  readonly current: Distribution;
  readonly series: readonly MonthlyPoint[];
  readonly bands: readonly Band[];
  readonly factors: readonly Factor[];
  readonly confidence: 1 | 2 | 3 | 4 | 5;
  readonly medianDaysListed: number | null;
  readonly changeYearPct: number | null;
  readonly activeCount: number;
  readonly observationCount: number;
  /**
   * Vehicles collected for this search that the search text excludes. The
   * collector verifies only the make and model, so a search for "Nissan Skyline
   * R34" stores every Skyline the portal returned; the query then requires every
   * word. Both are deliberate, and the gap between them was invisible: 45 cars
   * collected, 19 shown, and nothing saying why.
   */
  readonly excludedByText: number;
  /**
   * Search words read as a production period rather than as a word the advert
   * must contain. Reported so the reader can see why a car without the word is
   * in the list, and correct the search when the guess is wrong.
   */
  readonly periods: readonly Period[];
}

export interface PricedResult {
  readonly id: string;
  readonly make: string;
  readonly model: string;
  readonly variant: string | null;
  readonly firstRegistration: string | null;
  readonly mileageKm: number | null;
  readonly powerW: number | null;
  readonly gearbox: string | null;
  readonly city: string | null;
  readonly market: string;
  readonly daysListed: number;
  /** False when the figure is only how long we have been watching. */
  readonly daysListedExact: boolean;
  readonly priceChangeCount: number;
  readonly vsMedian: number;
  readonly price: number;
  readonly firstPrice: number;
  readonly photoCount: number;
  readonly thumbnail: string | null;
  readonly sources: readonly string[];
  readonly url: string;
}

export class MarketService {
  readonly #vehicles: VehicleRepository;

  constructor(vehicles: VehicleRepository) {
    this.#vehicles = vehicles;
  }

  report(criteria: Criteria, windowMonths = DEFAULT_WINDOW_MONTHS): MarketReport {
    const since = new Date();
    since.setMonth(since.getMonth() - windowMonths);

    const observations = this.#vehicles.observations(criteria, since.toISOString());
    const active = this.#vehicles.search(criteria, true);
    const all = this.#vehicles.search(criteria, false);
    const withoutText = criteria.text === ""
      ? active.length
      : this.#vehicles.search({ ...criteria, text: "" }, true).length;
    const activePrices = active.map((v) => v.current_price).filter((p) => p > 0);

    const series = monthlySeries(observations);
    const current = describe(activePrices);

    return {
      current,
      series,
      bands: histogram(activePrices, BAND_SIZE_EUR),
      factors: this.#factors(all),
      confidence: confidence(observations.length),
      medianDaysListed: medianDays(all),
      changeYearPct: yearOverYear(series),
      activeCount: active.length,
      observationCount: observations.length,
      excludedByText: Math.max(0, withoutText - active.length),
      periods: this.#vehicles.periods(criteria, true),
    };
  }

  priced(criteria: Criteria, activeOnly: boolean): PricedResult[] {
    const rows = this.#vehicles.search(criteria, activeOnly);
    const median = describe(rows.map((r) => r.current_price).filter((p) => p > 0)).p50;
    return rows.map((r) => ({
      id: r.id,
      make: r.make,
      model: r.model,
      variant: r.variant,
      firstRegistration: r.first_registration,
      mileageKm: r.mileage_km,
      powerW: r.power_w,
      gearbox: r.gearbox,
      city: r.city,
      market: r.market,
      daysListed: Math.max(0, r.days_listed ?? 0),
      daysListedExact: r.days_listed_exact === 1,
      priceChangeCount: r.price_changes,
      vsMedian: relativeToMedian(r.current_price, median),
      price: r.current_price,
      firstPrice: r.first_price ?? r.current_price,
      photoCount: r.photo_count,
      thumbnail: r.thumb_path === null ? r.thumb_url : MEDIA_PREFIX + r.thumb_path,
      sources: r.sources === null ? [] : r.sources.split(","),
      url: r.listing_url ?? "",
    }));
  }

  /** Each factor self-suppresses below the sample floor rather than shipping a caveat. */
  #factors(rows: readonly ResultRow[]): Factor[] {
    const price = (r: ResultRow): number => r.current_price;
    const candidates: readonly (Factor | null)[] = [
      priceFactor("coupe", rows, price, (r) => r.body_style === BODY.coupe),
      priceFactor("lowMileage", rows, price, (r) => r.mileage_km !== null && r.mileage_km < LOW_MILEAGE_KM),
      priceFactor("dealer", rows, price, (r) => r.seller_type === SELLER.dealer),
      priceFactor("manual", rows, price, (r) => r.gearbox === GEARBOX.manual),
    ];
    return candidates.filter((f): f is Factor => f !== null);
  }
}

function medianDays(rows: readonly ResultRow[]): number | null {
  const closed = rows.map((r) => r.days_listed ?? 0).filter((d) => d > 0);
  if (closed.length < MIN_SAMPLE_FOR_TREND) return null;
  return Math.round(describe(closed).p50);
}

function yearOverYear(series: readonly MonthlyPoint[]): number | null {
  const latest = series[series.length - 1];
  if (!latest?.reliable) return null;
  const target = series.find((p) => monthsBetween(p.month, latest.month) === 12);
  if (!target?.reliable || target.p50 <= 0) return null;
  return (latest.p50 - target.p50) / target.p50;
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  if (ay === undefined || am === undefined || by === undefined || bm === undefined) return -1;
  return (by - ay) * 12 + (bm - am);
}
