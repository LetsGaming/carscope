import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SQL = readFileSync(
  new URL("../../apps/api/src/db/migrations/003_clean_city.sql", import.meta.url), "utf8",
);

test("the clean-city migration repairs stored cities and leaves good ones alone", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE vehicles (id INTEGER PRIMARY KEY, city TEXT)");
  const cities = [
    "Bönningstedt Heute,", "Velbert Heute,", "Köln Gestern,", "Ulm Vorgestern,",
    "Hückeswagen, Schloss-Stadt", "Rodenbach", "Steinebach (Sieg)", null,
  ];
  const insert = db.prepare("INSERT INTO vehicles (city) VALUES (?)");
  for (const city of cities) insert.run(city);

  db.exec(SQL);

  const after = db.prepare("SELECT city FROM vehicles ORDER BY id").all().map((r) => r["city"]);
  assert.deepEqual(after, [
    "Bönningstedt", "Velbert", "Köln", "Ulm", "Hückeswagen", "Rodenbach", "Steinebach (Sieg)", null,
  ]);
});
