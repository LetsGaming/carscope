import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SQL = readFileSync(
  new URL("../../apps/api/src/db/migrations/006_clean_variant.sql", import.meta.url), "utf8",
);

test("the clean-variant migration removes the urgency note and nothing else", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE vehicles (id INTEGER PRIMARY KEY, variant TEXT)");
  const insert = db.prepare("INSERT INTO vehicles (variant) VALUES (?)");
  for (const v of ["R34 nur noch 2 Tage online", "nur noch 1 Tag online", "R34 GTT", null]) insert.run(v);

  db.exec(SQL);

  const after = db.prepare("SELECT variant FROM vehicles ORDER BY id").all().map((r) => r["variant"]);
  assert.deepEqual(after, ["R34", null, "R34 GTT", null]);
});
