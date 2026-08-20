import { ref, watch, type Ref } from "vue";

const STORAGE_KEY = "carscope.apiKey";

/**
 * The key lives only in this browser's `localStorage`, entered by whoever
 * operates this install. Nothing is shipped in the built bundle: a static
 * file cannot hold a secret, and different people opening the same page can
 * hold different keys. See docs/http-api.md on why writes need one at all.
 */
export function useApiKey(): { apiKey: Ref<string | null>; clear: () => void } {
  const apiKey = ref<string | null>(
    typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY),
  );

  watch(apiKey, (value) => {
    if (typeof localStorage === "undefined") return;
    if (value === null || value.trim() === "") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value.trim());
  });

  return { apiKey, clear: () => { apiKey.value = null; } };
}

/** Read once, outside a component — for the plain `fetch` wrapper in api.ts. */
export function readStoredApiKey(): string | null {
  if (typeof localStorage === "undefined") return null;
  const value = localStorage.getItem(STORAGE_KEY);
  return value === null || value.trim() === "" ? null : value;
}
