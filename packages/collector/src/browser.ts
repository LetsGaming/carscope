import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { failure, FAILURE, type AppError } from "@carscope/core";
import { artifactDir, artifactName, pruneArtifacts } from "./artifacts.ts";
import type { Transport } from "./http.ts";

export interface BrowserOptions {
  readonly headless: boolean;
  /** Left unset so Chrome sends its own, which always matches the binary. */
  readonly userAgent?: string;
  readonly locale: string;
  readonly timeoutMs: number;
  /** Time to let client-side rendering settle after the document loads. */
  readonly settleMs: number;
  /** Cookies and consent are kept here so the wall is answered once, not per request. */
  readonly stateDir?: string;
  readonly timezone?: string;
  /**
   * A Playwright browser channel such as `chrome` or `msedge`. Bundled Chromium
   * differs from real Chrome in ways bot protection reads — codecs, build flags,
   * the user-agent's own consistency — so naming a channel is the strongest
   * remaining lever when a portal still refuses.
   */
  readonly channel?: string;
  /**
   * When set, the markup and a screenshot of every fetch are written here, one
   * pair per host. A portal that answers with a challenge or a consent wall
   * returns HTTP 200, so the only way to see what happened is to look at it.
   */
  readonly debugDir?: string;
  /**
   * Attach to a browser you already run, over the DevTools protocol. That
   * browser has a real profile, a real history and a fingerprint a portal has
   * already accepted, none of which can be synthesised convincingly.
   *
   *   chrome.exe --remote-debugging-port=9222
   */
  readonly cdpEndpoint?: string;
  /**
   * Or drive a persistent profile of its own. Warm it up once by hand with
   * headless off, and the session it built is reused from then on.
   */
  readonly profileDir?: string;
  /**
   * `off` touches nothing and lets Chrome be Chrome. `patched` applies the
   * fingerprint corrections, which help against naive checks and hurt against
   * good ones — a native getter replaced by a JS function is readable through
   * `Function.prototype.toString`, so each patch is itself a tell.
   */
  readonly stealth?: "off" | "patched";
  /** Aborting images is fast but reads like an ad blocker to some checks. */
  readonly blockAssets?: boolean;
  /**
   * Records every step — navigation, click, network call — with screenshots and
   * DOM snapshots, into a zip per fetch. Open it with
   * `npx playwright show-trace <file>` to step through what the browser did.
   */
  readonly traceDir?: string;
  /** Milliseconds between actions, so a headed run can be watched. */
  readonly slowMoMs?: number;
  /** Artefacts retained per host before the oldest are removed. */
  readonly keepArtifacts?: number;
}

export interface PageResult {
  readonly status: number;
  readonly body: string;
}

/**
 * The one thing a browser backend must do. Declaring it as a port keeps
 * Playwright out of the collector's types and lets the pipeline be tested
 * without launching Chromium.
 */
export interface BrowserFetch {
  fetch(url: string, options: BrowserOptions): Promise<PageResult>;
  close(): Promise<void>;
}

export class BrowserUnavailable extends Error {
  constructor(cause: unknown) {
    super("Playwright is not available; install it or set COLLECT_BROWSER=never", { cause });
    this.name = "BrowserUnavailable";
  }
}

// Stylesheets are allowed through: a page that renders without any CSS is itself
// a headless tell, and the bandwidth saved is not worth failing the check.
const BLOCKED_ASSETS = "**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,mp4,webm,avif}";

/**
 * Headless Chromium announces itself: `navigator.webdriver` is true, the plugin
 * list is empty and `window.chrome` is missing. Akamai and DataDome check all
 * three. This runs before any page script.
 */
