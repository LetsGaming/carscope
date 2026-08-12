import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../apps/api/src/config.ts";
import { openDatabase } from "../../apps/api/src/db/index.ts";

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

test("an unwritable data directory says so, instead of failing as SQLite", (t) => {
  // SQLite reports it as "unable to open database file", which reads like a
  // corrupt database. In a container it is almost always a bind mount Docker
  // created as root while the process runs as someone else.
  const dir = mkdtempSync(join(tmpdir(), "carscope-"));
  t.after(() => { chmodSync(dir, 0o755); rmSync(dir, { recursive: true, force: true }); });
  chmodSync(dir, 0o555);

  if (process.getuid?.() === 0) return; // root writes anywhere; nothing to prove.

  assert.throws(
    () => openDatabase(join(dir, "carscope.sqlite")),
    /not writable by uid \d+.*CARSCOPE_UID/s,
  );
});

test("a writable directory is created on demand, however deep", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "carscope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const db = openDatabase(join(dir, "nested", "deeper", "carscope.sqlite"));
  t.after(() => db.close());
  assert.ok(db.prepare("SELECT name FROM schema_migrations").all().length > 0);
});

