import { test } from "node:test";
import assert from "node:assert/strict";
import {
  identityKey, isCertainMatch, isSameVehicle, matchScore, normaliseName, titleOverlap,
} from "../../packages/core/src/identity.ts";
import type { MatchInput } from "../../packages/core/src/identity.ts";

const base: MatchInput = {
  make: "Nissan", model: "Skyline", firstRegistration: "1999-06",
  mileageKm: 96_400, market: "NL", sellerName: "JDM Import Venlo",
  priceBase: 34_900, imageHash: "abc123", powerW: 151_512,
  title: "Nissan Skyline R34 GT-T Sedan",
};

test("normalises diacritics and punctuation", () => {
  assert.equal(normaliseName("Škoda  Octavia-RS"), "skoda octavia rs");
});

test("identity key buckets mileage so rounded figures still collide", () => {
  const a = identityKey({ ...base, mileageKm: 96_400 });
  const b = identityKey({ ...base, mileageKm: 96_000 });
  assert.equal(a, b);
});

test("same car cross-posted on two portals matches", () => {
  const other: MatchInput = { ...base, priceBase: 35_100, mileageKm: 96_000 };
  assert.ok(isSameVehicle(base, other));
});

test("different car from the same dealer does not match", () => {
  const other: MatchInput = {
    ...base, priceBase: 52_000, mileageKm: 64_900, imageHash: "zzz999", powerW: 151_512 + 40_000,
  };
  assert.ok(matchScore(base, other) < 0.72);
});

test("the same car advertised twice on one portal is merged", () => {
  // Neither ad carries a seller name and each has its own uploaded photo, so the
  // image hash and seller weight are both unavailable. What remains is decisive.
  const first: MatchInput = {
    make: "Nissan", model: "Skyline", firstRegistration: "1998-05", mileageKm: 132_000,
    market: "DE", sellerName: null, priceBase: 18_000, imageHash: "one",
    powerW: null, title: "Nissan Skyline R34 GT-T",
  };
  const second: MatchInput = { ...first, imageHash: "two", title: "Nissan Skyline R34 GT-T Sedan" };

  assert.ok(isCertainMatch(first, second));
  assert.ok(isSameVehicle(first, second));
});

test("two different cars from one seller stay apart", () => {
  const first: MatchInput = {
    make: "Nissan", model: "Skyline", firstRegistration: "1998-05", mileageKm: 132_000,
    market: "DE", sellerName: "JDM Import", priceBase: 18_000, imageHash: "one",
    powerW: null, title: "Nissan Skyline R34 GT-T",
  };
  const other: MatchInput = {
    ...first, firstRegistration: "2000-09", mileageKm: 230_000,
    priceBase: 35_990, imageHash: "two", title: "Nissan Skyline R34 GT-R V-Spec",
  };
  assert.equal(isCertainMatch(first, other), false);
  assert.equal(isSameVehicle(first, other), false);
});

test("title overlap is measured against the shorter title", () => {
  assert.equal(titleOverlap("Nissan Skyline R34", "Nissan Skyline R34 GT-T Sedan"), 1);
  assert.ok(titleOverlap("Nissan Skyline", "BMW 745i Leder") < 0.1);
  assert.equal(titleOverlap("", "Nissan"), 0);
});

test("portals that name the same car differently still merge", () => {
  // AutoUncle calls it a Skyline and knows only the year; Kleinanzeigen calls it
  // an R34 and knows the month. Same mileage to the km, same price to the euro.
  const aggregator: MatchInput = {
    make: "Nissan", model: "Skyline", firstRegistration: "1998", mileageKm: 78_500,
    market: "DE", sellerName: null, priceBase: 33_000, imageHash: "au",
    powerW: 205_940, title: "Nissan Skyline R34 Sedan 4 Door Turbo Automat",
  };
  const portal: MatchInput = {
    ...aggregator, model: "R34", firstRegistration: "1998-07",
    imageHash: "ka", title: "Nissan R34",
  };

  assert.ok(isCertainMatch(aggregator, portal), "the model name is not evidence about the car");
  assert.ok(isSameVehicle(aggregator, portal));
});

test("a year is compatible with a month inside it, and nothing else", () => {
  const base: MatchInput = {
    make: "Nissan", model: "Skyline", firstRegistration: "2000", mileageKm: 230_000,
    market: "DE", sellerName: null, priceBase: 35_990, imageHash: "a",
    powerW: null, title: "Nissan Skyline Nismo",
  };
  assert.ok(isCertainMatch(base, { ...base, firstRegistration: "2000-09" }));
  assert.equal(isCertainMatch(base, { ...base, firstRegistration: "2001-09" }), false);
});

test("the same mileage at a different price is not the same car", () => {
  const base: MatchInput = {
    make: "Nissan", model: "Skyline", firstRegistration: "1998", mileageKm: 78_500,
    market: "DE", sellerName: null, priceBase: 33_000, imageHash: "a",
    powerW: null, title: "Nissan Skyline",
  };
  assert.equal(isCertainMatch(base, { ...base, priceBase: 29_000 }), false);
  assert.equal(isSameVehicle(base, { ...base, priceBase: 29_000, imageHash: "b" }), false);
});
