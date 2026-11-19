import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EMPTY_CRITERIA, type RawListing, type SourceAdapter } from "@carscope/core";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";
import { SKYLINE, byId } from "./skyline-results.ts";
import { HELD_IDS, PROD, SAME_CAR, toRaws } from "./prod-skyline.ts";

const NOW = "2026-08-10T12:00:00.000Z";
const adapter = (id: string): SourceAdapter =>
  ({ id, label: id, markets: ["DE"], minIntervalMs: 0 } as unknown as SourceAdapter);

function repo(t: { after: (fn: () => unknown) => void }): VehicleRepository {
  const db: DatabaseSync = openDatabase(":memory:");
  t.after(() => db.close());
  return new VehicleRepository(db);
}

function store(vehicles: VehicleRepository, id: string, listing: RawListing = byId(id).listing) {
  const source = byId(id).source;
  const resolved = vehicles.resolve(listing, adapter(source), null, NOW, "DE");
  vehicles.upsertListing(resolved.vehicle.id, listing, adapter(source), NOW);
  vehicles.recordPrice({
    vehicleId: resolved.vehicle.id, observedAt: NOW, sourceId: source,
    amount: listing.price, currency: "EUR", baseAmount: listing.price, rate: 1,
  });
  return resolved;
}

const noGearbox = (id: string): RawListing => {
  const { listing } = byId(id);
  const { gearbox: _gearbox, ...attributes } = listing.attributes;
  return { ...listing, attributes };
};

test("the same car arriving from a second portal joins the first, with both links", (t) => {
  const vehicles = repo(t);
  const first = store(vehicles, "575913a6");
  const second = store(vehicles, "88bde6f7");

  assert.equal(second.created, false);
  assert.equal(second.vehicle.id, first.vehicle.id);
  const car = vehicles.findById(first.vehicle.id);
  assert.deepEqual(car?.listings.map((l) => l.sourceId).sort(), ["autouncle", "kleinanzeigen"]);
});

test("the search shows three cars: the Stagea is not a Skyline, the duplicate is folded", (t) => {
  const vehicles = repo(t);
  for (const s of SKYLINE) store(vehicles, s.id);

  const shown = vehicles.search({ ...EMPTY_CRITERIA, make: "Nissan", model: "Skyline R34" }, true);
  assert.equal(shown.length, 3);
  const velbert = shown.find((r) => r.mileage_km === 89_750);
  assert.deepEqual(velbert?.sources?.split(",").sort(), ["autouncle", "kleinanzeigen"]);
});

test("a duplicate stored before the gearbox was known is merged by consolidate", (t) => {
  const vehicles = repo(t);
  const first = store(vehicles, "575913a6");
  // The aggregator's card carried no gearbox, so the two did not meet.
  const second = store(vehicles, "88bde6f7", noGearbox("88bde6f7"));
  assert.equal(second.created, true);

  // The detail page then said "manual", which is what made them one car.
  vehicles.saveDetail(second.vehicle.id, { gearbox: "manual" }, NOW);
  assert.equal(vehicles.consolidate(), 1);

  assert.equal(vehicles.findById(second.vehicle.id), null, "the later row is gone");
  const car = vehicles.findById(first.vehicle.id);
  assert.deepEqual(car?.listings.map((l) => l.sourceId).sort(), ["autouncle", "kleinanzeigen"]);
  assert.equal(vehicles.priceHistory(first.vehicle.id).length, 2, "both portals' prices are kept");
  assert.equal(vehicles.consolidate(), 0, "nothing is left to merge");
});

test("consolidate leaves different cars alone", (t) => {
  const vehicles = repo(t);
  const ids = ["575913a6", "85c1cad9", "b48b8325"].map((id) => store(vehicles, id).vehicle.id);
  assert.equal(vehicles.consolidate(), 0);
  assert.equal(ids.every((id) => vehicles.findById(id) !== null), true);

  const twin = store(vehicles, "88bde6f7");
  assert.equal(twin.created, false, "it joins the Velbert car on arrival");
});

test("the prod snapshot ends as 13 listed cars, in whatever order the adverts arrive", (t) => {
  for (const order of [PROD, [...PROD].reverse()]) {
    const vehicles = repo(t);
    const vehicleOf = new Map<string, string>();
    let minute = 0;
    for (const row of order) {
      for (const raw of toRaws(row)) {
        // Each advert is seen a minute after the last, so "latest price" is defined.
        const at = new Date(Date.parse(NOW) + minute * 60_000).toISOString();
        minute += 1;
        const resolved = vehicles.resolve(raw, adapter("kleinanzeigen"), null, at, "DE");
        vehicles.upsertListing(resolved.vehicle.id, raw, adapter("kleinanzeigen"), at);
        vehicles.recordPrice({
          vehicleId: resolved.vehicle.id, observedAt: at, sourceId: "kleinanzeigen",
          amount: row.price, currency: "EUR", baseAmount: row.price, rate: 1,
        });
      }
    }
    vehicles.consolidate();
    for (const row of PROD) {
      const id = vehicles.search({ ...EMPTY_CRITERIA }, true, true).concat(vehicles.search(EMPTY_CRITERIA, true))
        .find((r) => (vehicles.findById(r.id)?.listings ?? []).some((l) => l.url.includes(`/${row.id}/`)))?.id;
      assert.ok(id !== undefined, row.id);
      vehicleOf.set(row.id, id);
    }

    assert.equal(vehicles.search(EMPTY_CRITERIA, true).length, PROD.length - HELD_IDS.length - SAME_CAR.length);
    assert.equal(vehicles.search(EMPTY_CRITERIA, true, true).length, HELD_IDS.length);
    for (const [a, b] of SAME_CAR) assert.equal(vehicleOf.get(a), vehicleOf.get(b), `${a} and ${b}`);
    assert.equal(new Set(vehicleOf.values()).size, PROD.length - SAME_CAR.length);
  }
});
