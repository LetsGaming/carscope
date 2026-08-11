import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  BODY, CURRENCY, EMPTY_CRITERIA, FUEL, GEARBOX, MARKET, MARKETS, SELLER,
} from "@carscope/core";
import { build } from "../../apps/api/src/app.ts";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { readCriteria } from "../../apps/api/src/repositories/criteria-json.ts";
import { toVehicle, type VehicleRow } from "../../apps/api/src/repositories/rows.ts";
import { CriteriaSchema } from "../../apps/api/src/schemas.ts";

/** Reads the `enum` a TypeBox string-enum carries, without asserting its shape. */
function enumValues(schema: unknown): string[] {
  if (typeof schema !== "object" || schema === null || !("enum" in schema)) return [];
  const values: unknown = schema.enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === "string") : [];
}

const config = loadConfig({
  DATABASE_FILE: ":memory:", LOG_LEVEL: "silent",
  COLLECT_ENABLED_SOURCES: "mock", COLLECT_STORE_PHOTOS: "false",
});

test("a query value outside the domain is dropped, not passed to the filter", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  // Asserting the query string into its union let `fuel=petrol'--` reach the
  // column comparison. Anything that is not a member now reads as unset.
  const res = await app.inject({
    url: "/api/vehicles?fuel=petrol'--&gearbox=stick&bodyStyle=spaceship&markets=DE,XX,ZZ",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), []);
});

test("the request schema offers exactly the domain's countries", () => {
  // The UI and the schema both used to carry their own shortened list, so a
  // country the collector supported could never be asked for.
  assert.deepEqual(enumValues(CriteriaSchema.properties.markets.items), [...MARKETS]);
  assert.ok(MARKETS.includes(MARKET.pl), "Poland is a supported market");
});

test("stored criteria are read field by field, not spread in wholesale", () => {
  const stored = JSON.stringify({
    ...EMPTY_CRITERIA,
    text: "Skyline",
    fuel: "plutonium",
    gearbox: GEARBOX.manual,
    markets: [MARKET.de, "XX"],
    radiusKm: "200",
    excludeDamaged: "yes",
  });

  const criteria = readCriteria(stored);
  assert.ok(criteria !== null);
  assert.equal(criteria.text, "Skyline");
  assert.equal(criteria.gearbox, GEARBOX.manual, "a valid value survives");
  assert.equal(criteria.fuel, null, "a retired or bogus value is dropped");
  assert.deepEqual([...criteria.markets], [MARKET.de], "an unknown country is dropped");
  assert.equal(criteria.radiusKm, null, "a string where a number belongs is not trusted");
  assert.equal(criteria.excludeDamaged, false, "only a real boolean enables the filter");
});

test("criteria read from storage get four independent ranges", () => {
  // The reader builds a range per field. Returning one shared object would put
  // the client straight back into filling every range from one input.
  const criteria = readCriteria(JSON.stringify({
    ...EMPTY_CRITERIA,
    priceEur: { min: 10_000, max: 40_000 },
    registrationYear: { min: 1998, max: 2002 },
  }));
  assert.ok(criteria !== null);

  assert.deepEqual(criteria.priceEur, { min: 10_000, max: 40_000 });
  assert.deepEqual(criteria.mileageKm, { min: null, max: null });
  assert.notEqual(criteria.priceEur, criteria.mileageKm);
  assert.notEqual(criteria.mileageKm, criteria.powerPs);
  assert.notEqual(criteria.mileageKm, EMPTY_CRITERIA.mileageKm);
});

test("unreadable stored criteria fall back rather than throwing", () => {
  assert.equal(readCriteria("{not json"), null);
  assert.equal(readCriteria("[]"), null);
});

test("a row written by an older build still maps to a domain vehicle", () => {
  const row = {
    id: "v1", make: "Nissan", model: "Skyline", variant: null,
    body_style: "spaceship", first_registration: "1999-05", mileage_km: 90_000,
    power_w: 206_000, fuel: "plutonium", gearbox: GEARBOX.manual,
    seller_type: SELLER.private, seller_name: null, market: "XX",
    postal_code: null, city: null, damaged: null, identity_key: "k",
    image_hash: null, description: null, detail_fetched_at: null,
    first_listed_at: null, first_seen_at: "2026-01-01T00:00:00Z",
    last_seen_at: "2026-01-01T00:00:00Z", delisted_at: null,
  } satisfies VehicleRow;

  const vehicle = toVehicle(row);
  assert.equal(vehicle.bodyStyle, null, "a value the domain no longer knows reads as unset");
  assert.equal(vehicle.fuel, null);
  assert.equal(vehicle.gearbox, GEARBOX.manual);
  assert.equal(vehicle.market, MARKET.de, "an unmappable country falls back to the home market");
});

test("the domain vocabulary is one list, shared by schema and reader", () => {
  // Each of these used to exist as a separate literal list in three files.
  assert.equal(BODY.coupe, "coupe");
  assert.equal(FUEL.petrol, "petrol");
  assert.equal(CURRENCY.eur, "EUR");
  assert.deepEqual(enumValues(CriteriaSchema.properties.fuel.anyOf[0]), Object.values(FUEL));
});

test("an applied migration that changed refuses to open the database", (t) => {
  // Editing an applied migration leaves existing databases on the old schema
  // while a fresh one gets the new schema, and nothing says so until they differ.
  const file = join(mkdtempSync(join(tmpdir(), "carscope-")), "db.sqlite");
  t.after(() => rmSync(dirname(file), { recursive: true, force: true }));

  openDatabase(file).close();

  const tampered = new DatabaseSync(file);
  tampered.exec("UPDATE schema_migrations SET checksum = 'edited-after-it-was-applied'");
  tampered.close();

  assert.throws(() => openDatabase(file), /changed after it was applied/);
});
