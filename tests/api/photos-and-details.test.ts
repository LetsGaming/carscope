import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { variantWithoutName } from "@carscope/core";
import type { RawListing, SourceAdapter } from "@carscope/core";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";

const NOW = "2026-11-20T12:00:00.000Z";
const adapter = (id: string): SourceAdapter =>
  ({ id, label: id, markets: ["DE"], minIntervalMs: 0 } as unknown as SourceAdapter);

function setup(t: { after: (fn: () => unknown) => void }) {
  const db: DatabaseSync = openDatabase(":memory:");
  t.after(() => db.close());
  return { db, vehicles: new VehicleRepository(db) };
}

const raw = (over: Partial<RawListing> & { attrs?: RawListing["attributes"] } = {}): RawListing => ({
  sourceListingId: "a1", url: "https://www.autoscout24.de/angebote/a1", title: "Nissan Skyline R34",
  price: 30_000, currency: "EUR", photoUrls: [],
  attributes: { make: "Nissan", model: "Skyline", market: "DE", mileageKm: 100_000, firstRegistration: "1999-03", ...over.attrs },
  ...over,
});

test("a variant that repeats the car's name keeps only what follows", () => {
  assert.equal(variantWithoutName("Nissan Skyline R34 GTT", "Nissan", "Skyline"), "R34 GTT");
  assert.equal(variantWithoutName("Skyline R34 GTT", "Nissan", "Skyline"), "R34 GTT");
  assert.equal(variantWithoutName("Nissan GT-T", "Nissan", "Skyline"), "GT-T");
  assert.equal(variantWithoutName("nissan skyline", "Nissan", "Skyline"), null);
  assert.equal(variantWithoutName("R34 GTT", "Nissan", "Skyline"), "R34 GTT");
  assert.equal(variantWithoutName(null, "Nissan", "Skyline"), null);
});

test("a stored variant never repeats the make and model, whichever portal wrote it", (t) => {
  const { vehicles } = setup(t);
  const { vehicle } = vehicles.resolve(
    raw({ attrs: { make: "Nissan", model: "Skyline", variant: "Nissan Skyline R34 GTT", market: "DE", mileageKm: 1 } }),
    adapter("autoscout24"), null, NOW, "DE",
  );
  assert.equal(vehicle.variant, "R34 GTT");
});

test("a longer gallery keeps the pictures that are already on disk", (t) => {
  const { vehicles } = setup(t);
  const urls = ["u0", "u1", "u2"];
  const { vehicle } = vehicles.resolve(raw({ photoUrls: urls.slice(0, 2) }), adapter("autoscout24"), null, NOW, "DE");
  vehicles.savePhotos(vehicle.id, [
    { url: "u0", localPath: "photos/ab/x/0.webp", position: 0 },
    { url: "u1", localPath: "photos/ab/x/1.webp", position: 1 },
  ]);

  // The next run's list page names three pictures: more than are stored, so the set is replaced.
  vehicles.resolve(raw({ photoUrls: urls }), adapter("autoscout24"), null, NOW, "DE");

  const car = vehicles.findById(vehicle.id);
  assert.deepEqual(car?.photos.map((p) => [p.url, p.localPath]), [
    ["u0", "photos/ab/x/0.webp"], ["u1", "photos/ab/x/1.webp"], ["u2", null],
  ]);
});

test("a card without mileage or registration is read again after a day, not at once", (t) => {
  const { db, vehicles } = setup(t);
  const bareCard: RawListing = {
    sourceListingId: "b1", url: "https://www.autouncle.de/de/d/b1", title: "Nissan Skyline 280 PS",
    price: 30_000, currency: "EUR", photoUrls: ["a", "b", "c"],
    attributes: { make: "Nissan", model: "Skyline", market: "DE" },
  };
  const { vehicle } = vehicles.resolve(bareCard, adapter("autouncle"), null, NOW, "DE");
  vehicles.saveDetail(vehicle.id, {}, new Date().toISOString());
  assert.equal(vehicles.needsDetail(vehicle.id), false, "just read, however bare");

  db.prepare("UPDATE vehicles SET detail_fetched_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 2 * 86_400_000).toISOString(), vehicle.id);
  assert.equal(vehicles.needsDetail(vehicle.id), true, "bare and read two days ago");

  db.prepare("UPDATE vehicles SET mileage_km = 90000, first_registration = '1999-03' WHERE id = ?").run(vehicle.id);
  assert.equal(vehicles.needsDetail(vehicle.id), false, "complete cars are not read again");
});
