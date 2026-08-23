import {
  HOUR_MS, MINUTE_MS,
  FAILURE, convert, marketsFor,
  type Criteria, type QueryContext, type QueryHints,
  type RawListing, type SourceAdapter,
} from "@carscope/core";
import type { HttpClient } from "./http.ts";
import { applyUnsupported } from "./filter.ts";
import { imageSetHash } from "./images.ts";
import { RUN_STATUS } from "./ports.ts";
import type {
  CollectionRun, CollectorStore, LookupCache, PhotoFetcher, RunStatus, SavedSearch,
} from "./ports.ts";
import type { Dropped } from "./filter.ts";

export interface RunnerOptions {
  readonly maxPages: number;
  /** Wall clock a single source may take before the run is cut short. */
  readonly sourceDeadlineMs: number;
  /** Detail pages cost a navigation each, so a run only takes so many. */
  readonly maxDetails: number;
  /**
   * Worst case for one page fetch. A detail page is only started when this much
   * of the source's budget is still left, so enrichment cannot run the clock out.
   */
  readonly detailReserveMs: number;
  /**
   * Whether a detail page may be fetched at all this run. Off for a first/manual
   * search so it answers as fast as the list pages alone; on for the scheduler's
   * automatic re-searches, which have the run budget to enrich what they find.
   */
  readonly enrichDetails: boolean;
  /** Sources routed through the challenge solver rather than our own browser. */
  readonly solverSources: readonly string[];
  /** Rate to base currency at collection time; stored per snapshot. */
  readonly rateToBase: (currency: string) => number;
}

export interface RunnerDeps {
  readonly http: HttpClient;
  readonly store: CollectorStore;
  readonly options: RunnerOptions;
  readonly now: () => Date;
  /** Omitted in tests and when photo storage is switched off; URLs are still recorded. */
  readonly photos?: PhotoFetcher;
  /** Backs adapter lookups such as translating a model name to an id. */
  readonly cache?: LookupCache;
  /** Called after each offer is persisted, so a stream can report it at once. */
  readonly onStored?: (sourceId: string) => void;
  /** Called for every listing the post-filter rejected, with the reason. */
  readonly onDropped?: (sourceId: string, dropped: Dropped) => void;
}

/**
 * One pass of one source over one saved search. Everything that is not
 * source-specific lives here so adapters stay small: paging, gap filtering,
 * identity resolution, snapshotting, delisting and run bookkeeping.
 */
export async function collect(
  deps: RunnerDeps,
  adapter: SourceAdapter,
  search: SavedSearch,
): Promise<CollectionRun> {
  const startedAt = deps.now().toISOString();
  const hints = await resolveHints(deps, adapter, search.criteria);
  const markets = marketsFor(search.criteria, adapter.markets);

  const totals = { fetched: 0, kept: 0, created: 0, merged: 0, photos: 0, dropped: 0 };
  const details: DetailBudget = { taken: 0, skipped: 0, outOfTime: false };
  const seenIds: string[] = [];
  const notes: string[] = [];
  // Set the moment anything is left unread, so the next search asks again
  // rather than answering from a database that holds part of the portal.
  let complete = true;
  let status: RunStatus = markets.length === 0 ? RUN_STATUS.skipped : RUN_STATUS.ok;
  if (markets.length === 0) notes.push("keines der gewählten Länder wird von dieser Quelle abgedeckt");

  const deadline = deps.now().getTime() + deps.options.sourceDeadlineMs * Math.max(1, markets.length);

  for (const market of markets) {
    if (deps.now().getTime() > deadline) {
      status = RUN_STATUS.error;
      complete = false;
      notes.push(`Zeitlimit von ${String(Math.round(deps.options.sourceDeadlineMs / 1000))} s erreicht`);
      break;
    }

    // Each country gets its own budget: charging one deadline across all of them
    // means the last country asked never gets a turn.
    const marketDeadline = Math.min(deadline, deps.now().getTime() + deps.options.sourceDeadlineMs);
    const pass = await collectMarket(
      deps, adapter, search, { market, hints }, marketDeadline, seenIds, totals, details, notes,
    );
    if (pass.note !== null) notes.push(`${market}: ${pass.note}`);
    if (!pass.complete) complete = false;
    // A country that refuses does not invalidate the ones that answered.
    if (pass.status !== RUN_STATUS.ok && status === RUN_STATUS.ok && totals.fetched === 0) {
      status = pass.status;
    }
  }

  const delisted = deps.store.markDelisted(adapter.id, seenIds, deps.now().toISOString(), startedAt);
  if (totals.dropped > 0) {
    notes.push(`${String(totals.dropped)} Treffer nachträglich aussortiert`);
  }
  if (details.skipped > 0) {
    notes.push(details.outOfTime
      ? `${String(details.skipped)} Detailseiten aufgeschoben, Zeitbudget erreicht`
      : `${String(details.skipped)} Detailseiten aufgeschoben, Limit pro Lauf erreicht`);
  }
  // Deferred detail pages are not a partial read of the portal: every listing
  // was seen, and the next run enriches the rest without re-reading the lists.
  return finish(deps, {
    complete,
    sourceId: adapter.id, searchId: search.id, startedAt,
    ...totals, delisted, status,
    note: notes.length === 0 ? null : notes.join(" · "),
  });
}

