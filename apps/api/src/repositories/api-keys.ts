import { randomUUID } from "node:crypto";
import { HOUR_MS } from "@carscope/core";
import { allRows, changed, getRow, type Db, type SqlRow } from "../db/index.ts";

export interface ApiKeyRow extends SqlRow {
  id: string; prefix: string; token_hash: string; label: string; scopes: string;
  created_at: string; expires_at: string | null; revoked_at: string | null;
  last_used_at: string | null;
}

const COLUMNS = "id, prefix, token_hash, label, scopes, created_at, expires_at, revoked_at, last_used_at";

/** last_used_at is coarsened to this resolution; see the migration's comment on why. */
const LAST_USED_RESOLUTION_MS = HOUR_MS;

export class ApiKeyRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  findByHash(tokenHash: string): ApiKeyRow | null {
    const row = getRow<ApiKeyRow>(
      this.#db.prepare(`SELECT ${COLUMNS} FROM api_keys WHERE token_hash = ?`),
      tokenHash,
    );
    return row ?? null;
  }

  list(): ApiKeyRow[] {
    return allRows<ApiKeyRow>(this.#db.prepare(`SELECT ${COLUMNS} FROM api_keys ORDER BY created_at`));
  }

  insert(args: {
    prefix: string; tokenHash: string; label: string; scopes: string; expiresAt: string | null;
  }): ApiKeyRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db.prepare(`
      INSERT INTO api_keys (id, prefix, token_hash, label, scopes, created_at, expires_at, revoked_at, last_used_at)
      VALUES (?,?,?,?,?,?,?,NULL,NULL)
    `).run(id, args.prefix, args.tokenHash, args.label, args.scopes, now, args.expiresAt);
    const row = this.findByHash(args.tokenHash);
    if (row === null) throw new Error(`api key ${id} vanished mid-write`);
    return row;
  }

  /** Found and revoked are different questions; both return false here, not a thrown error. */
  revoke(prefix: string): boolean {
    return changed(this.#db.prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE prefix = ? AND revoked_at IS NULL",
    ).run(new Date().toISOString(), prefix)) > 0;
  }

  /**
   * Only on a successful check, and only once the stored value is stale enough
   * to be worth a write — see the migration comment on `last_used_at`.
   */
  touch(id: string, now: Date): void {
    const row = getRow<{ last_used_at: string | null } & SqlRow>(
      this.#db.prepare("SELECT last_used_at FROM api_keys WHERE id = ?"),
      id,
    );
    const stale = row?.last_used_at === null || row?.last_used_at === undefined
      || now.getTime() - Date.parse(row.last_used_at) >= LAST_USED_RESOLUTION_MS;
    if (!stale) return;
    this.#db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now.toISOString(), id);
  }
}
