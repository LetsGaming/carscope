import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kleinanzeigen } from "@carscope/collector";

const FIXTURE = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "kleinanzeigen-list.html"),
  "utf8",
);
const spec = { url: "https://www.kleinanzeigen.de/s-autos/nissan/k0c216" };

/**
 * Every advert used to arrive with the one thumbnail in its article markup, and
 * the gallery was the reason a detail page was fetched per car: about seven
 * seconds each, which spent a whole run's budget on eleven of them. The list
 * page ships the data its own client hydrates from, and the galleries are in it.
 */
test("galleries come from the list page, not from a page per car", () => {
  const parsed = kleinanzeigen.parseList(FIXTURE, spec);
  assert.ok(parsed.ok);

  const byId = new Map(parsed.value.listings.map((l) => [l.sourceListingId, l]));
  assert.equal(byId.get("3476304951")?.photoUrls.length, 17);
  assert.equal(byId.get("3469172151")?.photoUrls.length, 11);
});

test("each gallery stays with its own advert", () => {
  // Bounding the scan by the next advert instead of by the array swept up
  // whatever sat between them and hung another car's pictures on this one.
  const parsed = kleinanzeigen.parseList(FIXTURE, spec);
  assert.ok(parsed.ok);

  for (const listing of parsed.value.listings) {
    for (const url of listing.photoUrls) {
      assert.ok(
        url.includes(listing.sourceListingId),
        `${listing.sourceListingId} was given ${url}`,
      );
    }
  }
});

test("an advert with fewer pictures than the article keeps the article's", () => {
  const parsed = kleinanzeigen.parseList(FIXTURE, spec);
  assert.ok(parsed.ok);
  const thin = parsed.value.listings.find((l) => l.sourceListingId === "3401852319");
  assert.ok(thin !== undefined);
  assert.ok(thin.photoUrls.length >= 1, "never fewer than what the markup already gave");
});
