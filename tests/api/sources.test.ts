import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CRITERIA } from "@carscope/core";
import { build } from "../../apps/api/src/app.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { finish } from "./helpers.ts";

const config = loadConfig({
  DATABASE_FILE: ":memory:", LOG_LEVEL: "silent",
  COLLECT_ENABLED_SOURCES: "mock", COLLECT_STORE_PHOTOS: "false",
});

interface Source {
  id: string; enabled: boolean; status: string; note: string | null; markets: string[];
}

test("every source reports whether it is on and why it is in that state", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const sources = (await app.inject({ url: "/api/sources" })).json<Source[]>();
  assert.equal(sources.length, 5);

  for (const s of sources) {
    assert.ok(s.note !== null, `${s.id} must explain its state`);
    assert.equal(s.status, s.enabled ? "idle" : "off");
  }
  assert.equal(sources.find((s) => s.id === "mock")?.note, "Noch nie abgefragt");
  assert.equal(sources.find((s) => s.id === "mobile.de")?.note, "Aus");
});

test("a source can be switched on at runtime and takes effect", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const off = (await app.inject({ url: "/api/sources" })).json<Source[]>();
  assert.equal(off.find((s) => s.id === "kleinanzeigen")?.enabled, false);

  const patched = await app.inject({
    method: "PATCH", url: "/api/sources/kleinanzeigen", payload: { enabled: true },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json<Source[]>().find((s) => s.id === "kleinanzeigen")?.enabled, true);

  const again = (await app.inject({ url: "/api/sources" })).json<Source[]>();
  assert.equal(again.find((s) => s.id === "kleinanzeigen")?.enabled, true, "the setting persists");

  await app.inject({ method: "PATCH", url: "/api/sources/mock", payload: { enabled: false } });
  await app.inject({ method: "POST", url: "/api/collect?text=Skyline&force=true" });
  const runs = await finish(app);
  assert.ok(!runs.some((r) => r.sourceId === "mock"), "a disabled source is not run");
});

test("an unknown source is a 404", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const res = await app.inject({ method: "PATCH", url: "/api/sources/nope", payload: { enabled: true } });
  assert.equal(res.statusCode, 404);
});

test("collection runs for criteria that were never saved", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const res = await app.inject({ method: "POST", url: "/api/collect?text=Skyline" });
  assert.equal(res.statusCode, 202);
  assert.equal((await finish(app))[0]?.created, 3);

  const found = await app.inject({ url: "/api/vehicles?text=Skyline" });
  assert.equal(found.json<unknown[]>().length, 3, "an ad-hoc search finds what it just collected");
  assert.equal((await app.inject({ url: "/api/searches" })).json<unknown[]>().length, 0,
    "nothing had to be saved for that to work");
});

test("repeating an ad-hoc search is throttled rather than refetching", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/api/collect?text=Skyline" });
  await finish(app);
  await app.inject({ method: "POST", url: "/api/collect?text=Skyline" });
  assert.deepEqual(await finish(app), [], "the adapter interval suppresses the second run");

  await app.inject({ method: "POST", url: "/api/collect?text=Skyline&force=true" });
  assert.equal((await finish(app)).length, 1);
});

test("a vehicle is filed under the country it stands in", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  await app.inject({
    method: "POST", url: "/api/searches", payload: { name: "x", criteria: EMPTY_CRITERIA },
  });
  await app.inject({ method: "POST", url: "/api/collect?force=true" });
  await finish(app);

  const de = await app.inject({ url: "/api/vehicles?markets=DE" });
  const se = await app.inject({ url: "/api/vehicles?markets=SE" });
  assert.equal(de.statusCode, 200);
  assert.equal(se.statusCode, 200);
  assert.equal(
    de.json<unknown[]>().length + se.json<unknown[]>().length,
    (await app.inject({ url: "/api/vehicles" })).json<unknown[]>().length,
    "filtering by country partitions the corpus rather than dropping cars",
  );
});

test("collection returns immediately and reports progress while it runs", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const started = Date.now();
  const res = await app.inject({ method: "POST", url: "/api/collect?text=Skyline&force=true" });
  assert.equal(res.statusCode, 202);
  assert.ok(Date.now() - started < 1_000, "the request does not wait for the portals");

  const job = res.json<{ id: string; finishedAt: string | null }>();
  assert.ok(job.id.startsWith("adhoc-"));

  await finish(app);
  const done = (await app.inject({ url: "/api/collect" })).json<{
    done: number; total: number; finishedAt: string | null; current: string | null; timedOut: boolean;
  }>();
  assert.equal(done.done, done.total, "every enabled source was visited");
  assert.equal(done.current, null);
  assert.equal(done.timedOut, false);
  assert.ok(done.finishedAt !== null, "the job reports when it ended");
});

test("the job names what it is collecting", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/api/collect?text=Nissan+Skyline&force=true" });
  const job = (await app.inject({ url: "/api/collect" })).json<{ label: string; id: string }>();
  assert.equal(job.label, "Nissan Skyline");

  // The same criteria always map to the same key, which is what makes
  // per-criteria throttling work without a saved search.
  await finish(app);
  await app.inject({ method: "POST", url: "/api/collect?text=Nissan+Skyline&force=true" });
  assert.equal((await app.inject({ url: "/api/collect" })).json<{ id: string }>().id, job.id);
  await finish(app);
});

test("job status is null before anything has been collected", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: "/api/collect" })).json(), null);
});

test("progress counts offers as they are stored, not sources as they finish", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/api/collect?text=Skyline&force=true" });
  await finish(app);

  const job = (await app.inject({ url: "/api/collect" })).json<{
    stored: number; total: number; done: number;
  }>();
  // One source, three offers: a per-source counter could only ever report 1.
  assert.equal(job.total, 1);
  assert.equal(job.stored, 3, "each offer is reported as it lands");
});

test("sources are collected in parallel, not one after another", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  await app.inject({ method: "PATCH", url: "/api/sources/kleinanzeigen", payload: { enabled: true } });
  await app.inject({ method: "POST", url: "/api/collect?text=Nissan+Skyline&force=true" });
  await finish(app);

  const job = (await app.inject({ url: "/api/collect" })).json<{
    total: number; done: number; runs: { sourceId: string }[];
  }>();
  assert.equal(job.total, 2, "both enabled sources were scheduled");
  assert.equal(job.done, job.total, "and both reported back");
  assert.equal(new Set(job.runs.map((r) => r.sourceId)).size, 2);
});
