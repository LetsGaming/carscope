import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../../apps/api/src/app.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { finish } from "./helpers.ts";

const config = loadConfig({
  DATABASE_FILE: ":memory:", LOG_LEVEL: "silent",
  COLLECT_ENABLED_SOURCES: "mock", COLLECT_STORE_PHOTOS: "false",
});

test("a vehicle another source is still writing is not retired mid-run", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/api/collect?force=true" });
  await finish(app);
  const before = (await app.inject({ url: "/api/vehicles" })).json<unknown[]>().length;
  assert.equal(before, 3);

  // A vehicle that exists but has no listing yet — the window between resolving
  // it and recording where it came from, which used to last a photo download.
  const now = new Date().toISOString();
  app.db.prepare(`
    INSERT INTO vehicles (id, make, model, market, identity_key, first_seen_at, last_seen_at)
    VALUES ('half-written', 'Nissan', 'Skyline', 'DE', 'k', ?, ?)
  `).run(now, now);

  // Another source finishing its run must not sweep it away.
  const removed = app.vehicles.markDelisted("other-source", ["x"], now, now);
  assert.equal(removed, 0);

  const survivor = app.db.prepare("SELECT delisted_at FROM vehicles WHERE id = 'half-written'")
    .get() as { delisted_at: string | null };
  assert.equal(survivor.delisted_at, null, "a vehicle seen during this run stays");
});

test("a vehicle whose listings really are gone is retired", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/api/collect?force=true" });
  await finish(app);

  // A run starting now: everything collected earlier is fair game.
  const later = new Date(Date.now() + 60_000).toISOString();
  const removed = app.vehicles.markDelisted("mock", [], later, later);
  assert.equal(removed, 3, "its listings are delisted");

  assert.equal((await app.inject({ url: "/api/vehicles?active=true" })).json<unknown[]>().length, 0);
  assert.equal((await app.inject({ url: "/api/vehicles?active=false" })).json<unknown[]>().length, 3,
    "and the price history survives the car leaving the market");
});

test("the all-time list carries when an advert ended, the active list omits it", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/api/collect?force=true" });
  await finish(app);
  const later = new Date(Date.now() + 60_000).toISOString();
  app.vehicles.markDelisted("mock", [], later, later);

  type Row = { delistedAt: string | null };
  const all = (await app.inject({ url: "/api/vehicles?active=false" })).json<Row[]>();
  assert.equal(all.length, 3);
  assert.ok(all.every((r) => r.delistedAt === later), "each says when it went offline");

  const live = (await app.inject({ url: "/api/vehicles" })).json<Row[]>();
  assert.equal(live.length, 0, "the default stays active only");
});
