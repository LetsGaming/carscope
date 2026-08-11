<script setup lang="ts">
import { computed } from "vue";
import { eur } from "../lib/format";
import type { PriceSnapshot } from "../lib/api";

const props = defineProps<{ history: PriceSnapshot[] }>();

const W = 900, H = 210, L = 66, R = 14, T = 12, B = 28;

/** Asking prices hold then step, so a step path is the truthful shape. */
const steps = computed(() => {
  const seen: PriceSnapshot[] = [];
  for (const p of props.history) {
    if (seen.at(-1)?.baseAmount !== p.baseAmount) seen.push(p);
  }
  const last = props.history.at(-1);
  if (last && seen.at(-1) !== last) seen.push(last);
  return seen;
});

const bounds = computed(() => {
  const values = props.history.map((p) => p.baseAmount);
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.25, 500);
  return { lo: Math.max(0, lo - pad), hi: hi + pad };
});

const span = computed(() => {
  const first = props.history[0], last = props.history.at(-1);
  if (!first || !last) return { from: 0, to: 1 };
  const from = Date.parse(first.observedAt), to = Date.parse(last.observedAt);
  return { from, to: to === from ? from + 86_400_000 : to };
});

const x = (iso: string): number =>
  L + ((Date.parse(iso) - span.value.from) / (span.value.to - span.value.from)) * (W - L - R);
const y = (v: number): number =>
  T + (1 - (v - bounds.value.lo) / (bounds.value.hi - bounds.value.lo)) * (H - T - B);

const path = computed(() => {
  let d = "";
  steps.value.forEach((p, i) => {
    const prev = steps.value[i - 1];
    d += i === 0
      ? `M${x(p.observedAt)} ${y(p.baseAmount)}`
      : ` L${x(p.observedAt)} ${y(prev?.baseAmount ?? p.baseAmount)} L${x(p.observedAt)} ${y(p.baseAmount)}`;
  });
  return d;
});

const gridLines = computed(() => {
  const { lo, hi } = bounds.value;
  const step = Math.max(500, Math.round((hi - lo) / 3 / 500) * 500);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v < hi; v += step) out.push(v);
  return out;
});
</script>

<template>
  <svg v-if="history.length > 0" :viewBox="`0 0 ${W} ${H}`" role="img"
       aria-label="Preisverlauf dieses Fahrzeugs">
    <g v-for="v in gridLines" :key="v">
      <line :x1="L" :y1="y(v)" :x2="W - R" :y2="y(v)" stroke="var(--line)" />
      <text :x="L - 12" :y="y(v) + 4" text-anchor="end" font-size="12" fill="var(--ink-3)">{{ eur(v) }}</text>
    </g>
    <path :d="path" fill="none" stroke="var(--accent)" stroke-width="2.25" />
    <circle v-for="p in steps" :key="p.observedAt" :cx="x(p.observedAt)" :cy="y(p.baseAmount)"
            r="4" fill="var(--accent)" />
  </svg>
  <p v-else class="faint">Noch keine zweite Beobachtung.</p>
</template>

<style scoped>
svg { display: block; width: 100%; height: auto; }
</style>
