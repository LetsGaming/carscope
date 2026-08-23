import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_CRITERIA, wattToPs, type Criteria } from "@carscope/core";
import { mobileDe } from "../../packages/collector/src/adapters/mobilede.ts";
import { kleinanzeigen } from "../../packages/collector/src/adapters/kleinanzeigen.ts";
import { autoScout24 } from "../../packages/collector/src/adapters/autoscout24.ts";

/** Every query is built for one country; the source covers several. */
const DE = { market: "DE", hints: {} } as const;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/** Captured from live result pages, trimmed to three listings each. */
const PAGES = {
  mobile: fixture("mobilede-list.html"),
  kleinanzeigen: fixture("kleinanzeigen-list.html"),
  autoscout: fixture("autoscout24-list.html"),
  autoscoutDetail: fixture("autoscout24-detail.html"),
};

const spec = { url: "https://www.autoscout24.de/lst" };

test("mobile.de reads listings from the rendered page", () => {
  const parsed = mobileDe.parseList(PAGES.mobile, spec);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  const listings = parsed.value.listings;
  assert.ok(listings.length >= 2, `expected listings, got ${String(listings.length)}`);

  for (const l of listings) {
    assert.match(l.sourceListingId, /^\d+$/);
    assert.match(l.url, /^https:\/\/suchen\.mobile\.de\/fahrzeuge\/details\.html\?id=\d+$/);
    assert.ok(l.price > 100, `implausible price ${String(l.price)}`);
    assert.ok(l.title.length > 3);
    assert.ok(!/\d[\d.]*\s*€/.test(l.title), `price leaked into the title: ${l.title}`);
  }
});

test("mobile.de reads the seller block past its inline icon", () => {
  const parsed = mobileDe.parseList(PAGES.mobile, spec);
  assert.ok(parsed.ok);
  const places = parsed.value.listings.map((l) => l.attributes.postalCode).filter(Boolean);
  assert.ok(places.length > 0, "the address survived the inline SVG");
  for (const l of parsed.value.listings) {
    assert.ok(l.attributes.sellerType === "private" || l.attributes.sellerType === "dealer");
    assert.ok(!/\d{4,5}/.test(l.attributes.sellerName ?? ""), "a dealer name never carries the postal code");
  }
});

test("mobile.de power and gearbox vary per listing", () => {
  const parsed = mobileDe.parseList(PAGES.mobile, spec);
  assert.ok(parsed.ok);
  const powers = parsed.value.listings.map((l) => l.attributes.powerW).filter((p) => p != null);
  assert.ok(powers.length >= 2, "power was read at all");
  for (const w of powers) {
    const ps = wattToPs(w);
    assert.ok(ps > 40 && ps < 1200, `implausible ${String(ps)} PS`);
  }
});

test("mobile.de captures registration, mileage and place", () => {
  const parsed = mobileDe.parseList(PAGES.mobile, spec);
  assert.ok(parsed.ok);
  const first = parsed.value.listings[0];
  assert.ok(first);
  assert.match(first.attributes.firstRegistration ?? "", /^\d{4}-\d{2}$/);
  assert.ok((first.attributes.mileageKm ?? 0) > 0);
  assert.ok(first.photoUrls.length > 0, "photo urls were found");
});

test("kleinanzeigen reads listings from data-adid articles", () => {
  const parsed = kleinanzeigen.parseList(PAGES.kleinanzeigen, spec);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  const listings = parsed.value.listings;
  assert.equal(listings.length, 3);

  for (const l of listings) {
    assert.match(l.sourceListingId, /^\d+$/);
    assert.match(l.url, /^https:\/\/www\.kleinanzeigen\.de\/s-anzeige\//);
    assert.ok(l.price > 100);
    assert.ok(l.photoUrls.length > 0, "the embedded ImageObject supplied a photo");
    assert.match(l.attributes.postalCode ?? "", /^\d{5}$/);
  }
});

test("kleinanzeigen builds the two-grammar filter URL", () => {
  const criteria: Criteria = {
    ...EMPTY_CRITERIA,
    make: "Nissan", model: "Skyline R34",
    sellerType: "private",
    powerPs: { min: 280, max: null },
    gearbox: "manual",
  };
  const { url } = kleinanzeigen.buildQuery(criteria, 1, DE);
  // Generic filters are path segments; category attributes follow k0c216 with +.
  assert.ok(url.includes("/anbieter:privat/"), url);
  assert.ok(url.includes("/nissan-skyline-r34/"), url);
  assert.ok(url.includes("k0c216+"), url);
  assert.ok(url.includes("autos.power_i:280,"), "ranges use a comma, not a colon");
  assert.ok(url.includes("autos.shift_s:manuell"), "gearbox values are German");
  assert.ok(!url.includes("autos.gearbox_s"), "the invented attribute name is gone");
});

test("autoscout24 reads the page state blob", () => {
  const parsed = autoScout24.parseList(PAGES.autoscout, spec);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  const listings = parsed.value.listings;
  assert.equal(listings.length, 3);

  const first = listings[0];
  assert.ok(first);
  assert.equal(first.attributes.make, "Nissan");
  assert.equal(first.attributes.model, "Skyline");
  assert.match(first.url, /^https:\/\/www\.autoscout24\.de\/angebote\//);
  assert.equal(first.attributes.firstRegistration, "1999-05", "MM-YYYY is converted to YYYY-MM");
  assert.equal(first.attributes.mileageKm, 103_000);
  assert.equal(wattToPs(first.attributes.powerW ?? 0), 280, "power comes from vehicleDetails");
  assert.equal(first.attributes.gearbox, "manual");
  assert.equal(first.attributes.sellerType, "private");
  assert.equal(first.attributes.postalCode, "57520");
});

test("autoscout24 photos are upsized from the list page's thumbnail size to full resolution", () => {
  const parsed = autoScout24.parseList(PAGES.autoscout, spec);
  assert.ok(parsed.ok);
  const first = parsed.value.listings[0];
  assert.ok(first);
  assert.ok(first.photoUrls.length > 0, "the list page carries photos at all");
  for (const url of first.photoUrls) {
    assert.match(url, /\/1920x1080\.webp$/, `expected full resolution, got ${url}`);
  }
});

test("autoscout24 reads the seller notes off the detail page, line breaks intact", () => {
  assert.ok(autoScout24.parseDetail);
  const parsed = autoScout24.parseDetail(PAGES.autoscoutDetail);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  const description = parsed.value.attributes?.description ?? null;
  assert.match(description ?? "", /FAHRZEUGDATEN:/);
  assert.match(description ?? "", /\n/, "the seller's own line breaks survive");
  assert.equal("photoUrls" in parsed.value, false, "the list page already ships every photo");
});

test("every adapter reports a failure rather than silence on an unknown page", () => {
  const junk = "<html><body>nichts hier</body></html>";
  for (const adapter of [mobileDe, kleinanzeigen, autoScout24]) {
    const parsed = adapter.parseList(junk, spec);
    assert.equal(parsed.ok, false, `${adapter.id} must not return zero results silently`);
  }
});
