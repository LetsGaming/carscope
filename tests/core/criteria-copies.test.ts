import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyCriteria, emptyCriteria, EMPTY_CRITERIA, EMPTY_RANGE, MARKET,
} from "@carscope/core";
import {
  copyCriteria as copyEditable, emptyCriteria as emptyEditable,
} from "../../apps/web/src/lib/types.ts";

const RANGES = ["priceEur", "mileageKm", "registrationYear", "powerPs"] as const;

test("a fresh criteria object shares nothing between its ranges", () => {
  // One shared EMPTY_RANGE across all four fields meant typing a minimum price
  // filled the mileage, year and power minimums with the same number.
  const c = emptyCriteria();
  for (const a of RANGES) {
    for (const b of RANGES) {
      if (a !== b) assert.notEqual(c[a], c[b], `${a} and ${b} are the same object`);
    }
    assert.notEqual(c[a], EMPTY_RANGE, `${a} still points at the shared constant`);
  }
});

test("writing to one range of a fresh criteria leaves the others alone", () => {
  const c = emptyEditable();
  c.priceEur.min = 5_000;

  assert.equal(c.priceEur.min, 5_000);
  assert.equal(c.mileageKm.min, null);
  assert.equal(c.registrationYear.min, null);
  assert.equal(c.powerPs.min, null);
  assert.equal(EMPTY_CRITERIA.priceEur.min, null, "the shared constant is untouched");
});

test("the shared constants refuse to be written to", () => {
  // Freezing turns the next accidental shallow copy into a loud failure at the
  // line that causes it, rather than a form that fills its own fields.
  assert.throws(() => {
    Object.assign(EMPTY_CRITERIA.priceEur, { min: 1 });
  }, TypeError);
  assert.throws(() => {
    Object.assign(EMPTY_CRITERIA, { text: "x" });
  }, TypeError);
});

test("copying a search gives the form its own ranges and markets", () => {
  const saved = {
    ...emptyCriteria(),
    priceEur: { min: 10_000, max: 20_000 },
    markets: [MARKET.de, MARKET.at],
  };

  const copy = copyEditable(saved);
  copy.priceEur.max = 99_000;
  copy.markets.push(MARKET.ch);

  assert.equal(saved.priceEur.max, 20_000, "the saved search kept its price");
  assert.deepEqual([...saved.markets], [MARKET.de, MARKET.at], "and its countries");
  assert.equal(copy.priceEur.min, 10_000, "while the copy carried the values over");
});

test("a domain copy is independent too", () => {
  const original = { ...emptyCriteria(), mileageKm: { min: 0, max: 90_000 } };
  const copy = copyCriteria(original);
  assert.notEqual(copy.mileageKm, original.mileageKm);
  assert.deepEqual(copy.mileageKm, original.mileageKm);
});

test("every fresh criteria object is a new one", () => {
  const a = emptyCriteria();
  const b = emptyCriteria();
  assert.notEqual(a, b);
  assert.notEqual(a.priceEur, b.priceEur);
  assert.notEqual(a.markets, b.markets);
});
