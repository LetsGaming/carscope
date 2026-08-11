import { allRows, changed, type Db, type SqlRow } from "../db/index.ts";

interface SettingRow extends SqlRow { id: string; enabled: number }

export class SourceSettingsRepository {
  readonly #db: Db;
  readonly #defaults: ReadonlySet<string>;

  constructor(db: Db, defaults: readonly string[]) {
    this.#db = db;
    this.#defaults = new Set(defaults);
  }

  /** Stored settings win; anything never touched falls back to the configured default. */
  enabledIds(known: readonly string[]): Set<string> {
    const stored = new Map(
      allRows<SettingRow>(this.#db.prepare("SELECT id, enabled FROM source_settings"))
        .map((row) => [row.id, row.enabled === 1]),
    );
    return new Set(known.filter((id) => stored.get(id) ?? this.#defaults.has(id)));
  }

  setEnabled(id: string, enabled: boolean): void {
    this.#db.prepare(`
      INSERT INTO source_settings (id, enabled, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
    `).run(id, enabled ? 1 : 0, new Date().toISOString());
  }

  forget(id: string): boolean {
    return changed(this.#db.prepare("DELETE FROM source_settings WHERE id = ?").run(id)) > 0;
  }
}
