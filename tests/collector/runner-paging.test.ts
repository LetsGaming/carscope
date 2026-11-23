import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CRITERION, CURRENCY, EMPTY_CRITERIA, ok, type Criteria, type ListPage, type RawListing, type SourceAdapter,
} from "@carscope/core";
import { collect } from "../../packages/collector/src/runner.ts";
import type { CollectorStore } from "../../packages/collector/src/ports.ts";
import type { HttpClient } from "../../packages/collector/src/http.ts";

const listing = (id: string): RawListing => ({
  sourceListingId: id, url: `https://x.invalid/${id}`, title: "Nissan Skyline R34", price: 30_000,
  currency: CURRENCY.eur, photoUrls: [], attributes: { make: "Nissan", model: "Skyline" },
});

function setup(pages: (page: number) => ListPage) {
  const asked: Criteria[] = [];
  const delisted: string[][] = [];
  const fetched: string[] = [];
  const adapter = {
    id: "fake", label: "Fake", markets: ["DE"], currency: CURRENCY.eur, minIntervalMs: 0,
    unsupported: [CRITERION.priceEur],
    buildQuery(c: Criteria, page: number) {
      asked.push(c);
      return { url: `https://x.invalid/list?page=${String(page)}` };
    },
    parseList(body: string) { return ok(pages(Number(body))); },
  } as unknown as SourceAdapter;
  const store: CollectorStore = {
    resolveVehicle: (raw) => ({ vehicle: { id: raw.sourceListingId } as never, created: true }),
    upsertListing() {}, recordPrice() {},
    markDelisted: (_s, seen) => { delisted.push([...seen]); return 0; },
    savePhotos() {}, setImageHash() {}, saveDetail() {}, needsDetail: () => false, recordRun() {},
  };
  const http = {
    async getText(url: string) {
      fetched.push(url);
      return ok(new URL(url).searchParams.get("page") ?? "1");
    },
  } as unknown as HttpClient;
  const deps = {
    http, store,
    options: {
      maxPages: 5, sourceDeadlineMs: 30_000, maxDetails: 0, detailReserveMs: 1_000,
      enrichDetails: false, solverSources: [], rateToBase: () => 1,
    },
    now: () => new Date("2026-11-20T10:00:00Z"),
  };
  return { adapter, deps, asked, delisted, fetched };
}

const search = (criteria: Criteria) => ({ id: "s1", name: "x", criteria });

test("the portal is asked for what never changes on a car, not for price, mileage or power", async () => {
  const { adapter, deps, asked } = setup(() => ({ listings: [listing("1")], hasMore: false }));
  const criteria: Criteria = {
    ...EMPTY_CRITERIA, text: "Nissan Skyline",
    priceEur: { min: null, max: 45_000 }, mileageKm: { min: 1_000, max: 200_000 },
    powerPs: { min: 280, max: 280 }, registrationYear: { min: 1998, max: 2002 },
  };

  await collect(deps, adapter, search(criteria));

  const c = asked[0];
  assert.ok(c);
  assert.deepEqual(c.priceEur, { min: null, max: null });
  assert.deepEqual(c.mileageKm, { min: null, max: null });
  assert.deepEqual(c.powerPs, { min: null, max: null });
  assert.deepEqual(c.registrationYear, { min: 1998, max: 2002 }, "a registration year never changes");
});

test("a car above the price limit is kept, so it is not read as removed", async () => {
  const { adapter, deps } = setup(() => ({ listings: [listing("1")], hasMore: false }));
  const criteria: Criteria = { ...EMPTY_CRITERIA, text: "Nissan Skyline", priceEur: { min: null, max: 20_000 } };

  const run = await collect(deps, adapter, search(criteria));

  assert.equal(run.kept, 1, "30000 is above the limit of 20000, and the list filter hides it, not the run");
  assert.equal(run.dropped ?? 0, 0);
});

test("a page with nothing new is the portal showing its last page again", async () => {
  const { adapter, deps, fetched } = setup(() => ({ listings: [listing("1"), listing("2")], hasMore: true }));

  const run = await collect(deps, adapter, search(EMPTY_CRITERIA));

  assert.equal(fetched.length, 2, "page 2 added nothing, so there was no page 3");
  assert.equal(run.complete, true);
});

test("a run that stopped at the page limit does not mark any car as removed", async () => {
  const { adapter, deps, delisted } = setup((page) => ({ listings: [listing(`p${String(page)}`)], hasMore: true }));

  const run = await collect(deps, adapter, search(EMPTY_CRITERIA));

  assert.equal(run.complete, false);
  assert.deepEqual(delisted, [], "cars on pages that were never read are not gone");
});

test("a complete run marks the cars it did not see", async () => {
  const { adapter, deps, delisted } = setup((page) => ({
    listings: [listing(`p${String(page)}`)], hasMore: page < 2,
  }));

  const run = await collect(deps, adapter, search(EMPTY_CRITERIA));

  assert.equal(run.complete, true);
  assert.deepEqual(delisted, [["p1", "p2"]]);
});
