import fp from "fastify-plugin";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  CRITERION, toCurrency, toMarket,
  type Criteria, type CriterionKey, type Market,
} from "@carscope/core";
import { readFileSync } from "node:fs";
import {
  ALL_ADAPTERS, browserTransport, ClearanceStore, collect, customAdapter, HostThrottle, HttpClient,
  isDue, PhotoStore, PlaywrightBrowser, RUN_STATUS, Solver, solverTransport, withLoopback,
  type BrowserFetch, type CollectionRun, type CustomSource,
} from "@carscope/collector";
import type { SourceAdapter } from "@carscope/core";
import { SqliteCollectorStore } from "../services/store.ts";
import { PhotoJanitor } from "../services/photo-janitor.ts";
import { WebhookDispatcher } from "../services/webhooks.ts";
import { BROWSER_MODE, type Config } from "../config.ts";

export interface CollectionTarget {
  readonly id: string;
  readonly name: string;
  readonly criteria: Criteria;
}

export interface CollectionJob {
  readonly id: string;
  readonly label: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly total: number;
  readonly done: number;
  readonly current: string | null;
  readonly runs: readonly CollectionRun[];
  /** Offers persisted so far, across every source in this run. */
  readonly stored: number;
  readonly timedOut: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Built-in portals plus anything described in `DATA_DIR/sources.json`. */
    adapters: readonly SourceAdapter[];
    startCollection(target: CollectionTarget, force: boolean): CollectionJob;
    currentJob(): CollectionJob | null;
    collectionIdle(): Promise<void>;
  }
}

/** Stable per-criteria id, so throttling and run history work without a saved search. */
export function collectionKey(criteria: Criteria): string {
  return `adhoc-${createHash("sha1").update(JSON.stringify(criteria)).digest("hex").slice(0, 16)}`;
}

const GRACE_MS = 15_000;

/** Resolves as a failed run if the adapter never comes back at all. */
function stall(sourceId: string, searchId: string, ms: number, now: () => Date): Promise<CollectionRun> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const at = now().toISOString();
      resolve({
        sourceId, searchId, startedAt: at, finishedAt: at,
        fetched: 0, kept: 0, created: 0, merged: 0, delisted: 0, photos: 0, dropped: 0,
        status: RUN_STATUS.error, complete: false, note: STALLED_NOTE,
      });
    }, ms);
    timer.unref();
  });
}

/**
 * Our own limit, not the portal's failure. The old wording blamed the source for
 * not answering, which sent the search for a fault at a portal that had answered
 * every request on time.
 */
const STALLED_NOTE = "Zeitbudget überschritten, Abfrage abgebrochen";

/**
 * A broken entry disables that one source; it never stops the server booting.
 * The file is user-written, so each entry is checked rather than assumed: an
 * asserted shape produced an adapter with an undefined id, which then failed
 * much later and much less clearly than the entry that caused it.
 */
function loadCustomSources(app: FastifyInstance, path: string): SourceAdapter[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    app.log.error({ err: e, path }, "sources.json is not valid JSON; configured sources are off");
    return [];
  }
  if (!Array.isArray(parsed)) {
    app.log.error({ path }, "sources.json must contain an array; configured sources are off");
    return [];
  }

  const adapters: SourceAdapter[] = [];
  for (const [index, entry] of parsed.entries()) {
    const source = toCustomSource(entry);
    if (source === null) {
      app.log.error({ path, index }, "sources.json entry is missing id, label, url or markets");
      continue;
    }
    adapters.push(customAdapter(source));
  }
  app.log.info({ count: adapters.length, path }, "loaded configured sources");
  return adapters;
}

/** Only the fields without a default are required; the adapter fills the rest. */
function toCustomSource(entry: unknown): CustomSource | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const raw: Record<string, unknown> = { ...entry };

  const id = asNonEmptyString(raw["id"]);
  const label = asNonEmptyString(raw["label"]);
  const url = asNonEmptyString(raw["url"]);
  const markets = Array.isArray(raw["markets"])
    ? raw["markets"].map((code) => toMarket(asNonEmptyString(code))).filter(isMarket)
    : [];
  if (id === null || label === null || url === null || markets.length === 0) return null;

  const currency = toCurrency(asNonEmptyString(raw["currency"]));
  const intervalHours = asPositiveNumber(raw["intervalHours"]);
  const unsupported = Array.isArray(raw["unsupported"])
    ? raw["unsupported"].map((key) => asNonEmptyString(key)).filter(isCriterionKey)
    : [];

  return {
    id, label, url, markets, unsupported,
    ...(currency === null ? {} : { currency }),
    ...(intervalHours === null ? {} : { intervalHours }),
    ...(raw["needsBrowser"] === true ? { needsBrowser: true } : {}),
    ...(raw["requiresMake"] === true ? { requiresMake: true } : {}),
  };
}

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const asPositiveNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

