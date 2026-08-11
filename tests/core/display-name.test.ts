import { test } from "node:test";
import assert from "node:assert/strict";
import { displayName } from "@carscope/core";

/**
 * One portal stored "NISSAN SKYLINE" and the next "Nissan Skyline", so the same
 * car read as two different cars in the list. Dedup was never affected, because
 * identity keys are case-folded; this is only about what a reader sees.
 */
test("a shouted name is settled", () => {
  assert.equal(displayName("NISSAN SKYLINE"), "Nissan Skyline");
  assert.equal(displayName("ALFA ROMEO GIULIA"), "Alfa Romeo Giulia");
});

test("a name already written properly is left alone", () => {
  assert.equal(displayName("Nissan Skyline"), "Nissan Skyline");
  assert.equal(displayName("Land Rover"), "Land Rover");
});

test("makes that really are upper case stay that way", () => {
  // Blind title casing turns BMW into Bmw, which is worse than the shouting.
  for (const make of ["BMW", "VW", "MG", "DS", "GMC", "RAM", "KIA"]) {
    assert.equal(displayName(make), make);
  }
  assert.equal(displayName("VW GOLF"), "VW Golf");
});

test("anything carrying a digit is left exactly as found", () => {
  // The meaning lives in the characters: a chassis code, an engine, a model.
  assert.equal(displayName("SKYLINE R34"), "Skyline R34");
  assert.equal(displayName("RB25DET"), "RB25DET");
  assert.equal(displayName("PORSCHE 911"), "Porsche 911");
  assert.equal(displayName("320D"), "320D");
});

test("a hyphenated name is judged one part at a time", () => {
  assert.equal(displayName("GT-R"), "GT-R", "two letters either side stay");
  assert.equal(displayName("MERCEDES-BENZ C-KLASSE"), "Mercedes-Benz C-Klasse");
});

test("nothing is invented for an empty name", () => {
  assert.equal(displayName(""), "");
});
