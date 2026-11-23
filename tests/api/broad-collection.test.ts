import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EMPTY_CRITERIA, type RawListing, type SourceAdapter } from "@carscope/core";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";

const adapter = (id: string): SourceAdapter =>
  ({ id, label: id, markets: ["DE"], minIntervalMs: 0 } as unknown as SourceAdapter);
let clock = Date.parse("2026-11-23T22:00:00.000Z");

function setup(t: { after: (fn: () => unknown) => void }) {
  const db: DatabaseSync = openDatabase(":memory:");
  t.after(() => db.close());
  return { db, vehicles: new VehicleRepository(db) };
}

function see(
  vehicles: VehicleRepository,
  source: string,
  raw: Omit<RawListing, "currency" | "photoUrls" | "url"> & { attributes: RawListing["attributes"] },
): string {
  const at = new Date((clock += 60_000)).toISOString();
  const full: RawListing = { ...raw, url: `https://${source}.invalid/${raw.sourceListingId}`, currency: "EUR", photoUrls: [] };
  const { vehicle } = vehicles.resolve(full, adapter(source), null, at, "DE");
  vehicles.upsertListing(vehicle.id, full, adapter(source), at);
  vehicles.recordPrice({
    vehicleId: vehicle.id, observedAt: at, sourceId: source,
    amount: raw.price, currency: "EUR", baseAmount: raw.price, rate: 1,
  });
  return vehicle.id;
}

// Seen on prod on 23 Nov 2026: an AutoScout24 car in Nordhorn and its AutoUncle card, which
// states no place, no mileage and no registration, only a price and the words of the advert.
const AUTOSCOUT = {
  sourceListingId: "as1", title: "Nissan Skyline R34 GTT zu Gtr*oem Teile*Z-Tune*Midnight", price: 69_899,
  attributes: {
    make: "Nissan", model: "Skyline", market: "DE", mileageKm: 143_529, firstRegistration: "1998-09",
    powerW: 205_940, city: "Nordhorn", postalCode: "48529", sellerType: "dealer",
  },
} as const;
const AUTOUNCLE_CARD = {
  sourceListingId: "au1", title: "Nissan Skyline 280 PS | Seltenes Fahrzeug", price: 69_899,
  attributes: { make: "Nissan", model: "Skyline", market: "DE", variant: "R34 GTT zu Gtr*oem Teile*Z-Tune*Midnight" },
} as const;

test("a card with no place and no mileage joins the car with the same price and the same words", (t) => {
  const { vehicles } = setup(t);
  const first = see(vehicles, "autoscout24", { ...AUTOSCOUT, attributes: { ...AUTOSCOUT.attributes, sellerType: "private" } });
  const second = see(vehicles, "autouncle", AUTOUNCLE_CARD);

  assert.equal(second, first);
  assert.deepEqual(vehicles.findById(first)?.listings.map((l) => l.sourceId).sort(), ["autoscout24", "autouncle"]);
});

test("it does not matter which of the two adverts arrives first", (t) => {
  const { vehicles } = setup(t);
  see(vehicles, "autouncle", AUTOUNCLE_CARD);
  see(vehicles, "autoscout24", { ...AUTOSCOUT, attributes: { ...AUTOSCOUT.attributes, sellerType: "private" } });

  assert.equal(vehicles.counts().vehicles, 1, "joined on arrival");
  assert.equal(vehicles.consolidate(), 0, "nothing left for the end-of-job pass");
});

test("a dealer's cards meet by price and words only when the words are many and specific", (t) => {
  const { vehicles } = setup(t);
  see(vehicles, "autoscout24", AUTOSCOUT);
  see(vehicles, "autouncle", AUTOUNCLE_CARD);
  assert.equal(vehicles.counts().vehicles, 1, "seven specific words in common: Z-Tune, Midnight, OEM, ...");

  // A dealer can hold two cars of one model at one price; "R34 GTT" is not specific enough.
  const { vehicles: stock } = setup(t);
  see(stock, "autoscout24", {
    ...AUTOSCOUT, sourceListingId: "as9", title: "Nissan Skyline R34 GTT",
    attributes: { ...AUTOSCOUT.attributes, sellerType: "dealer" },
  });
  see(stock, "autouncle", {
    ...AUTOUNCLE_CARD, sourceListingId: "au9",
    attributes: { make: "Nissan", model: "Skyline", market: "DE", variant: "R34 GTT" },
  });
  assert.equal(stock.counts().vehicles, 2);
});

