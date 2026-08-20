<script setup lang="ts">
defineProps<{ apiKey: string | null }>();
const emit = defineEmits<{ "update:apiKey": [value: string | null] }>();
</script>

<template>
  <div class="field">
    <label for="api-key">API-Schlüssel</label>
    <input
      id="api-key" type="password" autocomplete="off" spellcheck="false"
      placeholder="nur nötig, wenn der Server Schlüssel verlangt"
      :value="apiKey ?? ''"
      @change="emit('update:apiKey', ($event.target as HTMLInputElement).value || null)">
    <button v-if="apiKey" type="button" class="clear" @click="emit('update:apiKey', null)">
      Entfernen
    </button>
    <p class="hint">
      Bleibt nur in diesem Browser (localStorage), wird nirgends sonst gespeichert.
    </p>
  </div>
</template>

<style scoped>
.field { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); padding: var(--s3) 0 0; }
label { font-size: .8125rem; color: var(--ink-2); }
input {
  flex: 1; min-width: 12rem; padding: 4px var(--s2);
  border: 1px solid var(--line-2); border-radius: var(--r); background: var(--surface); color: var(--ink);
  font-size: .8125rem;
}
.clear { font-size: .75rem; color: var(--ink-3); padding: 2px var(--s2); }
.clear:hover { color: var(--accent); }
.hint { flex-basis: 100%; margin: 0; font-size: .6875rem; color: var(--ink-3); }
</style>
