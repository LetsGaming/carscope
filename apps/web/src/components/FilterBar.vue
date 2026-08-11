<script setup lang="ts">
import { FUEL, GEARBOX, MARKET, MARKETS, SELLER, type Market } from "@carscope/core";
import type { EditableCriteria } from "../lib/types";

/**
 * The criteria are owned by the workspace, so they arrive as a model rather than
 * a prop the component writes through. `defineModel` gives the two-way binding
 * the template needs without any component reaching into its parent's state.
 */
const criteria = defineModel<EditableCriteria>({ required: true });

const CURRENT_YEAR = new Date().getFullYear();

defineProps<{ loading: boolean; collecting: boolean }>();
const emit = defineEmits<{ search: [] }>();

/**
 * Every country the API accepts is offered. The list used to be a shorter copy
 * of the domain's, so SE, CH and PL could be collected but never selected.
 */
const COUNTRY_LABELS: Readonly<Record<Market, string>> = {
  [MARKET.de]: "Deutschland",
  [MARKET.at]: "Österreich",
  [MARKET.nl]: "Niederlande",
  [MARKET.be]: "Belgien",
  [MARKET.lu]: "Luxemburg",
  [MARKET.it]: "Italien",
  [MARKET.es]: "Spanien",
  [MARKET.fr]: "Frankreich",
  [MARKET.se]: "Schweden",
  [MARKET.ch]: "Schweiz",
  [MARKET.pl]: "Polen",
};

const COUNTRIES = MARKETS.map((code) => ({ code, label: COUNTRY_LABELS[code] }));

const FUEL_LABELS: Readonly<Record<string, string>> = {
  [FUEL.petrol]: "Benzin",
  [FUEL.diesel]: "Diesel",
  [FUEL.electric]: "Elektro",
  [FUEL.hybrid]: "Hybrid",
  [FUEL.lpg]: "Autogas",
  [FUEL.cng]: "Erdgas",
};

const GEARBOX_LABELS: Readonly<Record<string, string>> = {
  [GEARBOX.manual]: "Schaltung",
  [GEARBOX.automatic]: "Automatik",
};

const SELLER_LABELS: Readonly<Record<string, string>> = {
  [SELLER.private]: "Privat",
  [SELLER.dealer]: "Händler",
};

/**
 * A year field accepting six digits lets 19999 through, which the schema then
 * rejects as an integer out of range after a round trip. The bounds are the
 * ones the API declares, so the form cannot ask for something it will refuse.
 */
const LIMIT = {
  PRICE: { min: 0, max: 10_000_000, digits: 8 },
  MILEAGE: { min: 0, max: 2_000_000, digits: 7 },
  YEAR: { min: 1900, max: CURRENT_YEAR + 1, digits: 4 },
  POWER: { min: 0, max: 2_000, digits: 4 },
} as const;

const RADIUS_OPTIONS = [
  { label: "ohne Umkreis", value: null },
  { label: "50 km", value: 50 },
  { label: "100 km", value: 100 },
  { label: "200 km", value: 200 },
  { label: "500 km", value: 500 },
];

function toggleCountry(code: Market): void {
  const markets = criteria.value.markets;
  criteria.value = {
    ...criteria.value,
    markets: markets.includes(code) ? markets.filter((m) => m !== code) : [...markets, code],
  };
}
</script>

