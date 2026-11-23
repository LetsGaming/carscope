import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { photoDir } from "@carscope/collector";
import type { RawListing, SourceAdapter } from "@carscope/core";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { SearchRepository } from "../../apps/api/src/repositories/searches.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";
import { MarketService } from "../../apps/api/src/services/market.ts";
import { runCleanup } from "../../apps/api/src/services/cleanup.ts";

const adapter = (id: string): SourceAdapter =>
  ({ id, label: id, markets: ["DE"], minIntervalMs: 0 } as unknown as SourceAdapter);
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-19T21:00:00.000Z");
const at = (hours: number): string => new Date(T0 + hours * HOUR).toISOString();

function setup(t: { after: (fn: () => unknown) => void }) {
  const db: DatabaseSync = openDatabase(":memory:");
  t.after(() => db.close());
  const vehicles = new VehicleRepository(db);
  const searches = new SearchRepository(db);
  return { db, vehicles, searches, market: new MarketService(vehicles) };
}

function advert(
  vehicles: VehicleRepository,
  o: { source: string; id: string; title: string; price: number; hours: number; attrs: RawListing["attributes"] },
): string {
  const raw: RawListing = {
    sourceListingId: o.id, url: `https://portal.invalid/${o.id}`, title: o.title, price: o.price,
    currency: "EUR", photoUrls: [], attributes: { make: "Nissan", model: "Skyline", market: "DE", ...o.attrs },
  };
  const { vehicle } = vehicles.resolve(raw, adapter(o.source), null, at(o.hours), "DE");
  vehicles.upsertListing(vehicle.id, raw, adapter(o.source), at(o.hours));
  vehicles.recordPrice({
    vehicleId: vehicle.id, observedAt: at(o.hours), sourceId: o.source,
    amount: o.price, currency: "EUR", baseAmount: o.price, rate: 1,
  });
  return vehicle.id;
}

/** What prod looked like: the Nismo card sits on the Rodenbach car. */
function nismoOnRodenbach(s: ReturnType<typeof setup>) {
  const magdeburg = advert(s.vehicles, {
    source: "kleinanzeigen", id: "3562811585", title: "Nissan Skyline R34 GTT GTR Nismo", price: 40_000, hours: 1,
    attrs: { mileageKm: 36_500, firstRegistration: "1999-02", city: "Magdeburg", postalCode: "39128" },
  });
  const rodenbach = advert(s.vehicles, {
    source: "autouncle", id: "220776024", title: "Nissan Skyline 280 PS | Seltenes Fahrzeug", price: 44_900, hours: 2,
    attrs: { city: "Rodenbach", postalCode: "63517" },
  });
  // The wrong merge, written the way it was stored.
  s.db.prepare(`
    INSERT INTO listings (id, vehicle_id, source_id, source_listing_id, url, title, first_seen_at, last_seen_at)
    VALUES ('wrong', ?, 'autouncle', '229720598', 'https://portal.invalid/229720598', 'Nissan Skyline Nismo 280 PS', ?, ?)
  `).run(rodenbach, at(40), at(60));
  const snap = s.db.prepare(`
    INSERT INTO price_snapshots (vehicle_id, observed_at, source_id, amount, currency, base_amount, rate)
    VALUES (?, ?, 'autouncle', 40000, 'EUR', 40000, 1)
  `);
  for (const h of [40, 45, 50, 60]) snap.run(rodenbach, at(h));
  return { magdeburg, rodenbach };
}

test("an advert on the wrong car moves with its own prices and leaves the other prices behind", (t) => {
  const s = setup(t);
  const { magdeburg, rodenbach } = nismoOnRodenbach(s);

  const moved = s.vehicles.moveListing(
    { sourceId: "autouncle", listingId: "229720598" },
    { sourceId: "kleinanzeigen", listingId: "3562811585" },
    40_000,
  );

  assert.equal(moved, true);
  const target = s.vehicles.findById(magdeburg);
  assert.deepEqual(target?.listings.map((l) => l.sourceId).sort(), ["autouncle", "kleinanzeigen"]);
  assert.equal(s.vehicles.priceHistory(magdeburg).filter((p) => p.sourceId === "autouncle").length, 4);
  assert.deepEqual(
    s.vehicles.priceHistory(rodenbach).map((p) => p.baseAmount).sort(),
    [44_900], "the Rodenbach car keeps only its own price",
  );
  assert.equal(
    s.vehicles.moveListing(
      { sourceId: "autouncle", listingId: "229720598" }, { sourceId: "kleinanzeigen", listingId: "3562811585" }, 40_000,
    ), false, "a second run finds nothing to move",
  );
  assert.equal(
    s.vehicles.moveListing({ sourceId: "autouncle", listingId: "nope" }, { sourceId: "kleinanzeigen", listingId: "3562811585" }, 1),
    false,
  );
});