test("the same price with other words is another car", (t) => {
  const { vehicles } = setup(t);
  see(vehicles, "autoscout24", { ...AUTOSCOUT, attributes: { ...AUTOSCOUT.attributes, sellerType: "private" } });
  see(vehicles, "autouncle", {
    ...AUTOUNCLE_CARD, sourceListingId: "au2",
    attributes: { make: "Nissan", model: "Skyline", market: "DE", variant: "R33 GTST Schalter Coupe Turbo" },
  });

  assert.equal(vehicles.counts().vehicles, 2);
});

test("a title that starts with a year names the car, not a make called 1999", (t) => {
  const { vehicles } = setup(t);
  const id = see(vehicles, "kleinanzeigen", {
    sourceListingId: "k1", title: "1999 Nissan Skyline R34 GTT Unverbastelt TÜV Neu RB25DET NEO", price: 0,
    attributes: { market: "DE", mileageKm: 178_000, firstRegistration: "1999-03", city: "Hückeswagen", postalCode: "42499" },
  });

  const car = vehicles.findById(id);
  assert.equal(car?.make, "Nissan");
  assert.equal(car?.model, "Skyline");
});

test("a card with no price does not take a car's price and joins it by place and words", (t) => {
  const { vehicles } = setup(t);
  const live = see(vehicles, "autoscout24", {
    sourceListingId: "as2", title: "Nissan Skyline R34 GT-T 1999 TÜV Neu - Unverbastelt 4-Door Turbo", price: 24_490,
    attributes: {
      make: "Nissan", model: "Skyline", market: "DE", mileageKm: 178_000, firstRegistration: "1999-03",
      city: "Hückeswagen", postalCode: "42499", sellerType: "private",
    },
  });
  const vb = see(vehicles, "kleinanzeigen", {
    sourceListingId: "k2", title: "1999 Nissan Skyline R34 GTT Unverbastelt TÜV Neu RB25DET NEO", price: 0,
    attributes: { market: "DE", mileageKm: 178_000, firstRegistration: "1999-03", city: "Hückeswagen", postalCode: "42499" },
  });

  assert.equal(vb, live);
  assert.deepEqual(vehicles.priceHistory(live).map((p) => p.baseAmount), [24_490], "no 0 EUR row");
  assert.equal(vehicles.search(EMPTY_CRITERIA, true).length, 1, "still listed");
});

test("cars named after a year are renamed by the cleanup, and then merge", (t) => {
  const { db, vehicles } = setup(t);
  const real = see(vehicles, "autoscout24", {
    sourceListingId: "as3", title: "Nissan Skyline R34 GT-T Unverbastelt TÜV NEU 4-Türer", price: 24_490,
    attributes: {
      make: "Nissan", model: "Skyline", market: "DE", mileageKm: 170_000, firstRegistration: "1999-03",
      city: "Hückeswagen", postalCode: "42499", sellerType: "private",
    },
  });
  // The row as it was stored before the fix: make "1999", model "Nissan".
  const wrong = see(vehicles, "kleinanzeigen", {
    sourceListingId: "k3", title: "1999 Nissan Skyline R34 GTT Unverbastelt TÜV Neu", price: 0,
    attributes: { make: "1999", model: "Nissan", market: "DE", mileageKm: 178_000, firstRegistration: "1999-03", city: "Hückeswagen", postalCode: "42499" },
  });
  assert.notEqual(wrong, real, "a make of 1999 cannot meet a Nissan");

  assert.equal(vehicles.reinferNames(), 1);
  assert.equal(vehicles.consolidate(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vehicles").get()?.["n"], 1);
});
