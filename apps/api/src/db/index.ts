import { DatabaseSync, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;
export type Statement = StatementSync;

/**
 * Every row type in `repositories/rows.ts` extends this. It states what a SQL
 * result actually is — a map of column names to SQLite values — so narrowing a
 * driver result to a declared row shape needs no unsafe conversion.
 */
export type SqlRow = Record<string, SQLOutputValue>;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
] as const;

export function openDatabase(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  for (const pragma of PRAGMAS) db.exec(pragma);
  migrate(db);
  return db;
}

/** node:sqlite has no transaction helper, so wrap one rather than repeating BEGIN/COMMIT. */
export function transaction<T>(db: Db, work: () => T): T {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** `changes` and `lastInsertRowid` come back as number | bigint depending on magnitude. */
export const changed = (result: { changes: number | bigint }): number => Number(result.changes);

/**
 * The driver types every result as `SqlRow`, and every read narrows it to the
 * row shape the query's own column list produces. That narrowing is unavoidable
 * — SQL shapes are not knowable to the compiler — so it happens here, in two
 * readers, instead of at each of the twenty-odd call sites it used to.
 *
 * The row interfaces in `repositories/rows.ts` extend `SqlRow`, so a shape that
 * is not a possible SQL result will not compile, and the mapper it feeds is
 * still what turns a row into a domain type.
 */
export const allRows = <T extends SqlRow>(
  statement: Statement,
  ...params: readonly (string | number | null)[]
): T[] => statement.all(...params) as T[];

export const getRow = <T extends SqlRow>(
  statement: Statement,
  ...params: readonly (string | number | null)[]
): T | undefined => statement.get(...params) as T | undefined;

interface MigrationRow extends SqlRow {
  name: string;
  checksum: string;
}

const checksumOf = (sql: string): string => createHash("sha256").update(sql).digest("hex");

/**
 * Applied migrations are immutable. Recording a checksum and refusing to boot
 * when one changes is what makes that true in practice: editing an applied file
 * otherwise leaves every existing database on the old schema while a fresh one
 * gets the new schema, and nothing says so until they disagree at runtime.
 */
function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `);

  const applied = new Map(
    allRows<MigrationRow>(db.prepare("SELECT name, checksum FROM schema_migrations"))
      .map((row) => [row.name, row.checksum]),
  );
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const record = db.prepare(
    "INSERT INTO schema_migrations (name, applied_at, checksum) VALUES (?, ?, ?)",
  );

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = checksumOf(sql);
    const recorded = applied.get(file);

    if (recorded !== undefined) {
      if (recorded !== checksum) {
        throw new Error(
          `migration ${file} changed after it was applied; add a new migration instead of editing it`,
        );
      }
      continue;
    }

    transaction(db, () => {
      db.exec(sql);
      record.run(file, new Date().toISOString(), checksum);
    });
  }
}
