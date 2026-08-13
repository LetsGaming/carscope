import { test } from "node:test";
import assert from "node:assert/strict";
import { ClearanceStore, passFor, type Clearance } from "../../packages/collector/src/clearance.ts";

const clearance = (cookies: Clearance["cookies"], obtainedAtMs = 0): Clearance => ({
  cookies,
  userAgent: "camoufox-UA",
  obtainedAtMs,
});

test("a pass carries every cookie whose domain covers the host, agent included", () => {
  const pass = passFor(
    clearance([
      { name: "cf_clearance", value: "abc", domain: ".portal.invalid" },
      { name: "sid", value: "42", domain: "www.portal.invalid" },
    ]),
    "www.portal.invalid",
  );

  assert.equal(pass?.cookie, "cf_clearance=abc; sid=42");
  assert.equal(pass?.userAgent, "camoufox-UA");
});

test("a cookie for another host is not sent", () => {
  const pass = passFor(
    clearance([{ name: "cf_clearance", value: "abc", domain: ".other.invalid" }]),
    "www.portal.invalid",
  );
  assert.equal(pass, null, "nothing covers the host, so there is no pass");
});

test("a bare domain matches the host exactly, not its subdomains", () => {
  const cookies = [{ name: "x", value: "1", domain: "portal.invalid" }];
  assert.ok(passFor(clearance(cookies), "portal.invalid"));
  assert.equal(passFor(clearance(cookies), "www.portal.invalid"), null);
});

test("a fresh clearance is handed back; a stale one is dropped", () => {
  let nowMs = 1_000;
  const store = new ClearanceStore(500, () => nowMs);
  store.put("portal.invalid", clearance(
    [{ name: "cf_clearance", value: "abc", domain: "portal.invalid" }],
    nowMs,
  ));

  nowMs = 1_400;
  assert.ok(store.pass("portal.invalid"), "within the TTL it is replayed");

  nowMs = 1_600;
  assert.equal(store.pass("portal.invalid"), null, "past the TTL it is gone");
});

test("a solve that returned no cookies is not banked", () => {
  const store = new ClearanceStore(1_000, () => 0);
  store.put("portal.invalid", clearance([]));
  assert.equal(store.pass("portal.invalid"), null, "there was nothing to replay");
});

test("an invalidated host has no pass until it is solved again", () => {
  const store = new ClearanceStore(1_000, () => 0);
  store.put("portal.invalid", clearance([{ name: "x", value: "1", domain: "portal.invalid" }]));
  assert.ok(store.pass("portal.invalid"));

  store.invalidate("portal.invalid");
  assert.equal(store.pass("portal.invalid"), null);
});
