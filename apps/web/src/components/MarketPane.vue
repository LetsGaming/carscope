<script setup lang="ts">
import { computed } from "vue";
import { BODY, DAY_MS, GEARBOX, LOW_MILEAGE_KM, SELLER } from "@carscope/core";
import PriceChart from "./PriceChart.vue";
import { eur, num, pct } from "../lib/format";
import type { MarketReport } from "../lib/types";

const props = defineProps<{ report: MarketReport; target?: number | null }>();

/** Keyed by what the report emits; the mileage threshold is the server's, not a copy. */
const FACTOR_LABELS: Record<string, string> = {
  [BODY.coupe]: "Coupé statt Limousine",
  lowMileage: `Unter ${num(LOW_MILEAGE_KM)} km`,
  [SELLER.dealer]: "Händler statt privat",
  [GEARBOX.manual]: "Schaltung statt Automatik",
};

const hasTrend = computed(() => props.report.series.some((p) => p.reliable));
const maxBand = computed(() => Math.max(1, ...props.report.bands.map((b) => b.count)));

/** Day one has a distribution but no history; the runway says what unlocks when. */
const RUNWAY = [
  { label: "Angebote ansehen", need: 0 },
  { label: "Preisverteilung", need: 0 },
  { label: "Standzeiten", need: 30 },
  { label: "Preissenkungen", need: 60 },
  { label: "Jahresverlauf", need: 365 },
];

const daysCollected = computed(() => {
  const first = props.report.series[0];
  if (!first) return 0;
  return Math.round((Date.now() - Date.parse(`${first.month}-01T00:00:00Z`)) / DAY_MS);
});
</script>

<template>
  <div class="mkt">
    <div class="headline">
      <div class="stat">
        <span class="k">Median Angebotspreis</span>
        <span class="v">{{ report.current.n > 0 ? eur(report.current.p50) : "–" }}</span>
        <span class="s" v-if="report.current.n > 0">
          Hälfte liegt zwischen {{ eur(report.current.p25) }} und {{ eur(report.current.p75) }}
        </span>
      </div>
      <div class="stat">
        <span class="k">Gegenüber Vorjahr</span>
        <span :class="['v', report.changeYearPct === null ? 'faint' : report.changeYearPct > 0 ? 'over' : 'under']">
          {{ report.changeYearPct === null ? "–" : pct(report.changeYearPct) }}
        </span>
        <span class="s">{{ report.changeYearPct === null ? "noch keine Historie" : "auf Basis der Monatsmediane" }}</span>
      </div>
      <div class="stat">
        <span class="k">Steht im Schnitt</span>
        <span class="v">{{ report.medianDaysListed ?? "–" }} <small v-if="report.medianDaysListed">Tage</small></span>
        <span class="s">bis verkauft oder zurückgezogen</span>
      </div>
      <div class="stat">
        <span class="k">Stichprobe</span>
        <span class="v">{{ report.observationCount }}</span>
        <span class="s">Fahrzeuge in der Historie · {{ report.activeCount }} aktuell gelistet</span>
      </div>
    </div>

    <section class="panel">
      <header class="chart-head">
        <h2>Preisentwicklung</h2>
        <p class="legend">
          <span><i class="sw ink" />Median</span>
          <span><i class="sw mid" />mittlere Hälfte</span>
          <span><i class="sw soft" />Streubereich</span>
          <span v-if="target != null"><i class="sw acc" />dein Ziel</span>
        </p>
      </header>

      <PriceChart v-if="hasTrend" :series="report.series" :target="target ?? null" />

      <div v-else class="cold">
        <h3>Die Angebote sind da. Der Verlauf braucht Zeit.</h3>
        <p>
          Historische Preise sind nirgends öffentlich abrufbar, die Datenbank füllt sich also ab dem
          ersten Lauf und nicht rückwirkend. Suchen, Filtern und Vergleichen funktioniert sofort.
        </p>
        <div class="runway">
          <div v-for="r in RUNWAY" :key="r.label" class="track">
            <span>{{ r.label }}</span>
            <span class="bar">
              <i :class="{ wait: daysCollected < r.need }"
                 :style="{ width: `${r.need === 0 ? 100 : Math.min(100, (daysCollected / r.need) * 100)}%` }" />
            </span>
            <span class="s">{{ r.need === 0 ? "sofort" : `ab etwa ${r.need} Tagen` }}</span>
          </div>
        </div>
      </div>

      <p class="caveat" v-if="hasTrend">
        Beruht auf {{ report.observationCount }} Fahrzeugen, je Fahrzeug und Monat ein Preis. Monate mit weniger als fünf
        Fahrzeugen sind blass dargestellt, weil einzelne Ausreißer sie stark ziehen.
      </p>
    </section>

    <div class="two">
      <section class="panel">
        <h2>Was gerade angeboten wird</h2>
        <p v-if="report.bands.length === 0" class="faint">Keine aktiven Angebote.</p>
        <div v-for="b in report.bands" :key="b.from" class="band">
          <span class="r">{{ eur(b.from) }}</span>
          <span class="bar"><i :style="{ width: `${(b.count / maxBand) * 100}%` }" /></span>
          <span class="c">{{ b.count }}</span>
        </div>
      </section>

      <section class="panel">
        <h2>Was den Preis treibt</h2>
        <dl v-if="report.factors.length" class="kv">
          <template v-for="f in report.factors" :key="f.key">
            <dt>{{ FACTOR_LABELS[f.key] ?? f.key }}</dt>
            <dd :class="f.deltaEur < 0 ? 'under' : ''">{{ pct(0) === "+0 %" ? "" : "" }}{{ f.deltaEur > 0 ? "+" : "−" }}{{ eur(Math.abs(f.deltaEur)) }}</dd>
          </template>
        </dl>
        <p v-else class="faint">
          Noch zu wenige Fahrzeuge je Gruppe. Sobald beide Seiten eines Merkmals mindestens
          15 Fahrzeuge haben, erscheint der Median-Unterschied hier.
        </p>
        <p v-if="report.factors.length" class="caveat">
          Unbereinigte Median-Differenz zwischen den Gruppen. Hinweise, keine belastbaren Aufschläge.
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.mkt { padding: var(--s5); display: grid; gap: var(--s5); }
.headline { display: flex; gap: var(--s7); flex-wrap: wrap; align-items: flex-end; }
.stat { display: grid; gap: 1px; }
.stat .k { font-size: .8125rem; color: var(--ink-3); }
.stat .v { font-size: 1.75rem; font-weight: 600; letter-spacing: -.02em; line-height: 1.1; }
.stat .v small { font-size: 1rem; font-weight: 400; }
.stat .s { font-size: .8125rem; color: var(--ink-3); }

