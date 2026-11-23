import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMPTY_CRITERIA, type Criteria } from "@carscope/core";
import { kleinanzeigen } from "../../packages/collector/src/adapters/kleinanzeigen.ts";

// Two cards and a repeat of the first, cut from a captured result page: a priced car,
// a car whose card says only "VB", and the priced car listed again as a top advert.
const PAGE = readFileSync(new URL("../fixtures/kleinanzeigen-list-vb.html", import.meta.url), "utf8");
const withRange = (range: string): string => PAGE.replace("{range}", range);
const spec = { url: "https://www.kleinanzeigen.de/s-autos/x" };

const parse = (body: string) => {
  const parsed = kleinanzeigen.parseList(body, spec);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  return parsed.value;
};

test("a car listed twice on one page is one listing", () => {
  const page = parse(withRange("1 - 25 von 40"));
  assert.deepEqual(page.listings.map((l) => l.sourceListingId), ["3564088235", "3561267761"]);
});

test("a card that states no amount is kept at 0 instead of dropped", () => {
  const byId = new Map(parse(withRange("1 - 25 von 40")).listings.map((l) => [l.sourceListingId, l]));

  assert.equal(byId.get("3564088235")?.price, 39_999);
  const vb = byId.get("3561267761");
  assert.equal(vb?.price, 0, "VB without a number");
  assert.equal(vb?.attributes.mileageKm, 178_000);
  assert.equal(vb?.attributes.firstRegistration, "1999-03");
  assert.equal(vb?.attributes.postalCode, "42499");
});

test("the page says whether another page follows", () => {
  assert.equal(parse(withRange("1 - 25 von 40")).hasMore, true);
  assert.equal(parse(withRange("26 - 40 von 40")).hasMore, false, "the last page of 40");
  assert.equal(parse(withRange("1 - 2 von 2")).hasMore, false, "everything fits on one page");
  assert.equal(parse(withRange("1 - 25 von 1.040")).hasMore, true, "thousands use a dot");
});

test("without a range the next link decides, and without both the runner decides", () => {
  const noRange = PAGE.replace(/<span id="srp-breadcrumb-summary"[^>]*>[^<]*<\/span>/, "");
  assert.equal(parse(noRange).hasMore, true, "a page of cars and nothing else to go by");
  assert.equal(
    parse(noRange.replace("<body>", '<body><a aria-label="Nächste" href="x">'.concat("</a>"))).hasMore, true,
  );
});

test("the query asks for offers only, not for what buyers want", () => {
  const url = kleinanzeigen.buildQuery({ ...EMPTY_CRITERIA, text: "Nissan Skyline" } as Criteria, 1, {
    market: "DE", hints: {},
  }).url;
  assert.match(url, /\/anzeige:angebote\//);
});
