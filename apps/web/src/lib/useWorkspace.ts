import { ref, shallowRef, type Ref } from "vue";
import { DEFAULT_WINDOW_MONTHS } from "@carscope/core";
import { api } from "./api";
import { useCollectionProgress } from "./useCollectionProgress";
import {
  copyCriteria, emptyCriteria,
  type EditableCriteria, type MarketReport, type Result, type SavedSearch,
} from "./types";

/**
 * All server state for the workspace lives here rather than in components, so
 * views only render and emit. Watching a running collection is its own
 * composable; this one owns the searches, the results and the report.
 */
export function useWorkspace() {
  const progress = useCollectionProgress();
  const searches = shallowRef<SavedSearch[]>([]);
  const activeId = ref<string | null>(null);
  const criteria = ref<EditableCriteria>(emptyCriteria());
  const results = shallowRef<Result[]>([]);
  const market = shallowRef<MarketReport | null>(null);
  const removed = shallowRef<Result | null>(null);
  /** Wanted ads and placeholder prices, kept out of the list. Loaded when asked for. */
  const heldResults = shallowRef<Result[]>([]);
  const showHeld = ref(false);
  /** "all" also lists cars whose adverts have gone offline. */
  const scope = ref<"active" | "all">("active");
  const loading = ref(false);
  const collecting = ref(false);
  const error: Ref<string | null> = ref(null);

  async function guard(work: () => Promise<void>): Promise<void> {
    error.value = null;
    try {
      await work();
    } catch (e) {
      error.value = e instanceof Error ? e.message : "Anfrage fehlgeschlagen";
    }
  }

  const loadSearches = (): Promise<void> => guard(async () => {
    searches.value = await api.listSearches();
    const first = searches.value[0];
    if (activeId.value === null && first) await select(first.id);
    else await refresh();
  });

  const select = (id: string): Promise<void> => guard(async () => {
    activeId.value = id;
    removed.value = null;
    const found = searches.value.find((s) => s.id === id);
    // A copy, not a reference: the form writes into its ranges, and a shallow
    // copy would edit the entry still sitting in the rail.
    if (found) criteria.value = copyCriteria(found.criteria);
    await refresh();
  });

  /** Runs against everything already collected. Saving is not a precondition. */
  /**
   * A collection run refreshes about once a second and does not wait for the
   * previous one, so several are in flight at once and they do not come back in
   * the order they were sent. Without this counter the last response to arrive
   * won, which could be the oldest: the offers were in the database and the list
   * showed what the query had returned before they were written.
   */
  let issued = 0;

  const refresh = (): Promise<void> => guard(async () => {
    issued += 1;
    const ticket = issued;
    loading.value = true;
    try {
      // Both requests read the criteria as they were when the search started,
      // so typing while one is in flight cannot change what was asked for.
      const snapshot = copyCriteria(criteria.value);
      const [r, m] = await Promise.all([
        api.results(snapshot, scope.value === "active"),
        api.market(snapshot, DEFAULT_WINDOW_MONTHS),
      ]);
      // A response older than one already applied is discarded, not shown.
      if (ticket !== issued) return;
      results.value = r;
      market.value = m;
    } finally {
      // Only the newest request owns the loading flag, or an early one finishing
      // late would clear it while the current one is still running.
      if (ticket === issued) loading.value = false;
    }
  });

  const save = (name: string): Promise<void> => guard(async () => {
    const id = activeId.value;
    const saved = id === null
      ? await api.createSearch(name, criteria.value)
      : await api.updateSearch(id, name, criteria.value);
    searches.value = [...searches.value.filter((s) => s.id !== saved.id), saved]
      .sort((a, b) => a.name.localeCompare(b.name));
    await select(saved.id);
  });

  const remove = (id: string): Promise<void> => guard(async () => {
    await api.deleteSearch(id);
    searches.value = searches.value.filter((s) => s.id !== id);
    if (activeId.value === id) {
      activeId.value = null;
      results.value = [];
      market.value = null;
    }
  });

  /**
   * For a car the filters cannot tell apart from a real hit. It is hidden, not
   * deleted, so the next collection does not bring it back and undo can.
   */
  const hideResult = (id: string): Promise<void> => guard(async () => {
    const gone = results.value.find((r) => r.id === id) ?? null;
    await api.hideVehicle(id);
    removed.value = gone;
    results.value = results.value.filter((r) => r.id !== id);
    await refresh();
  });

  const undoHide = (): Promise<void> => guard(async () => {
    const gone = removed.value;
    if (gone === null) return;
    await api.restoreVehicle(gone.id);
    removed.value = null;
    await refresh();
  });

  const loadHeld = (): Promise<void> => guard(async () => {
    heldResults.value = await api.results(copyCriteria(criteria.value), true, true);
  });

  const toggleHeld = async (): Promise<void> => {
    showHeld.value = !showHeld.value;
    if (showHeld.value) await loadHeld();
  };

  /** The rules were wrong about this one: it is a real listing. */
  const releaseHeld = (id: string): Promise<void> => guard(async () => {
    await api.releaseVehicle(id);
    await Promise.all([refresh(), loadHeld()]);
  });

  const setScope = (next: "active" | "all"): Promise<void> => {
    scope.value = next;
    return refresh();
  };

  const reset = (): void => {
    activeId.value = null;
    criteria.value = emptyCriteria();
    removed.value = null;
  };

  /**
   * A search reaches the portals as well as the database. The local query
   * answers at once; the collection run is followed in the background so
   * results appear as each source finishes rather than after all of them.
   */
  const search = (): Promise<void> => guard(async () => {
    await refresh();
    collecting.value = true;
    try {
      await progress.follow(await api.collect(criteria.value, false), refresh);
    } finally {
      collecting.value = false;
    }
    await refresh();
  });

  return {
    searches, activeId, criteria, results, market, removed, scope, heldResults, showHeld,
    loading, collecting,
    job: progress.job, error,
    loadSearches, select, refresh, save, remove, hideResult, undoHide, setScope, toggleHeld, releaseHeld, reset, search,
  };
}
