<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ src: string | null; seed: string; count?: number }>();

/** The palette itself is a token set; this only picks which one. */
const TONE_COUNT = 6;
const SEED_MULTIPLIER = 31;

/** Until a thumbnail is cached locally the frame keeps the crop and scale honest. */
const tone = computed(() => {
  let h = 0;
  for (const ch of props.seed) h = (h * SEED_MULTIPLIER + ch.charCodeAt(0)) % TONE_COUNT;
  return { back: `var(--tone-${h + 1}-back)`, fore: `var(--tone-${h + 1}-fore)` };
});
const gradientId = computed(() => `g-${props.seed.replace(/[^a-z0-9]/gi, "")}`);
</script>

<template>
  <div class="frame">
    <img v-if="src" :src="src" alt="" loading="lazy">
    <svg v-else viewBox="0 0 200 80" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" :stop-color="tone.fore" />
          <stop offset="1" :stop-color="tone.back" />
        </linearGradient>
      </defs>
      <rect width="200" height="80" :fill="`url(#${gradientId})`" />
      <ellipse cx="100" cy="74" rx="86" ry="6" fill="var(--tone-shadow)" />
      <path
        d="M8 62 L11 46 C13 39 22 35 38 33 L58 19 C63 15 72 13 88 13 L116 13 C130 13 140 16 148 22 L164 33 C180 35 190 40 192 48 L193 62 Z"
        fill="var(--tone-body)" opacity=".82" />
      <path d="M63 32 L76 21 C79 18 84 17 93 17 L104 17 L104 32 Z" :fill="tone.fore" opacity=".5" />
      <path d="M110 17 L124 17 C133 17 139 20 145 25 L154 32 L110 32 Z" :fill="tone.fore" opacity=".38" />
      <circle cx="52" cy="62" r="14" fill="var(--tone-body)" />
      <circle cx="52" cy="62" r="6" :fill="tone.fore" opacity=".6" />
      <circle cx="152" cy="62" r="14" fill="var(--tone-body)" />
      <circle cx="152" cy="62" r="6" :fill="tone.fore" opacity=".6" />
    </svg>
    <span v-if="count" class="count">{{ count }} Fotos</span>
  </div>
</template>

<style scoped>
.frame {
  position: relative;
  border-radius: var(--r);
  overflow: hidden;
  background: var(--sunk);
  aspect-ratio: 16 / 10;
}
img, svg { display: block; width: 100%; height: 100%; object-fit: cover; }
.count {
  position: absolute; left: 6px; bottom: 6px;
  background: var(--scrim-soft); color: var(--on-scrim);
  font-size: .6875rem; padding: 1px 6px; border-radius: 99px;
}
</style>
