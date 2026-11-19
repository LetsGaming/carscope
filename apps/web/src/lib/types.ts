/**
 * Wire shapes only. Anything the server and the client both reason about (the
 * criteria, the domain vocabulary, the unit conversions) comes from
 * `@carscope/core` rather than being restated here, because a second copy of a
 * union is a copy that silently stops matching what the API accepts.
 */
import {
  copyCriteria as copyDomainCriteria, emptyCriteria as emptyDomainCriteria, MARKET,
  type Criteria, type Market, type Range,
} from "@carscope/core";

export type { Criteria, Market, Range } from "@carscope/core";

/**
 * The form writes into the criteria object, so the client's view of it is
 * mutable all the way down. The ranges have to be listed explicitly: a mapped
 * type only strips `readonly` from the level it is applied to, which is what let
 * the four ranges be edited through a type that claimed they could not be.
 */
export type MutableRange = { -readonly [K in keyof Range]: Range[K] };

export type EditableCriteria = {
  -readonly [K in keyof Criteria]: K extends "markets"
    ? Market[]
    : Criteria[K] extends Range ? MutableRange : Criteria[K];
};

/**
 * Every criteria object the form touches is built here. Both helpers rebuild the
 * nested ranges, because a shallow copy of the domain criteria shares one range
 * object across `priceEur`, `mileageKm`, `registrationYear` and `powerPs`, and
 * typing a price then filled all four.
 */
export const emptyCriteria = (): EditableCriteria => ({
  ...emptyDomainCriteria(),
  markets: [MARKET.de],
  priceEur: { min: null, max: null },
  mileageKm: { min: null, max: null },
  registrationYear: { min: null, max: null },
  powerPs: { min: null, max: null },
});

export const copyCriteria = (criteria: Criteria): EditableCriteria => {
  const copy = copyDomainCriteria(criteria);
  return {
    ...copy,
    markets: [...copy.markets],
    priceEur: { ...copy.priceEur },
    mileageKm: { ...copy.mileageKm },
    registrationYear: { ...copy.registrationYear },
    powerPs: { ...copy.powerPs },
  };
};

export interface SavedSearch { id: string; name: string; criteria: EditableCriteria }

export interface Result {
  id: string; make: string; model: string; variant: string | null;
  firstRegistration: string | null; mileageKm: number | null; powerW: number | null;
  gearbox: string | null; city: string | null; market: string;
  daysListed: number; daysListedExact: boolean; delistedAt: string | null;
  heldReason: string | null;
  priceChangeCount: number; vsMedian: number;
  price: number; firstPrice: number;
  photoCount: number; thumbnail: string | null;
  sources: string[]; url: string;
}

export interface Distribution {
  n: number; p10: number; p25: number; p50: number; p75: number; p90: number; mean: number;
}

export interface MonthlyPoint extends Distribution { month: string; reliable: boolean }

export interface MarketReport {
  current: Distribution;
  series: MonthlyPoint[];
  bands: { from: number; to: number; count: number }[];
  factors: { key: string; deltaEur: number; nWith: number; nWithout: number }[];
  confidence: number;
  medianDaysListed: number | null;
  changeYearPct: number | null;
  activeCount: number;
  observationCount: number;
  excludedByText: number;
  heldCount: number;
  periods: { token: string; fromYear: number; toYear: number }[];
}

export interface Source {
  id: string; label: string; markets: string[]; enabled: boolean;
  status: string; finishedAt: string | null; fetched: number;
  consecutiveFailures: number; note: string | null;
}

export interface CollectionRun {
  sourceId: string; status: string;
  fetched: number; kept: number; created: number;
  merged: number; delisted: number; photos: number;
  note: string | null;
}

export interface CollectionJob {
  id: string; label: string;
  startedAt: string; finishedAt: string | null;
  total: number; done: number; current: string | null;
  runs: CollectionRun[]; stored: number; timedOut: boolean;
}
