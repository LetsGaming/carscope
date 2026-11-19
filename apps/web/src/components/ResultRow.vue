<script setup lang="ts">
import { computed } from "vue";
import PhotoFrame from "./PhotoFrame.vue";
import { eur, num, pct, registration, relativeTime, wattToPs } from "../lib/format";
import type { Result } from "../lib/types";

const props = defineProps<{ result: Result; layout: "list" | "grid" }>();
const emit = defineEmits<{ remove: [id: string] }>();

const title = computed(() =>
  [props.result.make, props.result.model, props.result.variant].filter(Boolean).join(" "));
const drop = computed(() => props.result.firstPrice - props.result.price);

/**
 * How long the advert has been up, where the portal says so. Otherwise this is
 * only how long we have been watching, and it is labelled as such — a car
 * collected today has not been online for zero days.
 */
const onlineFor = computed(() => {
  const days = props.result.daysListed;
  if (props.result.daysListedExact) {
    return days === 0 ? "heute eingestellt" : `seit ${String(days)} Tagen online`;
  }
  return days === 0 ? "neu erfasst" : `seit ${String(days)} Tagen beobachtet`;
});
const flags = computed(() => {
  const out: { tone: string; text: string }[] = [];
  if (props.result.delistedAt !== null) {
    out.push({ tone: "gone", text: `Inserat beendet ${relativeTime(props.result.delistedAt)}` });
  }
  if (props.result.vsMedian <= -0.05) out.push({ tone: "good", text: "unter Median" });
  if (props.result.vsMedian >= 0.15) out.push({ tone: "warn", text: "deutlich über Median" });
  if (drop.value > 0) out.push({ tone: "good", text: `${props.result.priceChangeCount}× gesenkt` });
  if (props.result.daysListedExact && props.result.daysListed > 120) {
    out.push({ tone: "warn", text: `${String(props.result.daysListed)} Tage online` });
  }
  return out;
});
</script>

<template>
  <article :class="['row', layout, { gone: result.delistedAt !== null }]">
    <RouterLink :to="`/fahrzeug/${result.id}`" class="photo">
      <PhotoFrame :src="result.thumbnail" :seed="result.id" :count="result.photoCount" />
    </RouterLink>

    <div class="body">
      <h3 class="title"><RouterLink :to="`/fahrzeug/${result.id}`">{{ title }}</RouterLink></h3>
      <p class="specs">
        <span>{{ registration(result.firstRegistration) }}</span>
        <span v-if="result.mileageKm !== null">{{ num(result.mileageKm) }} km</span>
        <span v-if="result.powerW !== null">{{ wattToPs(result.powerW) }} PS</span>
        <span v-if="result.gearbox">{{ result.gearbox === "manual" ? "Schaltung" : "Automatik" }}</span>
      </p>
      <p class="where">
        <span>{{ result.city ?? result.market }}</span>
        <span :title="result.daysListedExact ? 'Vom Portal angegeben' : 'Seit unserer ersten Beobachtung'">
          {{ onlineFor }}
        </span>
        <span class="srcs">
          <b v-for="s in result.sources" :key="s" :class="{ merged: result.sources.length > 1 }">{{ s }}</b>
        </span>
      </p>
      <p v-if="flags.length" class="flags">
        <span v-for="f in flags" :key="f.text" :class="['flag', f.tone]">{{ f.text }}</span>
      </p>
    </div>

    <div class="price">
      <span class="amount">{{ eur(result.price) }}</span>
      <span :class="['vs', result.vsMedian < 0 ? 'under' : 'over']">{{ pct(result.vsMedian) }} zum Median</span>
      <span v-if="drop > 0" class="drop under">−{{ eur(drop) }} seit Erstlistung</span>
      <button
        type="button" class="remove"
        title="Passt nicht? Aus der Liste entfernen. Bleibt auch nach einer neuen Abfrage entfernt."
        @click="emit('remove', result.id)">
        Entfernen
      </button>
    </div>
  </article>
</template>

<style scoped>
.row {
  display: grid;
  grid-template-columns: 15rem 1fr 11rem;
  gap: var(--s5);
  padding: var(--s4) 0;
  border-bottom: 1px solid var(--line);
  align-items: start;
}
.photo { display: block; text-decoration: none; }
.row.gone .photo, .row.gone .amount { opacity: .6; }
.title { margin: 0 0 3px; font-size: 1.0625rem; font-weight: 600; letter-spacing: -.011em; line-height: 1.3; }
.title a { text-decoration: none; }
.row:hover .title a { color: var(--accent); }
.specs, .where, .flags { margin: 0; display: flex; flex-wrap: wrap; gap: var(--s1) var(--s3); }
.specs { color: var(--ink-2); font-size: .875rem; }
.where { margin-top: var(--s2); font-size: .8125rem; color: var(--ink-3); align-items: center; }
.srcs { display: inline-flex; gap: 4px; }
.srcs b { font-weight: 400; font-size: .6875rem; border: 1px solid var(--line-2); border-radius: var(--r); padding: 0 5px; }
.srcs b.merged { border-color: var(--accent); color: var(--accent); }
.flags { margin-top: var(--s2); }
.flag { font-size: .75rem; border-radius: 99px; padding: 1px 8px; border: 1px solid var(--line-2); color: var(--ink-2); }
.flag.good { border-color: var(--under); color: var(--under); }
.flag.warn { border-color: var(--over); color: var(--over); }
.flag.gone { background: var(--sunk); color: var(--ink-3); }
.price { text-align: right; display: grid; gap: 2px; }
.amount { font-size: 1.375rem; font-weight: 600; letter-spacing: -.02em; }
.vs, .drop { font-size: .8125rem; }
.remove { justify-self: end; margin-top: var(--s1); padding: 0; font-size: .75rem; color: var(--ink-3); text-decoration: underline; }
.remove:hover { color: var(--accent); }
.row.grid .remove { justify-self: start; }

.row.grid {
  grid-template-columns: 1fr;
  gap: var(--s2);
  border-bottom: 0;
}
.row.grid .price { text-align: left; }
.row.grid .amount { font-size: 1.0625rem; }
.row.grid .title { font-size: .9375rem; }
.row.grid .where, .row.grid .flags { display: none; }

@media (max-width: 64rem) {
  .row:not(.grid) { grid-template-columns: 9rem 1fr; }
  .row:not(.grid) .price { grid-column: 2; text-align: left; }
}
@media (max-width: 34rem) {
  .row:not(.grid) { grid-template-columns: 1fr; }
  .row:not(.grid) .price { grid-column: 1; }
}
</style>
