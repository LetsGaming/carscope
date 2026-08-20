import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_CRITERIA } from "@carscope/core";
import { build } from "../../apps/api/src/app.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { issueKey, scopesToColumn, SCOPE } from "../../apps/api/src/services/api-keys.ts";

const openConfig = loadConfig({
  DATABASE_FILE: ":memory:", LOG_LEVEL: "silent", COLLECT_ENABLED_SOURCES: "mock",
});
const gatedConfig = loadConfig({
  DATABASE_FILE: ":memory:", LOG_LEVEL: "silent", COLLECT_ENABLED_SOURCES: "mock",
  API_KEYS_REQUIRED: "true",
});

const createSearch = { method: "POST" as const, url: "/api/searches", payload: { name: "x", criteria: EMPTY_CRITERIA } };

test("with API_KEYS_REQUIRED unset, every write still works with no key — the back-compat guarantee", async (t) => {
  const app = await build({ config: openConfig, withScheduler: false });
  t.after(() => app.close());

  const created = await app.inject(createSearch);
  assert.equal(created.statusCode, 201);
  const id = created.json<{ id: string }>().id;

  assert.equal((await app.inject({ method: "PUT", url: `/api/searches/${id}`, payload: { name: "y", criteria: EMPTY_CRITERIA } })).statusCode, 200);
  assert.equal((await app.inject({ method: "PATCH", url: "/api/sources/mock", payload: { enabled: false } })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/searches/${id}` })).statusCode, 204);
});

test("with API_KEYS_REQUIRED=true, a write with no key is 401", async (t) => {
  const app = await build({ config: gatedConfig, withScheduler: false });
  t.after(() => app.close());
  const res = await app.inject(createSearch);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json<{ error: string }>().error, "unauthorized");
});

test("reads never require a key, even when API_KEYS_REQUIRED=true", async (t) => {
  const app = await build({ config: gatedConfig, withScheduler: false });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: "/api/searches" })).statusCode, 200);
});

test("a revoked key is 401, same as no key", async (t) => {
  const app = await build({ config: gatedConfig, withScheduler: false });
  t.after(() => app.close());

  const issued = issueKey();
  const row = app.apiKeys.insert({
    prefix: issued.prefix, tokenHash: issued.tokenHash, label: "t", scopes: scopesToColumn([SCOPE.write]), expiresAt: null,
  });
  app.apiKeys.revoke(row.prefix);

  const res = await app.inject({ ...createSearch, headers: { authorization: `Bearer ${issued.token}` } });
  assert.equal(res.statusCode, 401);
});

test("an expired key is 401, same as no key", async (t) => {
  const app = await build({ config: gatedConfig, withScheduler: false });
  t.after(() => app.close());

  const issued = issueKey();
  app.apiKeys.insert({
    prefix: issued.prefix, tokenHash: issued.tokenHash, label: "t", scopes: scopesToColumn([SCOPE.write]),
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });

  const res = await app.inject({ ...createSearch, headers: { authorization: `Bearer ${issued.token}` } });
  assert.equal(res.statusCode, 401);
});

test("a write-scoped key can write but not manage webhooks; admin can do both", async (t) => {
  const app = await build({ config: gatedConfig, withScheduler: false });
  t.after(() => app.close());

  const writeKey = issueKey();
  app.apiKeys.insert({
    prefix: writeKey.prefix, tokenHash: writeKey.tokenHash, label: "w", scopes: scopesToColumn([SCOPE.write]), expiresAt: null,
  });
  const adminKey = issueKey();
  app.apiKeys.insert({
    prefix: adminKey.prefix, tokenHash: adminKey.tokenHash, label: "a", scopes: scopesToColumn([SCOPE.admin]), expiresAt: null,
  });

  const created = await app.inject({ ...createSearch, headers: { authorization: `Bearer ${writeKey.token}` } });
  assert.equal(created.statusCode, 201, "write scope can create a search");
  const searchId = created.json<{ id: string }>().id;

  const webhookPayload = { method: "POST" as const, url: "/api/webhooks", payload: { searchId, url: "http://127.0.0.1:1/hook" } };
  const forbidden = await app.inject({ ...webhookPayload, headers: { authorization: `Bearer ${writeKey.token}` } });
  assert.equal(forbidden.statusCode, 403, "write scope does not imply admin");

  const allowed = await app.inject({ ...webhookPayload, headers: { authorization: `Bearer ${adminKey.token}` } });
  assert.equal(allowed.statusCode, 201, "admin implies write and carries its own scope");
});

test("the plaintext token is never stored, only its hash", async (t) => {
  const app = await build({ config: gatedConfig, withScheduler: false });
  t.after(() => app.close());
  const issued = issueKey();
  const row = app.apiKeys.insert({
    prefix: issued.prefix, tokenHash: issued.tokenHash, label: "t", scopes: "", expiresAt: null,
  });
  assert.notEqual(row.token_hash, issued.token);
  assert.equal(row.token_hash, issued.tokenHash);
});
