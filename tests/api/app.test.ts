import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CRITERIA } from "@carscope/core";
import { build } from "../../apps/api/src/app.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { finish } from "./helpers.ts";

const BASE_ENV = { DATABASE_FILE: ":memory:", LOG_LEVEL: "silent", COLLECT_ENABLED_SOURCES: "mock" };
const config = loadConfig(BASE_ENV);

test("full slice: create a search, collect, then read market and results", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST", url: "/api/searches",
    payload: { name: "R34 GT-T", criteria: { ...EMPTY_CRITERIA, make: "Nissan", model: "Skyline" } },
  });
  assert.equal(created.statusCode, 201);
  const searchId = created.json<{ id: string }>().id;

  const collected = await app.inject({ method: "POST", url: `/api/searches/${searchId}/collect` });
  assert.equal(collected.statusCode, 202, "the request returns before the portals do");
  const runs = await finish(app);
  assert.equal(runs[0]?.status, "ok");
  assert.equal(runs[0]?.created, 3);

  const results = await app.inject({ url: `/api/searches/${searchId}/vehicles` });
  assert.equal(results.statusCode, 200);
  const vehicles = results.json<{ price: number; vsMedian: number; sources: string[] }[]>();
  assert.equal(vehicles.length, 3);
  assert.deepEqual(vehicles.map((v) => v.price).sort((a, b) => a - b), [34_900, 35_500, 36_900]);
  assert.ok(vehicles.every((v) => v.sources.includes("mock")));

  const market = await app.inject({ url: `/api/searches/${searchId}/market` });
  const report = market.json<{ current: { n: number; p50: number }; confidence: number; factors: unknown[] }>();
  assert.equal(report.current.n, 3);
  assert.equal(report.current.p50, 35_500);
  assert.equal(report.confidence, 1);
  assert.equal(report.factors.length, 0, "factors stay hidden below the sample floor");
});

test("collecting twice merges instead of duplicating", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST", url: "/api/searches",
    payload: { name: "R34", criteria: EMPTY_CRITERIA },
  });
  const id = created.json<{ id: string }>().id;

  await app.inject({ method: "POST", url: `/api/searches/${id}/collect` });
  await finish(app);
  await app.inject({ method: "POST", url: `/api/searches/${id}/collect` });
  const run = (await finish(app))[0];
  assert.equal(run?.created, 0, "a second pass creates nothing");
  assert.equal(run?.merged, 3);

  const vehicles = await app.inject({ url: `/api/searches/${id}/vehicles` });
  assert.equal(vehicles.json<unknown[]>().length, 3, "no duplicate vehicles after a second pass");
});

test("an inverted range is rejected at the boundary", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const res = await app.inject({
    method: "POST", url: "/api/searches",
    payload: { name: "bad", criteria: { ...EMPTY_CRITERIA, priceEur: { min: 50_000, max: 10_000 } } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json<{ error: string }>().error, "invalid");
});

test("unknown search returns a typed 404", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const res = await app.inject({ url: "/api/searches/nope/market" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json<{ error: string }>().error, "not_found");
});

test("source health lists every adapter with its enabled flag", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const res = await app.inject({ url: "/api/sources" });
  const sources = res.json<{ id: string; enabled: boolean; markets: string[] }[]>();
  assert.equal(sources.length, 5, "one entry per portal, not one per country");
  assert.equal(sources.find((s) => s.id === "mock")?.enabled, true);
  assert.equal(sources.find((s) => s.id === "mobile.de")?.enabled, false);
  assert.equal(sources.find((s) => s.id === "autoscout24")?.markets.length, 8);
});

test("price history survives repeated collection of a photo-less listing", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const id = (await app.inject({
    method: "POST", url: "/api/searches", payload: { name: "R34", criteria: EMPTY_CRITERIA },
  })).json<{ id: string }>().id;

  await app.inject({ method: "POST", url: `/api/searches/${id}/collect` });
  await finish(app);
  await app.inject({ method: "POST", url: `/api/searches/${id}/collect` });
  await finish(app);

  const vehicles = await app.inject({ url: `/api/searches/${id}/vehicles` });
  const noPhotos = vehicles.json<{ id: string; photoCount: number }[]>().find((v) => v.photoCount === 0);
  assert.ok(noPhotos, "the photo-less mock vehicle is still listed");

  const history = await app.inject({ url: `/api/vehicles/${noPhotos.id}/prices` });
  assert.ok(history.json<unknown[]>().length >= 1, "its snapshots stayed on one vehicle");
});

test("a POST with no body is a client error, not a server fault", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const id = (await app.inject({
    method: "POST", url: "/api/searches", payload: { name: "R34", criteria: EMPTY_CRITERIA },
  })).json<{ id: string }>().id;

  // What the browser sent before: a JSON content type with nothing behind it.
  const res = await app.inject({
    method: "POST",
    url: `/api/searches/${id}/collect`,
    headers: { "content-type": "application/json" },
    payload: "",
  });
  assert.equal(res.statusCode, 400, "an empty JSON body must not become a 500");
  assert.equal(res.json<{ error: string }>().error, "FST_ERR_CTP_EMPTY_JSON_BODY");
});

test("collecting with no content type at all succeeds", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const id = (await app.inject({
    method: "POST", url: "/api/searches", payload: { name: "R34", criteria: EMPTY_CRITERIA },
  })).json<{ id: string }>().id;

  const res = await app.inject({ method: "POST", url: `/api/searches/${id}/collect` });
  assert.equal(res.statusCode, 202);
});

test("plain HTTP is not told to upgrade its own assets", async (t) => {
  // Helmet adds upgrade-insecure-requests by default. carscope is normally
  // reached over HTTP on a LAN, where that turns its own CSS, JS and manifest
  // into failed HTTPS requests and leaves a blank page.
  const app = await build({ config: loadConfig(BASE_ENV), withScheduler: false });
  t.after(() => app.close());

  const res = await app.inject({ url: "/api/health" });
  assert.doesNotMatch(String(res.headers["content-security-policy"]), /upgrade-insecure-requests/);
  assert.equal(res.headers["cross-origin-opener-policy"], undefined, "ignored on an untrustworthy origin");
});

test("behind TLS the strict headers come back", async (t) => {
  const app = await build({
    config: loadConfig({ ...BASE_ENV, HTTPS: "true" }),
    withScheduler: false,
  });
  t.after(() => app.close());

  const res = await app.inject({ url: "/api/health" });
  assert.match(String(res.headers["content-security-policy"]), /upgrade-insecure-requests/);
  assert.equal(res.headers["cross-origin-opener-policy"], "same-origin");
});

