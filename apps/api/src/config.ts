import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Node reads `.env` itself since 22; nothing here did, so every setting in the
 * file was silently ignored while the defaults applied.
 */
function loadEnvFile(path = process.env["ENV_FILE"] ?? ".env"): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // A malformed file must not stop the server; the defaults still apply.
  }
}

export interface Config {
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly corsOrigin: readonly string[];
  /** Reached over HTTPS, directly or through a TLS proxy. Decides strict headers. */
  readonly https: boolean;
  readonly dataDir: string;
  readonly databaseFile: string;
  readonly webRoot: string | null;
  readonly collect: {
    readonly intervalMinutes: number;
    readonly userAgent: string;
    readonly enabledSources: readonly string[];
    readonly maxPages: number;
    readonly timeoutMs: number;
    readonly minHostIntervalMs: number;
    readonly storePhotos: boolean;
    readonly deadlineMs: number;
    readonly sourceDeadlineMs: number;
    readonly browser: BrowserMode;
    readonly browserHeadless: boolean;
    readonly browserSettleMs: number;
    readonly browserChannel: string | null;
    readonly browserDebug: boolean;
    readonly browserUserAgent: string | null;
    readonly browserCdp: string | null;
    readonly browserProfileDir: string | null;
    readonly browserStealth: BrowserStealth;
    readonly browserBlockAssets: boolean;
    readonly browserTrace: boolean;
    readonly browserSlowMoMs: number;
    readonly keepArtifacts: number;
    readonly solverUrl: string | null;
    readonly solverTimeoutMs: number;
    readonly solverSources: readonly string[];
    /** How long a solved host's clearance is replayed before it is solved again. */
    readonly solverClearanceTtlMs: number;
    readonly maxDetails: number;
    readonly assetIntervalMs: number;
    readonly concurrency: number;
    readonly locale: string;
    readonly timezone: string;
    readonly photoBudgetMb: number;
  };
}

/**
 * `auto` launches a browser only for adapters that declare they need one,
 * `always` uses it for every request, `never` disables it and lets those
 * adapters fail loudly rather than silently returning nothing.
 */
export const BROWSER_STEALTH = { off: "off", patched: "patched" } as const;
export type BrowserStealth = (typeof BROWSER_STEALTH)[keyof typeof BROWSER_STEALTH];

export const BROWSER_MODE = { auto: "auto", always: "always", never: "never" } as const;
export type BrowserMode = (typeof BROWSER_MODE)[keyof typeof BROWSER_MODE];

const BROWSER_MODE_VALUES = new Set<string>(Object.values(BROWSER_MODE));

const toBrowserMode = (value: string | undefined): BrowserMode =>
  value !== undefined && BROWSER_MODE_VALUES.has(value)
    ? (value as BrowserMode)
    : BROWSER_MODE.auto;

/**
 * A user agent naming the tool is honest but announces a bot, and mobile.de
 * refuses it outright. Only plain fetches use this; the browser sends its own.
 */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

/** Real portals are on out of the box; an install that finds nothing looks broken. */
const DEFAULT_SOURCES = ["kleinanzeigen", "autoscout24", "autouncle"] as const;

const int = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const list = (value: string | undefined): string[] =>
  (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * An empty setting means unset.
 *
 * `.env` files carry keys with nothing after the `=` to document that an option
 * exists, and `"" ?? null` is `""` — enough to look configured. An empty CDP
 * endpoint routed every fetch through a connection to nowhere.
 */
const optional = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

/** Loaded once at boot. Nothing else in the app reads process.env. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) loadEnvFile();
  const dataDir = optional(env["DATA_DIR"]) ?? "./data";
  const sources = list(env["COLLECT_ENABLED_SOURCES"]);
  return {
    port: int(env["PORT"], 8080),
    host: optional(env["HOST"]) ?? "0.0.0.0",
    logLevel: optional(env["LOG_LEVEL"]) ?? "info",
    https: env["HTTPS"] === "true",
    corsOrigin: list(env["CORS_ORIGIN"]),
    dataDir,
    databaseFile: optional(env["DATABASE_FILE"]) ?? join(dataDir, "carscope.sqlite"),
    webRoot: optional(env["WEB_ROOT"]),
    collect: {
      intervalMinutes: int(env["COLLECT_INTERVAL_MINUTES"], 360),
      // Only used for plain fetches. Browser requests keep Chrome's own header,
      // which is the one that matches the binary actually making the request.
      userAgent: optional(env["COLLECT_USER_AGENT"]) ?? DEFAULT_USER_AGENT,
      browserUserAgent: optional(env["COLLECT_BROWSER_USER_AGENT"]),
      enabledSources: sources.length > 0 ? sources : DEFAULT_SOURCES,
      maxPages: int(env["COLLECT_MAX_PAGES"], 6),
      timeoutMs: int(env["COLLECT_TIMEOUT_MS"], 15_000),
      minHostIntervalMs: int(env["COLLECT_MIN_HOST_INTERVAL_MS"], 2_500),
      storePhotos: env["COLLECT_STORE_PHOTOS"] !== "false",
      deadlineMs: int(env["COLLECT_DEADLINE_MS"], 300_000),
      // Per country, not per source: eight countries need eight budgets.
      sourceDeadlineMs: int(env["COLLECT_SOURCE_DEADLINE_MS"], 60_000),
      browser: toBrowserMode(optional(env["COLLECT_BROWSER"]) ?? undefined),
      browserHeadless: env["COLLECT_BROWSER_HEADLESS"] !== "false",
      browserSettleMs: int(env["COLLECT_BROWSER_SETTLE_MS"], 1_500),
      browserChannel: optional(env["COLLECT_BROWSER_CHANNEL"]),
      browserDebug: env["COLLECT_BROWSER_DEBUG"] === "true",
      browserCdp: optional(env["COLLECT_BROWSER_CDP"]),
      browserProfileDir: optional(env["COLLECT_BROWSER_PROFILE_DIR"]),
      // Off by default: each patch replaces a native function with a JS one,
      // which is readable through Function.prototype.toString.
      browserStealth: env["COLLECT_BROWSER_STEALTH"] === BROWSER_STEALTH.patched
        ? BROWSER_STEALTH.patched
        : BROWSER_STEALTH.off,
      browserBlockAssets: env["COLLECT_BROWSER_BLOCK_ASSETS"] !== "false",
      browserTrace: env["COLLECT_BROWSER_TRACE"] === "true",
      browserSlowMoMs: int(env["COLLECT_BROWSER_SLOWMO_MS"], 0),
      keepArtifacts: int(env["COLLECT_DEBUG_KEEP"], 50),
      solverUrl: optional(env["COLLECT_SOLVER_URL"]),
      solverTimeoutMs: int(env["COLLECT_SOLVER_TIMEOUT_MS"], 60_000),
      solverSources: list(env["COLLECT_SOLVER_SOURCES"]),
      solverClearanceTtlMs: int(env["COLLECT_SOLVER_CLEARANCE_TTL_MS"], 30 * 60_000),
      maxDetails: int(env["COLLECT_MAX_DETAILS"], 0),
      assetIntervalMs: int(env["COLLECT_ASSET_INTERVAL_MS"], 150),
      concurrency: int(env["COLLECT_CONCURRENCY"], 3),
      locale: optional(env["COLLECT_LOCALE"]) ?? "de-DE",
      timezone: optional(env["COLLECT_TIMEZONE"]) ?? "Europe/Berlin",
      photoBudgetMb: int(env["COLLECT_PHOTO_BUDGET_MB"], 2_000),
    },
  };
}
