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

async function withSearch(app: Awaited<ReturnType<typeof build>>): Promise<string> {
  const res = await app.inject({
    method: "POST", url: "/api/searches", payload: { name: "R34", criteria: EMPTY_CRITERIA },
  });
  return res.json<{ id: string }>().id;
}

test("the public namespace is readable with no key at all", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  await withSearch(app);

  const res = await app.inject({ url: "/api/public/v1/searches" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<unknown[]>().length, 1);
});

test("the public namespace always answers with a wildcard CORS header, the internal one never does", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const pub = await app.inject({ url: "/api/public/v1/searches" });
  assert.equal(pub.headers["access-control-allow-origin"], "*");

  // CORS_ORIGIN is unset in `config`, so the internal branch must stay silent —
  // this is the no-regression guarantee for the cors delegate rewrite.
  const internal = await app.inject({ url: "/api/searches" });
  assert.equal(internal.headers["access-control-allow-origin"], undefined);
});

test("a public vehicle list is clamped to the configured maximum, never to whatever the caller asks for", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const searchId = await withSearch(app);
  await app.inject({ method: "POST", url: `/api/searches/${searchId}/collect` });
  await finish(app);

  const res = await app.inject({ url: `/api/public/v1/searches/${searchId}/vehicles?limit=9999` });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json<unknown[]>().length <= config.public.maxLimit);
});

test("an unknown search is a typed 404 on the public namespace too", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const res = await app.inject({ url: "/api/public/v1/searches/nope/vehicles" });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json<{ error: string }>().error, "not_found");
});

test("the public vehicle DTO never carries a field the internal one added later", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const searchId = await withSearch(app);
  await app.inject({ method: "POST", url: `/api/searches/${searchId}/collect` });
  await finish(app);

  const res = await app.inject({ url: `/api/public/v1/searches/${searchId}/vehicles` });
  const [vehicle] = res.json<Record<string, unknown>[]>();
  assert.ok(vehicle);
  // The public contract is deliberately narrow: no city, no seller name, no
  // description, no listing internals — see routes/public/dto.ts.
  for (const leaked of ["city", "sellerName", "description", "sources", "postalCode"]) {
    assert.ok(!(leaked in vehicle), `${leaked} must not appear in the public DTO`);
  }
});

test("PUBLIC_API=false removes the namespace entirely", async (t) => {
  const off = loadConfig({
    DATABASE_FILE: ":memory:", LOG_LEVEL: "silent",
    COLLECT_ENABLED_SOURCES: "mock", PUBLIC_API: "false",
  });
  const app = await build({ config: off, withScheduler: false });
  t.after(() => app.close());
  const res = await app.inject({ url: "/api/public/v1/searches" });
  assert.equal(res.statusCode, 404);
});
