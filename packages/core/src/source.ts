import type { Criteria, CriterionKey } from "./criteria.ts";
import type { Market, Vehicle } from "./vehicle.ts";
import type { Currency } from "./units.ts";
import type { Result } from "./result.ts";

export interface RequestSpec {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Set when the source cannot express the query; the runner skips it and says why. */
  readonly skip?: string;
}

/** What an adapter produces before identity resolution. Flat and source-shaped. */
export interface RawListing {
  readonly sourceListingId: string;
  readonly url: string;
  readonly title: string;
  readonly price: number;
  readonly currency: Currency;
  readonly photoUrls: readonly string[];
  /** `market` is optional: adapters set it when the listing states a country. */
  readonly attributes: Partial<Omit<Vehicle, "id" | "identityKey" | "imageHash">>;
}

export interface ListPage {
  readonly listings: readonly RawListing[];
  readonly hasMore: boolean;
  /** Set when the page implies more results than were understood. */
  readonly note?: string;
}

/**
 * Every source implements this and nothing else. Scheduling, deduplication,
 * snapshotting, rate limiting, retries and photo storage live in the collector
 * and are never reimplemented per source.
 */
export interface SourceAdapter {
  readonly id: string;
  readonly label: string;
  /** Countries this source covers. AutoScout24 is one portal in eight of them. */
  readonly markets: readonly Market[];
  readonly currency: Currency;
  readonly minIntervalMs: number;
  /** Criteria this source cannot express in a query. The collector filters them afterwards. */
  readonly unsupported: readonly CriterionKey[];
  /** True when the portal only answers a real browser rather than a plain request. */
  readonly needsBrowser?: boolean;

  buildQuery(criteria: Criteria, page: number, ctx: QueryContext): RequestSpec;
  /**
   * Optional lookup run once per collection, before paging. Portals that
   * identify models numerically need a round trip to translate a name.
   */
  resolveHints?(criteria: Criteria, ctx: HintContext): Promise<QueryHints>;
  parseList(body: string, spec: RequestSpec): Result<ListPage>;
  parseDetail?(body: string): Result<Partial<RawListing>>;
}

export type QueryHints = Readonly<Record<string, string>>;

/** A source is queried once per market it covers that the search asks for. */
export interface QueryContext {
  readonly market: Market;
  readonly hints: QueryHints;
}

export interface HintContext {
  fetchText(url: string, browser: boolean): Promise<Result<string>>;
  /** Lookups are stable for months; caching keeps them to one request per make. */
  cached(key: string, produce: () => Promise<string | null>): Promise<string | null>;
}

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
