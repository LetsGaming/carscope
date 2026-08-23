import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { RawListing, SourceAdapter } from "@carscope/core";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";

const NOW = "2026-08-10T12:00:00.000Z";

const adapter = (id: string): SourceAdapter =>
  ({ id, label: id, markets: ["DE"], minIntervalMs: 0 } as unknown as SourceAdapter);

const listing = (over: Partial<RawListing>): RawListing => ({
  sourceListingId: "a1",
  url: "https://portal.invalid/a1",
  title: "Nissan Skyline",
  price: 41_999,
  currency: "EUR",
  photoUrls: [],
  attributes: { make: "Nissan", model: "Skyline", market: "DE", mileageKm: 145_000 },
  ...over,
} as RawListing);

function repo(t: { after: (fn: () => unknown) => void }): VehicleRepository {
  const db: DatabaseSync = openDatabase(":memory:");
  t.after(() => db.close());
  return new VehicleRepository(db);
}

/**
 * The first source used to be the whole truth. A car listed thinly on whichever
 * portal happened to be read first stayed thin, even when a second advert for
 * the same car carried the gearbox, the seller and a description.
 */
test("a second advert fills in what the first one never said", (t) => {
  const vehicles = repo(t);

  const first = vehicles.resolve(listing({
    attributes: { make: "Nissan", model: "Skyline", market: "DE", mileageKm: 145_000, firstRegistration: "1998" },
  }), adapter("thin"), null, NOW, "DE");
  assert.equal(first.created, true);
  assert.equal(first.vehicle.gearbox, null);

  const second = vehicles.resolve(listing({
    sourceListingId: "b1",
    attributes: {
      make: "Nissan", model: "Skyline", market: "DE", mileageKm: 145_000,
      firstRegistration: "1998-08", gearbox: "manual", sellerName: "Autohaus Nord",
      description: "Frisch importiert", powerW: 205_940,
    },
  }), adapter("rich"), null, NOW, "DE");

  assert.equal(second.created, false, "it is recognised as the same car");
  assert.equal(second.vehicle.gearbox, "manual", "a gap is filled");
  assert.equal(second.vehicle.sellerName, "Autohaus Nord");
  assert.equal(second.vehicle.powerW, 205_940);
  assert.equal(
    second.vehicle.firstRegistration, "1998-08",
    "the more precise date wins, because it is the same fact stated better",
  );
});

test("a later source never overwrites what an earlier one established", (t) => {
  const vehicles = repo(t);

  vehicles.resolve(listing({
    attributes: {
      make: "Nissan", model: "Skyline", market: "DE", mileageKm: 145_000,
      gearbox: "manual", sellerName: "Autohaus Nord",
    },
  }), adapter("first"), null, NOW, "DE");

  const second = vehicles.resolve(listing({
    sourceListingId: "b1",
    attributes: {
      make: "Nissan", model: "Skyline", market: "DE", mileageKm: 145_000,
      gearbox: "automatic", sellerName: "Anderes Autohaus",
    },
  }), adapter("second"), null, NOW, "DE");

  assert.equal(second.vehicle.gearbox, "manual", "the row does not flip between runs");
  assert.equal(second.vehicle.sellerName, "Autohaus Nord");
});

test("an aggregator's find is recorded under the source it was fetched from", (t) => {
  // AutoUncle results are adverts on mobile.de, AutoScout24 and others, but a
  // listing is attributed to AutoUncle, the source it was fetched from — not to
  // the portal the advert originated on. Tracking the advert's true origin
  // would be a cross-source concept no other adapter shares, for no real
  // benefit over the search history already on the vehicle. See autouncle.ts.
  const vehicles = repo(t);

  const found = vehicles.resolve(listing({}), adapter("autouncle"), null, NOW, "DE");
  vehicles.upsertListing(found.vehicle.id, listing({}), adapter("autouncle"), NOW);
  const stored = vehicles.findById(found.vehicle.id);
  assert.equal(stored?.listings[0]?.sourceId, "autouncle", "how we found it is recorded");
});

test("a shouted make is settled on the way in", (t) => {
  const vehicles = repo(t);
  const created = vehicles.resolve(listing({
    attributes: { make: "NISSAN", model: "SKYLINE", market: "DE", variant: "GT-R V-SPEC" },
  }), adapter("loud"), null, NOW, "DE");

  assert.equal(created.vehicle.make, "Nissan");
  assert.equal(created.vehicle.model, "Skyline");
  assert.equal(created.vehicle.variant, "GT-R V-Spec");
});

test("the source with more pictures wins the gallery", (t) => {
  const vehicles = repo(t);

  const thin = vehicles.resolve(listing({ photoUrls: ["https://p.invalid/1.jpg"] }), adapter("thin"), null, NOW, "DE");
  assert.equal(vehicles.findById(thin.vehicle.id)?.photos.length, 1);

  vehicles.resolve(listing({
    sourceListingId: "b1",
    photoUrls: ["https://p.invalid/1.jpg", "https://p.invalid/2.jpg", "https://p.invalid/3.jpg"],
  }), adapter("rich"), null, NOW, "DE");

  assert.equal(vehicles.findById(thin.vehicle.id)?.photos.length, 3);
});
