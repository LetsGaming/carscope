import { test } from "node:test";
import assert from "node:assert/strict";
import {
  identityKey, isAttributeMatch, isCertainMatch, isSameVehicle, isSamePlaceMatch, isSparseMatch, matchScore, normaliseName, titleOverlap,
} from "../../packages/core/src/identity.ts";
import type { MatchInput } from "../../packages/core/src/identity.ts";
import { byId } from "../api/skyline-results.ts";
import { HELD_IDS, PROD, SAME_CAR, type ProdRow } from "../api/prod-skyline.ts";

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

const asInput = (id: string): MatchInput => {
  const { listing } = byId(id);
  const a = listing.attributes;
  return {
    make: a.make ?? "", model: a.model ?? "", firstRegistration: a.firstRegistration ?? null,
    mileageKm: a.mileageKm ?? null, market: "DE", sellerName: null,
    priceBase: listing.price, imageHash: null, powerW: a.powerW ?? null,
    gearbox: a.gearbox ?? null, title: listing.title,
  };
};

const VELBERT = "575913a6";
const VELBERT_ON_AUTOUNCLE = "88bde6f7";
const RODENBACH = "85c1cad9";
const HUECKESWAGEN = "b48b8325";

test("one car on two portals, 5 km and one month apart, is one car", () => {
  const kleinanzeigen = asInput(VELBERT);
  // Autouncle names it "280 PS": no title words in common, no photos, no seller.
  const autouncle: MatchInput = { ...asInput(VELBERT_ON_AUTOUNCLE), title: "280 PS" };

  assert.equal(isCertainMatch(kleinanzeigen, autouncle), false, "mileage and month differ");
  assert.ok(matchScore(kleinanzeigen, autouncle) < 0.72, "scoring alone never reached it");
  assert.ok(isAttributeMatch(kleinanzeigen, autouncle));
  assert.ok(isSameVehicle(kleinanzeigen, autouncle));
});

test("the three different R34s are never merged with each other", () => {
  const cars = [VELBERT, VELBERT_ON_AUTOUNCLE, RODENBACH, HUECKESWAGEN].map(asInput);
  const velbert = cars[0];
  const autouncle = cars[1];
  const rodenbach = cars[2];
  const hueckeswagen = cars[3];
  assert.ok(velbert && autouncle && rodenbach && hueckeswagen);

  for (const [x, y] of [
    [velbert, rodenbach], [velbert, hueckeswagen], [rodenbach, hueckeswagen],
    [autouncle, rodenbach], [autouncle, hueckeswagen],
  ] as const) {
    assert.equal(isSameVehicle(x, y), false, `${x.firstRegistration ?? ""} vs ${y.firstRegistration ?? ""}`);
  }
});

test("the attribute rule needs every attribute, on both sides", () => {
  const a = asInput(VELBERT);
  const b = asInput(VELBERT_ON_AUTOUNCLE);
  assert.ok(isAttributeMatch(a, b));
  assert.equal(isAttributeMatch(a, { ...b, gearbox: null }), false, "no gearbox is no agreement");
  assert.equal(isAttributeMatch(a, { ...b, gearbox: "automatic" }), false);
  assert.equal(isAttributeMatch(a, { ...b, powerW: null }), false);
  assert.equal(isAttributeMatch(a, { ...b, mileageKm: 90_100 }), false, "350 km apart");
  assert.equal(isAttributeMatch(a, { ...b, priceBase: 44_900 }), false, "over 1 percent");
  assert.equal(isAttributeMatch(a, { ...b, firstRegistration: "1999-10" }), false, "four months");
  assert.equal(isAttributeMatch(a, { ...b, firstRegistration: "1999" }), true, "a bare year fits any month");
  assert.equal(isAttributeMatch(a, { ...b, firstRegistration: null }), false);
});

