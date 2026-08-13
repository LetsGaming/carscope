import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactDir, artifactName, pruneArtifacts } from "./artifacts.ts";
import type { ClearanceCookie, ClearanceWriter } from "./clearance.ts";
import { BLOCKED_STATUS, looksBinary, looksLikeChallenge, type Transport } from "./http.ts";

export interface SolverOptions {
  /** FlareSolverr-compatible endpoint, e.g. http://127.0.0.1:8191/v1 */
  readonly endpoint: string;
  readonly timeoutMs: number;
}

interface SolverSolution {
  readonly status: number | null;
  readonly response: string | null;
  /** Cookies the challenge issued, kept so the clearance can be replayed. */
  readonly cookies: readonly ClearanceCookie[];
  /** The agent the solver drove; `cf_clearance` is bound to it. */
  readonly userAgent: string | null;
}

interface SolverReply {
  readonly status: string | null;
  readonly message: string | null;
  readonly solution: SolverSolution | null;
}

export interface SolverPage {
  readonly status: number;
  readonly body: string;
  readonly cookies: readonly ClearanceCookie[];
  readonly userAgent: string | null;
}

/**
 * A reply that is not `ok` carries the solver's own words; anything else would
 * report an empty page as a page with no cars on it.
 */
function toPage(reply: SolverReply): SolverPage {
  if (reply.status !== OK) {
    throw new Error(reply.message === null || reply.message === ""
      ? "solver could not fetch the page"
      : reply.message);
  }
  return {
    status: reply.solution?.status ?? NO_STATUS,
    body: reply.solution?.response ?? "",
    cookies: reply.solution?.cookies ?? [],
    userAgent: reply.solution?.userAgent ?? null,
  };
}

const OK = "ok";
/** No status from the solver is not a real HTTP status; the client maps it to a failure. */
const NO_STATUS = 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The cookies Byparr returns are Playwright cookies with more fields than a
 * replay needs. Only name, value and domain are read, and only entries that
 * carry all three: a cookie without a domain cannot be scoped to a host safely.
 */
function toCookies(value: unknown): ClearanceCookie[] {
  if (!Array.isArray(value)) return [];
  const cookies: ClearanceCookie[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const name = asString(entry["name"]);
    const cookieValue = asString(entry["value"]);
    const domain = asString(entry["domain"]);
    if (name === null || cookieValue === null || domain === null || domain === "") continue;
    cookies.push({ name, value: cookieValue, domain });
  }
  return cookies;
}

/**
 * The solver is a separate service that can be any version, so its answer is
 * read field by field rather than asserted into the shape we hope for. A reply
 * that does not fit reads as a solver that could not fetch the page.
 */
function toReply(payload: unknown): SolverReply {
  if (!isRecord(payload)) return { status: null, message: null, solution: null };
  const solution = payload["solution"];
  return {
    status: asString(payload["status"]),
    message: asString(payload["message"]),
    solution: isRecord(solution)
      ? {
        status: asNumber(solution["status"]),
        response: asString(solution["response"]),
        cookies: toCookies(solution["cookies"]),
        userAgent: asString(solution["userAgent"]),
      }
      : null,
  };
}

/**
 * Hands a request to Byparr or FlareSolverr, which drives its own browser
 * through the challenge and returns the page behind it — together with the
 * cookies and user agent that got past it.
 *
 * Cloudflare's interstitial is a different problem from Akamai's scoring: it can
 * be passed, it just has to be passed by something that looks like a person
 * waiting. Delegating that keeps the challenge-solving out of this codebase,
 * where it would be an arms race, and behind an interface that is a transport
 * like any other — so failures stay typed and a solver that is down reads as a
 * source that is down, not as a source with no listings.
 *
 * Byparr is stateless: it takes no cookies in and keeps no session between
 * calls (`cmd` is accepted only for FlareSolverr compatibility and ignored). The
 * reuse that makes it worth its cost therefore happens on our side, from the
 * clearance it returns — see the clearance store — not through a session here.
 */
export class Solver {
  readonly #options: SolverOptions;
  readonly #fetch: typeof fetch;

  constructor(options: SolverOptions, fetchImpl: typeof fetch = fetch) {
    this.#options = options;
    this.#fetch = fetchImpl;
  }

  async #command(body: Record<string, unknown>): Promise<SolverReply> {
    const res = await this.#fetch(this.#options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // The solver waits out the challenge itself, so it needs longer than a page.
      signal: AbortSignal.timeout(this.#options.timeoutMs + 15_000),
    });
    if (!res.ok) throw new Error(`solver returned ${String(res.status)}`);
    return toReply(await res.json());
  }

  async get(url: string): Promise<SolverPage> {
    const reply = await this.#command({
      cmd: "request.get",
      url,
      maxTimeout: this.#options.timeoutMs,
    });
    return toPage(reply);
  }
}

