<script setup lang="ts">
import { computed } from "vue";
import { eur } from "../lib/format";
import type { MonthlyPoint } from "../lib/types";

const props = defineProps<{ series: MonthlyPoint[]; target?: number | null }>();

const W = 1000, H = 300, L = 66, R = 16, T = 12, B = 30;
const MONTH_LABELS = 5;

const bounds = computed(() => {
  const values = props.series.flatMap((p) => [p.p10, p.p90]);
  if (props.target != null) values.push(props.target);
  const lo = Math.min(...values, Infinity);
  const hi = Math.max(...values, -Infinity);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
  const pad = Math.max((hi - lo) * 0.12, 500);
  return { lo: Math.max(0, lo - pad), hi: hi + pad };
});

const x = (i: number): number =>
  L + (props.series.length < 2 ? 0.5 : i / (props.series.length - 1)) * (W - L - R);
const y = (v: number): number =>
  T + (1 - (v - bounds.value.lo) / (bounds.value.hi - bounds.value.lo)) * (H - T - B);

/** Only the numeric percentile bands can bound a ribbon, so the key type says so. */
type Percentile = "p10" | "p25" | "p50" | "p75" | "p90";

const ribbon = (lo: Percentile, hi: Percentile): string =>
  [
    ...props.series.map((p, i) => `${x(i)},${y(p[hi])}`),
    ...props.series.map((p, i) => `${x(i)},${y(p[lo])}`).reverse(),
  ].join(" ");

const medianPath = computed(() =>
  props.series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)} ${y(p.p50)}`).join(" "));

/** The leading run of thin months is veiled rather than hidden, so a rising line
 *  built on three cars never reads as a trend. */
const thinWidth = computed(() => {
  const firstReliable = props.series.findIndex((p) => p.reliable);
  if (firstReliable <= 0) return 0;
  return x(firstReliable) - L;
});

const gridLines = computed(() => {
  const { lo, hi } = bounds.value;
  const step = Math.max(1000, Math.round((hi - lo) / 4 / 1000) * 1000);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v < hi; v += step) out.push(v);
  return out;
});

const monthTicks = computed(() =>
  Array.from({ length: Math.min(MONTH_LABELS, props.series.length) }, (_, k) => {
    const i = Math.round((k / Math.max(1, Math.min(MONTH_LABELS, props.series.length) - 1)) * (props.series.length - 1));
    const point = props.series[i];
    if (!point) return null;
    const [year, month] = point.month.split("-");
    return { at: x(i), label: `${month}/${year?.slice(2) ?? ""}` };
  }).filter((t): t is { at: number; label: string } => t !== null));

const last = computed(() => props.series[props.series.length - 1] ?? null);
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" role="img"
       :aria-label="`Angebotspreise über ${series.length} Monate`">
    <defs>
      <linearGradient id="veil" x1="0" x2="1">
        <stop offset="0" stop-color="var(--surface)" stop-opacity=".8" />
        <stop offset="1" stop-color="var(--surface)" stop-opacity="0" />
      </linearGradient>
    </defs>

    <g v-for="v in gridLines" :key="v">
      <line :x1="L" :y1="y(v)" :x2="W - R" :y2="y(v)" stroke="var(--line)" />
      <text :x="L - 12" :y="y(v) + 4" text-anchor="end" font-size="12" fill="var(--ink-3)">{{ eur(v) }}</text>
    </g>

    <polygon v-if="series.length > 1" :points="ribbon('p10', 'p90')" fill="var(--ink-3)" opacity=".15" />
    <polygon v-if="series.length > 1" :points="ribbon('p25', 'p75')" fill="var(--ink-3)" opacity=".35" />
    <path :d="medianPath" fill="none" stroke="var(--ink)" stroke-width="2.25" />

    <rect v-if="thinWidth > 0" :x="L" :y="T" :width="thinWidth" :height="H - T - B" fill="url(#veil)" />

    <g v-if="target != null">
      <line :x1="L" :y1="y(target)" :x2="W - R" :y2="y(target)"
            stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="6 5" />
      <text :x="W - R" :y="y(target) - 8" text-anchor="end" font-size="12" fill="var(--accent)">
        Ziel {{ eur(target) }}
      </text>
    </g>

    <circle v-if="last" :cx="x(series.length - 1)" :cy="y(last.p50)" r="4.5" fill="var(--ink)" />

    <text v-for="t in monthTicks" :key="t.label" :x="t.at" :y="H - 6"
          text-anchor="middle" font-size="12" fill="var(--ink-3)">{{ t.label }}</text>
  </svg>
</template>

<style scoped>
svg { display: block; width: 100%; height: auto; }
</style>
