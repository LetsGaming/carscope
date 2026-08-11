import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostThrottle, HttpClient, PhotoStore, photoDir } from "@carscope/collector";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

function storeServing(body: BodyInit): { store: PhotoStore; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "carscope-"));
  const http = new HttpClient(new HostThrottle(0), {
    timeoutMs: 1_000,
    userAgent: "test",
    transport: () => Promise.resolve(new Response(body, { status: 200 })),
  });
  return { store: new PhotoStore(http, dir), dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a picture is stored under the vehicle's own directory", async (t) => {
  const { store, dir, cleanup } = storeServing(PNG);
  t.after(cleanup);

  const [photo] = await store.ensure("abc123", ["https://portal.example/car.png"]);
  assert.ok(photo !== undefined);
  assert.ok(photo.localPath !== null, "the picture was stored");
  assert.ok(photo.localPath.endsWith("0.png"), "the extension follows the bytes");
  assert.ok(existsSync(join(dir, photo.localPath)));
});

test("active content from a portal is never stored under our own origin", async (t) => {
  // Stored photos are served from /media on the app's origin, so an SVG the
  // portal handed us would be script running as the app. The listing keeps the
  // remote URL instead and nothing lands on disk.
  const { store, dir, cleanup } = storeServing(SVG);
  t.after(cleanup);

  const [photo] = await store.ensure("abc123", ["https://portal.example/car.svg"]);
  assert.ok(photo !== undefined);
  assert.equal(photo.localPath, null, "nothing is stored");
  assert.equal(photo.url, "https://portal.example/car.svg", "the remote URL still works");
  assert.deepEqual(readdirSync(join(dir, photoDir("abc123"))), [], "no file was written");
});
