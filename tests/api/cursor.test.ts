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

interface Feed { items: { id: string }[]; nextCursor: string | null }

test("the feed is exactly-once: a second page after a second run returns only the new cars", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST", url: "/api/searches", payload: { name: "x", criteria: EMPTY_CRITERIA },
  });
  const searchId = created.json<{ id: string }>().id;

  await app.inject({ method: "POST", url: `/api/searches/${searchId}/collect` });
  await finish(app);

  const first = (await app.inject({ url: `/api/public/v1/searches/${searchId}/feed` })).json<Feed>();
  assert.equal(first.items.length, 3, "the mock adapter seeds three listings");
  assert.notEqual(first.nextCursor, null);

  const secondFromStart = (await app.inject({ url: `/api/public/v1/searches/${searchId}/feed` })).json<Feed>();
  assert.deepEqual(secondFromStart.items.map((i) => i.id).sort(), first.items.map((i) => i.id).sort(),
    "reading from the start is idempotent, not additive");

  const nextPage = (await app.inject({
    url: `/api/public/v1/searches/${searchId}/feed?cursor=${first.nextCursor}`,
  })).json<Feed>();
  assert.equal(nextPage.items.length, 0, "nothing new since the cursor");
  assert.equal(nextPage.nextCursor, null);
});

test("limit truncation returns the remainder next time, with no gap and no repeat", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  const created = await app.inject({
    method: "POST", url: "/api/searches", payload: { name: "x", criteria: EMPTY_CRITERIA },
  });
  const searchId = created.json<{ id: string }>().id;
  await app.inject({ method: "POST", url: `/api/searches/${searchId}/collect` });
  await finish(app);

  const page1 = (await app.inject({ url: `/api/public/v1/searches/${searchId}/feed?limit=2` })).json<Feed>();
  assert.equal(page1.items.length, 2);
  assert.notEqual(page1.nextCursor, null);

  const page2 = (await app.inject({
    url: `/api/public/v1/searches/${searchId}/feed?cursor=${page1.nextCursor}&limit=2`,
  })).json<Feed>();
  assert.equal(page2.items.length, 1, "the remaining car, and only it");

  const ids = [...page1.items, ...page2.items].map((i) => i.id);
  assert.equal(new Set(ids).size, 3, "no id repeated across pages");
});
