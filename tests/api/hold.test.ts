import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EMPTY_CRITERIA, type RawListing, type SourceAdapter } from "@carscope/core";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";
import { MarketService } from "../../apps/api/src/services/market.ts";

const NOW = "2026-08-10T12:00:00.000Z";
const LATER = "2026-08-11T12:00:00.000Z";
const adapter = (id: string): SourceAdapter =>
  ({ id, label: id, markets: ["DE"], minIntervalMs: 0 } as unknown as SourceAdapter);

function setup(t: { after: (fn: () => unknown) => void }) {
  const db: DatabaseSync = openDatabase(":memory:");
  t.after(() => db.close());
  const vehicles = new VehicleRepository(db);
  return { vehicles, market: new MarketService(vehicles) };
}

function store(
  vehicles: VehicleRepository,
  over: { id: string; title: string; price: number; description?: string; km?: number; at?: string },
) {
  const raw: RawListing = {
    sourceListingId: over.id, url: `https://www.kleinanzeigen.de/s-anzeige/x/${over.id}`,
    title: over.title, price: over.price, currency: "EUR", photoUrls: [],
    attributes: {
      make: "Nissan", model: "Skyline", market: "DE", mileageKm: over.km ?? 120_000,
      ...(over.description === undefined ? {} : { description: over.description }),
    },
  };
  const at = over.at ?? NOW;
  const { vehicle } = vehicles.resolve(raw, adapter("kleinanzeigen"), null, at, "DE");
  vehicles.upsertListing(vehicle.id, raw, adapter("kleinanzeigen"), at);
  vehicles.recordPrice({
    vehicleId: vehicle.id, observedAt: at, sourceId: "kleinanzeigen",
    amount: over.price, currency: "EUR", baseAmount: over.price, rate: 1,
  });
  return vehicle.id;
}

const listed = (v: VehicleRepository): number => v.search(EMPTY_CRITERIA, true).length;

test("a wanted ad is stored but kept out of lists, statistics and the feed", (t) => {
  const { vehicles, market } = setup(t);
  store(vehicles, { id: "1", title: "Nissan Skyline R34 GT-T", price: 30_000, km: 100_000 });
  const wanted = store(vehicles, {
    id: "2", title: "Nissan Skyline R34 GT-T", price: 45_000, km: 200_000,
    description: "Suche Nissan Skyline R34 GTT mit GTR Style Bodykit. Budget liegt bei 45.000 Euro",
  });

  assert.equal(listed(vehicles), 1);
  assert.equal(vehicles.since(EMPTY_CRITERIA, 0, 10).items.length, 1);
  assert.equal(market.report(EMPTY_CRITERIA).current.n, 1);
  assert.equal(market.report(EMPTY_CRITERIA).heldCount, 1);
  assert.deepEqual(vehicles.search(EMPTY_CRITERIA, true, true).map((r) => [r.id, r.held_reason]),
    [[wanted, "wanted"]]);
});

test("a car with a placeholder price is held until it reports a real one", (t) => {
  const { vehicles } = setup(t);
  const id = store(vehicles, { id: "1", title: "Nissan Skyline R34", price: 1 });
  assert.equal(listed(vehicles), 0, "held while the price is 1 euro");

  vehicles.recordPrice({
    vehicleId: id, observedAt: LATER, sourceId: "kleinanzeigen",
    amount: 38_000, currency: "EUR", baseAmount: 38_000, rate: 1,
  });
  assert.equal(listed(vehicles), 1, "released by the next real price");
});

test("a car whose text calls the price a placeholder is held although the price looks real", (t) => {
  const { vehicles } = setup(t);
  store(vehicles, {
    id: "1", title: "Nissan Skyline R34", price: 11_111,
    description: "PREIS IN DER ANZEIGE DIENT NUR ALS PLATZHALTER!!!",
  });
  assert.equal(listed(vehicles), 0);
});

test("releasing by hand overrules the rules for good", (t) => {
  const { vehicles } = setup(t);
  const id = store(vehicles, { id: "1", title: "Nissan Skyline R34", price: 1 });
  assert.equal(listed(vehicles), 0);

  assert.equal(vehicles.release(id, LATER), true);
  assert.equal(listed(vehicles), 1);
  assert.equal(vehicles.reassessAll(), 0, "a later sweep does not hold it again");
  assert.equal(vehicles.release("nope", LATER), false);
});

test("the detail text can hold a car that looked fine in the list", (t) => {
  const { vehicles } = setup(t);
  const id = store(vehicles, { id: "1", title: "Nissan Skyline R34", price: 30_000 });
  assert.equal(listed(vehicles), 1);

  vehicles.saveDetail(id, { description: "Suche Nissan Skyline R34, Budget 30.000" }, LATER);
  assert.equal(listed(vehicles), 0);
  assert.equal(vehicles.reassessAll(), 0, "the sweep agrees with the write");
});

test("a wanted ad does not become the home of a real car", (t) => {
  const { vehicles } = setup(t);
  const wanted = store(vehicles, {
    id: "1", title: "Nissan Skyline R34 GT-T", price: 25_000, km: 200_000,
    description: "ich suche nach einem Nissan Skyline R34 GT-T",
  });
  const real = store(vehicles, { id: "2", title: "Nissan Skyline R34 GT-T", price: 25_000, km: 200_000 });
  assert.notEqual(real, wanted);
  assert.equal(listed(vehicles), 1);
});