/**
 * How much enrichment this run has spent. `outOfTime` separates "the per-run cap
 * was reached", which is a setting, from "the clock ran out", which is not.
 */
interface DetailBudget {
  taken: number;
  skipped: number;
  outOfTime: boolean;
}

interface MarketPass {
  readonly status: RunStatus;
  /** False when this country still had pages the run did not reach. */
  readonly complete: boolean;
  readonly note: string | null;
}

async function collectMarket(
  deps: RunnerDeps,
  adapter: SourceAdapter,
  search: SavedSearch,
  ctx: QueryContext,
  deadline: number,
  seenIds: string[],
  totals: { fetched: number; kept: number; created: number; merged: number; photos: number; dropped: number },
  details: DetailBudget,
  notes: string[],
): Promise<MarketPass> {
  for (let page = 1; page <= deps.options.maxPages; page += 1) {
    if (deps.now().getTime() > deadline) {
      return { status: RUN_STATUS.error, complete: false, note: "Zeitlimit erreicht" };
    }

    const spec = adapter.buildQuery(search.criteria, page, ctx);
    if (spec.skip !== undefined) return { status: RUN_STATUS.skipped, complete: true, note: spec.skip };

    const body = await deps.http.getText(spec.url, {
      ...(spec.headers === undefined ? {} : { headers: spec.headers }),
      browser: adapter.needsBrowser === true,
      solver: deps.options.solverSources.includes(adapter.id),
    });
    if (!body.ok) {
      return {
        status: body.error.kind === FAILURE.blocked ? RUN_STATUS.blocked : RUN_STATUS.error,
        complete: false,
        note: body.error.message,
      };
    }

    const parsed = adapter.parseList(body.value, spec);
    if (!parsed.ok) return { status: RUN_STATUS.error, complete: false, note: parsed.error.message };

    if (parsed.value.note !== undefined) notes.push(parsed.value.note);
    totals.fetched += parsed.value.listings.length;
    const { kept: usable, dropped } = applyUnsupported(adapter, search.criteria, parsed.value.listings);
    totals.kept += usable.length;
    totals.dropped += dropped.length;
    for (const d of dropped) deps.onDropped?.(adapter.id, d);

    const observedAt = deps.now().toISOString();
    for (const raw of usable) {
      const hash = imageSetHash(raw.photoUrls);
      const resolved = deps.store.resolveVehicle(raw, adapter, hash, ctx.market);
      if (resolved.created) totals.created += 1;
      else totals.merged += 1;

      // Recorded before anything slow: between creating a vehicle and giving it
      // a listing, it looks abandoned to the delisting sweep.
      deps.store.upsertListing(resolved.vehicle.id, raw, adapter, observedAt);
      const money = convert(raw.price, adapter.currency, deps.options.rateToBase(raw.currency));
      deps.store.recordPrice({
        vehicleId: resolved.vehicle.id,
        observedAt,
        amount: money.amount,
        currency: money.currency,
        baseAmount: money.baseAmount,
        rate: money.rate,
        sourceId: adapter.id,
      });
      seenIds.push(raw.sourceListingId);
      deps.onStored?.(adapter.id);

      let enriched = raw;
      // Enrichment is the expensive half of a run: one request per car, each as
      // slow as a page load. The budget was only checked between result pages,
      // so a source could spend its whole deadline here and be killed by the
      // watchdog mid-car, reported as a portal that had stopped answering when
      // it had answered every time. A car left unenriched keeps
      // `detail_fetched_at` unset and is picked up by the next run.
      if (deps.options.enrichDetails && adapter.parseDetail && deps.store.needsDetail(resolved.vehicle.id)) {
        if (details.taken >= deps.options.maxDetails) details.skipped += 1;
        else if (deps.now().getTime() + deps.options.detailReserveMs > deadline) {
          details.skipped += 1;
          details.outOfTime = true;
        } else {
          details.taken += 1;
          const detail = await fetchDetail(deps, adapter, raw.url);
          if (detail !== null) {
            enriched = mergeDetail(raw, detail);
            deps.store.saveDetail(resolved.vehicle.id, detail, observedAt);
          }
        }
      }

      // Hashed after enrichment, not before: the list page shows one picture and
      // the detail page a gallery, so a hash of the former never changes and the
      // gallery is never fetched.
      const enrichedHash = imageSetHash(enriched.photoUrls);
      const setChanged = resolved.created || resolved.vehicle.imageHash !== enrichedHash;
      if (deps.photos && setChanged && enriched.photoUrls.length > 0) {
        const stored = await deps.photos.ensure(resolved.vehicle.id, enriched.photoUrls);
        deps.store.savePhotos(resolved.vehicle.id, stored);
        deps.store.setImageHash(resolved.vehicle.id, enrichedHash);
        totals.photos += stored.filter((p) => p.localPath !== null).length;
      }

    }

    if (!parsed.value.hasMore) return { status: RUN_STATUS.ok, complete: true, note: null };

    // Stopping at the page limit while the portal still has results is a partial
    // answer, and a partial answer that says nothing looks like a complete one.
    if (page === deps.options.maxPages) {
      return {
        status: RUN_STATUS.ok,
        complete: false,
        note: `nach ${String(page)} Seiten abgebrochen, das Portal hat weitere Treffer`,
      };
    }
  }
  return { status: RUN_STATUS.ok, complete: true, note: null };
}