test("snapshots are cut down to the first and last row of each run of one price", (t) => {
  const s = setup(t);
  const id = advert(s.vehicles, {
    source: "autoscout24", id: "a", title: "Nissan Skyline R34", price: 30_000, hours: 0, attrs: { mileageKm: 90_000 },
  });
  const put = s.db.prepare(`
    INSERT OR IGNORE INTO price_snapshots (vehicle_id, observed_at, source_id, amount, currency, base_amount, rate)
    VALUES (?, ?, 'autoscout24', ?, 'EUR', ?, 1)
  `);
  for (let h = 1; h <= 9; h += 1) put.run(id, at(h), 30_000, 30_000);
  for (let h = 10; h <= 14; h += 1) put.run(id, at(h), 28_000, 28_000);
  put.run(id, at(15), 30_000, 30_000);

  const deleted = s.vehicles.compactSnapshots();

  assert.equal(deleted, 8 + 3, "ten rows of one price leave eight, five of the next leave three");
  assert.deepEqual(s.vehicles.priceHistory(id).map((p) => p.baseAmount), [30_000, 30_000, 28_000, 28_000, 30_000]);
});

test("photo rows without a file are pointed at the file on disk", (t) => {
  const s = setup(t);
  const id = advert(s.vehicles, {
    source: "autoscout24", id: "a", title: "Nissan Skyline R34", price: 30_000, hours: 0, attrs: { mileageKm: 90_000 },
  });
  s.vehicles.savePhotos(id, [
    { url: "u0", localPath: null, position: 0 },
    { url: "u1", localPath: "photos/xx/kept.webp", position: 1 },
    { url: "u2", localPath: null, position: 2 },
  ]);

  const linked = s.vehicles.relinkPhotos(id, new Map([[0, "photos/ab/id/0.webp"], [1, "photos/ab/id/1.webp"]]));

  assert.equal(linked, 1, "position 1 already has a file, position 2 has none on disk");
  assert.deepEqual(s.vehicles.findById(id)?.photos.map((p) => p.localPath),
    ["photos/ab/id/0.webp", "photos/xx/kept.webp", null]);
});

test("the cleanup repairs, merges, relinks and compacts in one pass, and a second pass changes nothing", (t) => {
  const s = setup(t);
  const { magdeburg, rodenbach } = nismoOnRodenbach(s);
  s.searches.create("Skyline", {
    text: "Nissan Skyline", make: null, model: null, priceEur: { min: null, max: null },
    mileageKm: { min: null, max: null }, registrationYear: { min: null, max: null },
    powerPs: { min: null, max: null }, fuel: null, gearbox: null, sellerType: null, bodyStyle: null,
    excludeDamaged: false, markets: ["DE"], postalCode: null, radiusKm: null,
  });
  const dataDir = mkdtempSync(join(tmpdir(), "carscope-cleanup-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  s.vehicles.savePhotos(rodenbach, [{ url: "u0", localPath: null, position: 0 }]);
  mkdirSync(join(dataDir, photoDir(rodenbach)), { recursive: true });
  writeFileSync(join(dataDir, photoDir(rodenbach), "0.webp"), "x");

  const first = runCleanup({ vehicles: s.vehicles, searches: s.searches, market: s.market, dataDir });

  assert.deepEqual(first.repairs.map((r) => r.moved), [true, false, false], "only the Nismo advert exists here");
  assert.equal(first.photosRelinked, 1);
  assert.equal(s.vehicles.findById(magdeburg)?.listings.length, 2);
  assert.equal(s.vehicles.findById(rodenbach)?.listings.length, 1);
  assert.equal(first.marketAfter[0]?.search, "Skyline");

  const second = runCleanup({ vehicles: s.vehicles, searches: s.searches, market: s.market, dataDir });
  assert.deepEqual(second.repairs.map((r) => r.moved), [false, false, false]);
  assert.equal(second.merged, 0);
  assert.equal(second.photosRelinked, 0);
  assert.equal(second.snapshotsDeleted, 0);
  assert.deepEqual(second.after, first.after);
});

test("a hash that many cars share is forgotten, one that two cars share is kept", (t) => {
  const s = setup(t);
  const ids = ["a", "b", "c", "d", "e"].map((n, i) => advert(s.vehicles, {
    source: "autouncle", id: n, title: `Nissan Skyline ${n}`, price: 30_000 + i * 5_000, hours: i,
    attrs: { mileageKm: 50_000 + i * 20_000 },
  }));
  s.vehicles.setImageHash(ids[0] ?? "", "stock");
  s.vehicles.setImageHash(ids[1] ?? "", "stock");
  s.vehicles.setImageHash(ids[2] ?? "", "stock");
  s.vehicles.setImageHash(ids[3] ?? "", "pair");
  s.vehicles.setImageHash(ids[4] ?? "", "pair");

  assert.equal(s.vehicles.clearSharedImageHashes(3), 3);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) AS n FROM vehicles WHERE image_hash = 'pair'").get()?.["n"], 2,
  );
});

test("a car that no longer holds an advert is removed", (t) => {
  const s = setup(t);
  const id = advert(s.vehicles, {
    source: "autouncle", id: "a", title: "Nissan Skyline", price: 30_000, hours: 0, attrs: { mileageKm: 50_000 },
  });
  advert(s.vehicles, {
    source: "autouncle", id: "b", title: "Nissan Skyline", price: 60_000, hours: 1, attrs: { mileageKm: 150_000 },
  });
  s.db.prepare("DELETE FROM listings WHERE vehicle_id = ?").run(id);

  assert.equal(s.vehicles.removeEmptyVehicles(), 1);
  assert.equal(s.vehicles.findById(id), null);
  assert.equal(s.vehicles.counts().vehicles, 1);
});
