import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { hashToken, hasScope, parseScopes, type Scope } from "../services/api-keys.ts";
import { Forbidden, Unauthorized } from "../errors.ts";
import type { Config } from "../config.ts";

export interface ApiKeyIdentity {
  readonly id: string;
  readonly prefix: string;
  readonly scopes: ReadonlySet<Scope>;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Resolved once per request by the `onRequest` hook below; null when anonymous. */
    apiKey: ApiKeyIdentity | null;
  }
  interface FastifyInstance {
    /** A preHandler that 401s with no key and 403s with the wrong scope. */
    requireScope(scope: Scope): preHandlerHookHandler;
  }
}

const BEARER_PREFIX = "Bearer ";

/**
 * Resolves `Authorization: Bearer <token>` into `request.apiKey`, once per
 * request, before any route handler runs. A missing or unrecognised header
 * simply leaves `apiKey` null — anonymous access is the default everywhere
 * except behind `requireScope`, and most of the app stays reachable with no
 * key at all (see `Config.apiKeysRequired`).
 */
export default fp(async function auth(app: FastifyInstance, opts: { config: Config }) {
  app.decorateRequest("apiKey", null);

  app.addHook("onRequest", async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (header === undefined || !header.startsWith(BEARER_PREFIX)) return;
    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token === "") return;

    // An exact match on a unique hash column is the whole check: there is no
    // application-level comparison left to time, so no constant-time compare
    // and no dummy-lookup path is needed for the unknown-token case.
    const row = app.apiKeys.findByHash(hashToken(token));
    if (row === null) return;

    const now = new Date();
    if (row.revoked_at !== null || (row.expires_at !== null && Date.parse(row.expires_at) <= now.getTime())) {
      // Deliberately still anonymous rather than an error here: a revoked or
      // expired key falls back to the rate-limited anonymous tier instead of
      // failing the request outright, exactly like sending no key at all.
      return;
    }

    app.apiKeys.touch(row.id, now);
    req.apiKey = { id: row.id, prefix: row.prefix, scopes: parseScopes(row.scopes) };
  });

  app.decorate("requireScope", (scope: Scope): preHandlerHookHandler =>
    async (req: FastifyRequest, _reply: FastifyReply) => {
      if (!opts.config.apiKeysRequired) return;
      if (req.apiKey === null) throw new Unauthorized();
      if (!hasScope(req.apiKey.scopes, scope)) throw new Forbidden();
    });
}, { name: "auth", dependencies: ["storage"] });