const STEALTH = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'languages', { get: () => ['de-DE', 'de', 'en-US'] });
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
window.chrome = window.chrome || { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };
const query = navigator.permissions && navigator.permissions.query;
if (query) {
  navigator.permissions.query = (p) =>
    p && p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : query.call(navigator.permissions, p);
}
`;

/** Consent walls stand in front of the results on every German portal. */
const CONSENT_SELECTORS = [
  // Text matching first: the wording is stable where the markup is not.
  'button:has-text("Alle akzeptieren")',
  'button:has-text("Einverstanden")',
  'button:has-text("Alle Cookies akzeptieren")',
  'button:has-text("Akzeptieren und weiter")',
  'button:has-text("Zustimmen")',
  'button[title="Einverstanden"]',
  'button[title="Alle akzeptieren"]',
  ".sp_choice_type_11",
  "#gdpr-banner-accept",
  "#_evidon-accept-button",
  "#_evidon-banner-acceptbutton",
  'button[data-testid="as24-cmp-accept-all-button"]',
  'button[aria-label*="akzeptieren" i]',
];

/* Minimal structural types for the parts of Playwright actually used. */
interface PwRoute { abort(): Promise<void> }
interface PwResponse { status(): number }
interface PwLocator {
  first(): PwLocator;
  click(options: { timeout: number }): Promise<void>;
}
interface PwFrame { locator(selector: string): PwLocator; url(): string }
interface PwPage {
  route(pattern: string, handler: (route: PwRoute) => void): Promise<void>;
  goto(url: string, options: { waitUntil: "domcontentloaded" | "load"; timeout: number }): Promise<PwResponse | null>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  locator(selector: string): PwLocator;
  frames(): PwFrame[];
  url(): string;
}
interface PwTracing {
  start(options: { screenshots: boolean; snapshots: boolean; sources: boolean }): Promise<void>;
  stop(options: { path: string }): Promise<void>;
}
interface PwContext {
  tracing: PwTracing;
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
  addInitScript(script: string): Promise<void>;
  storageState(options: { path: string }): Promise<unknown>;
  cookies(): Promise<{ name: string }[]>;
}
interface PwBrowser {
  contexts(): PwContext[];
  newContext(options: {
    userAgent?: string;
    locale: string;
    timezoneId?: string;
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    storageState?: string;
    extraHTTPHeaders?: Record<string, string>;
  }): Promise<PwContext>;
  close(): Promise<void>;
  once(event: "disconnected", handler: () => void): void;
}
interface PwChromium {
  launch(options: {
    headless: boolean;
    args: string[];
    channel?: string;
    ignoreDefaultArgs?: string[];
    slowMo?: number;
  }): Promise<PwBrowser>;
  connectOverCDP(endpoint: string): Promise<PwBrowser>;
  launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<PwContext>;
}

/**
 * Chromium behind one lazily launched, reused browser. Each request gets a fresh
 * context so cookies never leak between portals, and assets are aborted because
 * only the markup matters.
 */
export class PlaywrightBrowser implements BrowserFetch {
  #browser: Promise<PwBrowser> | null = null;
  #signature = "";
  #userAgent: string | null = null;
  /** Whether the binary put "HeadlessChrome" in its own user agent. */
  #namesItselfHeadless = false;
  /** Held open in CDP and profile mode; the session is the whole value. */
  #shared: PwContext | null = null;
  readonly #warmed = new Set<string>();

  async #chromium(): Promise<PwChromium> {
    // Imported by name so the dependency stays optional: an install without
    // Playwright fails loudly here instead of quietly returning no listings.
    const mod: unknown = await import(/* @vite-ignore */ "playwright");
    return (mod as { chromium: PwChromium }).chromium;
  }

  async #launch(headless: boolean, channel?: string, slowMoMs?: number): Promise<PwBrowser> {
    const signature = `${String(headless)}:${channel ?? ""}:${String(slowMoMs ?? 0)}`;
    if (this.#browser !== null && this.#signature === signature) return this.#browser;
    if (this.#browser !== null) await this.close();
    this.#signature = signature;
    this.#browser = (async () => {
      let chromium: PwChromium;
      try {
        // Imported by name so the dependency stays optional: an install without
        // Playwright fails loudly here instead of quietly returning no listings.
        const mod: unknown = await import(/* @vite-ignore */ "playwright");
        chromium = (mod as { chromium: PwChromium }).chromium;
      } catch (e) {
        throw new BrowserUnavailable(e);
      }
      const browser = await chromium.launch({
        headless,
        ...(channel === undefined || channel === "" ? {} : { channel }),
        // Playwright adds --enable-automation, which sets the infobar flag a
        // page can read. Removing it is free; it is not by itself sufficient.
        ignoreDefaultArgs: ["--enable-automation"],
        ...(slowMoMs === undefined || slowMoMs === 0 ? {} : { slowMo: slowMoMs }),
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
        ],
      });
      browser.once("disconnected", () => { this.#browser = null; });
      return browser;
    })();
    try {
      return await this.#browser;
    } catch (e) {
      this.#browser = null;
      throw e;
    }
  }

  /**
   * Headless Chromium calls itself `HeadlessChrome` in both its user agent and
   * its client hints. Reading the browser's own string and correcting that one
   * word keeps every self-report consistent with the binary — inventing a string
   * instead risks claiming a version the browser does not have, which is what a
   * portal checking "is this browser less than twelve months old" looks at.
   */
  async #userAgentFor(browser: PwBrowser): Promise<string> {
    if (this.#userAgent !== null) return this.#userAgent;

    const probe = await browser.newContext({ locale: "de-DE", viewport: VIEWPORT, deviceScaleFactor: 1 });
    try {
      const page = await probe.newPage();
      const reported = String(await page.evaluate("navigator.userAgent"));
      this.#namesItselfHeadless = reported !== stripHeadless(reported);
      this.#userAgent = stripHeadless(reported);
    } finally {
      await probe.close();
    }
    return this.#userAgent;
  }

  /**
   * A context, from whichever mode is configured.
   *
   * `cdp` and `profile` reuse a long-lived context deliberately: the whole point
   * is a session a portal has already accepted, and a fresh context would throw
   * exactly that away.
   */
  /**
   * A context, from whichever mode is configured.
   *
   * `cdp` and `profile` reuse one long-lived context deliberately: the point of
   * both is a session a portal has already accepted, and a fresh context throws
   * exactly that away.
   */
  async #contextFor(options: BrowserOptions, host: string): Promise<{ context: PwContext; own: boolean }> {
    if (this.#shared !== null) return { context: this.#shared, own: false };

    if (options.cdpEndpoint !== undefined && options.cdpEndpoint !== "") {
      const chromium = await this.#chromium();
      const browser = await chromium.connectOverCDP(options.cdpEndpoint);
      const existing = browser.contexts()[0];
      if (existing === undefined) throw new Error(`${options.cdpEndpoint} has no open context`);
      this.#shared = existing;
      return { context: existing, own: false };
    }

    if (options.profileDir !== undefined && options.profileDir !== "") {
      const chromium = await this.#chromium();
      this.#shared = await chromium.launchPersistentContext(options.profileDir, {
        headless: options.headless,
        locale: options.locale,
        viewport: VIEWPORT,
        ...(options.timezone === undefined ? {} : { timezoneId: options.timezone }),
        ...(options.channel === undefined || options.channel === "" ? {} : { channel: options.channel }),
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
      });
      if (options.stealth === "patched") await this.#shared.addInitScript(STEALTH).catch(() => null);
      return { context: this.#shared, own: false };
    }

    const browser = await this.#launch(options.headless, options.channel, options.slowMoMs);
    const detected = await this.#userAgentFor(browser);
    const identity = identityFor({
      detected,
      ...(options.userAgent === undefined ? {} : { configured: options.userAgent }),
      namesItselfHeadless: this.#namesItselfHeadless,
      patched: options.stealth === "patched",
    });
    const { userAgent } = identity;
    const statePath = options.stateDir === undefined
      ? undefined
      : join(options.stateDir, `${host}.json`);

    const context = await browser.newContext({
      // Chrome's own headers are consistent by construction, so they are left
      // alone unless something has to be corrected. See identityFor.
      ...(identity.override ? { userAgent } : {}),
      locale: options.locale,
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      extraHTTPHeaders: {
        // A real browser always sends a quality list, never a bare locale.
        "accept-language": `${options.locale},${options.locale.split("-")[0] ?? "de"};q=0.9,en;q=0.8`,
        // Client hints name the brand separately from the user agent. Correcting
        // one and leaving the other is worse than correcting neither, because
        // the disagreement is itself the signal.
        ...(identity.override ? clientHints(userAgent) : {}),
      },
      ...(options.timezone === undefined ? {} : { timezoneId: options.timezone }),
      ...(statePath !== undefined && isFresh(statePath) ? { storageState: statePath } : {}),
    });
    if (options.stealth === "patched") {
      await context.addInitScript(STEALTH).catch(() => null);
    }
    if (identity.override) {
      // navigator.userAgent is the third place the name appears.
      await context.addInitScript(consistencyScript(userAgent)).catch(() => null);
    }
    return { context, own: true };
  }

  async fetch(url: string, options: BrowserOptions): Promise<PageResult> {
    const host = new URL(url).host;
    const { context, own } = await this.#contextFor(options, host);
    const statePath = options.stateDir === undefined || !own
      ? undefined
      : join(options.stateDir, `${host}.json`);

    // One name per fetch, shared by the trace and the debug pair, so a trace and
    // its markup can be lined up afterwards.
    const artifact = artifactName(url);
    const tracing = options.traceDir !== undefined;
    if (tracing) {
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
        .catch(() => null);
    }

    const page = await context.newPage();
    try {
      if (options.blockAssets !== false) {
        await page.route(BLOCKED_ASSETS, (route) => void route.abort());
      }
      let accepted = false;

      // Landing straight on a deep search URL with no history is itself a signal.
      // The first visit to a host goes to its front page, as a person would, and
      // waits there for the bot-manager sensor to score the session.
      if (!this.#warmed.has(host)) {
        this.#warmed.add(host);
        await page.goto(new URL(url).origin, { waitUntil: "load", timeout: options.timeoutMs })
          .catch(() => null);
        accepted = await acceptConsent(page);
        await waitForSensor(context);
        await page.waitForTimeout(options.settleMs);
      }

      const response = await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs });
      await page.waitForTimeout(options.settleMs);
      accepted = (await acceptConsent(page)) || accepted;

      // Result pages lazy-load rows below the fold.
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await page.waitForTimeout(options.settleMs);

      const body = await page.content();
      if (options.debugDir !== undefined) {
        await writeDebug(page, options.debugDir, host, artifact, body, options.keepArtifacts);
      }

      // A scored session is worth keeping even when no consent dialog appeared;
      // requiring consent meant a portal whose dialog we could not find started
      // cold on every request. A refusal is still not persisted.
      const status = response?.status() ?? 0;
      if (statePath !== undefined && (accepted || (status > 0 && status < 400))) {
        await mkdir(dirname(statePath), { recursive: true });
        await context.storageState({ path: statePath }).catch(() => null);
      }
      return { status, body };
    } finally {
      if (tracing && options.traceDir !== undefined) {
        const dir = await artifactDir(options.traceDir, host).catch(() => null);
        if (dir !== null) {
          await context.tracing.stop({ path: join(dir, `${artifact}.zip`) }).catch(() => null);
          await pruneArtifacts(dir, options.keepArtifacts).catch(() => null);
        }
      }
      await page.close().catch(() => null);
      if (own) await context.close().catch(() => null);
    }
  }


  async close(): Promise<void> {
    const shared = this.#shared;
    this.#shared = null;
    // A browser we attached to over CDP belongs to whoever started it.
    if (shared !== null) await shared.close().catch(() => null);

    if (this.#browser === null) return;
    const browser = await this.#browser.catch(() => null);
    this.#browser = null;
    await browser?.close();
  }
}

export const INSTALL_HINT = "run: npx playwright install chromium";

const VIEWPORT = { width: 1440, height: 900 } as const;

const stripHeadless = (reported: string): string => reported.replace(/HeadlessChrome/g, "Chrome");

export interface BrowserIdentity {
  readonly userAgent: string;
  /** Whether to override what the binary would send by itself. */
  readonly override: boolean;
}

/**
 * What the context should claim about itself.
 *
 * A headless Chrome writes "HeadlessChrome" into its own user agent, its client
 * hints and `navigator.userAgent`. Bot protection reads all three, so running
 * headless without correcting them is the same as announcing it: Cloudflare
 * answered AutoUncle's search page with a challenge on the first navigation and
 * never cleared it. The correction used to be computed and then applied only
 * under `COLLECT_BROWSER_STEALTH=patched`, which is not the default, so it was
 * discarded in exactly the case it exists for.
 *
 * Headful Chrome names itself correctly, so nothing is overridden and its own
 * headers stand.
 */
export function identityFor(input: {
  readonly detected: string;
  readonly configured?: string;
  readonly namesItselfHeadless: boolean;
  readonly patched: boolean;
}): BrowserIdentity {
  const userAgent = input.configured ?? input.detected;
  return {
    userAgent,
    override: input.configured !== undefined || input.namesItselfHeadless || input.patched,
  };
}

/**
 * Sec-CH-UA, derived from the string the page will report.
 *
 * Bundled Chromium sends `"Chromium";v="151", "Not=A?Brand";v="99"` — no real
 * browser brand at all, which no installed browser ever looks like. A real one
 * names itself alongside Chromium.
 */
function clientHints(userAgent: string): Record<string, string> {
  const major = /Chrome\/(\d+)/.exec(userAgent)?.[1];
  if (major === undefined) return {};
  return {
    "sec-ch-ua": `"Not=A?Brand";v="99", "Google Chrome";v="${major}", "Chromium";v="${major}"`,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": /Windows/.test(userAgent) ? '"Windows"'
      : /Macintosh/.test(userAgent) ? '"macOS"' : '"Linux"',
  };
}

/** Bot-manager cookies are only set once the vendor's sensor script has run. */
const SENSOR_COOKIES = /^(_abck|ak_bmsc|bm_sz|bm_sv|datadome|reese84)$/;
const SENSOR_WAIT_MS = 6_000;
const SENSOR_POLL_MS = 250;

/**
 * Waits for the bot-manager sensor to finish.
 *
 * Akamai scores a session from telemetry its own script posts, and records the
 * result in `_abck`. Reading the page before that has happened means leaving
 * with no score at all, which it treats as a failed one.
 */
async function waitForSensor(context: PwContext): Promise<boolean> {
  const until = Date.now() + SENSOR_WAIT_MS;
  while (Date.now() < until) {
    const cookies = await context.cookies().catch(() => []);
    if (cookies.some((c) => SENSOR_COOKIES.test(c.name))) return true;
    await new Promise((resolve) => setTimeout(resolve, SENSOR_POLL_MS));
  }
  return false;
}

/**
 * The page can read its own user agent, client hints and GPU. Headless reports a
 * software renderer, which no real machine has.
 */
function consistencyScript(userAgent: string): string {
  const major = /Chrome\/(\d+)/.exec(userAgent)?.[1] ?? "0";
  return `
