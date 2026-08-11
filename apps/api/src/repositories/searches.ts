import { randomUUID } from "node:crypto";
import { EMPTY_CRITERIA, type Criteria } from "@carscope/core";
import type { SavedSearch } from "@carscope/collector";
import { allRows, changed, getRow, type Db, type SqlRow } from "../db/index.ts";
import { readCriteria } from "./criteria-json.ts";

interface SearchRow extends SqlRow {
  id: string;
  name: string;
  criteria: string;
}

const COLUMNS = "id, name, criteria";

export class SearchRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  list(): SavedSearch[] {
    return allRows<SearchRow>(
      this.#db.prepare(`SELECT ${COLUMNS} FROM searches ORDER BY name`),
    ).map(toSearch);
  }

  findById(id: string): SavedSearch | null {
    const row = getRow<SearchRow>(
      this.#db.prepare(`SELECT ${COLUMNS} FROM searches WHERE id = ?`),
      id,
    );
    return row === undefined ? null : toSearch(row);
  }

  create(name: string, criteria: Criteria): SavedSearch {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db.prepare(
      "INSERT INTO searches (id, name, criteria, created_at, updated_at) VALUES (?,?,?,?,?)",
    ).run(id, name, JSON.stringify(criteria), now, now);
    return { id, name, criteria };
  }

  update(id: string, name: string, criteria: Criteria): SavedSearch | null {
    const rows = changed(this.#db.prepare(
      "UPDATE searches SET name = ?, criteria = ?, updated_at = ? WHERE id = ?",
    ).run(name, JSON.stringify(criteria), new Date().toISOString(), id));
    return rows === 0 ? null : { id, name, criteria };
  }

  remove(id: string): boolean {
    return changed(this.#db.prepare("DELETE FROM searches WHERE id = ?").run(id)) > 0;
  }
}

function toSearch(row: SearchRow): SavedSearch {
  return { id: row.id, name: row.name, criteria: readCriteria(row.criteria) ?? EMPTY_CRITERIA };
}
