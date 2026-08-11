import { DAY_MS } from "@carscope/core";
import type { LookupCache } from "@carscope/collector";
import { getRow, type Db, type SqlRow } from "../db/index.ts";

interface LookupRow extends SqlRow { value: string | null; updated_at: string }

const MAX_AGE_DAYS = 30;

/** A negative result is cached too, so an unresolvable model is asked about once. */
export class LookupRepository implements LookupCache {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(key: string): string | null {
    const row = getRow<LookupRow>(this.#db.prepare(
      "SELECT value, updated_at FROM lookup_cache WHERE key = ?",
    ), key);
    if (row === undefined) return null;

    const ageDays = (Date.now() - Date.parse(row.updated_at)) / DAY_MS;
    return ageDays > MAX_AGE_DAYS ? null : row.value;
  }

  set(key: string, value: string | null): void {
    this.#db.prepare(`
      INSERT INTO lookup_cache (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }
}
