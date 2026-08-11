<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useRoute } from "vue-router";
import PhotoGallery from "../components/PhotoGallery.vue";
import PriceHistory from "../components/PriceHistory.vue";
import { eur, mapsUrl, num, registration, wattToKw, wattToPs } from "../lib/format";
import { vehicleApi, type PriceSnapshot, type VehicleDetail } from "../lib/api";

const route = useRoute();
const vehicle = ref<VehicleDetail | null>(null);
const history = ref<PriceSnapshot[]>([]);
const error = ref<string | null>(null);

const title = computed(() =>
  vehicle.value === null
    ? ""
    : [vehicle.value.make, vehicle.value.model, vehicle.value.variant].filter(Boolean).join(" "));

const drop = computed(() =>
  vehicle.value === null ? 0 : vehicle.value.firstPrice.baseAmount - vehicle.value.currentPrice.baseAmount);

onMounted(async () => {
  const id = String(route.params["id"]);
  try {
    const [v, h] = await Promise.all([vehicleApi.detail(id), vehicleApi.prices(id)]);
    vehicle.value = v;
    history.value = h;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Fahrzeug nicht gefunden";
  }
});
</script>

<template>
  <div>
    <header class="app">
      <RouterLink to="/" class="btn">← Angebote</RouterLink>
      <h1 v-if="vehicle">{{ title }}</h1>
    </header>

    <p v-if="error" class="empty">{{ error }}</p>
    <p v-else-if="!vehicle" class="empty">Lädt …</p>

    <div v-else class="detail">
      <div class="main">
        <PhotoGallery :photos="vehicle.photos" :seed="vehicle.id" />

        <p class="specs">
          <span>{{ registration(vehicle.firstRegistration) }}</span>
          <span v-if="vehicle.mileageKm !== null">{{ num(vehicle.mileageKm) }} km</span>
          <span v-if="vehicle.powerW !== null">{{ wattToPs(vehicle.powerW) }} PS · {{ wattToKw(vehicle.powerW) }} kW</span>
          <span v-if="vehicle.gearbox">{{ vehicle.gearbox === "manual" ? "Schaltung" : "Automatik" }}</span>
          <a v-if="mapsUrl(vehicle)" class="place" :href="mapsUrl(vehicle) ?? '#'" target="_blank" rel="noopener">
            {{ [vehicle.postalCode, vehicle.city].filter(Boolean).join(" ") || vehicle.market }} · Karte
          </a>
          <span v-else>{{ vehicle.market }}</span>
        </p>

        <section v-if="vehicle.description" class="panel description">
          <h2>Beschreibung des Anbieters</h2>
          <p>{{ vehicle.description }}</p>
        </section>

        <section class="panel chart">
          <h2>Preisverlauf</h2>
          <PriceHistory :history="history" />
        </section>
      </div>

      <aside class="side">
        <p class="price">{{ eur(vehicle.currentPrice.baseAmount) }}</p>
        <p v-if="drop > 0" class="under">{{ eur(drop) }} unter der Erstlistung</p>
        <p v-if="vehicle.listings[0]" class="acts">
          <a class="btn primary" :href="vehicle.listings[0].url" target="_blank" rel="noopener">
            Beim Anbieter öffnen
          </a>
        </p>

        <h2>Gefunden auf</h2>
        <p class="srcs"><b v-for="l in vehicle.listings" :key="l.sourceId">{{ l.sourceId }}</b></p>
        <p v-if="vehicle.listings.length > 1" class="note">
          Als ein Fahrzeug zusammengefasst.
        </p>

        <h2>Eckdaten</h2>
        <dl class="facts">
          <dt>Anbieter</dt><dd>{{ vehicle.sellerName ?? (vehicle.sellerType === "private" ? "Privat" : "–") }}</dd>
          <dt>{{ vehicle.firstListedAt ? "Online seit" : "Beobachtet seit" }}</dt>
          <dd>{{ vehicle.daysListed }} Tagen</dd>
          <dt>Preisänderungen</dt><dd>{{ vehicle.priceChangeCount }}</dd>
          <dt>Beobachtungen</dt><dd>{{ history.length }}</dd>
        </dl>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex; align-items: center; gap: var(--s4);
  padding: var(--s3) var(--s5); background: var(--surface); border-bottom: 1px solid var(--line);
}
.app h1 { margin: 0; font-size: 1rem; font-weight: 600; }
.app .btn { text-decoration: none; }
.detail { display: grid; grid-template-columns: 1fr 21rem; }
.main { padding: var(--s5); min-width: 0; }
.specs { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s3); color: var(--ink-2); margin: var(--s4) 0 0; }
.place { color: var(--accent); text-decoration: none; }
.place:hover { text-decoration: underline; }
.description { margin-top: var(--s5); }
.description h2 { font-size: 1rem; font-weight: 600; margin: 0 0 var(--s3); }
.description p { margin: 0; white-space: pre-wrap; color: var(--ink-2); max-width: 72ch; }
.chart { margin-top: var(--s5); }
.chart h2, .side h2 { font-size: 1rem; font-weight: 600; margin: 0 0 var(--s3); }
.side { border-left: 1px solid var(--line); padding: var(--s5); background: var(--surface); }
.side h2 { font-size: .8125rem; font-weight: 500; color: var(--ink-3); margin-top: var(--s5); }
.price { font-size: 1.75rem; font-weight: 600; letter-spacing: -.02em; margin: 0; }
.acts { margin: var(--s4) 0 0; }
.acts .btn { text-decoration: none; display: inline-block; }
.srcs { display: flex; gap: 4px; flex-wrap: wrap; margin: var(--s2) 0 0; }
.srcs b { font-weight: 400; font-size: .6875rem; border: 1px solid var(--accent); color: var(--accent); border-radius: var(--r); padding: 0 5px; }
.note { font-size: .8125rem; color: var(--ink-3); margin-top: var(--s2); }
.facts { display: grid; grid-template-columns: 1fr auto; gap: var(--s2) var(--s4); font-size: .875rem; margin: 0; }
.facts dt { color: var(--ink-2); }
.facts dd { margin: 0; font-weight: 500; }
@media (max-width: 64rem) {
  .detail { grid-template-columns: 1fr; }
  .side { border-left: 0; border-top: 1px solid var(--line); }
}
</style>
