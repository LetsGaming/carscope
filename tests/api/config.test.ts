import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../apps/api/src/config.ts";

test("an empty setting means unset, not configured-with-nothing", () => {
  // `.env.example` lists optional keys with nothing after the `=`, to document
  // that they exist. Read literally, an empty CDP endpoint looks configured and
  // routes every fetch through a connection to nowhere.
  const c = loadConfig({
    COLLECT_BROWSER_CDP: "",
    COLLECT_BROWSER_PROFILE_DIR: "",
    COLLECT_BROWSER_CHANNEL: "",
    COLLECT_BROWSER_USER_AGENT: "   ",
    WEB_ROOT: "",
  });

  assert.equal(c.collect.browserCdp, null);
  assert.equal(c.collect.browserProfileDir, null);
  assert.equal(c.collect.browserChannel, null);
  assert.equal(c.collect.browserUserAgent, null);
  assert.equal(c.webRoot, null);
});

test("an empty setting falls back to the default rather than blanking it", () => {
  const c = loadConfig({ DATA_DIR: "", LOG_LEVEL: "  ", COLLECT_LOCALE: "" });
  assert.equal(c.dataDir, "./data");
  assert.equal(c.logLevel, "info");
  assert.equal(c.collect.locale, "de-DE");
});

test("a real setting is still honoured, and trimmed", () => {
  const c = loadConfig({ COLLECT_BROWSER_CDP: " http://127.0.0.1:9222 ", DATA_DIR: "/srv/carscope" });
  assert.equal(c.collect.browserCdp, "http://127.0.0.1:9222");
  assert.equal(c.dataDir, "/srv/carscope");
});
