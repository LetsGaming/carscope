import { test } from "node:test";
import assert from "node:assert/strict";
import { HOLD, holdReason, type HoldInput } from "../../packages/core/src/hold.ts";

const base: HoldInput = {
  titles: ["Nissan Skyline R34 GT-T"], urls: [], description: null,
  make: "Nissan", model: "Skyline", priceBase: 30_000,
};

// Excerpts of the adverts found on prod.
test("a wanted ad that opens with 'Suche' is held, whatever its price", () => {
  const ad: HoldInput = {
    ...base,
    description: "Suche Nissan Skyline R34 GTT mit GTR Style Bodykit. Am Fahrzeug sollte alles eingetragen sein.",
    priceBase: 1,
  };
  assert.equal(holdReason(ad), HOLD.wanted);
});

test("a wanted ad is recognised by its URL slug alone", () => {
  const ad: HoldInput = {
    ...base,
    urls: ["https://www.kleinanzeigen.de/s-anzeige/-suche-nissan-skyline-r34-gt-t/3522639940-216-2032"],
  };
  assert.equal(holdReason(ad), HOLD.wanted);
});

test("a wanted ad that greets first is still held", () => {
  const ad: HoldInput = {
    ...base,
    description: "Hallo allerseits,\n\nich suche nach einem Nissan Skyline R34 GT-T in der Coupe oder Limousinen Variante.",
    priceBase: 25_000,
  };
  assert.equal(holdReason(ad), HOLD.wanted);
});

test("titles that start with a wanted marker are held", () => {
  for (const title of ["[Suche] Nissan Skyline", "Gesuch: Nissan Skyline R34", "Ankauf Nissan Skyline"]) {
    assert.equal(holdReason({ ...base, titles: [title] }), HOLD.wanted, title);
  }
});

test("a seller who uses the word 'suche' is not a buyer", () => {
  for (const description of [
    "Ich suche einen neuen Besitzer für meinen Nissan Skyline R34.",
    "Nissan Skyline R34 GT-T, suche keinen Tausch, nur Verkauf.",
    "Verkaufe meinen Skyline. Suche nach 6 Jahren ein neues Zuhause für ihn.",
  ]) {
    assert.equal(holdReason({ ...base, description }), null, description);
  }
});

test("a price under 100 euro is a placeholder", () => {
  assert.equal(holdReason({ ...base, priceBase: 1 }), HOLD.placeholderPrice);
  assert.equal(holdReason({ ...base, priceBase: 99 }), HOLD.placeholderPrice);
  assert.equal(holdReason({ ...base, priceBase: 100 }), null);
});

test("a seller who says the price is a placeholder gets held, at any price", () => {
  const ad: HoldInput = {
    ...base,
    description: "PREIS IN DER ANZEIGE DIENT NUR ALS PLATZHALTER!!!\n\nZum Verkauf steht ein Nissan Skyline R34 GT-T",
    priceBase: 11_111,
  };
  assert.equal(holdReason(ad), HOLD.placeholderPrice);
});

test("a price that merely looks typed is a real price", () => {
  // The Velbert R34 really costs 44444 euro.
  for (const priceBase of [44_444, 11_111, 9_999, 12_345]) {
    assert.equal(holdReason({ ...base, priceBase }), null, String(priceBase));
  }
});

test("no price known yet holds nothing", () => {
  assert.equal(holdReason({ ...base, priceBase: null }), null);
});

test("a license plate holder is not a price placeholder", () => {
  assert.equal(holdReason({ ...base, description: "Inklusive Kennzeichen Platzhalter und Schlüssel." }), null);
});
