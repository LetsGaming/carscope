import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describe as summarise, monthlyObservations, monthlySeries, type CarHistory,
} from "../../packages/core/src/stats.ts";

const sightings = (from: string, count: number, step: number, amount: number) =>
  Array.from({ length: count }, (_, i) => ({
    observedAt: new Date(Date.parse(from) + i * step).toISOString(), baseAmount: amount,
  }));

const HOUR = 3_600_000;

test("a car counts once per month however often it was seen", () => {
  // One car seen every hour for 40 days at 25000, three cars seen once at 40000.
  const longLived: CarHistory = {
    vehicleId: "long", from: "2026-09-01", to: "2026-10-10T00:00:00.000Z",
    prices: sightings("2026-09-01T00:00:00.000Z", 960, HOUR, 25_000),
  };
  const shortLived: CarHistory[] = ["a", "b", "c"].map((id) => ({
    vehicleId: id, from: "2026-09-10", to: "2026-09-12T00:00:00.000Z",
    prices: [{ observedAt: "2026-09-10T10:00:00.000Z", baseAmount: 40_000 }],
  }));
  const cars = [longLived, ...shortLived];

  const bySighting = monthlySeries(cars.flatMap((c) => c.prices)).find((p) => p.month === "2026-09");
  const byCar = monthlySeries(monthlyObservations(cars, "2026-01-01")).find((p) => p.month === "2026-09");

  assert.equal(bySighting?.p50, 25_000, "by sighting the long-lived car decides");
  assert.equal(byCar?.n, 4);
  assert.equal(byCar?.p50, 40_000, "by car, three of four asked 40000");
  assert.equal(byCar?.reliable, false, "four cars are not a reliable month");
});

test("a car is carried through the months it was for sale at the price in effect", () => {
  const car: CarHistory = {
    vehicleId: "x", from: "2026-08-20", to: "2026-11-05T00:00:00.000Z",
    prices: [
      { observedAt: "2026-08-20T10:00:00.000Z", baseAmount: 30_000 },
      { observedAt: "2026-10-12T10:00:00.000Z", baseAmount: 27_000 },
    ],
  };

  const rows = monthlyObservations([car], "2026-01-01");

  assert.deepEqual(rows.map((r) => [r.observedAt.slice(0, 7), r.baseAmount]), [
    ["2026-08", 30_000], ["2026-09", 30_000], ["2026-10", 27_000], ["2026-11", 27_000],
  ]);
});

test("a car sold in the middle of a month is priced as it was then", () => {
  const car: CarHistory = {
    vehicleId: "x", from: "2026-08-01", to: "2026-08-10T00:00:00.000Z",
    prices: [
      { observedAt: "2026-08-01T10:00:00.000Z", baseAmount: 30_000 },
      { observedAt: "2026-08-25T10:00:00.000Z", baseAmount: 20_000 },
    ],
  };

  assert.equal(monthlyObservations([car], "2026-01-01")[0]?.baseAmount, 30_000,
    "the later price came after the car was gone");
});

test("a car is not priced for months before it was first seen", () => {
  // The portal says the advert is from January; the first observation is in August.
  const car: CarHistory = {
    vehicleId: "x", from: "2026-01-19", to: "2026-09-20T00:00:00.000Z",
    prices: [{ observedAt: "2026-08-18T21:00:00.000Z", baseAmount: 26_990 }],
  };

  const rows = monthlyObservations([car], "2026-01-01");

  assert.deepEqual(rows.map((r) => r.observedAt.slice(0, 7)), ["2026-08", "2026-09"]);
});

test("months before the window are not reported", () => {
  const car: CarHistory = {
    vehicleId: "x", from: "2026-01-05", to: "2026-04-05T00:00:00.000Z",
    prices: [{ observedAt: "2026-01-05T10:00:00.000Z", baseAmount: 30_000 }],
  };

  const rows = monthlyObservations([car], "2026-03-01T00:00:00.000Z");

  assert.deepEqual(rows.map((r) => r.observedAt.slice(0, 7)), ["2026-03", "2026-04"]);
  assert.equal(summarise([]).n, 0);
});
