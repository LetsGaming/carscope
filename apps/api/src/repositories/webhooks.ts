import { randomUUID } from "node:crypto";
import { allRows, changed, getRow, type Db, type SqlRow } from "../db/index.ts";

export interface WebhookRow extends SqlRow {
  id: string; search_id: string; url: string; secret: string; enabled: number;
  created_at: string; notified_through: number;
  last_delivery_at: string | null; last_status: number | null; consecutive_failures: number;
}

const COLUMNS = `id, search_id, url, secret, enabled, created_at,
  notified_through, last_delivery_at, last_status, consecutive_failures`;

export class WebhookRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Enabled hooks for one search. An `adhoc-*` job id simply matches nothing here. */
  listEnabledFor(searchId: string): WebhookRow[] {
    return allRows<WebhookRow>(this.#db.prepare(
      `SELECT ${COLUMNS} FROM webhooks WHERE search_id = ? AND enabled = 1`,
    ), searchId);
  }

  list(): WebhookRow[] {
    return allRows<WebhookRow>(this.#db.prepare(`SELECT ${COLUMNS} FROM webhooks ORDER BY created_at`));
  }

  findById(id: string): WebhookRow | null {
    const row = getRow<WebhookRow>(this.#db.prepare(`SELECT ${COLUMNS} FROM webhooks WHERE id = ?`), id);
    return row ?? null;
  }

  insert(args: { searchId: string; url: string; secret: string }): WebhookRow {
    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO webhooks (id, search_id, url, secret, enabled, created_at, notified_through)
      VALUES (?,?,?,?,1,?,0)
    `).run(id, args.searchId, args.url, args.secret, new Date().toISOString());
    const row = this.findById(id);
    if (row === null) throw new Error(`webhook ${id} vanished mid-write`);
    return row;
  }

  remove(id: string): boolean {
    return changed(this.#db.prepare("DELETE FROM webhooks WHERE id = ?").run(id)) > 0;
  }

  /** Advanced only after a successful delivery; a failed one must not lose the gap. */
  advance(id: string, cursor: number, at: string): void {
    this.#db.prepare(`
      UPDATE webhooks SET notified_through = ?, last_delivery_at = ?, last_status = 200, consecutive_failures = 0
      WHERE id = ?
    `).run(cursor, at, id);
  }

  recordFailure(id: string, status: number | null, at: string, maxFailures: number): void {
    this.#db.prepare(`
      UPDATE webhooks SET last_delivery_at = ?, last_status = ?, consecutive_failures = consecutive_failures + 1
      WHERE id = ?
    `).run(at, status, id);
    const row = this.findById(id);
    // A dead endpoint would otherwise pin the cursor forever and grow every
    // future payload; past the limit it is disabled and stops being tried.
    if (row !== null && row.consecutive_failures >= maxFailures) this.disable(id);
  }

  disable(id: string): void {
    this.#db.prepare("UPDATE webhooks SET enabled = 0 WHERE id = ?").run(id);
  }
}
