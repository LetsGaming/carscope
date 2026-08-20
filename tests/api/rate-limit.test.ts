import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "../../apps/api/src/app.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { issueKey, scopesToColumn } from "../../apps/api/src/services/api-keys.ts";

const config = loadConfig({
  DATABASE_FILE: ":memory:", LOG_LEVEL: "silent", COLLECT_ENABLED_SOURCES: "mock",
  RATE_LIMIT_ANON_MAX: "2", RATE_LIMIT_WINDOW_MS: "60000",
});

test("an anonymous caller is cut off after the configured maximum, with the house error shape", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  await app.inject({ url: "/api/public/v1/searches" });
  await app.inject({ url: "/api/public/v1/searches" });
  const blocked = await app.inject({ url: "/api/public/v1/searches" });

  assert.equal(blocked.statusCode, 429);
  assert.deepEqual(blocked.json(), { error: "rate_limited", message: "too many requests" });
  assert.ok(blocked.headers["retry-after"] !== undefined);
});

test("a keyed caller has its own bucket, separate from the anonymous one", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  // Exhaust the anonymous bucket.
  await app.inject({ url: "/api/public/v1/searches" });
  await app.inject({ url: "/api/public/v1/searches" });
  assert.equal((await app.inject({ url: "/api/public/v1/searches" })).statusCode, 429);

  const issued = issueKey();
  app.apiKeys.insert({
    prefix: issued.prefix, tokenHash: issued.tokenHash, label: "t", scopes: scopesToColumn([]), expiresAt: null,
  });
  const keyed = await app.inject({
    url: "/api/public/v1/searches", headers: { authorization: `Bearer ${issued.token}` },
  });
  assert.equal(keyed.statusCode, 200, "a key lifts the caller out of the exhausted anonymous bucket");
});

test("/api/health and /api/events are never rate limited", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
  }
});
