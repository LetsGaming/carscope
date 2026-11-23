import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EMPTY_CRITERIA, type RawListing, type SourceAdapter } from "@carscope/core";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";
import { MarketService } from "../../apps/api/src/services/market.ts";

const DAY = 86_400_000;
const START = Date.parse("2026-09-01T10:00:00.000Z");
const adapter = (id: string): SourceAdapter =>
  ({ id, label: id, markets: ["DE"], minIntervalMs: 0 } as unknown as SourceAdapter);

function setup(t: { after: (fn: () => unknown) => void }) {
  const db: DatabaseSync = openDatabase(":memory:");
  t.after(() => db.close());
  const vehicles = new VehicleRepository(db);
  return { db, vehicles, market: new MarketService(vehicles) };
}

function see(vehicles: VehicleRepository, id: string, km: number, price: number, atMs: number): string {
  const at = new Date(atMs).toISOString();
  const raw: RawListing = {
    sourceListingId: id, url: `https://www.autoscout24.de/angebote/${id}`, title: "Nissan Skyline R34 GTT",
    price, currency: "EUR", photoUrls: [],
    attributes: { make: "Nissan", model: "Skyline", market: "DE", mileageKm: km, city: `Stadt${id}` },
  };
  const { vehicle } = vehicles.resolve(raw, adapter("autoscout24"), null, at, "DE");
  vehicles.upsertListing(vehicle.id, raw, adapter("autoscout24"), at);
  vehicles.recordPrice({
    vehicleId: vehicle.id, observedAt: at, sourceId: "autoscout24",
    amount: price, currency: "EUR", baseAmount: price, rate: 1,
  });
  return vehicle.id;
}

test("a price seen every few hours is stored as its first sighting and its last", (t) => {
  const { vehicles } = setup(t);
  let id = "";
  for (let i = 0; i < 100; i += 1) id = see(vehicles, "a", 100_000, 30_000, START + i * 3 * 3_600_000);

  const history = vehicles.priceHistory(id);
  assert.equal(history.length, 2);
  assert.equal(history[0]?.observedAt, new Date(START).toISOString(), "when the price was first seen");
  assert.equal(history[1]?.observedAt, new Date(START + 99 * 3 * 3_600_000).toISOString(), "when last confirmed");
});

test("every price change is kept, with the run of the old price closed", (t) => {
  const { vehicles } = setup(t);
  let id = "";
  for (let i = 0; i < 10; i += 1) id = see(vehicles, "a", 100_000, 30_000, START + i * DAY);
  for (let i = 10; i < 20; i += 1) id = see(vehicles, "a", 100_000, 28_000, START + i * DAY);
  id = see(vehicles, "a", 100_000, 30_000, START + 20 * DAY);

  assert.deepEqual(vehicles.priceHistory(id).map((p) => p.baseAmount), [30_000, 30_000, 28_000, 28_000, 30_000]);
});

test("a long-lived car does not outweigh short-lived ones in the monthly history", (t) => {
  const { vehicles, market } = setup(t);
  // One car at 25000 seen every 3 hours for 40 days; three cars at 40000 seen for a day each.
  for (let i = 0; i < 320; i += 1) see(vehicles, "long", 150_000, 25_000, START + i * 3 * 3_600_000);
  for (const [id, km] of [["b", 90_000], ["c", 95_000], ["d", 99_000]] as const) {
    see(vehicles, id, km, 40_000, START + 10 * DAY);
    see(vehicles, id, km, 40_000, START + 10 * DAY + 3_600_000);
  }

  const report = market.report(EMPTY_CRITERIA, 24);
  const september = report.series.find((p) => p.month === "2026-09");

  assert.equal(report.observationCount, 4, "four cars, not hundreds of sightings");
  assert.equal(september?.n, 4);
  assert.equal(Math.round(september?.p50 ?? 0), 40_000);
  assert.equal(report.confidence, 1, "four cars earn the lowest rating, not five stars");
});
