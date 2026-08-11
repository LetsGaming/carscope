import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { artifactDir, artifactName, pruneArtifacts } from "./artifacts.ts";
import { BLOCKED_STATUS, looksLikeChallenge, type Transport } from "./http.ts";

export interface SolverOptions {
  /** FlareSolverr-compatible endpoint, e.g. http://127.0.0.1:8191/v1 */
  readonly endpoint: string;
  readonly timeoutMs: number;
  /** Reuse one browser session across requests instead of solving each time. */
  readonly useSession?: boolean;
  /**
   * Called once with the outcome of the session attempt. Whether sessions are
   * available decides how long every later page takes, and without this the
   * answer was only visible in the solver's own log.
   */
  readonly onSession?: (available: boolean, reason: string) => void;
}

interface SolverSolution {
  readonly status: number | null;
  readonly response: string | null;
}

interface SolverReply {
  readonly status: string | null;
  readonly message: string | null;
  readonly solution: SolverSolution | null;
  readonly session: string | null;
}

export interface SolverPage {
  readonly status: number;
  readonly body: string;
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
  };
}

const SESSION_PREFIX = "carscope";
const OK = "ok";
/** No status from the solver is not a real HTTP status; the client maps it to a failure. */
const NO_STATUS = 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The solver is a separate service that can be any version, so its answer is
 * read field by field rather than asserted into the shape we hope for. A reply
 * that does not fit reads as a solver that could not fetch the page.
 */
function toReply(payload: unknown): SolverReply {
  if (!isRecord(payload)) return { status: null, message: null, solution: null, session: null };
  const solution = payload["solution"];
  return {
    status: asString(payload["status"]),
    message: asString(payload["message"]),
    session: asString(payload["session"]),
    solution: isRecord(solution)
      ? { status: asNumber(solution["status"]), response: asString(solution["response"]) }
      : null,
  };
}

/**
 * Hands a request to Byparr or FlareSolverr, which drives its own browser
 * through the challenge and returns the page behind it.
 *
 * Cloudflare's interstitial is a different problem from Akamai's scoring: it can
 * be passed, it just has to be passed by something that looks like a person
 * waiting. Delegating that keeps the challenge-solving out of this codebase,
 * where it would be an arms race, and behind an interface that is a transport
 * like any other — so failures stay typed and a solver that is down reads as a
 * source that is down, not as a source with no listings.
 */
export class Solver {
  readonly #options: SolverOptions;
  readonly #fetch: typeof fetch;
  #session: string | null = null;
  #sessionAttempted = false;

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

  /**
   * One session is reused where the solver has them: solving the challenge again
   * per page is the slow part.
   *
   * Not every FlareSolverr-compatible solver does. Byparr documents `cmd` as
   * being accepted for compatibility and ignored, so it reads this as an
   * ordinary fetch. Its `url` defaults to the bare string `https://`, which is
   * not navigable, so a `sessions.create` sent without one failed on every run
   * and left a Playwright stack trace in its log. Sending the page we were about
   * to request anyway means such a solver gets a real URL and simply warms up.
   *
   * The session is recorded only when the solver names it back. Falling back to
   * the id we proposed meant carscope believed in a session that was never
   * created, and attached it to every later request.
   */
  async #probe(url: string): Promise<SolverPage | null> {
    if (this.#options.useSession !== true || this.#sessionAttempted) return null;
    this.#sessionAttempted = true;

    try {
      const id = `${SESSION_PREFIX}-${String(Date.now())}`;
      const reply = await this.#command({ cmd: "sessions.create", session: id, url });

      if (reply.status === OK && reply.session !== null) {
        this.#session = reply.session;
        this.#options.onSession?.(true, "solver created a session");
        return null;
      }

      this.#options.onSession?.(
        false,
        "solver does not support sessions; every page solves its own challenge",
      );
      // A solver that ignores `cmd` has just fetched the page. Asking again
      // would hit the portal twice for one search, three seconds apart, which
      // is the pattern bot protection is watching for.
      return reply.status === OK && reply.solution !== null ? toPage(reply) : null;
    } catch (e) {
      this.#session = null;
      this.#options.onSession?.(false, e instanceof Error ? e.message : "session request failed");
      return null;
    }
  }

  async get(url: string): Promise<SolverPage> {
    const probed = await this.#probe(url);
    if (probed !== null) return probed;

    const session = this.#session;
    const reply = await this.#command({
      cmd: "request.get",
      url,
      maxTimeout: this.#options.timeoutMs,
      ...(session === null ? {} : { session }),
    });
    return toPage(reply);
  }

  async close(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    if (session === null) return;
    await this.#command({ cmd: "sessions.destroy", session }).catch(() => null);
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
 * 200 when it recognised the interstitial by page title. Cloudflare's managed
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
  /** Called when a page is judged, so the reason reaches the log. */
  readonly onVerdict?: (verdict: SolverVerdict) => void;
}

export interface SolverVerdict {
  readonly url: string;
  /** What the solver reported for the first navigation. */
  readonly reportedStatus: number;
  /** What the page is served as after the body has been read. */
  readonly servedStatus: number;
  readonly bytes: number;
  readonly challengeMarker: boolean;
}

/** Adapts a solver to the transport the HTTP client already speaks. */
export function solverTransport(solver: Solver, options: SolverTransportOptions = {}): Transport {
  return async (url) => {
    try {
      const page = await solver.get(url);
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
