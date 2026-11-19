<script setup lang="ts">
import { eur } from "../lib/format";
import type { Result } from "../lib/types";

defineProps<{ results: Result[] }>();
const emit = defineEmits<{ release: [id: string] }>();

const REASON: Readonly<Record<string, string>> = {
  wanted: "Gesuch",
  placeholder_price: "Platzhalterpreis",
};
</script>

<template>
  <ul class="held">
    <li v-for="r in results" :key="r.id">
      <span class="reason">{{ REASON[r.heldReason ?? ""] ?? "zurückgehalten" }}</span>
      <a :href="r.url" target="_blank" rel="noopener">{{ [r.make, r.model, r.variant].filter(Boolean).join(" ") }}</a>
      <span class="price">{{ eur(r.price) }}</span>
      <button type="button" @click="emit('release', r.id)">Freigeben</button>
    </li>
  </ul>
</template>

<style scoped>
.held { list-style: none; margin: 0; padding: var(--s2) var(--s5) var(--s4); display: grid; gap: var(--s2); }
.held li { display: flex; gap: var(--s3); align-items: baseline; font-size: .875rem; color: var(--ink-2); }
.reason { font-size: .75rem; border: 1px solid var(--line-2); border-radius: 99px; padding: 1px 8px; color: var(--ink-3); }
.price { margin-left: auto; color: var(--ink-3); }
.held button { color: var(--accent); text-decoration: underline; font-size: .8125rem; }
</style>
