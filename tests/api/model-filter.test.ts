import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  EMPTY_CRITERIA, modelAgrees, modelTerms, type Criteria, type SourceAdapter,
} from "@carscope/core";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";
import { applyUnsupported } from "../../packages/collector/src/filter.ts";
import { autoScout24 } from "../../packages/collector/src/adapters/autoscout24.ts";
import { kleinanzeigen } from "../../packages/collector/src/adapters/kleinanzeigen.ts";
import { SKYLINE, byId } from "./skyline-results.ts";

const NOW = "2026-08-10T12:00:00.000Z";
const STAGEA = "5488e3de";
const R34 = ["575913a6", "85c1cad9", "b48b8325", "88bde6f7"];

const SEARCH: Criteria = { ...EMPTY_CRITERIA, make: "Nissan", model: "Skyline R34" };

const adapter = (id: string): SourceAdapter =>
  ({ id, label: id, markets: ["DE"], minIntervalMs: 0 } as unknown as SourceAdapter);

test("a model field naming another model does not agree, an alias does", () => {
  const terms = modelTerms("Skyline R34");
  assert.equal(modelAgrees("Skyline", terms), true);
  assert.equal(modelAgrees("Stagea", terms), false);
  assert.equal(modelAgrees(null, terms), true, "a missing model decides nothing");
  assert.equal(modelAgrees("Skyline", modelTerms("R34")), true, "a chassis code finds the Skyline");
  assert.equal(modelAgrees("Golf", modelTerms("Golf GTI")), true);
});

test("the collector drops the Stagea and keeps the four R34s", () => {
  for (const portal of [autoScout24, kleinanzeigen]) {
    const { kept, dropped } = applyUnsupported(portal, SEARCH, SKYLINE.map((s) => s.listing));
    assert.deepEqual(
      kept.map((l) => l.sourceListingId.slice(0, 8)).sort(),
      [...R34].sort(),
      portal.id,
    );
    assert.equal(dropped.length, 1);
    assert.match(dropped[0]?.found ?? "", /Stagea/);
  }
});

test("a portal without a model field is judged by the word after the make", () => {
  const stagea = byId(STAGEA).listing;
  const { attributes: { model: _model, ...rest }, ...bare } = stagea;
  const { kept } = applyUnsupported(kleinanzeigen, SEARCH, [{ ...bare, attributes: rest }]);
  assert.equal(kept.length, 0, "the title says Skyline, but the model after the make is Stagea");
});

test("a stored Stagea is not returned for a Skyline search", (t) => {
  const db: DatabaseSync = openDatabase(":memory:");
  t.after(() => db.close());
  const vehicles = new VehicleRepository(db);

  for (const s of SKYLINE) {
    const source = adapter(s.source);
    const { vehicle } = vehicles.resolve(s.listing, source, null, NOW, "DE");
    vehicles.upsertListing(vehicle.id, s.listing, source, NOW);
    vehicles.recordPrice({
      vehicleId: vehicle.id, observedAt: NOW, sourceId: s.source,
      amount: s.listing.price, currency: "EUR", baseAmount: s.listing.price, rate: 1,
    });
  }

  const models = (c: Criteria): string[] =>
    vehicles.search(c, true).map((r) => r.model).sort();

  assert.deepEqual(models(SEARCH).includes("Stagea"), false);
  assert.equal(models(SEARCH).length, R34.length - 1, "four adverts, one of them the same car as another");
  assert.equal(models({ ...EMPTY_CRITERIA, make: "Nissan", model: "R34" }).includes("Stagea"), false);
  assert.equal(models({ ...EMPTY_CRITERIA, text: "Skyline" }).includes("Stagea"), true,
    "without a searched model nothing is checked against the model field");
});
