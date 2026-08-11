import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { artifactDir, artifactName, pruneArtifacts } from "../../packages/collector/src/artifacts.ts";

test("two fetches of one host never share a name", () => {
  const at = new Date("2026-08-09T11:44:02.123Z");
  const first = artifactName("https://www.autouncle.de/de/gebrauchtwagen/Nissan/Skyline", at);
  const second = artifactName("https://www.autouncle.de/de/gebrauchtwagen/Nissan/Skyline", at);

  // Same host, same page, same millisecond: a name built from the host alone
  // would have the second overwrite the first.
  assert.notEqual(first, second);
  assert.match(first, /^2026-08-09T11-44-02-123Z-\d{3}--/);
});

test("the name says which page was fetched", () => {
  const at = new Date("2026-08-09T11:44:02.123Z");
  assert.match(
    artifactName("https://www.autouncle.de/de/gebrauchtwagen/Nissan/Skyline?page=2", at),
    /de-gebrauchtwagen-Nissan-Skyline-page-2$/,
  );
  assert.match(artifactName("https://suchen.mobile.de/", at), /--root$/);
  assert.match(artifactName("not a url", at), /--unknown$/);
});

test("names sort into the order the fetches happened", () => {
  const early = artifactName("https://x.invalid/a", new Date("2026-08-09T10:00:00Z"));
  const late = artifactName("https://x.invalid/b", new Date("2026-08-09T11:00:00Z"));
  assert.ok(early < late, "sortable by name, so a directory listing is a timeline");
});

test("only the newest artefacts are kept", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const dir = await artifactDir(root, "www.autouncle.de");
  for (let i = 0; i < 8; i += 1) {
    const file = join(dir, `fetch-${String(i)}.html`);
    writeFileSync(file, "x");
    const at = new Date(2026, 0, 1, 0, 0, i);
    utimesSync(file, at, at);
  }

  const removed = await pruneArtifacts(dir, 3);
  assert.equal(removed, 5);
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["fetch-5.html", "fetch-6.html", "fetch-7.html"],
    "the oldest go, the record of recent fetches stays",
  );
});

test("pruning an absent directory is not an error", async () => {
  assert.equal(await pruneArtifacts(join(tmpdir(), "does-not-exist-carscope")), 0);
});
