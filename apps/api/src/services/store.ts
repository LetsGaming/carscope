import type { Market, PriceSnapshot, RawListing, SourceAdapter } from "@carscope/core";
import type { CollectionRun, CollectorStore, ResolvedVehicle, StoredPhoto } from "@carscope/collector";
import type { VehicleRepository } from "../repositories/vehicles.ts";
import type { RunRepository } from "../repositories/runs.ts";

/**
 * Binds the collector's storage port to the repositories. The collector depends
 * on the port, never on SQLite, so the whole pipeline is testable with a double.
 */
export class SqliteCollectorStore implements CollectorStore {
  readonly #vehicles: VehicleRepository;
  readonly #runs: RunRepository;
  readonly #now: () => Date;

  constructor(vehicles: VehicleRepository, runs: RunRepository, now: () => Date) {
    this.#vehicles = vehicles;
    this.#runs = runs;
    this.#now = now;
  }

  resolveVehicle(
    raw: RawListing,
    adapter: SourceAdapter,
    imageHash: string | null,
    market: Market,
  ): ResolvedVehicle {
    return this.#vehicles.resolve(raw, adapter, imageHash, this.#now().toISOString(), market);
  }

  upsertListing(vehicleId: string, raw: RawListing, adapter: SourceAdapter, observedAt: string): void {
    this.#vehicles.upsertListing(vehicleId, raw, adapter, observedAt);
  }

  recordPrice(snapshot: PriceSnapshot): void {
    this.#vehicles.recordPrice(snapshot);
  }

  markDelisted(
    sourceId: string,
    seenIds: readonly string[],
    observedAt: string,
    runStartedAt: string,
  ): number {
    return this.#vehicles.markDelisted(sourceId, seenIds, observedAt, runStartedAt);
  }

  needsDetail(vehicleId: string): boolean {
    return this.#vehicles.needsDetail(vehicleId);
  }

  saveDetail(vehicleId: string, detail: Partial<RawListing>, at: string): void {
    this.#vehicles.saveDetail(vehicleId, { ...detail.attributes }, at);
  }

  savePhotos(vehicleId: string, photos: readonly StoredPhoto[]): void {
    this.#vehicles.savePhotos(vehicleId, photos);
  }

  setImageHash(vehicleId: string, hash: string | null): void {
    this.#vehicles.setImageHash(vehicleId, hash);
  }

  recordRun(run: CollectionRun): void {
    this.#runs.record(run);
  }
}
