import { failure, FAILURE, err, ok, type Result } from "@carscope/core";
import type { ClearanceReader } from "./clearance.ts";

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface FetchOptions {
  readonly timeoutMs: number;
  readonly userAgent: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly transport?: Transport;
  /** Used when a request asks for a browser. Absent means plain fetch only. */
  readonly browserTransport?: Transport;
  /** Used when a request asks for a challenge solver. */
  readonly solverTransport?: Transport;
  /**
   * Clearances a past solve produced. Consulted before a solver request so a
   * host that has already been solved is fetched plainly, with the cookies and
   * agent that cleared it, instead of paying for the solver's browser again.
   */
  readonly clearance?: ClearanceReader;
}

export interface RequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /** Portals behind bot protection only answer a real browser. */
  readonly browser?: boolean;
  /** Portals behind an interstitial need something that waits it out. */
  readonly solver?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export const BLOCKED_STATUS: ReadonlySet<number> = new Set([401, 403, 405, 429]);
/** Not-found is its own answer: the list URL has no such search behind it. */
const NOT_FOUND_STATUS = 404;
const CHALLENGE_MARKERS = ["datadome", "captcha-delivery", "akamai reference", "px-captcha"];
const CONSENT_MARKERS = ["sourcepoint", "cmp-container", "privacy-mgmt", "cookie-consent-banner"];
const CONSENT_WALL_MAX_BYTES = 12_000;
/** How much of a failing browser/solver response is quoted back in the error. */
const UPSTREAM_DETAIL_CHARS = 200;
/** Only the head of a page is scanned for challenge and consent markers. */
const MARKER_SCAN_CHARS = 4_000;

/**
 * Whether a page is the bot check rather than the page behind it. Shared with
 * the solver transport, which has to decide the same thing about a body it was
 * handed with a status that describes an earlier navigation.
 */
export function looksLikeChallenge(body: string): boolean {
  const lower = body.slice(0, MARKER_SCAN_CHARS).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

/** Share of scanned characters that must be undecodable before a body is binary. */
const BINARY_CHAR_RATIO = 0.1;

/**
 * Whether a body is undecodable bytes rather than text. The solver can hand back
 * a still-compressed response — its own words describe re-serving the fetched
 * bytes after stripping the encoding header — which arrives as control
 * characters and U+FFFD replacements, not markup. Markup is effectively all
 * printable, so a meaningful share of undecodable characters in the scanned head
 * is the tell, and it is measured without assuming any particular encoding.
 */
export function looksBinary(body: string): boolean {
  const head = body.slice(0, MARKER_SCAN_CHARS);
  if (head.length === 0) return false;
  let undecodable = 0;
  for (const char of head) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x09 || (code > 0x0d && code < 0x20) || code === 0x7f;
    if (control || code === 0xfffd) undecodable += 1;
  }
  return undecodable / head.length > BINARY_CHAR_RATIO;
}

/** Serialises requests per host so one source can never burst against a portal. */
export class HostThrottle {
  readonly #next = new Map<string, number>();

  readonly #minIntervalMs: number;

  constructor(minIntervalMs: number) {
    this.#minIntervalMs = minIntervalMs;
  }

  async take(host: string): Promise<void> {
    const now = Date.now();
    const earliest = this.#next.get(host) ?? 0;
    const wait = Math.max(0, earliest - now);
    this.#next.set(host, Math.max(now, earliest) + this.#minIntervalMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * The single resilient client. Adapters never call fetch directly, so timeouts,
 * throttling and challenge detection are defined once.
 */
export class HttpClient {
  readonly #throttle: HostThrottle;
  readonly #assets: HostThrottle;
  readonly #defaults: FetchOptions;

  constructor(throttle: HostThrottle, defaults: FetchOptions, assets?: HostThrottle) {
    this.#throttle = throttle;
    // Static assets are served by a CDN that neither notices nor minds a burst;
    // pacing them like search pages costs more than every other step combined.
    this.#assets = assets ?? throttle;
    this.#defaults = defaults;
  }

  async getText(url: string, options: RequestOptions = {}): Promise<Result<string>> {
    const res = await this.#send(url, options);
    if (!res.ok) return res;
    const body = await res.value.text();
    const lower = body.slice(0, MARKER_SCAN_CHARS).toLowerCase();
    if (looksLikeChallenge(body)) {
      return err(failure(FAILURE.blocked, `${new URL(url).host} hat eine Bot-Prüfung ausgeliefert`));
    }
    // Short page plus a consent vendor means the wall was never dismissed, which
    // is a different problem from being detected and has a different fix.
    if (body.length < CONSENT_WALL_MAX_BYTES && CONSENT_MARKERS.some((m) => lower.includes(m))) {
      return err(failure(
        FAILURE.blocked,
        `${new URL(url).host} zeigt nur den Cookie-Dialog; Zustimmung wurde nicht übernommen`,
      ));
    }
    return ok(body);
  }

  async getBinary(url: string, maxBytes: number): Promise<Result<Uint8Array>> {
    // Assets always go over plain fetch; rendering them in a browser is waste.
    const res = await this.#send(url, {}, "image/avif,image/webp,image/jpeg,image/png,*/*");
    if (!res.ok) return res;

    const declared = Number.parseInt(res.value.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return err(failure(FAILURE.invalid, `asset exceeds ${String(maxBytes)} bytes`));
    }
    const bytes = new Uint8Array(await res.value.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      return err(failure(FAILURE.invalid, `asset exceeds ${String(maxBytes)} bytes`));
    }
    return ok(bytes);
  }

  async #send(
    url: string,
    options: RequestOptions,
    accept = "text/html,application/xhtml+xml",
  ): Promise<Result<Response>> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return err(failure(FAILURE.invalid, `malformed url: ${url}`));
    }

