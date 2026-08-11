<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import PhotoFrame from "./PhotoFrame.vue";

const props = defineProps<{
  photos: { url: string; position: number }[];
  seed: string;
}>();

const index = ref(0);
const count = computed(() => props.photos.length);
const strip = ref<HTMLElement | null>(null);
const SWIPE_THRESHOLD_PX = 40;

/** Wraps, so the last photo leads back to the first rather than dead-ending. */
function go(delta: number): void {
  if (count.value === 0) return;
  index.value = (index.value + delta + count.value) % count.value;
}

const current = computed(() => props.photos[index.value] ?? null);

/** The next photo is fetched while this one is being looked at. */
const preload = computed(() => {
  if (count.value < 2) return [];
  return [props.photos[(index.value + 1) % count.value], props.photos[(index.value - 1 + count.value) % count.value]]
    .filter((p): p is { url: string; position: number } => p !== undefined)
    .map((p) => p.url);
});

let touchStartX = 0;
const onTouchStart = (e: TouchEvent): void => { touchStartX = e.changedTouches[0]?.clientX ?? 0; };
const onTouchEnd = (e: TouchEvent): void => {
  const delta = (e.changedTouches[0]?.clientX ?? 0) - touchStartX;
  if (Math.abs(delta) > SWIPE_THRESHOLD_PX) go(delta < 0 ? 1 : -1);
};

/** Arrow keys work from anywhere on the page, as they do on every portal. */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function onKey(e: KeyboardEvent): void {
  const target = e.target;
  if (target instanceof HTMLElement && TYPING_TAGS.has(target.tagName)) return;
  if (e.key === "ArrowRight") go(1);
  else if (e.key === "ArrowLeft") go(-1);
  else return;
  e.preventDefault();
}

onMounted(() => window.addEventListener("keydown", onKey));
onUnmounted(() => window.removeEventListener("keydown", onKey));

// Keep the active thumbnail in view when paging past the end of the strip.
watch(index, () => {
  strip.value?.querySelector<HTMLElement>('[aria-current="true"]')
    ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
});
</script>

<template>
  <figure class="gallery">
    <div
      class="stage"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd">
      <PhotoFrame
        class="hero"
        :src="current?.url ?? null"
        :seed="`${seed}-${index}`" />

      <button
        v-if="count > 1" class="step prev" type="button"
        aria-label="Vorheriges Foto" @click="go(-1)">‹</button>
      <button
        v-if="count > 1" class="advance" type="button"
        aria-label="Nächstes Foto" @click="go(1)">
        <span class="step next" aria-hidden="true">›</span>
      </button>

      <figcaption v-if="count > 1" class="counter">{{ index + 1 }} / {{ count }}</figcaption>
    </div>

    <div v-if="count > 1" ref="strip" class="strip">
      <button
        v-for="(p, i) in photos" :key="p.position" type="button"
        :aria-current="i === index" :aria-label="`Foto ${i + 1}`" @click="index = i">
        <PhotoFrame :src="p.url" :seed="`${seed}-${i}`" />
      </button>
    </div>

    <link v-for="url in preload" :key="url" rel="prefetch" as="image" :href="url">
  </figure>
</template>

<style scoped>
.gallery { margin: 0; }
.stage { position: relative; }
.hero { aspect-ratio: 16 / 9; }

/* The whole right-hand side advances, which is what every portal does. */
.advance {
  position: absolute; inset: 0 0 0 35%;
  display: flex; align-items: center; justify-content: flex-end;
  padding-right: var(--s3); cursor: pointer;
}
.step {
  display: grid; place-items: center;
  width: 2.5rem; height: 2.5rem; border-radius: 50%;
  background: var(--scrim); color: var(--on-scrim); font-size: 1.5rem; line-height: 1;
  opacity: 0; transition: opacity .15s ease, background .15s ease;
}
.prev {
  position: absolute; left: var(--s3); top: 50%; transform: translateY(-50%);
  cursor: pointer; z-index: 1;
}
.stage:hover .step, .stage:focus-within .step { opacity: 1; }
.step:hover { background: var(--scrim-strong); }
.advance:focus-visible .step, .prev:focus-visible { opacity: 1; }

.counter {
  position: absolute; right: var(--s3); bottom: var(--s3);
  background: var(--scrim-soft); color: var(--on-scrim);
  font-size: .75rem; padding: 2px var(--s2); border-radius: 99px;
}

.strip {
  display: flex; gap: var(--s2); margin-top: var(--s2);
  overflow-x: auto; scroll-snap-type: x proximity; padding-bottom: 2px;
}
.strip button {
  flex: 0 0 6.5rem; padding: 0; border-radius: var(--r);
  overflow: hidden; scroll-snap-align: start; opacity: .55;
  transition: opacity .15s ease;
}
.strip button:hover { opacity: .85; }
.strip button[aria-current="true"] { opacity: 1; outline: 2px solid var(--accent); outline-offset: -2px; }

@media (prefers-reduced-motion: reduce) {
  .step, .strip button { transition: none; }
}
@media (max-width: 34rem) {
  /* Touch has swipe; permanent controls would only cover the picture. */
  .step { opacity: 1; width: 2rem; height: 2rem; font-size: 1.25rem; }
  .strip button { flex-basis: 5rem; }
}
</style>
