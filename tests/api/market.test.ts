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

async function collected(t: { after: (fn: () => unknown) => void }) {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const id = (await app.inject({
    method: "POST", url: "/api/searches",
    payload: { name: "R34", criteria: EMPTY_CRITERIA },
  })).json<{ id: string }>().id;
  await app.inject({ method: "POST", url: `/api/searches/${id}/collect` });
  await finish(app);
  return app;
}

interface Report { activeCount: number; excludedByText: number }

/**
 * Collecting is broader than searching on purpose: the collector verifies only
 * the make and model, so a search for "Nissan Skyline R34" stores every Skyline
 * the portal returned, and the query then requires every word. The gap between
 * the two used to be invisible, and looked like cars going missing.
 */
test("the report says how many stored cars the search text excludes", async (t) => {
  const app = await collected(t);

  const all = (await app.inject({ url: "/api/market" })).json<Report>();
  assert.ok(all.activeCount > 0, "the mock source stored something");
  assert.equal(all.excludedByText, 0, "no text, nothing excluded by it");

  const narrowed = (await app.inject({
    url: "/api/market?text=Nissan+Skyline+Zzz",
  })).json<Report>();
  const shown = (await app.inject({
    url: "/api/vehicles?text=Nissan+Skyline+Zzz&active=true",
  })).json<unknown[]>();

  assert.equal(narrowed.activeCount, shown.length, "the count matches the list");
  assert.equal(
    narrowed.activeCount + narrowed.excludedByText,
    all.activeCount,
    "shown plus excluded accounts for everything collected",
  );
  assert.ok(narrowed.excludedByText > 0, "a word no listing carries excludes cars");
});

test("a search text every stored car matches excludes none", async (t) => {
  const app = await collected(t);

  const report = (await app.inject({ url: "/api/market?text=Nissan" })).json<Report>();
  const all = (await app.inject({ url: "/api/market" })).json<Report>();

  assert.equal(report.activeCount, all.activeCount);
  assert.equal(report.excludedByText, 0);
});
