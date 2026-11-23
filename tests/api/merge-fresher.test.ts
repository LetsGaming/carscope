import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { RawListing, SourceAdapter } from "@carscope/core";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";

const OLD = "2026-08-18T21:09:00.000Z";
const LATER = "2026-10-01T12:00:00.000Z";
const adapter = (id: string): SourceAdapter =>
  ({ id, label: id, markets: ["DE"], minIntervalMs: 0 } as unknown as SourceAdapter);

function repo(t: { after: (fn: () => unknown) => void }): VehicleRepository {
  const db: DatabaseSync = openDatabase(":memory:");
  t.after(() => db.close());
  return new VehicleRepository(db);
}

/** Two adverts of one car, stored as two vehicles the way they were before a rule joined them. */
function twoAdverts(vehicles: VehicleRepository) {
  const make = (id: string, over: Partial<RawListing["attributes"]>, price: number, at: string) => {
    const raw: RawListing = {
      sourceListingId: id, url: `https://www.autoscout24.de/angebote/${id}`, title: "Nissan Skyline R34 GT-T",
      price, currency: "EUR", photoUrls: [],
      attributes: { make: "Nissan", model: "Skyline", market: "DE", postalCode: "42499", ...over },
    };
    const { vehicle } = vehicles.resolve(raw, adapter("autoscout24"), null, at, "DE");
    vehicles.upsertListing(vehicle.id, raw, adapter("autoscout24"), at);
    vehicles.recordPrice({
      vehicleId: vehicle.id, observedAt: at, sourceId: "autoscout24",
      amount: price, currency: "EUR", baseAmount: price, rate: 1,
    });
    return vehicle.id;
  };
  // Two cities, so the arrival rules keep them apart.
  const older = make("old", { mileageKm: 169_800, firstRegistration: "1998-06", city: "Aaa" }, 26_990, OLD);
  const live = make("new", { mileageKm: 178_000, firstRegistration: "1999-03", city: "Bbb", postalCode: "11111" },
    24_490, LATER);
  return { older, live };
}

test("after a merge the live advert's facts win, the lower rowid survives", (t) => {
  const vehicles = repo(t);
  const { older, live } = twoAdverts(vehicles);
  assert.notEqual(older, live);
  vehicles.markDelisted("autoscout24", ["new"], LATER, LATER);

  vehicles.mergeInto(older, live);

  const car = vehicles.findById(older);
  assert.ok(car);
  assert.equal(vehicles.findById(live), null);
  assert.equal(car.mileageKm, 178_000, "the odometer of the live advert");
  assert.equal(car.firstRegistration, "1999-03");
  assert.equal(car.city, "Bbb");
  assert.deepEqual(car.listings.map((l) => l.sourceId), ["autoscout24", "autoscout24"]);
});

test("a precise registration beats a bare year whichever advert is fresher", (t) => {
  const vehicles = repo(t);
  const { older, live } = twoAdverts(vehicles);
  vehicles.saveDetail(older, { firstRegistration: "1999-03" }, LATER);
  vehicles.saveDetail(live, { firstRegistration: "1999" }, LATER);

  vehicles.mergeInto(older, live);

  assert.equal(vehicles.findById(older)?.firstRegistration, "1999-03");
});

test("two prices seen at the same instant both survive a merge", (t) => {
  const vehicles = repo(t);
  const { older, live } = twoAdverts(vehicles);
  // The same run saw both adverts: same instant, same source, two prices.
  vehicles.recordPrice({
    vehicleId: older, observedAt: LATER, sourceId: "autoscout24",
    amount: 26_990, currency: "EUR", baseAmount: 26_990, rate: 1,
  });
  vehicles.markDelisted("autoscout24", ["new"], LATER, LATER);

  vehicles.mergeInto(older, live);

  const prices = vehicles.priceHistory(older).map((p) => p.baseAmount);
  assert.ok(prices.includes(26_990) && prices.includes(24_490), prices.join(","));
  assert.equal(prices.at(-1), 24_490, "the latest price is the live advert's");
});
