<script setup lang="ts">
import { computed } from "vue";
import { relativeTime } from "../lib/format";
import type { Source } from "../lib/types";

const props = defineProps<{ sources: Source[] }>();
const emit = defineEmits<{ toggle: [id: string, enabled: boolean] }>();

const active = computed(() => props.sources.filter((s) => s.enabled));

const TONE: Readonly<Record<string, string>> = {
  ok: "ok", idle: "idle", blocked: "bad", error: "bad", off: "off", skipped: "idle",
};

const LABEL: Readonly<Record<string, string>> = {
  ok: "läuft", idle: "noch nie gelaufen", blocked: "abgewiesen",
  error: "Fehler", off: "aus", skipped: "übersprungen",
};
</script>

<template>
  <section class="panel">
    <p class="lead">
      Portale, die abgefragt werden. Welche Länder ein Portal abfragt, entscheidet
      die Länderauswahl in der Suche — nicht diese Liste.
    </p>
    <ul class="list">
      <li v-for="s in sources" :key="s.id">
        <label class="row">
          <input
            type="checkbox" :checked="s.enabled"
            :aria-label="`${s.label} aktivieren`"
            @change="emit('toggle', s.id, ($event.target as HTMLInputElement).checked)">
          <span class="name">
            {{ s.label }}
            <span class="market">{{ s.markets.join(" ") }}</span>
          </span>
          <span :class="['state', TONE[s.status] ?? 'idle']">{{ LABEL[s.status] ?? s.status }}</span>
        </label>
        <p v-if="s.enabled && s.note" class="note">
          {{ s.note }}
          <template v-if="s.finishedAt"> · {{ relativeTime(s.finishedAt) }}</template>
          <template v-if="s.consecutiveFailures > 1"> · {{ s.consecutiveFailures }} Fehlversuche in Folge</template>
        </p>
      </li>
    </ul>
    <p v-if="active.length === 0" class="lead warn">
      Keine Quelle aktiv — eine Suche findet nur, was schon in der Datenbank liegt.
    </p>
  </section>
</template>

<style scoped>
.panel {
  background: var(--sunk);
  border-bottom: 1px solid var(--line-2);
  padding: var(--s4) var(--s5);
}
.lead { margin: 0 0 var(--s3); font-size: .8125rem; color: var(--ink-3); max-width: 62ch; }
.lead.warn { margin: var(--s3) 0 0; color: var(--over); }
.list {
  list-style: none; margin: 0; padding: 0;
  display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: var(--s1) var(--s4);
}
.row { display: flex; align-items: center; gap: var(--s2); padding: var(--s1) 0; cursor: pointer; }
.row:hover .name { color: var(--ink); }
.row input { accent-color: var(--accent); }
.name { flex: 1; font-size: .8125rem; }
.market { color: var(--ink-3); font-size: .6875rem; margin-left: 4px; }
.state { font-size: .6875rem; }
.state.ok { color: var(--under); }
.state.bad { color: var(--accent); }
.state.idle, .state.off { color: var(--ink-3); }
.note { margin: 0 0 var(--s2) 1.6rem; font-size: .75rem; color: var(--ink-3); }
</style>
