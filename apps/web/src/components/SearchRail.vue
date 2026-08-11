<script setup lang="ts">
import type { SavedSearch } from "../lib/types";

import { nextTick, ref } from "vue";

const props = defineProps<{
  searches: SavedSearch[];
  activeId: string | null;
  counts: Record<string, number>;
  savedName: string | null;
}>();
const emit = defineEmits<{ select: [id: string]; remove: [id: string]; create: []; save: [name: string] }>();

const naming = ref(false);
const draft = ref("");
const field = ref<HTMLInputElement | null>(null);

async function openNaming(): Promise<void> {
  draft.value = props.savedName ?? "";
  naming.value = true;
  await nextTick();
  field.value?.focus();
  field.value?.select();
}

function confirm(): void {
  if (draft.value.trim() === "") return;
  emit("save", draft.value.trim());
  naming.value = false;
}
</script>

<template>
  <aside class="rail">
    <h2>Gespeicherte Suchen</h2>
    <p v-if="searches.length === 0" class="none">
      Noch keine. Kriterien oben setzen und sichern.
    </p>
    <div class="list">
      <div v-for="s in searches" :key="s.id" class="item" :class="{ on: s.id === activeId }">
        <button class="pick" :aria-current="s.id === activeId" @click="emit('select', s.id)">
          <span class="nm">{{ s.name }}</span>
          <span class="mt">{{ counts[s.id] ?? 0 }} aktuell</span>
        </button>
        <button class="del" :aria-label="`${s.name} löschen`" @click="emit('remove', s.id)">×</button>
      </div>
    </div>
    <div class="foot">
      <template v-if="naming">
        <input
          ref="field" v-model="draft" class="namefield" placeholder="Name der Suche"
          @keydown.enter.prevent="confirm()" @keydown.esc="naming = false">
        <span class="foot-actions">
          <button class="btn primary" :disabled="draft.trim() === ''" @click="confirm()">Sichern</button>
          <button class="btn" @click="naming = false">Abbrechen</button>
        </span>
      </template>
      <template v-else>
        <button class="btn" @click="openNaming()">
          {{ savedName === null ? "Aktuelle Suche sichern" : "Umbenennen" }}
        </button>
        <button v-if="savedName !== null" class="btn" @click="emit('create')">Neue Suche</button>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.rail { padding: var(--s4) 0 0; }
h2 { margin: 0 var(--s4) var(--s2); font-size: .75rem; font-weight: 500; color: var(--ink-3); }
.none { margin: 0 var(--s4); font-size: .8125rem; color: var(--ink-3); }
.item { display: flex; align-items: stretch; border-left: 2px solid transparent; }
.item:hover { background: var(--surface); }
.item.on { background: var(--surface); border-left-color: var(--accent); }
.pick { flex: 1; text-align: left; padding: var(--s2) var(--s4); display: grid; gap: 1px; }
.nm { font-size: .875rem; }
.mt { font-size: .75rem; color: var(--ink-3); }
.del { padding: 0 var(--s3); color: var(--ink-3); font-size: 1.125rem; }
.del:hover { color: var(--accent); }
.foot { margin: var(--s3) var(--s4) var(--s3); display: grid; gap: var(--s2); }
.foot .btn { width: 100%; }
.foot-actions { display: flex; gap: var(--s2); }
.foot-actions .btn { flex: 1; }
.namefield {
  width: 100%; padding: 6px var(--s2);
  border: 1px solid var(--line-2); border-radius: var(--r); background: var(--bg);
}

@media (max-width: 64rem) {
  .list { display: flex; overflow-x: auto; }
  .item { border-left: 0; border-bottom: 2px solid transparent; min-width: 11rem; }
  .item.on { border-left: 0; border-bottom-color: var(--accent); }
}
</style>
