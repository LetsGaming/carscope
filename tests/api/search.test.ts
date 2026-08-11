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

async function seeded(t: { after: (fn: () => unknown) => void }) {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const id = (await app.inject({
    method: "POST", url: "/api/searches",
    payload: { name: "R34", criteria: EMPTY_CRITERIA },
  })).json<{ id: string }>().id;
  await app.inject({ method: "POST", url: `/api/searches/${id}/collect` });
  await finish(app);
  return { app, id };
}

test("searching needs no saved search", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  // Nothing saved, nothing collected: the endpoint answers rather than 404s.
  const empty = await app.inject({ url: "/api/vehicles?text=Nissan" });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), []);

  const market = await app.inject({ url: "/api/market?text=Nissan" });
  assert.equal(market.statusCode, 200);
  assert.equal(market.json<{ observationCount: number }>().observationCount, 0);
});

test("free text narrows the corpus", async (t) => {
  const { app } = await seeded(t);

  const all = await app.inject({ url: "/api/vehicles" });
  assert.equal(all.json<unknown[]>().length, 3);

  const hit = await app.inject({ url: "/api/vehicles?text=Skyline" });
  assert.equal(hit.json<unknown[]>().length, 3);

  const miss = await app.inject({ url: "/api/vehicles?text=Kadett" });
  assert.equal(miss.json<unknown[]>().length, 0);
});

test("range filters apply server side", async (t) => {
  const { app } = await seeded(t);

  const cheap = await app.inject({ url: "/api/vehicles?priceMax=35000" });
  assert.deepEqual(cheap.json<{ price: number }[]>().map((v) => v.price), [34_900]);

  const lowKm = await app.inject({ url: "/api/vehicles?kmMax=100000" });
  assert.equal(lowKm.json<unknown[]>().length, 1);

  const strong = await app.inject({ url: "/api/vehicles?psMin=200" });
  assert.equal(strong.json<{ powerW: number }[]>().length, 1, "PS is compared in watts");

  const automatics = await app.inject({ url: "/api/vehicles?gearbox=automatic" });
  assert.equal(automatics.json<unknown[]>().length, 1);
});

test("an inverted range on a search is a 400, not an empty list", async (t) => {
  const { app } = await seeded(t);
  const res = await app.inject({ url: "/api/vehicles?priceMin=50000&priceMax=10000" });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json<{ error: string }>().error, "invalid");
});

test("results carry the fields the list view renders", async (t) => {
  const { app } = await seeded(t);
  const rows = (await app.inject({ url: "/api/vehicles" })).json<{
    id: string; price: number; firstPrice: number; vsMedian: number;
    sources: string[]; daysListed: number; photoCount: number; url: string;
  }[]>();

  for (const r of rows) {
    assert.ok(r.id.length > 0);
    assert.ok(r.price > 0);
    assert.equal(r.firstPrice, r.price, "one observation means no change yet");
    assert.deepEqual(r.sources, ["mock"]);
    assert.ok(Number.isInteger(r.daysListed));
    assert.ok(r.url.startsWith("https://"));
  }
  assert.ok(rows.some((r) => r.vsMedian === 0), "the median vehicle sits at zero");
});

test("a saved search resolves to its own criteria", async (t) => {
  const { app } = await seeded(t);
  const saved = (await app.inject({
    method: "POST", url: "/api/searches",
    payload: { name: "Nur günstig", criteria: { ...EMPTY_CRITERIA, priceEur: { min: null, max: 35_000 } } },
  })).json<{ id: string }>();

  const scoped = await app.inject({ url: `/api/searches/${saved.id}/vehicles` });
  assert.deepEqual(scoped.json<{ price: number }[]>().map((v) => v.price), [34_900]);
});

test("saving a search preserves nulls instead of coercing them to zero", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST", url: "/api/searches",
    payload: {
      name: "R34",
      criteria: { ...EMPTY_CRITERIA, make: null, priceEur: { min: 25_000, max: null } },
    },
  });
  assert.equal(created.statusCode, 201);

  const stored = created.json<{ id: string; criteria: typeof EMPTY_CRITERIA }>();
  // Ajv's default coerceTypes turns null into 0 on an `integer | null` union,
  // which silently rewrote every saved search into "price between 0 and 0".
  assert.equal(stored.criteria.priceEur.max, null, "an open upper bound stays open");
  assert.equal(stored.criteria.mileageKm.min, null);
  assert.equal(stored.criteria.make, null, "an absent make stays absent, not an empty string");

  const roundTrip = (await app.inject({ url: "/api/searches" }))
    .json<{ criteria: typeof EMPTY_CRITERIA }[]>()[0];
  assert.equal(roundTrip?.criteria.registrationYear.max, null);
});

test("a saved search with an open bound still matches", async (t) => {
  const { app } = await seeded(t);
  const saved = (await app.inject({
    method: "POST", url: "/api/searches",
    payload: { name: "offen", criteria: { ...EMPTY_CRITERIA, priceEur: { min: 30_000, max: null } } },
  })).json<{ id: string }>();

  const rows = await app.inject({ url: `/api/searches/${saved.id}/vehicles` });
  assert.equal(rows.json<unknown[]>().length, 3, "an open upper bound must not exclude everything");
});
