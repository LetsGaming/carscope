import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CURRENCY, type RawListing, type SourceAdapter } from "@carscope/core";
import { imageSetHash } from "../../packages/collector/src/images.ts";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";
import cards from "../fixtures/autouncle-cards-2026-11-23.json" with { type: "json" };

const adapter = { id: "autouncle", label: "AutoUncle", markets: ["DE"], minIntervalMs: 0 } as unknown as SourceAdapter;
const AT = "2026-11-23T22:51:15.238Z";

const toRaw = (c: (typeof cards)[number]): RawListing => ({
  sourceListingId: c.id, url: c.url, title: c.title, price: c.price, currency: CURRENCY.eur,
  photoUrls: c.photo === null ? [] : [c.photo],
  attributes: {
    make: "Nissan", model: "Skyline", market: "DE",
    ...(c.variant === null ? {} : { variant: c.variant }),
    ...(c.zip === null ? {} : { postalCode: c.zip }),
    ...(c.city === null ? {} : { city: c.city }),
  },
});

test("AutoUncle's resize URLs give every picture its own hash", () => {
  const hashes = new Set(cards.map((c) => imageSetHash(c.photo === null ? [] : [c.photo])));
  assert.equal(hashes.size, cards.length, "16 cards, 16 different pictures");
});

test("the same picture at another size has the same hash", () => {
  const url = "https://images.autouncle.com/de/resize?url=de%2Fcar_images%2Fabc_1999-nissan.webp&amp;w=400&amp;h=300&amp;f=webp";
  assert.equal(imageSetHash([url]), imageSetHash([url.replace("w=400", "w=800").replace("h=300", "h=600")]));
  assert.notEqual(imageSetHash([url]), imageSetHash([url.replace("abc", "xyz")]));
});

test("a portal that serves plain asset paths hashes as before", () => {
  const a = "https://prod.pictures.autoscout24.net/listing-images/aaa_bbb.jpg/250x188.webp";
  const b = "https://prod.pictures.autoscout24.net/listing-images/aaa_bbb.jpg/1920x1080.webp";
  assert.equal(imageSetHash([a]), imageSetHash([b]));
});

test("the 16 real cards of one page stay 16 cars, whatever their price and words share", (t) => {
  const db: DatabaseSync = openDatabase(":memory:");
  t.after(() => db.close());
  const vehicles = new VehicleRepository(db);

  for (const c of cards) {
    const raw = toRaw(c);
    const { vehicle } = vehicles.resolve(raw, adapter, imageSetHash(raw.photoUrls), AT, "DE");
    vehicles.upsertListing(vehicle.id, raw, adapter, AT);
    vehicles.recordPrice({
      vehicleId: vehicle.id, observedAt: AT, sourceId: "autouncle", amount: c.price, currency: "EUR", baseAmount: c.price, rate: 1,
    });
  }

  // Two of them cost 49999 EUR and state different places and different cars.
  assert.equal(vehicles.counts().vehicles, cards.length);
  assert.equal(vehicles.consolidate(), 0);
});
