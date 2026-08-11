import { test } from "node:test";
import assert from "node:assert/strict";
import { inferPeriod, MIN_PERIOD_EVIDENCE, type PeriodEvidence } from "@carscope/core";

const evidence = (over: Partial<PeriodEvidence>): PeriodEvidence => ({
  token: "r34",
  withToken: 12, withTokenFrom: 1998, withTokenTo: 2002,
  total: 45, totalFrom: 1989, totalTo: 2009,
  ...over,
});

test("a word covering a narrow slice of the years is read as a period", () => {
  // Five of twenty-one collected Skyline years. A car built then counts even
  // when the advert never says R34, which is how a genuine one headlined
  // "GT-R V-Spec" was missing from every search for it.
  const period = inferPeriod(evidence({}));
  assert.deepEqual(period, { token: "r34", fromYear: 1997, toYear: 2003 });
});

test("a word spread across the generations stays a word", () => {
  // GTR sat in twelve of twenty-one years, because Skylines of every generation
  // have one. Reading it as a period pulled in every Skyline of that era.
  assert.equal(inferPeriod(evidence({ token: "gtr", withTokenFrom: 1991, withTokenTo: 2002 })), null);
});

test("a handful of adverts is not evidence", () => {
  assert.equal(inferPeriod(evidence({ withToken: MIN_PERIOD_EVIDENCE - 1 })), null);
});

test("a word every result carries tells the search nothing", () => {
  assert.equal(inferPeriod(evidence({ withToken: 45, total: 45 })), null);
});

test("a single model year cannot localise anything", () => {
  assert.equal(inferPeriod(evidence({ totalFrom: 1999, totalTo: 1999, withTokenFrom: 1999, withTokenTo: 1999 })), null);
});

test("cars with no registration year are never judged by it", () => {
  assert.equal(inferPeriod(evidence({ withTokenFrom: null, withTokenTo: null })), null);
});

test("the window is padded, because registration trails production", () => {
  const period = inferPeriod(evidence({ withTokenFrom: 1998, withTokenTo: 2002 }));
  assert.ok(period !== null);
  assert.ok(period.fromYear < 1998 && period.toYear > 2002, "an import registered late still counts");
});