type PartialRun = Omit<CollectionRun, "finishedAt" | "delisted"> & { delisted?: number };

function finish(deps: RunnerDeps, partial: PartialRun): CollectionRun {
  const run: CollectionRun = {
    ...partial,
    delisted: partial.delisted ?? 0,
    finishedAt: deps.now().toISOString(),
  };
  deps.store.recordRun(run);
  return run;
}

async function resolveHints(
  deps: RunnerDeps,
  adapter: SourceAdapter,
  criteria: Criteria,
): Promise<QueryHints> {
  if (adapter.resolveHints === undefined) return {};
  const cache = deps.cache;

  return adapter.resolveHints(criteria, {
    fetchText: (url, browser) => deps.http.getText(url, { browser }),
    async cached(key, produce) {
      const hit = cache?.get(key);
      if (hit !== undefined && hit !== null) return hit;
      const value = await produce();
      cache?.set(key, value);
      return value;
    },
  }).catch(() => ({}));
}

async function fetchDetail(
  deps: RunnerDeps,
  adapter: SourceAdapter,
  url: string,
): Promise<Partial<RawListing> | null> {
  const body = await deps.http.getText(url, {
    browser: adapter.needsBrowser === true,
    solver: deps.options.solverSources.includes(adapter.id),
  });
  if (!body.ok || adapter.parseDetail === undefined) return null;
  const parsed = adapter.parseDetail(body.value);
  return parsed.ok ? parsed.value : null;
}

/** The detail page wins where it has something; the list page fills the rest. */
function mergeDetail(raw: RawListing, detail: Partial<RawListing>): RawListing {
  return {
    ...raw,
    ...detail,
    photoUrls: detail.photoUrls !== undefined && detail.photoUrls.length > raw.photoUrls.length
      ? detail.photoUrls
      : raw.photoUrls,
    attributes: { ...raw.attributes, ...detail.attributes },
  };
}

/** Doubling, so a portal that keeps refusing is not asked by every search. */
export const RETRY_BACKOFF_MS = 5 * MINUTE_MS;
export const MAX_RETRY_BACKOFF_MS = 6 * HOUR_MS;

/**
 * Whether a source may be asked again.
 *
 * `lastCompleteIso` is the last run that read the portal to the end; a partial
 * one does not count, or a source cut short by its deadline would sit unread for
 * the whole interval while every search answered from half a portal.
 *
 * `failures` is how many incomplete runs followed it, and holds the other side:
 * retrying immediately after each failure means a blocked portal is asked by
 * every search. The wait doubles per failure up to the normal interval.
 */
export function isDue(
  lastCompleteIso: string | null,
  adapter: SourceAdapter,
  now: Date,
  failures = 0,
  lastAttemptIso: string | null = null,
): boolean {
  if (failures > 0 && lastAttemptIso !== null) {
    const wait = Math.min(RETRY_BACKOFF_MS * 2 ** (failures - 1), MAX_RETRY_BACKOFF_MS);
    if (now.getTime() - Date.parse(lastAttemptIso) < wait) return false;
  }
  if (lastCompleteIso === null) return true;
  return now.getTime() - Date.parse(lastCompleteIso) >= adapter.minIntervalMs;
}
