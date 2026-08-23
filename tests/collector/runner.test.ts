import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CRITERIA, ok, type PriceSnapshot, type RawListing, type SourceAdapter } from "@carscope/core";
import { collect } from "../../packages/collector/src/runner.ts";
import { mock } from "../../packages/collector/src/adapters/mock.ts";
import type { CollectionRun, CollectorStore } from "../../packages/collector/src/ports.ts";
import type { HttpClient } from "../../packages/collector/src/http.ts";

function stubStore() {
  const prices: PriceSnapshot[] = [];
  const runs: CollectionRun[] = [];
  const ids = new Map<string, string>();
  const store: CollectorStore = {
    resolveVehicle(raw: RawListing) {
      const known = ids.get(raw.sourceListingId);
      if (known) return { vehicle: { id: known } as never, created: false };
      const id = `veh-${ids.size + 1}`;
      ids.set(raw.sourceListingId, id);
      return { vehicle: { id } as never, created: true };
    },
    upsertListing() {},
    recordPrice(s) { prices.push(s); },
    markDelisted() { return 0; },
    savePhotos() {}, setImageHash() {}, saveDetail() {}, needsDetail: () => false,
    recordRun(r) { runs.push(r); },
  };
  return { store, prices, runs };
}

const httpStub = {
  async getText(url: string) { return ok(new URL(url).search.slice(1)); },
} as unknown as HttpClient;

const deps = (store: CollectorStore) => ({
  http: httpStub,
  store,
  options: {
    maxPages: 3, sourceDeadlineMs: 30_000, maxDetails: 25, detailReserveMs: 1_000,
    enrichDetails: true, solverSources: [], rateToBase: () => 1,
  },
  now: () => new Date("2026-08-05T10:00:00Z"),
});

test("a run snapshots every kept listing exactly once", async () => {
  const { store, prices, runs } = stubStore();
  const run = await collect(deps(store), mock, { id: "s1", name: "R34", criteria: EMPTY_CRITERIA });
  assert.equal(run.status, "ok");
  assert.equal(run.fetched, 3);
  assert.equal(run.kept, 3);
  assert.equal(run.created, 3);
  assert.equal(prices.length, 3);
  assert.equal(runs.length, 1);
});

test("a second run merges instead of creating", async () => {
  const { store, runs } = stubStore();
  const search = { id: "s1", name: "R34", criteria: EMPTY_CRITERIA };
  await collect(deps(store), mock, search);
  const second = await collect(deps(store), mock, search);
  assert.equal(second.created, 0);
  assert.equal(second.merged, 3);
  assert.equal(runs.length, 2);
});

test("a blocked source records the run and stops", async () => {
  const { store, runs } = stubStore();
  const blocked = {
    async getText() {
      return { ok: false as const, error: { kind: "blocked" as const, message: "challenge", retryable: false } };
    },
  } as unknown as HttpClient;
  const run = await collect(
    { ...deps(store), http: blocked },
    mock as SourceAdapter,
    { id: "s1", name: "R34", criteria: EMPTY_CRITERIA },
  );
  assert.equal(run.status, "blocked");
  assert.equal(run.fetched, 0);
  // The note names the country, because a source now covers several and only
  // one of them may be refusing.
  assert.equal(runs[0]?.note, "DE: challenge");
});

test("stopping at the page limit is reported, not passed off as complete", async () => {
  const { store } = stubStore();
  // A source that always claims another page: the run must say it gave up.
  const endless = {
    ...mock,
    parseList: () => ok({
      listings: [{
        sourceListingId: `id-${String(Math.random())}`,
        url: "https://mock.local/x", title: "Nissan Skyline",
        price: 30_000, currency: "EUR" as const, photoUrls: [], attributes: {},
      }],
      hasMore: true,
    }),
  };

  const run = await collect(deps(store), endless, { id: "s1", name: "R34", criteria: EMPTY_CRITERIA });
  assert.equal(run.status, "ok");
  assert.match(run.note ?? "", /weitere Treffer/, "a partial answer says so");
  assert.equal(run.fetched, 3, "the page limit still holds");
});

test("enrichment stops before it can run the source's clock out", async () => {
  // Eleven detail pages at seven seconds each spent a sixty-second budget, and
  // the watchdog killed the source mid-car and reported a portal that had
  // stopped answering. The deadline was only checked between result pages.
  const DETAIL_MS = 7_000;
  let clock = Date.parse("2026-08-05T10:00:00Z");
  const start = clock;

  const { store: base } = stubStore();
  const store: CollectorStore = { ...base, needsDetail: () => true };

  const http = {
    async getText(url: string) {
      if (!url.includes("page=")) clock += DETAIL_MS;
      return ok(new URL(url).search.slice(1));
    },
  } as unknown as HttpClient;

  const withDetail: SourceAdapter = { ...mock, parseDetail: () => ok({ attributes: {} }) };

  const run = await collect({
    http,
    store,
    now: () => new Date(clock),
    options: {
      maxPages: 1, sourceDeadlineMs: 10_000, maxDetails: 25,
      detailReserveMs: 1_000, enrichDetails: true, solverSources: [], rateToBase: () => 1,
    },
  }, withDetail, { id: "s1", name: "R34", criteria: EMPTY_CRITERIA });

  // A detail page that starts inside the budget may finish just outside it, so
  // the guarantee is one page of overshoot, not zero. Before, three pages ran
  // regardless and the source overran by more than it was allowed in total.
  assert.equal(run.status, "ok", "the run finishes rather than being cut off");
  assert.ok(
    clock - start <= 10_000 + DETAIL_MS,
    `stayed within a page of the budget, spent ${String(clock - start)}ms`,
  );
  assert.match(run.note ?? "", /aufgeschoben/, "and says what it left for the next run");
});

test("enrichDetails: false skips detail pages even when the adapter and store want one", async () => {
  const { store: base } = stubStore();
  const store: CollectorStore = { ...base, needsDetail: () => true };
  let detailRequests = 0;

  const http = {
    async getText(url: string) {
      if (!url.includes("page=")) detailRequests += 1;
      return ok(new URL(url).search.slice(1));
    },
  } as unknown as HttpClient;

  const withDetail: SourceAdapter = { ...mock, parseDetail: () => ok({ attributes: {} }) };

  await collect({
    http,
    store,
    now: () => new Date("2026-08-05T10:00:00Z"),
    options: {
      maxPages: 1, sourceDeadlineMs: 10_000, maxDetails: 25,
      detailReserveMs: 1_000, enrichDetails: false, solverSources: [], rateToBase: () => 1,
    },
  }, withDetail, { id: "s1", name: "R34", criteria: EMPTY_CRITERIA });

  assert.equal(detailRequests, 0, "a first/manual search never fetches a detail page");
});
