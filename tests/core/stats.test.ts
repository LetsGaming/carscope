import { test } from "node:test";
import assert from "node:assert/strict";
import { describe as summarise, histogram, monthlySeries, percentile, priceFactor, confidence } from "../../packages/core/src/stats.ts";

test("percentile interpolates between order statistics", () => {
  const s = [10, 20, 30, 40];
  assert.equal(percentile(s, 0), 10);
  assert.equal(percentile(s, 0.5), 25);
  assert.equal(percentile(s, 1), 40);
});

test("describe reports quartiles and count", () => {
  const d = summarise([100, 200, 300, 400, 500]);
  assert.equal(d.n, 5);
  assert.equal(d.p50, 300);
  assert.equal(d.mean, 300);
});

test("monthly series marks thin months unreliable", () => {
  const obs = [
    ...Array.from({ length: 3 }, () => ({ baseAmount: 100, observedAt: "2026-01-14T00:00:00Z" })),
    ...Array.from({ length: 9 }, () => ({ baseAmount: 200, observedAt: "2026-02-14T00:00:00Z" })),
  ];
  const series = monthlySeries(obs);
  assert.equal(series.length, 2);
  assert.equal(series[0]?.reliable, false);
  assert.equal(series[1]?.reliable, true);
});

test("histogram buckets on fixed band size", () => {
  const bands = histogram([1000, 1500, 2500], 1000);
  assert.equal(bands.length, 2);
  assert.equal(bands[0]?.count, 2);
});

test("price factor suppresses itself below the sample floor", () => {
  const few = Array.from({ length: 10 }, (_, i) => ({ p: 1000 + i, coupe: i % 2 === 0 }));
  assert.equal(priceFactor("coupe", few, (x) => x.p, (x) => x.coupe), null);

  const many = Array.from({ length: 60 }, (_, i) => ({ p: i % 2 === 0 ? 2000 : 1000, coupe: i % 2 === 0 }));
  const f = priceFactor("coupe", many, (x) => x.p, (x) => x.coupe);
  assert.equal(f?.deltaEur, 1000);
});

test("a large sample does not rescue a difference smaller than the spread", () => {
  // Both groups span ~4000 EUR but their medians differ by only 100.
  const noisy = Array.from({ length: 200 }, (_, i) => ({
    p: 30_000 + (i % 40) * 100 + (i % 2 === 0 ? 100 : 0),
    dealer: i % 2 === 0,
  }));
  assert.equal(
    priceFactor("dealer", noisy, (x) => x.p, (x) => x.dealer),
    null,
    "noise is suppressed even at n=100 per group",
  );
});

test("a real separation survives the effect gate", () => {
  const clear = Array.from({ length: 200 }, (_, i) => ({
    p: (i % 2 === 0 ? 44_000 : 36_000) + (i % 10) * 50,
    coupe: i % 2 === 0,
  }));
  const f = priceFactor("coupe", clear, (x) => x.p, (x) => x.coupe);
  // Medians land mid-jitter, so the gap is the separation plus half a step.
  assert.equal(f?.deltaEur, 7_950);
});

test("confidence rises with sample size", () => {
  assert.equal(confidence(2), 1);
  assert.equal(confidence(40), 3);
  assert.equal(confidence(500), 5);
});
