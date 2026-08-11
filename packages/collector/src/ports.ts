import type { Criteria, Market, PriceSnapshot, RawListing, SourceAdapter, Vehicle } from "@carscope/core";
import type { StoredPhoto } from "./images.ts";

export interface ResolvedVehicle {
  readonly vehicle: Vehicle;
  readonly created: boolean;
}

/**
 * What the collector needs from storage. The API owns the implementation, so
 * the collector never sees SQL and can be tested against an in-memory double.
 */
export interface CollectorStore {
  resolveVehicle(
    raw: RawListing,
    adapter: SourceAdapter,
    imageHash: string | null,
    market: Market,
  ): ResolvedVehicle;
  upsertListing(vehicleId: string, raw: RawListing, adapter: SourceAdapter, observedAt: string): void;
  recordPrice(snapshot: PriceSnapshot): void;
  markDelisted(
    sourceId: string,
    seenIds: readonly string[],
    observedAt: string,
    runStartedAt: string,
  ): number;
  savePhotos(vehicleId: string, photos: readonly StoredPhoto[]): void;
  setImageHash(vehicleId: string, hash: string | null): void;
  saveDetail(vehicleId: string, detail: Partial<RawListing>, at: string): void;
  needsDetail(vehicleId: string): boolean;
  recordRun(run: CollectionRun): void;
}

export interface LookupCache {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export interface PhotoFetcher {
  ensure(vehicleId: string, urls: readonly string[]): Promise<StoredPhoto[]>;
}

export const RUN_STATUS = {
  ok: "ok",
  blocked: "blocked",
  error: "error",
  skipped: "skipped",
} as const;
export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

export interface CollectionRun {
  readonly sourceId: string;
  readonly searchId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly fetched: number;
  readonly kept: number;
  readonly created: number;
  readonly merged: number;
  readonly delisted: number;
  readonly photos: number;
  /** Listings the portal returned that did not survive the post-filter. */
  readonly dropped: number;
  readonly status: RunStatus;
  /**
   * Whether the source was read to the end. A run stopped by the page limit or
   * the deadline saw part of what the portal offered, so it must not start the
   * clock that keeps the source from being asked again.
   */
  readonly complete: boolean;
  readonly note: string | null;
}

export interface SavedSearch {
  readonly id: string;
  readonly name: string;
  readonly criteria: Criteria;
}