.chart-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s4); flex-wrap: wrap; margin-bottom: var(--s4); }
.chart-head h2 { margin: 0; font-size: 1rem; font-weight: 600; }
.legend { margin: 0; display: flex; gap: var(--s4); flex-wrap: wrap; font-size: .8125rem; color: var(--ink-2); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.sw { width: 16px; height: 8px; border-radius: 2px; }
.sw.ink { background: var(--ink); }
.sw.mid { background: var(--ink-3); opacity: .55; }
.sw.soft { background: var(--ink-3); opacity: .25; }
.sw.acc { background: var(--accent); }

.cold h3 { margin: 0 0 var(--s2); font-size: 1.0625rem; font-weight: 600; }
.cold p { margin: 0; color: var(--ink-2); max-width: 62ch; }
.runway { display: grid; gap: var(--s3); margin-top: var(--s5); }
.track { display: grid; grid-template-columns: 9.5rem 1fr 8rem; gap: var(--s4); align-items: center; font-size: .875rem; }
.track .bar { height: 6px; border-radius: 99px; background: var(--sunk); overflow: hidden; }
.track .bar i { display: block; height: 100%; background: var(--under); border-radius: 99px; }
.track .bar i.wait { background: var(--line-2); }
.track .s { color: var(--ink-3); font-size: .8125rem; }

.caveat { font-size: .8125rem; color: var(--ink-3); margin: var(--s3) 0 0; max-width: 62ch; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s5); }
.panel h2 { margin: 0 0 var(--s4); font-size: 1rem; font-weight: 600; }
.band { display: grid; grid-template-columns: 5.75rem 1fr 1.75rem; gap: var(--s3); align-items: center; margin-bottom: 7px; font-size: .875rem; }
.band .r { text-align: right; color: var(--ink-2); }
.band .bar { height: 15px; border-radius: 2px; background: var(--sunk); }
.band .bar i { display: block; height: 100%; border-radius: 2px; background: var(--ink-3); }
.band .c { color: var(--ink-3); font-size: .8125rem; }
.kv { display: grid; grid-template-columns: 1fr auto; gap: var(--s2) var(--s4); font-size: .875rem; margin: 0; }
.kv dt { color: var(--ink-2); }
.kv dd { margin: 0; font-weight: 500; }

@media (max-width: 64rem) {
  .two { grid-template-columns: 1fr; }
  .headline { gap: var(--s5); }
  .track { grid-template-columns: 8rem 1fr; }
  .track .s { grid-column: 2; }
}
</style>
