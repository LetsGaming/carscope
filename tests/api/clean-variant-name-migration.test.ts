import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SQL = readFileSync(
  new URL("../../apps/api/src/db/migrations/007_clean_variant_name.sql", import.meta.url), "utf8",
);

test("the migration takes the car's own name out of a stored variant", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE vehicles (id INTEGER PRIMARY KEY, make TEXT, model TEXT, variant TEXT)");
  const insert = db.prepare("INSERT INTO vehicles (make, model, variant) VALUES ('Nissan', 'Skyline', ?)");
  for (const v of [
    "Nissan Skyline R34 GTT", "Skyline R34 GTT", "Nissan GT-T", "R34 GTT", "Nissan Skyline",
    "skyline", "Nissan Skylines", null,
  ]) insert.run(v);

  db.exec(SQL);

  const after = db.prepare("SELECT variant FROM vehicles ORDER BY id").all().map((r) => r["variant"]);
  assert.deepEqual(after, ["R34 GTT", "R34 GTT", "GT-T", "R34 GTT", null, null, "Skylines", null]);
});
