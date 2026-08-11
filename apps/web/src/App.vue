<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";

/** Follows the system setting. A manual switch is one control nobody asked for. */
const query = window.matchMedia("(prefers-color-scheme: dark)");
const apply = (): void => {
  document.documentElement.setAttribute("data-theme", query.matches ? "dark" : "light");
};

onMounted(() => {
  apply();
  query.addEventListener("change", apply);
});
onUnmounted(() => query.removeEventListener("change", apply));
</script>

<template>
  <RouterView />
</template>
