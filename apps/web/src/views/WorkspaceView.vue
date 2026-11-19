<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import FilterBar from "../components/FilterBar.vue";
import SearchRail from "../components/SearchRail.vue";
import SourcePanel from "../components/SourcePanel.vue";
import ApiKeyField from "../components/ApiKeyField.vue";
import ResultRow from "../components/ResultRow.vue";
import MarketPane from "../components/MarketPane.vue";
import { useWorkspace } from "../lib/useWorkspace";
import { useApiKey } from "../lib/useApiKey";
import { api } from "../lib/api";
import type { Source } from "../lib/types";
import { relativeTime } from "../lib/format";

const ws = useWorkspace();
const { apiKey } = useApiKey();
const tab = ref<"angebote" | "markt">("angebote");
const layout = ref<"list" | "grid">("list");
const sort = ref<"vsMedian" | "price" | "days" | "mileage">("vsMedian");
const onlyBelowMedian = ref(false);
const sources = ref<Source[]>([]);
const showSources = ref(false);

const SORTERS = {
  vsMedian: (a: { vsMedian: number }, b: { vsMedian: number }) => a.vsMedian - b.vsMedian,
  price: (a: { price: number }, b: { price: number }) => a.price - b.price,
  days: (a: { daysListed: number }, b: { daysListed: number }) => a.daysListed - b.daysListed,
  mileage: (a: { mileageKm: number | null }, b: { mileageKm: number | null }) =>
    (a.mileageKm ?? Infinity) - (b.mileageKm ?? Infinity),
} as const;

const visible = computed(() => {
  const rows = onlyBelowMedian.value ? ws.results.value.filter((r) => r.vsMedian < 0) : ws.results.value;
  return [...rows].sort(SORTERS[sort.value]);
});

const counts = computed(() =>
  ws.activeId.value === null ? {} : { [ws.activeId.value]: ws.results.value.length });

/** Stored for this search but filtered out by the words in the search box. */
const excluded = computed(() => ws.market.value?.excludedByText ?? 0);

/** Words the query read as a build period rather than as a word to look for. */
const periods = computed(() => ws.market.value?.periods ?? []);

/**
 * Rendering several hundred cards at once made the page heavy and buried the
 * market pane below an endless list. The page resets whenever the set changes,
 * so a refresh during collection never leaves the reader on a page that no
 * longer exists.
 */
const PAGE_SIZE = 24;
const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(visible.value.length / PAGE_SIZE)));
const paged = computed(() => visible.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE));

watch([() => visible.value.length, sort, onlyBelowMedian], () => { page.value = 1; });
watch(pageCount, (count) => { if (page.value > count) page.value = count; });

const degraded = computed(() => sources.value.filter((s) => s.enabled && s.consecutiveFailures > 0));
const lastRun = computed(() =>
  sources.value.map((s) => s.finishedAt).filter((f): f is string => f !== null).sort().at(-1) ?? null);

const target = computed(() => ws.criteria.value.priceEur.max);

async function loadSources(): Promise<void> {
  try {
    sources.value = await api.sources();
  } catch {
    sources.value = [];
  }
}

async function toggleSource(id: string, enabled: boolean): Promise<void> {
  try {
    sources.value = await api.setSource(id, enabled);
  } catch {
    await loadSources();
  }
}

const savedName = computed(() =>
  ws.searches.value.find((s) => s.id === ws.activeId.value)?.name ?? null);

function create(): void {
  ws.reset();
  void ws.refresh();
}

onMounted(async () => {
  await ws.loadSearches();
  await loadSources();
});
watch(() => ws.collecting.value, (busy) => { if (!busy) void loadSources(); });
</script>

