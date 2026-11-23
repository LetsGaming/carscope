import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EMPTY_CRITERIA, type Criteria, type RawListing, type SourceAdapter } from "@carscope/core";
import { openDatabase } from "../../apps/api/src/db/index.ts";
import { VehicleRepository } from "../../apps/api/src/repositories/vehicles.ts";
import { MarketService } from "../../apps/api/src/services/market.ts";

const NOW = "2026-11-20T12:00:00.000Z";
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
  over: {
    id: string; title: string; model: string; km: number; city: string;
    powerW?: number; reg?: string; price?: number;
  },
): void {
  const price = over.price ?? 30_000;
  const raw: RawListing = {
    sourceListingId: over.id, url: `https://www.kleinanzeigen.de/s-anzeige/x/${over.id}`,
    title: over.title, price, currency: "EUR", photoUrls: [],
    attributes: {
      make: "Nissan", model: over.model, market: "DE", mileageKm: over.km, city: over.city,
      ...(over.powerW === undefined ? {} : { powerW: over.powerW }),
      ...(over.reg === undefined ? {} : { firstRegistration: over.reg }),
    },
  };
  const { vehicle } = vehicles.resolve(raw, adapter("kleinanzeigen"), null, NOW, "DE");
  vehicles.upsertListing(vehicle.id, raw, adapter("kleinanzeigen"), NOW);
  vehicles.recordPrice({
    vehicleId: vehicle.id, observedAt: NOW, sourceId: "kleinanzeigen",
    amount: price, currency: "EUR", baseAmount: price, rate: 1,
  });
}

// The web client sends make, model and text as one string, so this is what reaches the API.
const TEXT_ONLY: Criteria = { ...EMPTY_CRITERIA, text: "Nissan Skyline" };

test("a text-only search keeps a Stagea out although its title says Skyline", (t) => {
  const { vehicles } = setup(t);
  store(vehicles, { id: "1", title: "Nissan Skyline R34 GTT", model: "Skyline", km: 90_000, city: "Velbert" });
  store(vehicles, {
    id: "2", title: "Nissan Stagea RS4 250t AWD Turbo jdm skyline V6", model: "Stagea", km: 144_000, city: "Bönningstedt",
  });

  assert.deepEqual(vehicles.search(TEXT_ONLY, true).map((r) => r.model), ["Skyline"]);
});

test("a chassis code in a text-only search still finds the Skyline", (t) => {
  const { vehicles } = setup(t);
  store(vehicles, { id: "1", title: "Nissan Skyline R34 GTT", model: "Skyline", km: 90_000, city: "Velbert" });
  store(vehicles, { id: "2", title: "Nissan Stagea 260 RS skyline R34 Motor", model: "Stagea", km: 144_000, city: "Kiel" });

  const found = vehicles.search({ ...EMPTY_CRITERIA, text: "Nissan R34" }, true);
  assert.deepEqual(found.map((r) => r.model), ["Skyline"]);
});

test("cars left out only for a value they do not state are counted", (t) => {
  const { vehicles, market } = setup(t);
  const range: Criteria = {
    ...TEXT_ONLY,
    powerPs: { min: 280, max: 280 },
    registrationYear: { min: 1998, max: 2002 },
  };
  store(vehicles, {
    id: "1", title: "Nissan Skyline R34", model: "Skyline", km: 90_000, city: "Velbert",
    powerW: 205_940, reg: "1999-06",
  });
  store(vehicles, { id: "2", title: "Nissan Skyline R34 GTT", model: "Skyline", km: 100_000, city: "Hanau" });
  store(vehicles, {
    id: "3", title: "Nissan Skyline R33", model: "Skyline", km: 70_000, city: "Kassel",
    powerW: 180_000, reg: "1996-01",
  });

  assert.equal(vehicles.search(range, true).length, 1, "only the car that states both and fits");
  const report = market.report(range);
  assert.equal(report.unknownCount, 1, "the car with no power and no registration, not the R33");
});