Object.defineProperty(navigator, 'userAgent', { get: () => ${JSON.stringify(userAgent)} });
Object.defineProperty(navigator, 'userAgentData', { get: () => ({
  brands: [
    { brand: 'Chromium', version: '${major}' },
    { brand: 'Google Chrome', version: '${major}' },
    { brand: 'Not(A:Brand', version: '24' },
  ],
  mobile: false,
  platform: ${JSON.stringify(/Windows/.test(userAgent) ? "Windows" : "Linux")},
}) });
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function (p) {
  if (p === 37445) return 'Intel Inc.';
  if (p === 37446) return 'Intel Iris OpenGL Engine';
  return getParameter.call(this, p);
};
`;
}

const CONSENT_SELECTOR = CONSENT_SELECTORS.join(", ");
const CONSENT_BUDGET_MS = 2_500;
const CONSENT_CLICK_MS = 400;
const CONSENT_FRAME_LIMIT = 3;
const CONSENT_VENDORS = /consent|privacy-mgmt|sourcepoint|cmp|gdpr|evidon|onetrust/i;

/**
 * Dismisses a cookie wall, under a hard budget.
 *
 * Every selector is tried in one locator rather than one at a time, and only
 * frames belonging to a consent vendor are considered: a results page carries a
 * dozen advertising iframes, and probing each selector in each of them costs
 * more than the whole source is allowed to take.
 */
async function acceptConsent(page: PwPage): Promise<boolean> {
  const deadline = Date.now() + CONSENT_BUDGET_MS;

  const vendorFrames = page.frames()
    .filter((frame) => CONSENT_VENDORS.test(frame.url()))
    .slice(0, CONSENT_FRAME_LIMIT);

  for (const target of [page, ...vendorFrames]) {
    if (Date.now() > deadline) break;
    try {
      await target.locator(CONSENT_SELECTOR).first().click({ timeout: CONSENT_CLICK_MS });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** One pair per fetch, under the host, with the oldest pruned away. */
async function writeDebug(
  page: PwPage,
  root: string,
  host: string,
  artifact: string,
  body: string,
  keep?: number,
): Promise<void> {
  try {
    const dir = await artifactDir(root, host);
    await writeFile(join(dir, `${artifact}.html`), body);
    await page.screenshot({ path: join(dir, `${artifact}.png`), fullPage: false });
    await pruneArtifacts(dir, keep);
  } catch {
    // Losing a debug artefact must never fail the fetch it was documenting.
  }
}

/** Exposed so the corrections can be checked without launching a browser. */
export {
  acceptConsent as acceptConsentForTest,
  clientHints as clientHintsForTest,
  waitForSensor as waitForSensorForTest,
  stripHeadless as userAgentForTest,
};

const STATE_TTL_MS = 12 * 60 * 60 * 1000;

/** Stale cookies are worse than none: an expired session reads as a fresh block. */
function isFresh(path: string): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs < STATE_TTL_MS;
  } catch {
    return false;
  }
}

export function browserFailure(e: unknown): AppError {
  if (e instanceof BrowserUnavailable) return failure(FAILURE.network, e.message);
  const message = e instanceof Error ? e.message : "browser fetch failed";
  // Playwright's own wording buries the fix; say it plainly.
  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return failure(FAILURE.network, `Chromium is not installed — ${INSTALL_HINT}`);
  }
  if (/timeout/i.test(message)) return failure(FAILURE.timeout, message);
  return failure(FAILURE.network, message);
}

/**
 * Adapts a browser backend to the transport the HTTP client already speaks, so
 * status handling, challenge detection and typed failures stay in one place
 * rather than each backend inventing its own idea of "no data".
 */
export function browserTransport(browser: BrowserFetch, options: BrowserOptions): Transport {
  return async (url) => {
    // Failures become a status the client already knows how to classify, so a
    // browser problem can never look like a page with no listings.
    let page: PageResult;
    try {
      page = await browser.fetch(url, options);
    } catch (e) {
      const error = browserFailure(e);
      return new Response(error.message, { status: error.kind === FAILURE.timeout ? 504 : 503 });
    }
    // A zero status means navigation produced no response at all.
    return new Response(page.body, {
      status: page.status === 0 ? 599 : page.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
}
