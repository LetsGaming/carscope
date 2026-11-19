import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { autoUncle } from "../../packages/collector/src/adapters/autouncle.ts";

const PAGE = readFileSync(new URL("../fixtures/autouncle-detail-facts.html", import.meta.url), "utf8");

test("the detail page fills in what a bare card never stated", () => {
  const parsed = autoUncle.parseDetail?.(PAGE);
  assert.ok(parsed?.ok, "the detail parses");
  const a = parsed.value.attributes;

  assert.equal(a?.mileageKm, 86_933);
  assert.equal(a?.firstRegistration, "1998-06");
  assert.equal(a?.powerW, 205_940, "280 PS, as every other portal states it");
  assert.equal(a?.gearbox, "manual");
  assert.equal(a?.fuel, "petrol");
  assert.equal(a?.bodyStyle, "sedan");
});

test("a page without the technical data adds nothing", () => {
  const parsed = autoUncle.parseDetail?.("<html><body><p>Kein Treffer</p></body></html>");
  assert.ok(parsed?.ok);
  assert.deepEqual(parsed.value.attributes, {});
});