<template>
  <div class="shell">
    <header class="app">
      <h1>Fahrzeugmarkt</h1>
      <button class="status" :aria-expanded="showSources" @click="showSources = !showSources">
        <i class="pip" :class="{ warn: degraded.length > 0 }" />
        {{ sources.filter((s) => s.enabled).length }} von {{ sources.length }} Quellen aktiv
        <template v-if="degraded.length"> · {{ degraded.length }} gestört</template>
        <template v-else-if="lastRun"> · zuletzt {{ relativeTime(lastRun) }}</template>
        <span class="caret">{{ showSources ? "▾" : "▸" }}</span>
      </button>

      <p v-if="ws.job.value && ws.collecting.value" class="progress">
        Fragt {{ ws.job.value.current ?? "Quellen" }} ab …
        {{ ws.job.value.done }}/{{ ws.job.value.total }}
        <template v-if="ws.job.value.stored > 0"> · {{ ws.job.value.stored }} Angebote</template>
      </p>
      <p v-else-if="ws.job.value?.timedOut" class="progress warn">
        Abfrage abgebrochen, Zeitlimit erreicht. Ergebnisse sind unvollständig.
      </p>
    </header>

    <template v-if="showSources">
      <SourcePanel :sources="sources" @toggle="toggleSource" />
      <ApiKeyField :api-key="apiKey" @update:api-key="apiKey = $event" />
    </template>

    <FilterBar
      v-model="ws.criteria.value"
      :loading="ws.loading.value"
      :collecting="ws.collecting.value"
      @search="ws.search" />

    <p v-if="ws.error.value" class="err" role="alert">{{ ws.error.value }}</p>

    <div class="body">
      <SearchRail
        :searches="ws.searches.value" :active-id="ws.activeId.value" :counts="counts"
        :saved-name="savedName"
        @select="ws.select" @remove="ws.remove" @create="create" @save="ws.save" />

      <div class="main">
        <nav class="tabs" role="tablist">
          <button role="tab" :aria-selected="tab === 'angebote'" @click="tab = 'angebote'">
            Angebote <span class="c">{{ ws.results.value.length }}</span>
          </button>
          <button role="tab" :aria-selected="tab === 'markt'" @click="tab = 'markt'">Markt</button>

          <span class="right" v-if="tab === 'angebote'">
            <button class="preset" :aria-pressed="onlyBelowMedian" @click="onlyBelowMedian = !onlyBelowMedian">
              Unter Median
            </button>
            <select v-model="sort" aria-label="Sortierung">
              <option value="vsMedian">Abweichung zum Markt</option>
              <option value="price">Preis aufsteigend</option>
              <option value="days">Zuletzt eingestellt</option>
              <option value="mileage">Kilometer</option>
            </select>
            <span class="viewsw">
              <button :aria-pressed="layout === 'list'" @click="layout = 'list'">Liste</button>
              <button :aria-pressed="layout === 'grid'" @click="layout = 'grid'">Raster</button>
            </span>
          </span>
        </nav>

        <section v-show="tab === 'angebote'">
          <p v-if="ws.removed.value" class="undo" role="status">
            Entfernt: {{ [ws.removed.value.make, ws.removed.value.model].join(" ") }}
            ({{ ws.removed.value.sources.join(", ") }}).
            <button type="button" @click="ws.undoHide">Rückgängig</button>
          </p>
          <!--
            Only while there is nothing to show. Replacing a populated list with
            a loading line unmounts every row, and a collection run refreshes
            about once a second, so the page jumped back to the top each time and
            reading the results while they arrived was impossible.
          -->
          <p v-if="ws.loading.value && visible.length === 0" class="empty">Lädt …</p>
          <p v-else-if="visible.length === 0" class="empty">
            <template v-if="sources.filter((s) => s.enabled).length === 0">
              Keine Quelle ist aktiv. Links unter „Quellen“ mindestens ein Portal einschalten.
            </template>
            <template v-else-if="degraded.length === sources.filter((s) => s.enabled).length">
              Alle aktiven Quellen sind gestört — siehe „Quellen“ links.
              Bis dahin kommen keine neuen Inserate herein.
            </template>
            <template v-else>
              Keine Treffer. Die Portale wurden abgefragt; entweder gibt es das Fahrzeug
              gerade nicht, oder die Kriterien sind zu eng.
            </template>
          </p>
          <div v-else :class="layout === 'grid' ? 'grid' : 'list'">
            <ResultRow
              v-for="r in paged" :key="r.id" :result="r" :layout="layout"
              @remove="ws.hideResult" />
          </div>
          <nav v-if="pageCount > 1" class="pager" aria-label="Seiten">
            <button type="button" :disabled="page === 1" @click="page -= 1">Zurück</button>
            <span>Seite {{ page }} von {{ pageCount }}, {{ visible.length }} Treffer</span>
            <button type="button" :disabled="page === pageCount" @click="page += 1">Weiter</button>
          </nav>
          <!--
            Collecting is deliberately broader than searching: only the make and
            model decide what is stored, so a portal's whole Skyline page is kept
            for a search that said "Nissan Skyline R34". Without this line the
            difference looked like lost cars.
          -->
          <p v-for="p in periods" :key="p.token" class="excluded">
            „{{ p.token.toUpperCase() }}“ wird als Baujahrsspanne {{ p.fromYear }}–{{ p.toYear }} gelesen.
            Fahrzeuge aus diesen Jahren zählen mit, auch wenn die Anzeige das Wort nicht nennt.
          </p>
          <p v-if="excluded > 0" class="excluded">
            {{ excluded }} weitere gespeicherte {{ excluded === 1 ? "Anzeige passt" : "Anzeigen passen" }}
            nicht zum Suchtext „{{ ws.criteria.value.text }}“.
            Weniger Wörter im Suchfeld zeigen mehr davon.
          </p>
        </section>

        <section v-show="tab === 'markt'">
          <MarketPane v-if="ws.market.value" :report="ws.market.value" :target="target" />
          <p v-else class="empty">Noch keine Marktdaten für diese Suche.</p>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex; align-items: center; gap: var(--s4); flex-wrap: wrap;
  padding: var(--s4) var(--s5) var(--s3);
  background: var(--surface); border-bottom: 1px solid var(--line);
}
.app h1 { margin: 0; font-size: 1rem; font-weight: 600; letter-spacing: -.01em; }
.status {
  display: flex; align-items: center; gap: var(--s2);
  font-size: .8125rem; color: var(--ink-3);
  padding: 2px var(--s2); border-radius: var(--r);
}
.status:hover { color: var(--ink); background: var(--sunk); }
.status .caret { font-size: .625rem; }
.progress { margin: 0 0 0 auto; font-size: .8125rem; color: var(--ink-2); }
.progress.warn { color: var(--over); }
.pip { width: 7px; height: 7px; border-radius: 50%; background: var(--under); }
.pip.warn { background: var(--over); }
.err {
  margin: 0; padding: var(--s3) var(--s5);
  background: var(--surface); color: var(--accent);
  border-bottom: 1px solid var(--line-2); font-size: .875rem;
}
.body { display: grid; grid-template-columns: 15rem 1fr; }
.rail { border-right: 1px solid var(--line); }
.main { min-width: 0; }
.tabs {
  display: flex; align-items: center; gap: var(--s5);
  padding: 0 var(--s5); background: var(--surface); border-bottom: 1px solid var(--line-2);
}
.tabs > button { padding: var(--s3) 0 calc(var(--s3) - 2px); border-bottom: 2px solid transparent; color: var(--ink-3); }
.tabs > button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--accent); }
.tabs .c { color: var(--ink-3); font-size: .8125rem; margin-left: 6px; }
.right { margin-left: auto; display: flex; gap: var(--s3); align-items: center; }
.right select { border: 0; background: none; color: var(--ink-2); font-size: .8125rem; }
.preset { padding: 3px var(--s3); border: 1px solid var(--line-2); border-radius: 99px; font-size: .8125rem; color: var(--ink-2); }
.preset[aria-pressed="true"] { background: var(--ink); color: var(--surface); border-color: var(--ink); }
.viewsw { display: flex; border: 1px solid var(--line-2); border-radius: var(--r); overflow: hidden; }
.viewsw button { padding: 3px var(--s3); font-size: .8125rem; color: var(--ink-3); }
.viewsw button[aria-pressed="true"] { background: var(--sunk); color: var(--ink); }
.undo {
  margin: 0; padding: var(--s2) var(--s5); display: flex; gap: var(--s3); align-items: center;
  background: var(--sunk); font-size: .8125rem; color: var(--ink-2);
}
.undo button { color: var(--accent); text-decoration: underline; }
.list { padding: var(--s2) var(--s5) var(--s6); }
.grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
  gap: var(--s5); padding: var(--s4) var(--s5) var(--s6);
}
@media (max-width: 64rem) { .body { grid-template-columns: 1fr; } }
@media (max-width: 34rem) {
  .app, .list, .grid { padding-left: var(--s4); padding-right: var(--s4); }
  .tabs { padding-left: var(--s4); padding-right: var(--s4); gap: var(--s4); flex-wrap: wrap; }
  .right { margin-left: 0; width: 100%; padding-bottom: var(--s2); }
}
</style>