const prodInput = (row: ProdRow): MatchInput => ({
  make: row.make, model: row.model, firstRegistration: row.reg, mileageKm: row.km,
  market: "DE", sellerName: null, priceBase: row.price, imageHash: null, powerW: row.powerW,
  gearbox: row.gearbox, title: row.titles[0] ?? "", titles: row.titles,
  city: row.city, sellerType: row.sellerType,
});

const pairKey = (a: string, b: string): string => [a, b].sort().join("+");

test("on the prod snapshot, exactly the three known pairs are one car", () => {
  const cars = PROD.filter((r) => !HELD_IDS.some((id) => id === r.id));
  const found: string[] = [];
  for (const [i, a] of cars.entries()) {
    for (const b of cars.slice(i + 1)) {
      if (isSameVehicle(prodInput(a), prodInput(b))) found.push(pairKey(a.id, b.id));
    }
  }
  assert.deepEqual(found.sort(), SAME_CAR.map(([a, b]) => pairKey(a, b)).sort());
});

test("a reposted advert keeps its town, loses nothing but price and a corrected odometer", () => {
  const first = PROD.find((r) => r.id === "14195382");
  const second = PROD.find((r) => r.id === "b48b8325");
  assert.ok(first && second);
  const a = prodInput(first);
  const b = prodInput(second);

  assert.equal(isAttributeMatch(a, b), false, "price and gearbox rule it out");
  assert.ok(isSamePlaceMatch(a, b));
  assert.equal(isSamePlaceMatch(a, { ...b, city: "Wipperfürth" }), false, "another town");
  assert.equal(isSamePlaceMatch(a, { ...b, city: null }), false, "no town known");
  assert.equal(isSamePlaceMatch({ ...a, sellerType: "dealer" }, b), false, "a dealer holds several cars");
  assert.equal(isSamePlaceMatch(a, { ...b, mileageKm: 195_000 }), false, "mileage over 5 percent");
  assert.equal(isSamePlaceMatch(a, { ...b, firstRegistration: "2001-03" }), false, "three years apart");
  assert.equal(isSamePlaceMatch(a, { ...b, gearbox: "manual" }), false, "known gearboxes disagree");
  assert.equal(isSamePlaceMatch(a, { ...b, titles: ["Honda Civic Type R"], title: "Honda Civic Type R" }), false);
});

test("a sparse card needs the town and the exact price, and may not contradict", () => {
  const full = PROD.find((r) => r.id === "85c1cad9");
  const card = PROD.find((r) => r.id === "a372d143");
  assert.ok(full && card);
  const a = prodInput(full);
  const b = prodInput(card);

  assert.ok(isSparseMatch(a, b));
  assert.equal(isSparseMatch(a, { ...b, priceBase: 44_000 }), false, "price differs");
  assert.equal(isSparseMatch(a, { ...b, city: "Hanau" }), false, "town differs");
  assert.equal(isSparseMatch(a, { ...b, mileageKm: 140_000 }), false, "a stated mileage contradicts");
  assert.equal(isSparseMatch(a, { ...b, sellerType: "dealer" }), false);
  assert.equal(isSparseMatch(a, prodInput(PROD.find((r) => r.id === "88bde6f7") ?? full)), false,
    "two full adverts are left to the other rules");
});

test("an aggregator card with only a make-and-model title is held to a close price", () => {
  const first = PROD.find((r) => r.id === "14195382");
  const second = PROD.find((r) => r.id === "b48b8325");
  assert.ok(first && second);
  const real = prodInput(second);
  const card: MatchInput = {
    ...prodInput(first),
    title: "Gebraucht (1998) Nissan Skyline GT 280 PS | Seltenes Fahrzeug",
    titles: ["Gebraucht (1998) Nissan Skyline GT 280 PS | Seltenes Fahrzeug"],
  };

  assert.ok(isSamePlaceMatch(card, real), "the title says nothing, the price is 9 percent apart");
  assert.equal(isSamePlaceMatch({ ...card, priceBase: 34_000 }, real), false, "40 percent apart");
});
