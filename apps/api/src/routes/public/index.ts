import type { FastifyPluginAsync } from "fastify";
import publicSearches from "./searches.ts";
import { PublicCache } from "../../services/public-cache.ts";
import type { Config } from "../../config.ts";
import type { PublicSearchSchema, PublicVehicleSchema, PublicMarketSchema } from "./dto.ts";
import type { Static } from "@sinclair/typebox";

export interface PublicCaches {
  readonly searchList: PublicCache<Static<typeof PublicSearchSchema>[]>;
  readonly vehicles: PublicCache<Static<typeof PublicVehicleSchema>[]>;
  readonly market: PublicCache<Static<typeof PublicMarketSchema>>;
}

/**
 * The only namespace meant to face the internet (see `PUBLIC_PREFIX` in
 * `app.ts`): read-only, saved-searches-only, its own DTOs, `access-control-
 * allow-origin: *` from the app-level CORS delegate.
 */
const publicApi: FastifyPluginAsync<{ config: Config }> = async (app, opts) => {
  // helmet's default Cross-Origin-Resource-Policy is `same-origin`. A CORS-mode
  // `fetch` against a JSON route is unaffected, but a browser loading `/media/*`
  // in `no-cors` mode — an <img> tag — would be blocked without this.
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cross-origin-resource-policy", "cross-origin");
  });

  const caches: PublicCaches = {
    searchList: new PublicCache(opts.config.public.cacheTtlMs),
    vehicles: new PublicCache(opts.config.public.cacheTtlMs),
    market: new PublicCache(opts.config.public.cacheTtlMs),
  };

  await app.register(publicSearches, {
    caches,
    tier: app.rateLimitTiers.read,
    defaultLimit: opts.config.public.defaultLimit,
    maxLimit: opts.config.public.maxLimit,
  });
};

export default publicApi;