/** Non-standard 5xx: the solver answered, but with nothing the client can use. */
const SOLVER_NO_STATUS_CODE = 599;
const SOLVER_UNAVAILABLE_CODE = 503;
const OK_STATUS = 200;
/**
 * A denial page or an interstitial is a few kilobytes. A results page is an
 * order of magnitude more, so size separates the two without parsing either.
 */
const BLOCK_PAGE_MAX_BYTES = 20_000;

/**
 * Byparr reports the status of the *first* navigation and only rewrites it to
 * 200 when it recognised the interstitial and solved it. Cloudflare's managed
 * challenge answers 403 and then clears itself, so a 403 arrives attached to
 * the page we asked for, and reading the status alone threw away a full results
 * page as "the portal refused the request".
 *
 * Getting past that is the entire job of a solver, so here the body decides. A
 * short body, or one still carrying a challenge marker, keeps the blocking
 * status and is reported as blocked. A substantial page that no longer looks
 * like a challenge is served as what it is.
 */
function statusFor(page: SolverPage): number {
  if (page.status === NO_STATUS) return SOLVER_NO_STATUS_CODE;
  if (!BLOCKED_STATUS.has(page.status)) return page.status;

  const solved = page.body.length >= BLOCK_PAGE_MAX_BYTES && !looksLikeChallenge(page.body);
  return solved ? OK_STATUS : page.status;
}

export interface SolverTransportOptions {
  /** Where to write the page the solver returned, as the browser transport does. */
  readonly debugDir?: string;
  readonly keepArtifacts?: number;
  /** Banks the clearance from a solved page so later requests can skip the solver. */
  readonly clearance?: ClearanceWriter;
  /** Called when a page is judged, so the reason reaches the log. */
  readonly onVerdict?: (verdict: SolverVerdict) => void;
  readonly now?: () => number;
}

export interface SolverVerdict {
  readonly url: string;
  /** What the solver reported for the first navigation. */
  readonly reportedStatus: number;
  /** What the page is served as after the body has been read. */
  readonly servedStatus: number;
  readonly bytes: number;
  readonly challengeMarker: boolean;
  /** Set when the body was not usable text, so the reason is not read as content. */
  readonly garbled?: boolean;
}

/** The solver answered, but the body is not decodable text — treated as a failure. */
const SOLVER_GARBLED_CODE = 598;
const SOLVER_GARBLED_MESSAGE = "solver returned a corrupted page (body was not decodable text)";

/** Adapts a solver to the transport the HTTP client already speaks. */
export function solverTransport(solver: Solver, options: SolverTransportOptions = {}): Transport {
  const now = options.now ?? Date.now;
  return async (url) => {
    try {
      const page = await solver.get(url);

      // Byparr requests an uncompressed body but re-serves the fetched response,
      // so a portal that ignores that and answers compressed leaves the browser
      // reading compressed bytes as text. That page is neither listings nor a
      // challenge; passing it on would feed the parser noise and put binary in
      // the run note. It reads as a solver that could not return the page.
      if (looksBinary(page.body)) {
        options.onVerdict?.({
          url,
          reportedStatus: page.status,
          servedStatus: SOLVER_GARBLED_CODE,
          bytes: page.body.length,
          challengeMarker: false,
          garbled: true,
        });
        return new Response(SOLVER_GARBLED_MESSAGE, { status: SOLVER_UNAVAILABLE_CODE });
      }

      const status = statusFor(page);

      // A solver page is the one thing that used to leave no trace anywhere: the
      // browser writes its markup to the debug directory and the solver wrote
      // nothing, so the only source that needed inspecting was the only one that
      // could not be inspected.
      options.onVerdict?.({
        url,
        reportedStatus: page.status,
        servedStatus: status,
        bytes: page.body.length,
        challengeMarker: looksLikeChallenge(page.body),
      });

      // Bank the clearance only from a page that came back clean: the cookies and
      // agent that just passed the challenge are what a later plain fetch replays
      // instead of paying for the browser again.
      if (status === OK_STATUS && page.userAgent !== null) {
        options.clearance?.put(new URL(url).host, {
          cookies: page.cookies,
          userAgent: page.userAgent,
          obtainedAtMs: now(),
        });
      }

      if (options.debugDir !== undefined) {
        await writeSolverDebug(options.debugDir, url, page.body, options.keepArtifacts);
      }

      return new Response(page.body, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "solver failed";
      // 5xx so the client classifies it as the source being unavailable, with
      // the solver's own words attached rather than an empty page.
      return new Response(`Solver: ${message}`, { status: SOLVER_UNAVAILABLE_CODE });
    }
  };
}

/** No screenshot: the solver drives its own browser and does not hand one back. */
async function writeSolverDebug(
  root: string,
  url: string,
  body: string,
  keep?: number,
): Promise<void> {
  try {
    const dir = await artifactDir(root, new URL(url).host);
    await writeFile(join(dir, `${artifactName(url)}.html`), body);
    await pruneArtifacts(dir, keep);
  } catch {
    // Losing a debug artefact must never fail the fetch it was documenting.
  }
}