<template>
  <form class="filters" @submit.prevent="emit('search')">
    <div class="search">
      <span class="field">
        <input
          v-model="criteria.text"
          placeholder="Marke, Modell oder Stichwort"
          aria-label="Marke, Modell oder Stichwort">
        <button
          v-if="criteria.text !== ''" class="clear" type="button"
          aria-label="Suchbegriff löschen" @click="criteria.text = ''">×</button>
      </span>
      <button class="btn primary" type="submit" :disabled="loading || collecting">
        {{ collecting ? "Fragt Quellen ab …" : loading ? "Sucht …" : "Suchen" }}
      </button>
    </div>

    <div class="line">
      <label class="f"><span>Preis €</span>
        <span class="pair">
          <input v-model.number="criteria.priceEur.min" inputmode="numeric" type="number"
            :min="LIMIT.PRICE.min" :max="LIMIT.PRICE.max" :maxlength="LIMIT.PRICE.digits" aria-label="Preis von">
          <em>–</em>
          <input v-model.number="criteria.priceEur.max" inputmode="numeric" type="number"
            :min="LIMIT.PRICE.min" :max="LIMIT.PRICE.max" :maxlength="LIMIT.PRICE.digits" aria-label="Preis bis">
        </span>
      </label>
      <label class="f"><span>Kilometer</span>
        <span class="pair">
          <input v-model.number="criteria.mileageKm.min" inputmode="numeric" type="number"
            :min="LIMIT.MILEAGE.min" :max="LIMIT.MILEAGE.max" :maxlength="LIMIT.MILEAGE.digits" aria-label="Kilometer von">
          <em>–</em>
          <input v-model.number="criteria.mileageKm.max" inputmode="numeric" type="number"
            :min="LIMIT.MILEAGE.min" :max="LIMIT.MILEAGE.max" :maxlength="LIMIT.MILEAGE.digits" aria-label="Kilometer bis">
        </span>
      </label>
      <label class="f"><span>Erstzulassung</span>
        <span class="pair">
          <input v-model.number="criteria.registrationYear.min" inputmode="numeric" type="number"
            :min="LIMIT.YEAR.min" :max="LIMIT.YEAR.max" :maxlength="LIMIT.YEAR.digits" aria-label="Baujahr von">
          <em>–</em>
          <input v-model.number="criteria.registrationYear.max" inputmode="numeric" type="number"
            :min="LIMIT.YEAR.min" :max="LIMIT.YEAR.max" :maxlength="LIMIT.YEAR.digits" aria-label="Baujahr bis">
        </span>
      </label>
      <label class="f"><span>Leistung PS</span>
        <span class="pair">
          <input v-model.number="criteria.powerPs.min" inputmode="numeric" type="number"
            :min="LIMIT.POWER.min" :max="LIMIT.POWER.max" :maxlength="LIMIT.POWER.digits" aria-label="Leistung von">
          <em>–</em>
          <input v-model.number="criteria.powerPs.max" inputmode="numeric" type="number"
            :min="LIMIT.POWER.min" :max="LIMIT.POWER.max" :maxlength="LIMIT.POWER.digits" aria-label="Leistung bis">
        </span>
      </label>
      <label class="f"><span>Kraftstoff</span>
        <select v-model="criteria.fuel">
          <option :value="null">egal</option>
          <option v-for="(label, value) in FUEL_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label class="f"><span>Getriebe</span>
        <select v-model="criteria.gearbox">
          <option :value="null">egal</option>
          <option v-for="(label, value) in GEARBOX_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <label class="f"><span>Anbieter</span>
        <select v-model="criteria.sellerType">
          <option :value="null">egal</option>
          <option v-for="(label, value) in SELLER_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
    </div>

    <div class="line where">
      <span class="f"><span>Land</span>
        <span class="chips">
          <button
            v-for="c in COUNTRIES" :key="c.code" type="button" class="chip"
            :aria-pressed="criteria.markets.includes(c.code)"
            :title="c.label"
            @click="toggleCountry(c.code)">{{ c.code }}</button>
          <span v-if="criteria.markets.length === 0" class="hint warn">
            alle Länder — deutlich langsamer
          </span>
        </span>
      </span>
      <label class="f"><span>Umkreis um PLZ</span>
        <span class="pair">
          <input v-model="criteria.postalCode" class="zip" inputmode="numeric" maxlength="10" placeholder="PLZ" aria-label="Postleitzahl">
          <select v-model="criteria.radiusKm" aria-label="Radius">
            <option v-for="r in RADIUS_OPTIONS" :key="String(r.value)" :value="r.value">{{ r.label }}</option>
          </select>
        </span>
      </label>
    </div>
  </form>
</template>

<style scoped>
.filters {
  background: var(--surface);
  border-bottom: 1px solid var(--line-2);
  padding: var(--s4) var(--s5);
  display: grid;
  gap: var(--s3);
}
.search { display: flex; gap: var(--s3); }
.field { position: relative; flex: 1; display: flex; }
.field input {
  flex: 1; min-width: 0;
  padding: var(--s3) 2.25rem var(--s3) var(--s4);
  border: 1px solid var(--line-2); border-radius: var(--r); background: var(--bg);
}
.clear {
  position: absolute; right: var(--s2); top: 50%; transform: translateY(-50%);
  width: 1.5rem; height: 1.5rem; border-radius: 50%;
  color: var(--ink-3); font-size: 1.125rem; line-height: 1;
}
.clear:hover { color: var(--ink); background: var(--sunk); }

.line { display: flex; gap: var(--s4); flex-wrap: wrap; align-items: flex-end; }
.where { padding-top: var(--s2); border-top: 1px solid var(--line); }
.f { display: grid; gap: 3px; }
.f > span:first-child { font-size: .75rem; color: var(--ink-3); }
.pair { display: flex; align-items: center; gap: var(--s1); }
.pair input { width: 4.75rem; }
.pair input.zip { width: 5.25rem; }
.pair em { font-style: normal; color: var(--ink-3); font-size: .8125rem; }
.line input, .line select {
  padding: 6px var(--s2);
  border: 1px solid var(--line-2); border-radius: var(--r); background: var(--bg);
}

.chips { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
.chip {
  padding: 5px var(--s3); border: 1px solid var(--line-2); border-radius: 99px;
  font-size: .8125rem; color: var(--ink-2);
}
.chip:hover { border-color: var(--ink-3); color: var(--ink); }
.chip[aria-pressed="true"] { background: var(--ink); color: var(--surface); border-color: var(--ink); }
.hint { font-size: .75rem; color: var(--ink-3); }
.hint.warn { color: var(--over); }

@media (max-width: 34rem) {
  .filters { padding: var(--s4); }
  .f { flex: 1 1 45%; }
}
</style>