    const viaSolver = options.solver === true ? this.#defaults.solverTransport : undefined;
    const viaBrowser = options.browser === true ? this.#defaults.browserTransport : undefined;
    if (options.browser === true && viaBrowser === undefined && viaSolver === undefined) {
      return err(failure(
        FAILURE.blocked,
        `${host} needs a browser but none is configured (COLLECT_BROWSER=never?)`,
      ));
    }

    // A clearance an earlier solve won lets this request skip the solver's
    // browser: the cookies and agent Cloudflare already cleared, replayed over
    // plain fetch, are what the solver would otherwise spend a browser to earn
    // again. Tried only where a solver is in play, and only as an opener — a
    // pass the portal no longer honours falls through to a fresh solve, so it is
    // never worse than solving outright.
    if (viaSolver !== undefined) {
      const cleared = await this.#viaClearance(url, options, accept, host);
      if (cleared !== null) return cleared;
    }

    // The solver goes first where one is configured, because it is the thing
    // that gets past an interstitial. It is not a replacement for our browser:
    // the two present differently to bot protection, and a portal that refuses
    // the solver's headless browser will still serve ours. A refusal from the
    // solver therefore falls through to the browser the adapter asked for,
    // rather than ending the source while a transport that works sits unused.
    const primary = viaSolver ?? viaBrowser ?? this.#defaults.transport ?? fetch;
    const first = await this.#attempt(url, options, accept, primary, host);
    const refused = !first.ok && first.error.kind === FAILURE.blocked;
    if (!refused || viaSolver === undefined || viaBrowser === undefined) return first;

    const second = await this.#attempt(url, options, accept, viaBrowser, host);
    if (second.ok) return second;
    return err(failure(
      FAILURE.blocked,
      `${host} refused both the solver and the browser`,
      second.error.status,
    ));
  }

  /**
   * Tries a held clearance over plain fetch. Returns the response only when it
   * succeeds — the point is to avoid the browser, so a page that comes back is
   * used directly. A stale pass answers with the challenge again, which reads as
   * blocked; that is the signal to discard it and let the caller solve afresh,
   * so this returns null and the request proceeds as if there had been no pass.
   */
  async #viaClearance(
    url: string,
    options: RequestOptions,
    accept: string,
    host: string,
  ): Promise<Result<Response> | null> {
    const clearance = this.#defaults.clearance;
    if (clearance === undefined) return null;
    const pass = clearance.pass(host);
    if (pass === null) return null;

    // The agent has to match the cookies: `cf_clearance` is bound to the agent
    // that earned it, and options.headers is merged last so it wins over the
    // client default.
    const replay: RequestOptions = {
      ...options,
      headers: { ...options.headers, cookie: pass.cookie, "user-agent": pass.userAgent },
    };
    const attempt = await this.#attempt(url, replay, accept, this.#defaults.transport ?? fetch, host);
    if (attempt.ok) return attempt;

    clearance.invalidate(host);
    return null;
  }

  async #attempt(
    url: string,
    options: RequestOptions,
    accept: string,
    transport: Transport,
    host: string,
  ): Promise<Result<Response>> {
    await (accept.startsWith("image/") ? this.#assets : this.#throttle).take(host);

    try {
      const res = await transport(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(this.#defaults.timeoutMs),
        headers: {
          "user-agent": this.#defaults.userAgent,
          "accept-language": "de-DE,de;q=0.9,en;q=0.6",
          accept,
          ...this.#defaults.headers,
          ...options.headers,
        },
      });

      if (BLOCKED_STATUS.has(res.status)) {
        return err(failure(FAILURE.blocked, `${host} refused the request`, res.status));
      }
      // A 404 means the page is not there, which for a list URL is the portal
      // saying it has no such search — not an error to show the body of. Read as
      // itself so the note says so, rather than dumping a 404 page into it.
      if (res.status === NOT_FOUND_STATUS) {
        return err(failure(FAILURE.notFound, `${host} has no page for this search (404)`, res.status));
      }
      if (!res.ok) {
        const detail = transport === this.#defaults.transport || transport === fetch
          ? ""
          : (await res.text()).slice(0, UPSTREAM_DETAIL_CHARS);
        return err(failure(
          FAILURE.http,
          detail === "" ? `${host} returned ${String(res.status)}` : `${host}: ${detail}`,
          res.status,
        ));
      }
      return ok(res);
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === "TimeoutError";
      return err(
        isTimeout
          ? failure(FAILURE.timeout, `${host} timed out after ${this.#defaults.timeoutMs}ms`)
          : failure(FAILURE.network, e instanceof Error ? e.message : "network error"),
      );
    }
  }
}
