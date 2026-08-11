import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CRITERIA, type Criteria } from "@carscope/core";
import { customAdapter } from "../../packages/collector/src/adapters/custom.ts";

const DE = { market: "DE", hints: {} } as const;

const source = customAdapter({
  id: "beispiel",
  label: "Beispiel",
  markets: ["DE"],
  requiresMake: true,
  url: "https://portal.invalid/suche?marke={makeSlug}&modell={modelSlug}"
    + "&preis_min={priceMin}&preis_max={priceMax}&ez_von={yearMin}&kw_min={kwMin}&seite={page}",
});

const R34: Criteria = {
  ...EMPTY_CRITERIA,
  text: "Nissan Skyline R34",
  priceEur: { min: null, max: 60_000 },
  registrationYear: { min: 1998, max: null },
  powerPs: { min: 280, max: null },
};

test("a configured source fills its tokens from the criteria", () => {
  const { url } = source.buildQuery(R34, 2, DE);
  const q = new URL(url).searchParams;
  assert.equal(q.get("marke"), "nissan");
  assert.equal(q.get("modell"), "skyline");
  assert.equal(q.get("preis_max"), "60000");
  assert.equal(q.get("ez_von"), "1998");
  assert.equal(q.get("kw_min"), "206", "PS is offered in kilowatts too");
  assert.equal(q.get("seite"), "2");
});

test("an unset filter is left out rather than sent empty", () => {
  const { url } = source.buildQuery(R34, 1, DE);
  assert.equal(new URL(url).searchParams.has("preis_min"), false);
  assert.ok(!url.includes("preis_min="), url);
});

test("a source that needs a make refuses a query without one", () => {
  const { skip } = source.buildQuery({ ...EMPTY_CRITERIA, text: "roter kombi" }, 1, DE);
  assert.match(skip ?? "", /keine Marke erkannt/);
});

test("vehicles are read from schema.org data, bare or inside a list", () => {
  const car = {
    "@type": "Car",
    url: "/inserat/4711",
    name: "Nissan Skyline R34 GT-T",
    offers: { price: "38500", availableAtOrFrom: { address: { postalCode: "31134", addressLocality: "Hildesheim" } } },
    mileageFromOdometer: { value: 96_400 },
    vehicleEngine: { enginePower: { value: 206, unitText: "PS" } },
    productionDate: "1999-06",
    image: ["https://portal.invalid/a.jpg", "https://portal.invalid/b.jpg"],
  };
  const page = `<script type="application/ld+json">${JSON.stringify({
    "@type": "ItemList", itemListElement: [{ "@type": "ListItem", item: car }],
  })}</script>`;

  const parsed = source.parseList(page, { url: "https://portal.invalid/suche" });
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);

  const listing = parsed.value.listings[0];
  assert.equal(listing?.url, "https://portal.invalid/inserat/4711", "a relative url is resolved");
  assert.equal(listing?.price, 38_500);
  assert.equal(listing?.attributes.mileageKm, 96_400);
  assert.equal(listing?.attributes.firstRegistration, "1999-06");
  assert.equal(listing?.attributes.postalCode, "31134");
  assert.equal(listing?.photoUrls.length, 2);
});

test("a page without schema.org data is a failure, never an empty result", () => {
  const parsed = source.parseList("<html><body>nichts</body></html>", { url: "https://portal.invalid/suche" });
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error.message, /schema\.org/);
});
