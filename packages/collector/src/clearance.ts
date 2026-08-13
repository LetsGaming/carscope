/**
 * A solver run is expensive: Byparr drives a full anti-detection browser through
 * the challenge. What it hands back is meant to be reused — the cookies the
 * challenge issued (a Cloudflare `cf_clearance` among them) and the user agent
 * they were issued to. Replaying those over a plain fetch is what lets one solve
 * serve many pages, which is the whole point of running a solver rather than
 * paying a browser per request.
 *
 * This module is the seam that makes that reuse possible: the solver transport
 * writes a clearance here, and the HTTP client reads a ready-to-send pass from
 * it before deciding to solve.
 */

/** A cookie the solver returned, reduced to what a replay needs. */
export interface ClearanceCookie {
  readonly name: string;
  readonly value: string;
  /** The scope the portal set, e.g. `.autouncle.de`; decides which hosts it covers. */
  readonly domain: string;
}

/**
 * One solve's worth of reuse. `cf_clearance` is bound to the exact user agent it
 * was issued to, so a later request has to carry both the cookies and that agent
 * or the portal rejects the cookie and challenges again.
 */
export interface Clearance {
  readonly cookies: readonly ClearanceCookie[];
  readonly userAgent: string;
  readonly obtainedAtMs: number;
}

/** A cheap way past a host: the Cookie header to send and the agent it is bound to. */
export interface ClearancePass {
  readonly cookie: string;
  readonly userAgent: string;
}

/** Read side handed to the HTTP client: ask for a pass, report one that stopped working. */
export interface ClearanceReader {
  /** A usable pass for the host, or null when there is none fresh enough. */
  pass(host: string): ClearancePass | null;
  /** Drop a pass the portal no longer honours, so the next request re-solves. */
  invalidate(host: string): void;
}

/** Write side handed to the solver transport: bank what a solve produced. */
export interface ClearanceWriter {
  put(host: string, clearance: Clearance): void;
}

/**
 * Whether a cookie's `domain` covers a request host, following how Playwright —
 * and so Byparr — represents scope. A leading dot means the cookie applies to
 * the domain and every subdomain, so `.autouncle.de` covers `www.autouncle.de`;
 * a host-only cookie is stored without the dot and matches that host alone.
 */
function domainCovers(cookieDomain: string, host: string): boolean {
  if (cookieDomain.startsWith(".")) {
    const bare = cookieDomain.slice(1);
    return host === bare || host.endsWith(`.${bare}`);
  }
  return host === cookieDomain;
}

/** The pass for a host from a clearance, or null when no stored cookie covers it. */
export function passFor(clearance: Clearance, host: string): ClearancePass | null {
  const jar = clearance.cookies.filter((c) => domainCovers(c.domain, host));
  if (jar.length === 0) return null;
  return {
    cookie: jar.map((c) => `${c.name}=${c.value}`).join("; "),
    userAgent: clearance.userAgent,
  };
}

/**
 * Holds the most recent clearance per host and hands out a pass while it is
 * fresh. A pass older than the TTL is discarded on read, so a stale
 * `cf_clearance` is re-solved rather than replayed into a fresh challenge.
 *
 * In-memory by design: a clearance is a short-lived credential tied to the
 * current IP and user agent, worth nothing once either changes, so there is
 * nothing to persist across restarts.
 */
export class ClearanceStore implements ClearanceReader, ClearanceWriter {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #byHost = new Map<string, Clearance>();

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  put(host: string, clearance: Clearance): void {
    // A solve that returned no cookies gives nothing to replay; banking it would
    // only mask the real clearance until the empty one expired.
    if (clearance.cookies.length === 0) return;
    this.#byHost.set(host, clearance);
  }

  pass(host: string): ClearancePass | null {
    const clearance = this.#byHost.get(host);
    if (clearance === undefined) return null;
    if (this.#now() - clearance.obtainedAtMs > this.#ttlMs) {
      this.#byHost.delete(host);
      return null;
    }
    return passFor(clearance, host);
  }

  invalidate(host: string): void {
    this.#byHost.delete(host);
  }
}
