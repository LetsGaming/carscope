import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kleinanzeigen } from "../../packages/collector/src/adapters/kleinanzeigen.ts";
import { cleanVariant } from "../../packages/collector/src/text.ts";

const PAGE = readFileSync(new URL("../fixtures/kleinanzeigen-detail.html", import.meta.url), "utf8");

const gearboxOf = (body: string): string | null | undefined => {
  const parsed = kleinanzeigen.parseDetail?.(body);
  if (parsed === undefined || !parsed.ok) throw new Error("detail did not parse");
  return parsed.value.attributes?.gearbox;
};

test("the gearbox comes from the details list of the ad page", () => {
  assert.equal(gearboxOf(PAGE), "manual");
  assert.equal(gearboxOf(PAGE.replace(/Manuell/, "Automatik")), "automatic");
});

test("a word in the seller's text never decides the gearbox", () => {
  const shouted = PAGE.replace("Angeboten wird", "Mit Klimaautomatik, Lichtautomatik und Automatik-Kennlinie. Angeboten wird");
  assert.equal(gearboxOf(shouted), "manual", "the details list says Manuell");

  const without = PAGE.replace(/<li[^>]*>\s*Getriebe[\s\S]*?<\/li>/, "");
  assert.equal(gearboxOf(without.replace("Angeboten wird", "Automatik. Angeboten wird")), null,
    "no details entry: unknown, not guessed from the text");
});

test("an urgency note is not part of an AutoUncle variant", () => {
  assert.equal(cleanVariant("R34 nur noch 2 Tage online"), "R34");
  assert.equal(cleanVariant("R34 GTT"), "R34 GTT");
  assert.equal(cleanVariant("nur noch 1 Tag online"), null);
  assert.equal(cleanVariant(null), null);
});
