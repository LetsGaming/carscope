import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_CRITERIA, wattToPs, type Criteria } from "@carscope/core";
import {
  autoUncle, carObjects, flightPayload,
} from "../../packages/collector/src/adapters/autouncle.ts";

const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "autouncle-list.html"),
  "utf8",
);
const spec = { url: "https://www.autouncle.de/de/gebrauchtwagen/Nissan/Skyline" };
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

test("listings come out of the Next.js flight payload", () => {
  const payload = flightPayload(FIXTURE);
  assert.ok(payload.length > 100_000, "the pushed chunks reassemble");
  assert.equal(carObjects(payload).length, 19);
});

test("every portal on the page is represented, including one we cannot read directly", () => {
  const parsed = autoUncle.parseList(FIXTURE, spec);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
  assert.equal(parsed.value.listings.length, 19);

  // This is the point of the adapter: mobile.de blocks us, AutoUncle does not.
  const titles = parsed.value.listings.map((l) => l.title).join(" ");
  assert.ok(titles.length > 0);
  for (const l of parsed.value.listings) {
    assert.match(l.url, /^https:\/\/www\.autouncle\.de\/de\/d\//);
    assert.ok(l.price > 100, `implausible price ${String(l.price)}`);
    assert.ok(l.photoUrls.length > 0);
  }
});

test("attributes arrive complete, not as a title to be guessed from", () => {
  const parsed = autoUncle.parseList(FIXTURE, spec);
  assert.ok(parsed.ok);
  const first = parsed.value.listings[0];
  assert.ok(first);

  assert.equal(first.attributes.make, "Nissan");
  assert.equal(first.attributes.model, "Skyline");
  assert.equal(first.attributes.mileageKm, 103_000);
  assert.equal(wattToPs(first.attributes.powerW ?? 0), 280);
  assert.equal(first.attributes.firstRegistration, "1999-05", "the month is resolved, not just the year");
  assert.equal(first.attributes.gearbox, "manual");
  assert.equal(first.attributes.bodyStyle, "coupe");
  assert.equal(first.attributes.sellerType, "dealer");
});

test("power and gearbox differ per listing", () => {
  const parsed = autoUncle.parseList(FIXTURE, spec);
  assert.ok(parsed.ok);
  const powers = new Set(parsed.value.listings.map((l) => l.attributes.powerW));
  const gearboxes = new Set(parsed.value.listings.map((l) => l.attributes.gearbox));
  assert.ok(powers.size >= 4, `only ${String(powers.size)} distinct power values`);
  assert.deepEqual([...gearboxes].sort(), ["automatic", "manual"]);
});

test("a page with neither cards nor flight data is a failure, not an empty result", () => {
  const parsed = autoUncle.parseList("<html><body>nichts</body></html>", spec);
  assert.equal(parsed.ok, false);
  assert.match(parsed.ok ? "" : parsed.error.message, /keine auswertbaren Inserate/);
});

test("a card the browser rendered is read even with no flight chunk behind it", () => {
  // Streamed chunks only carry what was sent with the document; a card added
  // during hydration exists on the page and in no chunk at all.
  const card = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "autouncle-card.html"),
    "utf8",
  );
  const parsed = autoUncle.parseList(card, spec);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);

  const listing = parsed.value.listings[0];
  assert.equal(listing?.sourceListingId, "224706435");
  assert.equal(listing?.price, 41_999);
  assert.equal(listing?.attributes.mileageKm, 145_000);
  assert.equal(wattToPs(listing?.attributes.powerW ?? 0), 280);
  assert.equal(listing?.attributes.firstRegistration, "1998-08");
  assert.equal(listing?.attributes.gearbox, "automatic");
  assert.equal(listing?.attributes.bodyStyle, "sedan");
  assert.equal(listing?.attributes.fuel, "petrol");
  assert.equal(listing?.attributes.postalCode, "14547");
  assert.equal(listing?.attributes.city, "Brandenburg", "and not the button after it");
  assert.ok(listing?.attributes.firstListedAt !== null, "Tage inseriert gives the listing date");
});

test("a query with no recognisable make is refused", () => {
  const { skip } = autoUncle.buildQuery({ ...EMPTY_CRITERIA, text: "roter kombi" }, 1, DE);
  assert.match(skip ?? "", /keine Marke erkannt/);
});

test("days on market come from the portal, not from when we first looked", () => {
  const parsed = autoUncle.parseList(FIXTURE, spec);
  assert.ok(parsed.ok);

  const dated = parsed.value.listings.filter((l) => l.attributes.firstListedAt != null);
  assert.ok(dated.length > 10, "AutoUncle states laytime for most listings");

  const today = new Date().toISOString().slice(0, 10);
  for (const l of dated) {
    assert.match(l.attributes.firstListedAt ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.ok((l.attributes.firstListedAt ?? "") <= today, "an advert cannot start in the future");
  }
  assert.ok(new Set(dated.map((l) => l.attributes.firstListedAt)).size > 3, "and they differ per listing");
});

test("a listing is identified by its id, not by having complete data", () => {
  const payload = flightPayload(FIXTURE);
  const cars = carObjects(payload);

  // 99 objects mention vdpPath; only the listings carry a carId. Requiring
  // mileage and year instead would drop any listing missing either.
  assert.equal(cars.length, 19);
  assert.ok(cars.every((c) => typeof c["carId"] === "string"));

  const sparse = '<script>self.__next_f.push([1,"'
    + JSON.stringify(JSON.stringify({ carId: "1", vdpPath: "/de/d/1", price: "9.000 €", title: "Nissan Skyline" })).slice(1, -1)
    + '"])</script>';
  const parsed = autoUncle.parseList(sparse, spec);
  assert.ok(parsed.ok, "a listing with no mileage or year is still a listing");
  assert.equal(parsed.value.listings[0]?.attributes.mileageKm, null);
});

test("a page reports no count it cannot measure", () => {
  // Two counts were tried and both lied. The search-wide total called normal
  // pagination a loss ("25 von 41"), and counting rendered <article> elements
  // counted the featured-cars carousel, reporting seventeen unreadable cards on
  // a page whose seventeen listings had all been read.
  const parsed = autoUncle.parseList(FIXTURE, spec);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.listings.length, 19);
  assert.equal(parsed.value.note, undefined);

  const withCarousel = `${FIXTURE}${"<article class=\"promo\"><a href=\"/de/d/999111\">Jaguar XK8</a></article>".repeat(17)}`;
  const again = autoUncle.parseList(withCarousel, spec);
  assert.ok(again.ok);
  assert.equal(again.value.note, undefined, "unrelated articles are not counted as unread results");
});

