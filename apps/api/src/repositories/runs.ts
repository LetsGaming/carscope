import { RUN_STATUS, type CollectionRun, type RunStatus } from "@carscope/collector";
import { allRows, getRow, type Db, type SqlRow } from "../db/index.ts";

export interface SourceHealth {
  readonly sourceId: string;
  readonly status: RunStatus;
  readonly finishedAt: string | null;
  readonly fetched: number;
  readonly created: number;
  readonly note: string | null;
  readonly consecutiveFailures: number;
}

interface RunRow extends SqlRow {
  source_id: string; status: string; finished_at: string;
  fetched: number; created: number; note: string | null;
}

interface LastRunRow extends SqlRow { finished_at: string }
interface StatusRow extends SqlRow { status: string }
interface CountRow extends SqlRow { n: number }

/** How far back a health check looks for an unbroken run of failures. */
const FAILURE_STREAK_WINDOW = 20;

const RUN_STATUSES = new Set<string>(Object.values(RUN_STATUS));

/** A status column written by an older build still has to resolve to something. */
const toRunStatus = (value: string): RunStatus =>
  RUN_STATUSES.has(value) ? (value as RunStatus) : RUN_STATUS.error;

export class RunRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  record(run: CollectionRun): void {
    this.#db.prepare(`
      INSERT INTO runs (source_id, search_id, started_at, finished_at, fetched, kept, created, merged, delisted, status, complete, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      run.sourceId, run.searchId, run.startedAt, run.finishedAt,
      run.fetched, run.kept, run.created, run.merged, run.delisted, run.status,
      run.complete ? 1 : 0, run.note,
    );
  }

  /**
   * When the source last answered in full. A run stopped by its page limit or
   * its deadline saw part of what the portal offered, so it does not count:
   * otherwise a source that read one page of three was not asked again for six
   * hours, and every search in between answered from a database that held part
   * of the portal.
   */
  lastRunAt(sourceId: string, searchId: string): string | null {
    const row = getRow<LastRunRow>(this.#db.prepare(`
      SELECT finished_at FROM runs
      WHERE source_id = ? AND search_id = ? AND complete = 1
      ORDER BY finished_at DESC LIMIT 1
    `), sourceId, searchId);
    return row?.finished_at ?? null;
  }

  /** When the source was last asked at all, complete or not. */
  lastAttemptAt(sourceId: string, searchId: string): string | null {
    const row = getRow<LastRunRow>(this.#db.prepare(
      "SELECT finished_at FROM runs WHERE source_id = ? AND search_id = ? ORDER BY finished_at DESC LIMIT 1",
    ), sourceId, searchId);
    return row?.finished_at ?? null;
  }

  /**
   * Consecutive incomplete runs since the last complete one. A source that is
   * blocked would otherwise be retried by every search, which is more traffic at
   * a portal that has already refused us.
   */
  failuresSince(sourceId: string, searchId: string): number {
    const row = getRow<CountRow>(this.#db.prepare(`
      SELECT COUNT(*) AS n FROM runs
      WHERE source_id = ? AND search_id = ? AND complete = 0
        AND finished_at > COALESCE(
          (SELECT MAX(finished_at) FROM runs
           WHERE source_id = ? AND search_id = ? AND complete = 1), '')
    `), sourceId, searchId, sourceId, searchId);
    return row?.n ?? 0;
  }

  health(): SourceHealth[] {
    const latest = allRows<RunRow>(this.#db.prepare(`
      SELECT r.source_id, r.status, r.finished_at, r.fetched, r.created, r.note
      FROM runs r
      JOIN (SELECT source_id, MAX(finished_at) AS m FROM runs GROUP BY source_id) t
        ON t.source_id = r.source_id AND t.m = r.finished_at
    `));

    return latest.map((row) => ({
      sourceId: row.source_id,
      status: toRunStatus(row.status),
      finishedAt: row.finished_at,
      fetched: row.fetched,
      created: row.created,
      note: row.note,
      consecutiveFailures: this.#consecutiveFailures(row.source_id),
    }));
  }

  #consecutiveFailures(sourceId: string): number {
    const rows = allRows<StatusRow>(this.#db.prepare(
      "SELECT status FROM runs WHERE source_id = ? ORDER BY finished_at DESC LIMIT ?",
    ), sourceId, FAILURE_STREAK_WINDOW);
    let n = 0;
    for (const r of rows) {
      if (r.status === RUN_STATUS.ok) break;
      n += 1;
    }
    return n;
  }
}
