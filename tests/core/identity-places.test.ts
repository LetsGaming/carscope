import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCertainMatch, isSameVehicle, isSamePlaceMatch, matchRank, matchScore, samePlace,
  type MatchInput,
} from "../../packages/core/src/identity.ts";

const card = (over: Partial<MatchInput> = {}): MatchInput => ({
  make: "Nissan", model: "Skyline", firstRegistration: null, mileageKm: null, market: "DE",
  sellerName: null, priceBase: 44_900, imageHash: null, powerW: null,
  title: "Nissan Skyline 280 PS | Seltenes Fahrzeug", ...over,
});

test("two bare cards with the same photo are not one car", () => {
  // Found on prod: a Nismo card joined the Rodenbach card. Both state nothing, so both
  // had the key "nissan|skyline|x|x|DE", and with a shared image hash the score reached 0.74.
  const rodenbach = card({ imageHash: "same" });
  const nismo = card({
    imageHash: "same", priceBase: 40_000, title: "Nissan Skyline Nismo 280 PS | Seltenes Fahrzeug",
  });

  assert.ok(matchScore(nismo, rodenbach) < 0.72, `score ${matchScore(nismo, rodenbach).toFixed(2)}`);
  assert.equal(isSameVehicle(nismo, rodenbach), false);
});

test("a key counts as evidence only when something in it is known on both sides", () => {
  const known = card({ firstRegistration: "1999-02", mileageKm: 36_500 });
  const sameKnown = card({ firstRegistration: "1999-02", mileageKm: 36_500 });
  const bare = card();

  assert.ok(matchScore(known, sameKnown) > matchScore(known, bare));
  assert.ok(matchScore(known, bare) < 0.5);
});

test("the strongest rule wins when several cars fit", () => {
  const incoming = card({
    firstRegistration: "1999-02", mileageKm: 36_500, priceBase: 40_000, city: "Magdeburg",
    postalCode: "39128", title: "Nissan Skyline R34 GTT Nismo",
  });
  const exact = card({
    firstRegistration: "1999-02", mileageKm: 36_500, priceBase: 40_000, city: "Magdeburg",
    postalCode: "39128", title: "Nissan Skyline R34 GTT Nismo",
  });
  const sparse = card({ priceBase: 40_000, city: "Magdeburg", postalCode: "39128" });

  assert.ok(isCertainMatch(incoming, exact));
  const exactRank = matchRank(incoming, exact);
  const sparseRank = matchRank(incoming, sparse);
  assert.ok(exactRank !== null && sparseRank !== null);
  assert.ok(exactRank > sparseRank, `${String(exactRank)} against ${String(sparseRank)}`);
  assert.equal(matchRank(incoming, card({ make: "Honda", model: "Civic" })), null);
});

test("the postal code decides the place when both sides have one", () => {
  const a = card({ city: "Altstadt-Lehel", postalCode: "80331" });

  assert.ok(samePlace(a, card({ city: "München", postalCode: "80331" })), "a district and its city");
  assert.equal(samePlace(card({ city: "Neustadt", postalCode: "01844" }),
    card({ city: "Neustadt", postalCode: "67433" })), false, "two towns of one name");
  assert.ok(samePlace(card({ city: "Velbert" }), card({ city: "velbert", postalCode: "42551" })),
    "without codes on both sides the city decides");
  assert.equal(samePlace(card({ postalCode: "42551" }), card({ city: "Velbert" })), false,
    "a place unknown on a side is not the same place");
});

test("the same-place rule works from the postal code when a card has no city", () => {
  const live = card({
    firstRegistration: "1999-03", mileageKm: 178_000, priceBase: 24_490, postalCode: "42499",
    sellerType: "private", title: "Nissan Skyline R34 GT-T 1999 TÜV Neu Unverbastelt",
  });
  const card2 = card({
    firstRegistration: "1998-06", mileageKm: 169_800, priceBase: 26_990, postalCode: "42499",
    sellerType: "private", title: "Nissan Skyline R34 GT-T Unverbastelt TÜV NEU 4-Türer",
  });

  assert.ok(isSamePlaceMatch(live, card2));
  assert.equal(isSamePlaceMatch(live, { ...card2, postalCode: "42551" }), false);
});
