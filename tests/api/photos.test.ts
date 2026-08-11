import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EMPTY_CRITERIA } from "@carscope/core";
import { build } from "../../apps/api/src/app.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import { finish } from "./helpers.ts";

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "carscope-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("photos are downloaded once and served from local storage", async (t) => {
  const { dir, cleanup } = workspace();
  t.after(cleanup);

  const app = await build({
    config: loadConfig({
      DATABASE_FILE: ":memory:", LOG_LEVEL: "silent",
      COLLECT_ENABLED_SOURCES: "mock", DATA_DIR: dir,
    }),
    withScheduler: false,
  });
  t.after(() => app.close());

  const id = (await app.inject({
    method: "POST", url: "/api/searches", payload: { name: "R34", criteria: EMPTY_CRITERIA },
  })).json<{ id: string }>().id;

  await app.inject({ method: "POST", url: `/api/searches/${id}/collect` });
  const first = await finish(app);
  assert.equal(first[0]?.photos, 2, "two of three mock cars have photos");

  const results = await app.inject({ url: `/api/searches/${id}/vehicles` });
  const withPhoto = results.json<{ id: string; thumbnail: string | null; photoCount: number }[]>()
    .find((v) => v.photoCount > 0);
  assert.ok(withPhoto, "a vehicle carries a photo");
  const thumbnail = withPhoto.thumbnail ?? "";
  assert.ok(thumbnail.startsWith("/media/photos/"), "the thumbnail is served locally, not hot-linked");
  assert.ok(existsSync(join(dir, thumbnail.replace("/media/", ""))), "the file is on disk");

  const served = await app.inject({ url: thumbnail });
  assert.equal(served.statusCode, 200);
  assert.equal(String(served.headers["content-type"]), "image/png");

  await app.inject({ method: "POST", url: `/api/searches/${id}/collect` });
  const second = await finish(app);
  assert.equal(second[0]?.photos, 0, "an unchanged image set is not downloaded again");
});

test("media paths cannot escape the data directory", async (t) => {
  const { dir, cleanup } = workspace();
  t.after(cleanup);
  const app = await build({
    config: loadConfig({ DATABASE_FILE: ":memory:", LOG_LEVEL: "silent", DATA_DIR: dir }),
    withScheduler: false,
  });
  t.after(() => app.close());

  const res = await app.inject({ url: "/media/../carscope.sqlite" });
  assert.notEqual(res.statusCode, 200);
});

test("a car left with only a cover photo is revisited", async (t) => {
  const { dir, cleanup } = workspace();
  t.after(cleanup);

  const app = await build({
    config: loadConfig({
      DATABASE_FILE: ":memory:", LOG_LEVEL: "silent",
      COLLECT_ENABLED_SOURCES: "mock", DATA_DIR: dir,
    }),
    withScheduler: false,
  });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/api/collect?force=true" });
  await finish(app);

  const withPhotos = app.db
    .prepare("SELECT vehicle_id FROM photos GROUP BY vehicle_id HAVING COUNT(*) >= 1")
    .all() as { vehicle_id: string }[];
  const id = withPhotos[0]?.vehicle_id ?? "";
  assert.ok(id !== "");

  // The state a gallery fix leaves behind: detail already marked read, one photo.
  app.db.prepare("DELETE FROM photos WHERE vehicle_id = ? AND position > 0").run(id);
  app.db.prepare("UPDATE vehicles SET detail_fetched_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);

  assert.equal(app.vehicles.needsDetail(id), true, "one picture is worth another look");
});

test("a fully illustrated car is left alone", async (t) => {
  const { dir, cleanup } = workspace();
  t.after(cleanup);
  const app = await build({
    config: loadConfig({
      DATABASE_FILE: ":memory:", LOG_LEVEL: "silent",
      COLLECT_ENABLED_SOURCES: "mock", DATA_DIR: dir,
    }),
    withScheduler: false,
  });
  t.after(() => app.close());

  await app.inject({ method: "POST", url: "/api/collect?force=true" });
  await finish(app);

  const id = (app.db.prepare("SELECT id FROM vehicles LIMIT 1").get() as { id: string }).id;
  app.db.prepare("UPDATE vehicles SET detail_fetched_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  for (const position of [0, 1, 2]) {
    app.db.prepare("INSERT OR REPLACE INTO photos (vehicle_id, position, url, local_path) VALUES (?,?,?,?)")
      .run(id, position, `https://x/${String(position)}.jpg`, `photos/x/${String(position)}.jpg`);
  }
  assert.equal(app.vehicles.needsDetail(id), false, "no reason to fetch it again");
});
