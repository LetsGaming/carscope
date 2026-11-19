import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../../apps/api/src/app.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { finish } from "./helpers.ts";

const config = loadConfig({
  DATABASE_FILE: ":memory:", LOG_LEVEL: "silent",
  COLLECT_ENABLED_SOURCES: "mock", COLLECT_STORE_PHOTOS: "false",
});

const ids = async (app: Awaited<ReturnType<typeof build>>, url = "/api/vehicles"): Promise<string[]> =>
  (await app.inject({ url })).json<{ id: string }[]>().map((v) => v.id).sort();

async function collected(t: { after: (fn: () => unknown) => void }) {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  await app.inject({ method: "POST", url: "/api/collect?force=true" });
  await finish(app);
  return app;
}

test("a car removed by hand stays gone after the next collection", async (t) => {
  const app = await collected(t);
  const [victim, ...rest] = await ids(app);
  assert.equal(rest.length, 2);

  const removed = await app.inject({ method: "DELETE", url: `/api/vehicles/${String(victim)}` });
  assert.equal(removed.statusCode, 204);
  assert.deepEqual(await ids(app), rest);

  await app.inject({ method: "POST", url: "/api/collect?force=true" });
  await finish(app);
  assert.deepEqual(await ids(app), rest, "the portal still lists it, the list does not");
  assert.deepEqual(await ids(app, "/api/vehicles?active=false"), rest, "all-time hides it too");
  assert.equal(
    (await app.inject({ url: `/api/vehicles/${String(victim)}` })).statusCode, 200,
    "the record is kept, so it can be restored",
  );
});

test("a removed car is left out of the statistics", async (t) => {
  const app = await collected(t);
  const [victim] = await ids(app);
  const count = async (): Promise<number> =>
    (await app.inject({ url: "/api/market" })).json<{ observationCount: number }>().observationCount;

  const before = await count();
  await app.inject({ method: "DELETE", url: `/api/vehicles/${String(victim)}` });
  assert.ok(await count() < before);
});

test("restoring brings a removed car back", async (t) => {
  const app = await collected(t);
  const all = await ids(app);
  const victim = String(all[0]);

  await app.inject({ method: "DELETE", url: `/api/vehicles/${victim}` });
  const restored = await app.inject({ method: "POST", url: `/api/vehicles/${victim}/restore` });
  assert.equal(restored.statusCode, 204);
  assert.deepEqual(await ids(app), all);
});

test("removing or restoring an unknown car is a 404", async (t) => {
  const app = await collected(t);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/vehicles/nope" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/vehicles/nope/restore" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/vehicles/nope/release" })).statusCode, 404);
});
