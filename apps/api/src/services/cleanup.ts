import { readdirSync } from "node:fs";
import { join, posix } from "node:path";
import { DEFAULT_WINDOW_MONTHS, monthlySeries } from "@carscope/core";
import { photoDir } from "@carscope/collector";
import type { SearchRepository } from "../repositories/searches.ts";
import type { VehicleRepository } from "../repositories/vehicles.ts";
import type { MarketService } from "./market.ts";

interface AdvertKey {
  readonly sourceId: string;
  readonly listingId: string;
}

export interface Repair {
  readonly advert: AdvertKey;
  readonly into: AdvertKey;
  readonly amount: number;
  readonly why: string;
}

/**
 * Adverts a merge once put on the wrong car, found by reading the database. Each
 * names both adverts, so running it twice, or on a database where the advert
 * already sits right, changes nothing.
 */
export const KNOWN_REPAIRS: readonly Repair[] = [{
  advert: { sourceId: "autouncle", listingId: "229720598" },
  into: { sourceId: "kleinanzeigen", listingId: "3562811585" },
  amount: 40_000,
  why: "AutoUncle card 'Nissan Skyline Nismo 280 PS' (1999, 40000 EUR) joined the Rodenbach car; it is the Magdeburg car",
}];

export interface MarketLine {
  readonly search: string;
  readonly activeCars: number;
  readonly medianNow: number;
  readonly carsInHistory: number;
  readonly confidence: number;
  readonly months: readonly { month: string; byCar: number; carsThatMonth: number; bySighting: number }[];
}

type Counts = ReturnType<VehicleRepository["counts"]>;

export interface CleanupReport {
  readonly before: Counts;
  readonly after: Counts;
  readonly holdChanges: number;
  readonly repairs: readonly { why: string; moved: boolean }[];
  readonly merged: number;
  /** Null when no photo directory was given. */
  readonly photosRelinked: number | null;
  readonly snapshotsDeleted: number;
  readonly marketBefore: readonly MarketLine[];
  readonly marketAfter: readonly MarketLine[];
}

export interface CleanupDeps {
  readonly vehicles: VehicleRepository;
  readonly searches: SearchRepository;
  readonly market: MarketService;
  /** The data directory that holds `photos/`, or null to leave photo links alone. */
  readonly dataDir: string | null;
}

/**
 * Brings a database in line with the current rules: holds, known wrong merges,
 * duplicates, photo links and snapshot volume. The order matters: a wrong advert
 * has to leave its car before duplicates merge, or the merge carries it along.
 */
export function runCleanup(deps: CleanupDeps): CleanupReport {
  const { vehicles } = deps;
  const before = vehicles.counts();
  const marketBefore = marketLines(deps);

  const holdChanges = vehicles.reassessAll();
  const repairs = KNOWN_REPAIRS.map((r) => ({
    why: r.why,
    moved: vehicles.moveListing(r.advert, r.into, r.amount),
  }));
  const merged = vehicles.consolidate();
  const photosRelinked = deps.dataDir === null ? null : relinkFromDisk(vehicles, deps.dataDir);
  const snapshotsDeleted = vehicles.compactSnapshots();

  return {
    before, after: vehicles.counts(), holdChanges, repairs, merged,
    photosRelinked, snapshotsDeleted, marketBefore, marketAfter: marketLines(deps),
  };
}

function relinkFromDisk(vehicles: VehicleRepository, dataDir: string): number {
  let linked = 0;
  for (const id of vehicles.vehicleIds()) {
    const dir = photoDir(id);
    let names: string[];
    try {
      names = readdirSync(join(dataDir, dir));
    } catch {
      continue;
    }
    const files = new Map<number, string>();
    for (const name of names) {
      const match = /^(\d+)\.(?:png|jpg|webp)$/.exec(name);
      if (match !== null) files.set(Number(match[1]), posix.join(dir, name));
    }
    linked += vehicles.relinkPhotos(id, files);
  }
  return linked;
}

function marketLines(deps: CleanupDeps): MarketLine[] {
  const since = new Date();
  since.setMonth(since.getMonth() - DEFAULT_WINDOW_MONTHS);
  return deps.searches.list().map((search) => {
    const report = deps.market.report(search.criteria);
    const sighting = new Map(
      monthlySeries(deps.vehicles.sightings(search.criteria, since.toISOString())).map((p) => [p.month, p.p50]),
    );
    return {
      search: search.name,
      activeCars: report.activeCount,
      medianNow: Math.round(report.current.p50),
      carsInHistory: report.observationCount,
      confidence: report.confidence,
      months: report.series.map((p) => ({
        month: p.month, byCar: Math.round(p.p50), carsThatMonth: p.n, bySighting: Math.round(sighting.get(p.month) ?? 0),
      })),
    };
  });
}
