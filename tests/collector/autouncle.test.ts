import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EMPTY_CRITERIA, type Criteria } from "@carscope/core";
import { autoUncle, domListings } from "../../packages/collector/src/adapters/autouncle.ts";

const fixture = readFileSync(
  fileURLToPath(new URL("../fixtures/autouncle-de.html", import.meta.url)),
  "utf8",
);
const SEARCH = "https://www.autouncle.de/de/gebrauchtwagen/Nissan/Skyline?s%5Bmin_hp%5D=280";
const DE = { market: "DE", hints: {} } as const;

const R34: Criteria = {
  ...EMPTY_CRITERIA,
  text: "Nissan Skyline",
  registrationYear: { min: 1998, max: 2002 },
  powerPs: { min: 280, max: null },
};

test("the search url matches the one the site produces", () => {
  const { url, skip } = autoUncle.buildQuery(R34, 1, DE);
  assert.equal(skip, undefined);
  const parsed = new URL(url);
  assert.equal(parsed.pathname, "/de/gebrauchtwagen/Nissan/Skyline");
  assert.equal(parsed.searchParams.get("s[min_year]"), "1998");
  assert.equal(parsed.searchParams.get("s[max_year]"), "2002");
  assert.equal(parsed.searchParams.get("s[min_hp]"), "280", "AutoUncle filters in PS");
});

test("a query with no recognisable make is refused", () => {
  const { skip } = autoUncle.buildQuery({ ...EMPTY_CRITERIA, text: "roter kombi" }, 1, DE);
  assert.match(skip ?? "", /keine Marke erkannt/);
});

test("every rendered card is read from the DOM, with the payload gone", () => {
  assert.equal(domListings(fixture, SEARCH).length, 3);
});

test("make and model come from the search, variant and specs from the card", () => {
  const [first] = domListings(fixture, SEARCH);
  assert.ok(first);
  assert.equal(first.sourceListingId, "225473608");
  assert.equal(first.price, 36000);
  assert.equal(first.url, "https://www.autouncle.de/de/d/225473608-gebraucht-1998-nissan-skyline-280-ps");
  assert.equal(first.attributes.make, "Nissan");
  assert.equal(first.attributes.model, "Skyline");
  assert.equal(first.attributes.variant, "R34 GTT");
  assert.equal(first.attributes.mileageKm, 134000);
  assert.equal(first.attributes.powerW, 205940); // 280 PS
  assert.equal(first.attributes.firstRegistration, "1998");
  assert.equal(first.attributes.gearbox, "automatic");
  assert.equal(first.attributes.bodyStyle, "sedan");
  assert.equal(first.attributes.fuel, "petrol");
  assert.equal(first.attributes.market, "DE");
});

test("a month is kept when the card states one", () => {
  const listing = domListings(fixture, SEARCH).find((l) => l.sourceListingId === "224706435");
  assert.equal(listing?.attributes.firstRegistration, "1998-08");
});

test('"PLZ Stadt, Region" yields both; "PLZ, Region" yields no city', () => {
  const byId = new Map(domListings(fixture, SEARCH).map((l) => [l.sourceListingId, l]));
  assert.equal(byId.get("225473608")?.attributes.postalCode, "22848");
  assert.equal(byId.get("225473608")?.attributes.city, "Norderstedt");
  // "14547, Brandenburg" is a postal code and a federal state, with no city between.
  assert.equal(byId.get("224706435")?.attributes.postalCode, "14547");
  assert.equal(byId.get("224706435")?.attributes.city, null);
});

test("a card with no subtitle carries no variant rather than an empty one", () => {
  const listing = domListings(fixture, SEARCH).find((l) => l.sourceListingId === "224706435");
  assert.equal("variant" in (listing?.attributes ?? {}), false);
});

test("listings are attributed to the source, not to any advert origin", () => {
  for (const listing of domListings(fixture, SEARCH)) {
    assert.equal("origin" in listing, false);
  }
});

test("the featured-cars strip advertising another model is left out", () => {
  const foreign = `<article class="_qzVn4">`
    + `<a class="_p9jqN" href="/de/d/999999999-gebraucht-2019-bmw-m3"></a>`
    + `<div class="_2NWrX"><h3>Gebraucht (2019) BMW M3 Competition</h3><p>Competition</p></div>`
    + `<div class="_i2QOc">59.000&nbsp;\u20ac</div>`
    + `</article>`;
  const listings = domListings(fixture + foreign, SEARCH);
  assert.equal(listings.length, 3, "the BMW card does not name the searched model");
  assert.equal(listings.some((l) => l.sourceListingId === "999999999"), false);
});

test("parseList returns the cards and does not page into an empty second page", () => {
  const parsed = autoUncle.parseList(fixture, { url: SEARCH });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.listings.length, 3);
  assert.equal(parsed.value.hasMore, false);
});

test("a page with no cards is a parse failure, not silent success", () => {
  const parsed = autoUncle.parseList("<html><body>Keine Treffer</body></html>", { url: SEARCH });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error.message, /keine auswertbaren Inserate/);
});
