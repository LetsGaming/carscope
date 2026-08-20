import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.ts";

export interface RateLimitTier {
  readonly max: number | ((req: FastifyRequest) => number);
  readonly timeWindow: number;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Route-level `config.rateLimit` values; a route opts in with one of these. */
    rateLimitTiers: { readonly read: RateLimitTier; readonly write: RateLimitTier };
  }
}

/**
 * `errorResponseBuilder` throws whatever it returns; the default returns an
 * `Error` with `statusCode` set, which is how the app's `setErrorHandler`
 * (mapping any 4xx to `{error, message}`) recognises it as a 429 rather than
 * an unclassified fault. Returning a plain object here — the tempting
 * shortcut, since `{error, message}` is already the target shape — throws
 * something with no `statusCode` at all, so the shared handler falls through
 * to its 500 branch and every rate-limited request would read as a server
 * fault instead of a 429.
 */
class RateLimited extends Error {
  readonly statusCode = 429;
  readonly code = "rate_limited";
  constructor() { super("too many requests"); }
}

/**
 * Registered with `global: false`, so a route is limited only when it opts in
 * via `config: { rateLimit: … }` — not by an exclusion list. `/api/events`
 * hijacks its reply for an SSE stream and must never be metered like a request,
 * `/api/health` and `/media/*` are meant to be hit freely, and neither is ever
 * touched here by construction rather than by remembering to skip it.
 */
export default fp(async function rateLimitPlugin(app: FastifyInstance, opts: { config: Config }) {
  const { rateLimit: cfg } = opts.config;

  await app.register(rateLimit, {
    global: false,
    // Auth resolves on `onRequest`; running the limiter on `preHandler` means
    // `request.apiKey` always exists by the time `keyGenerator` reads it.
    hook: "preHandler",
    timeWindow: cfg.windowMs,
    keyGenerator: (req: FastifyRequest) => req.apiKey?.id ?? `ip:${req.ip}`,
    errorResponseBuilder: () => new RateLimited(),
  });

  app.decorate("rateLimitTiers", {
    // A key present at all lifts a caller out of the anonymous tier — see
    // services/api-keys.ts on why there is no separate `read` scope for this.
    read: { max: (req: FastifyRequest) => (req.apiKey === null ? cfg.anonMax : cfg.keyMax), timeWindow: cfg.windowMs },
    write: { max: cfg.writeMax, timeWindow: cfg.windowMs },
  });
}, { name: "rateLimit", dependencies: ["auth"] });
