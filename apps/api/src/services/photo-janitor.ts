import { rm, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { photoDir } from "@carscope/collector";
import { allRows, type Db, type SqlRow } from "../db/index.ts";

interface DelistedRow extends SqlRow { id: string }

export interface PruneResult {
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly vehiclesPruned: number;
}

/**
 * Photos accumulate forever otherwise. Cars that are gone from the market are
 * pruned first, oldest delisting first: their price history is the part worth
 * keeping, and nobody browses a car that was sold two years ago.
 */
export class PhotoJanitor {
  readonly #db: Db;
  readonly #dataDir: string;
  readonly #budgetBytes: number;

  constructor(db: Db, dataDir: string, budgetMb: number) {
    this.#db = db;
    this.#dataDir = dataDir;
    this.#budgetBytes = budgetMb * 1_000_000;
  }

  async prune(): Promise<PruneResult> {
    const before = await directorySize(join(this.#dataDir, "photos"));
    if (before <= this.#budgetBytes) {
      return { bytesBefore: before, bytesAfter: before, vehiclesPruned: 0 };
    }

    const candidates = allRows<DelistedRow>(this.#db.prepare(`
      SELECT v.id FROM vehicles v
      WHERE v.delisted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM photos p WHERE p.vehicle_id = v.id AND p.local_path IS NOT NULL)
      ORDER BY v.delisted_at ASC
    `));

    const clear = this.#db.prepare("UPDATE photos SET local_path = NULL WHERE vehicle_id = ?");
    let freed = 0;
    let pruned = 0;

    for (const { id } of candidates) {
      if (before - freed <= this.#budgetBytes) break;
      const dir = join(this.#dataDir, photoDir(id));
      freed += await directorySize(dir);
      await rm(dir, { recursive: true, force: true });
      clear.run(id);
      pruned += 1;
    }

    return { bytesBefore: before, bytesAfter: before - freed, vehiclesPruned: pruned };
  }
}

async function directorySize(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null);
  if (entries === null) return 0;
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else total += (await stat(child).catch(() => null))?.size ?? 0;
  }
  return total;
}