const isMarket = (market: Market | null): market is Market => market !== null;

const CRITERION_KEYS = new Set<string>(Object.values(CRITERION));
const isCriterionKey = (key: string | null): key is CriterionKey =>
  key !== null && CRITERION_KEYS.has(key);

export default fp(async function collector(app: FastifyInstance, opts: { config: Config }) {
  const { collect: cfg } = opts.config;
  const plain = withLoopback((url, init) => fetch(url, init));
  const browser: BrowserFetch | null = cfg.browser === BROWSER_MODE.never
    ? null
    : new PlaywrightBrowser();
  const viaBrowser = browser === null ? undefined : withLoopback(browserTransport(browser, {
    headless: cfg.browserHeadless,
    ...(cfg.browserUserAgent === null ? {} : { userAgent: cfg.browserUserAgent }),
    locale: cfg.locale,
    timeoutMs: cfg.timeoutMs,
    settleMs: cfg.browserSettleMs,
    stateDir: join(opts.config.dataDir, "browser-state"),
    timezone: cfg.timezone,
    ...(cfg.browserChannel === null ? {} : { channel: cfg.browserChannel }),
    ...(cfg.browserDebug ? { debugDir: join(opts.config.dataDir, "debug") } : {}),
    stealth: cfg.browserStealth,
    keepArtifacts: cfg.keepArtifacts,
    ...(cfg.browserTrace ? { traceDir: join(opts.config.dataDir, "traces") } : {}),
    ...(cfg.browserSlowMoMs === 0 ? {} : { slowMoMs: cfg.browserSlowMoMs }),
    blockAssets: cfg.browserBlockAssets,
    ...(cfg.browserCdp === null ? {} : { cdpEndpoint: cfg.browserCdp }),
    ...(cfg.browserProfileDir === null ? {} : { profileDir: cfg.browserProfileDir }),
  }));

  const solver = cfg.solverUrl === null ? null : new Solver({
    endpoint: cfg.solverUrl,
    timeoutMs: cfg.solverTimeoutMs,
  });
  // Byparr keeps no session; the clearance it returns is reused here instead, so
  // a solved host is fetched plainly until its clearance ages out.
  const clearance = solver === null ? null : new ClearanceStore(cfg.solverClearanceTtlMs);
  if (solver !== null) {
    app.log.info(
      { endpoint: cfg.solverUrl, sources: cfg.solverSources, clearanceTtlMs: cfg.solverClearanceTtlMs },
      "challenge solver configured",
    );
  }

  const http = new HttpClient(new HostThrottle(cfg.minHostIntervalMs), {
    timeoutMs: cfg.timeoutMs,
    userAgent: cfg.userAgent,
    transport: cfg.browser === BROWSER_MODE.always && viaBrowser !== undefined ? viaBrowser : plain,
    ...(viaBrowser === undefined ? {} : { browserTransport: viaBrowser }),
    ...(solver === null || clearance === null ? {} : {
      clearance,
      solverTransport: withLoopback(solverTransport(solver, {
        clearance,
        ...(cfg.browserDebug
          ? { debugDir: join(opts.config.dataDir, "debug"), keepArtifacts: cfg.keepArtifacts }
          : {}),
        // Which branch decided a solver page is a refusal, without needing the
        // page itself: the status it claimed, what it was served as, and why.
        onVerdict: (v) => {
          if (v.garbled === true) {
            app.log.warn({
              url: v.url,
              reportedStatus: v.reportedStatus,
              bytes: v.bytes,
            }, "solver returned a corrupted page; treated as unavailable");
          } else if (v.servedStatus === v.reportedStatus && v.reportedStatus >= 400) {
            app.log.warn({
              url: v.url,
              reportedStatus: v.reportedStatus,
              bytes: v.bytes,
              challengeMarker: v.challengeMarker,
            }, "solver page kept its blocking status");
          }
        },
      })),
    }),
  }, new HostThrottle(cfg.assetIntervalMs));
  const photos = cfg.storePhotos ? new PhotoStore(http, opts.config.dataDir) : undefined;
  const now = (): Date => new Date();
  const janitor = new PhotoJanitor(app.db, opts.config.dataDir, cfg.photoBudgetMb);
  const dispatcher = new WebhookDispatcher(app.webhooks, app.vehicles, app.searches, opts.config.webhooks, now);
  const adapters = [...ALL_ADAPTERS, ...loadCustomSources(app, join(opts.config.dataDir, "sources.json"))];
  app.decorate("adapters", adapters);

  let job: CollectionJob | null = null;
  let pending: Promise<void> | null = null;

  /**
   * A run touches several portals behind a politeness throttle and can take
   * minutes, so it never happens inside a request. The job is started, the
   * request returns, and progress is polled. Each adapter writes to the database
   * as it finishes, so results appear while the rest is still running.
   */
  async function run(target: CollectionTarget, force: boolean): Promise<void> {
    const store = new SqliteCollectorStore(app.vehicles, app.runs, now);
    const enabled = app.sourceSettings.enabledIds(adapters.map((a) => a.id));
    const due = adapters
      .filter((a) => enabled.has(a.id))
      .filter((a) => force || isDue(
        app.runs.lastRunAt(a.id, target.id),
        a,
        now(),
        app.runs.failuresSince(a.id, target.id),
        app.runs.lastAttemptAt(a.id, target.id),
      ));

    job = {
      id: target.id, label: target.name,
      startedAt: now().toISOString(), finishedAt: null,
      total: due.length, done: 0, current: due[0]?.label ?? null,
      runs: [], stored: 0, timedOut: false,
    };

    const deadline = Date.now() + cfg.deadlineMs;
    const runs: CollectionRun[] = [];
    const running = new Set<string>();
    let timedOut = false;

    const note = (): void => {
      if (job !== null) {
        job = { ...job, done: runs.length, runs: [...runs], current: [...running].join(", ") || null };
      }
    };

    // Portals are independent and mostly slow for the same reason — waiting on a
    // browser. Running them one after another makes a search take as long as the
    // sum of every portal rather than the slowest one.
    const queue = [...due];
    const workers = Array.from({ length: Math.max(1, cfg.concurrency) }, async () => {
      for (;;) {
        const adapter = queue.shift();
        if (adapter === undefined) return;
        if (Date.now() > deadline) { timedOut = true; return; }

        running.add(adapter.label);
        note();
        try {
          const result = await Promise.race([
            collect(
            {
              http, store, now,
              options: {
                maxPages: cfg.maxPages,
                sourceDeadlineMs: cfg.sourceDeadlineMs,
                maxDetails: cfg.maxDetails,
                // One page fetch is the worst case for one detail page.
                detailReserveMs: cfg.timeoutMs,
                // A first/manual search (force) should answer as fast as the list
                // pages alone; only the scheduler's unattended re-searches spend
                // the extra time enriching what they find.
                enrichDetails: !force,
                solverSources: cfg.solverSources,
                rateToBase: (c) => app.fx.rateFor(c),
              },
              cache: app.lookups,
              onStored: () => {
                if (job !== null) job = { ...job, stored: job.stored + 1 };
              },
              onDropped: (sourceId, d) => {
                app.log.info(
                  { source: sourceId, criterion: d.criterion, found: d.found, title: d.title, url: d.url },
                  "listing rejected by a criterion the source could not express",
                );
              },
              ...(photos === undefined ? {} : { photos }),
            },
            adapter,
            target,
            ),
            stall(adapter.id, target.id, cfg.sourceDeadlineMs * adapter.markets.length + GRACE_MS, now),
          ]);
          if (result.status !== RUN_STATUS.ok) {
            app.log.warn(
              { source: adapter.id, status: result.status, note: result.note },
              "collection run degraded",
            );
          }
          runs.push(result);
        } finally {
          running.delete(adapter.label);
          note();
        }
      }
    });
    await Promise.all(workers);

    job = { ...job, current: null, finishedAt: now().toISOString(), runs, timedOut };

    const pruned = await janitor.prune().catch(() => null);
    if (pruned !== null && pruned.vehiclesPruned > 0) {
      app.log.info(pruned, "pruned photos of delisted vehicles to stay within budget");
    }

    // Awaited here, inside `run()`, so `collectionIdle()` covers delivery and a
    // test can wait for it deterministically rather than racing a fetch.
    await dispatcher.afterRun(target.id).catch((e: unknown) => {
      app.log.error({ err: e, searchId: target.id }, "webhook dispatch failed");
    });
  }

  app.decorate("startCollection", (target: CollectionTarget, force: boolean): CollectionJob => {
    if (pending !== null && job !== null && job.finishedAt === null) return job;
    pending = run(target, force)
      .catch((e: unknown) => { app.log.error({ err: e }, "collection job failed"); })
      .finally(() => { pending = null; });
    return job ?? {
      id: target.id, label: target.name, startedAt: now().toISOString(),
      finishedAt: null, total: 0, done: 0, current: null, runs: [], stored: 0, timedOut: false,
    };
  });

  app.decorate("currentJob", (): CollectionJob | null => job);
  app.decorate("collectionIdle", async (): Promise<void> => { await pending; });

  app.addHook("onClose", async () => {
    await pending;
    await browser?.close();
  });
}, { name: "collector", dependencies: ["storage"] });
