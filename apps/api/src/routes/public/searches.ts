import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { DEFAULT_WINDOW_MONTHS } from "@carscope/core";
import { ErrorSchema, IdParams } from "../../schemas.ts";
import { NotFound } from "../../errors.ts";
import type { RateLimitTier } from "../../plugins/rate-limit.ts";
import type { PublicCaches } from "./index.ts";
import {
  PublicFeedSchema, PublicMarketSchema, PublicSearchSchema, PublicVehicleSchema,
  toPublicFeedVehicle, toPublicVehicle,
} from "./dto.ts";

const field = Type.Optional(Type.String({ maxLength: 40 }));

export interface PublicSearchesOptions {
  readonly caches: PublicCaches;
  readonly tier: RateLimitTier;
  readonly defaultLimit: number;
  readonly maxLimit: number;
}

const publicSearches: FastifyPluginAsyncTypebox<PublicSearchesOptions> = async (app, opts) => {
  const { caches, tier, defaultLimit, maxLimit } = opts;
  const rateLimit = { config: { rateLimit: tier } };

  const clampLimit = (raw: string | undefined, defaultLimit: number, maxLimit: number): number => {
    const n = raw === undefined ? defaultLimit : Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return defaultLimit;
    return Math.min(n, maxLimit);
  };

  /** Only names offered here — criteria is operator configuration, not public data. */
  app.get("/searches", {
    schema: { response: { 200: Type.Array(PublicSearchSchema) } },
    ...rateLimit,
  }, async () =>
    caches.searchList.get("list", () => app.searches.list().map((s) => ({ id: s.id, name: s.name }))));

  app.get("/searches/:id/vehicles", {
    schema: {
      params: IdParams,
      querystring: Type.Object({ limit: field }),
      response: { 200: Type.Array(PublicVehicleSchema), 404: ErrorSchema },
    },
    ...rateLimit,
  }, async (req) => {
    const search = app.searches.findById(req.params.id);
    if (search === null) throw new NotFound("search");
    const limit = clampLimit(req.query.limit, defaultLimit, maxLimit);
    return caches.vehicles.get(`${search.id}:${String(limit)}`, () =>
      app.market.priced(search.criteria, true).slice(0, limit).map(toPublicVehicle));
  });

  app.get("/searches/:id/market", {
    schema: { params: IdParams, response: { 200: PublicMarketSchema, 404: ErrorSchema } },
    ...rateLimit,
  }, async (req) => {
    const search = app.searches.findById(req.params.id);
    if (search === null) throw new NotFound("search");
    return caches.market.get(search.id, () => {
      const report = app.market.report(search.criteria, DEFAULT_WINDOW_MONTHS);
      return { current: report.current, activeCount: report.activeCount, confidence: report.confidence };
    });
  });

  /**
   * The change feed: vehicles newly seen for this search since `cursor`. Not
   * cached — a poller sends its own cursor, so responses are not shared across
   * callers the way the list endpoints are, and caching would just delay a
   * result the client already knows is fresh.
   */
  app.get("/searches/:id/feed", {
    schema: {
      params: IdParams,
      querystring: Type.Object({ cursor: field, limit: field }),
      response: { 200: PublicFeedSchema, 404: ErrorSchema },
    },
    ...rateLimit,
  }, async (req) => {
    const search = app.searches.findById(req.params.id);
    if (search === null) throw new NotFound("search");
    const cursor = Number.parseInt(req.query.cursor ?? "0", 10);
    const limit = clampLimit(req.query.limit, defaultLimit, maxLimit);
    const { items, nextCursor } = app.vehicles.since(
      search.criteria,
      Number.isFinite(cursor) && cursor >= 0 ? cursor : 0,
      limit,
    );
    return {
      items: items.map(toPublicFeedVehicle),
      nextCursor: nextCursor === null ? null : String(nextCursor),
    };
  });
};

export default publicSearches;
