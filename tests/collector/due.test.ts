import { test } from "node:test";
import assert from "node:assert/strict";
import { HOUR_MS, MINUTE_MS } from "@carscope/core";
import { isDue, mock, RETRY_BACKOFF_MS } from "@carscope/collector";

const at = (iso: string): Date => new Date(iso);
const source = { ...mock, minIntervalMs: 6 * HOUR_MS };

test("a source never read is due", () => {
  assert.equal(isDue(null, source, at("2026-08-10T12:00:00Z")), true);
});

test("a complete run holds the source for its interval", () => {
  assert.equal(isDue("2026-08-10T11:00:00Z", source, at("2026-08-10T12:00:00Z")), false);
  assert.equal(isDue("2026-08-10T05:00:00Z", source, at("2026-08-10T12:00:00Z")), true);
});

test("a run cut short does not count as having read the source", () => {
  // Only complete runs reach this argument. A source that read one page of
  // three was otherwise not asked again for six hours, and every search in
  // between answered from a database holding part of the portal.
  const failedJustNow = "2026-08-10T11:59:00Z";
  assert.equal(
    isDue(null, source, at("2026-08-10T12:00:00Z"), 1, failedJustNow),
    false,
    "but it does not retry instantly either",
  );
  assert.equal(
    isDue(null, source, at("2026-08-10T12:30:00Z"), 1, failedJustNow),
    true,
    "it retries once the first backoff has passed",
  );
});

test("the wait doubles per failure, so a blocked portal is left alone", () => {
  const failedAt = "2026-08-10T12:00:00Z";
  const after = (ms: number): Date => new Date(Date.parse(failedAt) + ms);

  assert.equal(isDue(null, source, after(RETRY_BACKOFF_MS - MINUTE_MS), 1, failedAt), false);
  assert.equal(isDue(null, source, after(RETRY_BACKOFF_MS + MINUTE_MS), 1, failedAt), true);
  assert.equal(isDue(null, source, after(RETRY_BACKOFF_MS * 2 - MINUTE_MS), 2, failedAt), false);
  assert.equal(isDue(null, source, after(RETRY_BACKOFF_MS * 4 - MINUTE_MS), 3, failedAt), false);
});

test("the backoff never exceeds the source's own interval", () => {
  const failedAt = "2026-08-10T12:00:00Z";
  const wayLater = new Date(Date.parse(failedAt) + 7 * HOUR_MS);
  assert.equal(isDue(null, source, wayLater, 99, failedAt), true);
});
