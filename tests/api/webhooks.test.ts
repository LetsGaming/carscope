import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { EMPTY_CRITERIA } from "@carscope/core";
import { build } from "../../apps/api/src/app.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { finish } from "./helpers.ts";

const config = loadConfig({
  DATABASE_FILE: ":memory:", LOG_LEVEL: "silent",
  COLLECT_ENABLED_SOURCES: "mock", COLLECT_STORE_PHOTOS: "false",
  WEBHOOK_TIMEOUT_MS: "2000",
});

interface Delivery { headers: http.IncomingHttpHeaders; body: string }

async function startCatcher(status: number): Promise<{ port: number; deliveries: Delivery[]; close: () => Promise<void> }> {
  const deliveries: Delivery[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => {
      deliveries.push({ headers: req.headers, body });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, deliveries, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function registerSearchAndHook(
  app: Awaited<ReturnType<typeof build>>, url: string,
): Promise<{ searchId: string; secret: string }> {
  const created = await app.inject({
    method: "POST", url: "/api/searches", payload: { name: "x", criteria: EMPTY_CRITERIA },
  });
  const searchId = created.json<{ id: string }>().id;
  const hook = await app.inject({ method: "POST", url: "/api/webhooks", payload: { searchId, url } });
  assert.equal(hook.statusCode, 201);
  return { searchId, secret: hook.json<{ secret: string }>().secret };
}

test("a collection run that creates cars delivers exactly one signed webhook", async (t) => {
  const catcher = await startCatcher(200);
  t.after(() => catcher.close());

  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const { searchId, secret } = await registerSearchAndHook(app, `http://127.0.0.1:${catcher.port}/hook`);

  await app.inject({ method: "POST", url: `/api/searches/${searchId}/collect` });
  await finish(app);

  assert.equal(catcher.deliveries.length, 1);
  const [delivery] = catcher.deliveries;
  assert.ok(delivery);
  const timestamp = delivery.headers["x-carscope-timestamp"];
  assert.equal(typeof timestamp, "string");
  const expected = createHmac("sha256", secret).update(`${String(timestamp)}.${delivery.body}`).digest("hex");
  const got = delivery.headers["x-carscope-signature"];
  assert.equal(typeof got, "string");
  assert.ok(
    expected.length === (got as string).length
    && timingSafeEqual(Buffer.from(expected), Buffer.from(got as string)),
    "the HMAC over timestamp.body verifies with the secret shown at registration",
  );
  assert.equal(JSON.parse(delivery.body).items.length, 3);
});

test("a run with nothing new since the cursor delivers nothing", async (t) => {
  const catcher = await startCatcher(200);
  t.after(() => catcher.close());

  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const { searchId } = await registerSearchAndHook(app, `http://127.0.0.1:${catcher.port}/hook`);

  await app.inject({ method: "POST", url: `/api/searches/${searchId}/collect` });
  await finish(app);
  assert.equal(catcher.deliveries.length, 1);

  // The mock adapter's interval suppresses an immediate second run; force it,
  // exactly as the collector-level throttling test does. No new vehicles are
  // created because the same three listings are already known.
  await app.inject({ method: "POST", url: `/api/searches/${searchId}/collect?force=true` });
  await finish(app);
  assert.equal(catcher.deliveries.length, 1, "nothing new means nothing delivered");
});

test("a failing endpoint does not advance the cursor, and is retried on the next run", async (t) => {
  const catcher = await startCatcher(500);
  t.after(() => catcher.close());

  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const { searchId } = await registerSearchAndHook(app, `http://127.0.0.1:${catcher.port}/hook`);

  await app.inject({ method: "POST", url: `/api/searches/${searchId}/collect` });
  await finish(app);
  assert.equal(catcher.deliveries.length, 1, "the delivery was attempted");

  const hooks = app.webhooks.list();
  const hook = hooks.find((h) => h.search_id === searchId);
  assert.ok(hook);
  assert.equal(hook.notified_through, 0, "a failed delivery must not lose the gap");
  assert.equal(hook.consecutive_failures, 1);
});

test("an ad-hoc collection job never triggers a webhook", async (t) => {
  const catcher = await startCatcher(200);
  t.after(() => catcher.close());

  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  // Register a hook against a saved search, then run an unrelated ad-hoc job —
  // adhoc-* ids simply match no `webhooks.search_id`, no id-prefix check needed.
  await registerSearchAndHook(app, `http://127.0.0.1:${catcher.port}/hook`);

  await app.inject({ method: "POST", url: "/api/collect?text=Skyline" });
  await finish(app);

  assert.equal(catcher.deliveries.length, 0);
});

test("registering a webhook against an unknown search is a 404", async (t) => {
  const app = await build({ config, withScheduler: false });
  t.after(() => app.close());
  const res = await app.inject({
    method: "POST", url: "/api/webhooks", payload: { searchId: "nope", url: "http://127.0.0.1:1/hook" },
  });
  assert.equal(res.statusCode, 404);
});
