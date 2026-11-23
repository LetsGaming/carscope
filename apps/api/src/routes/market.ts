import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type, type Static } from "@sinclair/typebox";
import {
  DEFAULT_WINDOW_MONTHS, EMPTY_CRITERIA,
  toBodyStyle, toFuel, toGearbox, toMarket, toSellerType,
  type Criteria, type Market,
} from "@carscope/core";
import { ErrorSchema, IdParams } from "../schemas.ts";
import { NotFound } from "../errors.ts";
import { assertRangesValid } from "../validation.ts";
import { collectionKey, type CollectionJob } from "../plugins/collector.ts";
import { SCOPE } from "../services/api-keys.ts";
import type { MarketReport, PricedResult } from "../services/market.ts";

const DistributionSchema = Type.Object({
  n: Type.Integer(), p10: Type.Number(), p25: Type.Number(),
  p50: Type.Number(), p75: Type.Number(), p90: Type.Number(), mean: Type.Number(),
});

const MarketSchema = Type.Object({
  current: DistributionSchema,
  series: Type.Array(Type.Intersect([
    DistributionSchema,
    Type.Object({ month: Type.String(), reliable: Type.Boolean() }),
  ])),
  bands: Type.Array(Type.Object({ from: Type.Integer(), to: Type.Integer(), count: Type.Integer() })),
  factors: Type.Array(Type.Object({
    key: Type.String(), deltaEur: Type.Integer(),
    nWith: Type.Integer(), nWithout: Type.Integer(),
    withMedian: Type.Number(), withoutMedian: Type.Number(),
  })),
  confidence: Type.Integer(),
  medianDaysListed: Type.Union([Type.Integer(), Type.Null()]),
  changeYearPct: Type.Union([Type.Number(), Type.Null()]),
  activeCount: Type.Integer(),
  observationCount: Type.Integer(),
  excludedByText: Type.Integer(),
  heldCount: Type.Integer(),
  unknownCount: Type.Integer(),
  periods: Type.Array(Type.Object({
    token: Type.String(),
    fromYear: Type.Integer(),
    toYear: Type.Integer(),
  })),
});

const ResultSchema = Type.Object({
  id: Type.String(), make: Type.String(), model: Type.String(),
  variant: Type.Union([Type.String(), Type.Null()]),
  firstRegistration: Type.Union([Type.String(), Type.Null()]),
  mileageKm: Type.Union([Type.Integer(), Type.Null()]),
  powerW: Type.Union([Type.Integer(), Type.Null()]),
  gearbox: Type.Union([Type.String(), Type.Null()]),
  city: Type.Union([Type.String(), Type.Null()]),
  market: Type.String(),
  daysListed: Type.Integer(),
  daysListedExact: Type.Boolean(),
  delistedAt: Type.Union([Type.String(), Type.Null()]),
  heldReason: Type.Union([Type.String(), Type.Null()]),
  priceChangeCount: Type.Integer(),
  vsMedian: Type.Number(),
  price: Type.Integer(),
  firstPrice: Type.Integer(),
  photoCount: Type.Integer(),
  thumbnail: Type.Union([Type.String(), Type.Null()]),
  sources: Type.Array(Type.String()),
  url: Type.String(),
});

const field = Type.Optional(Type.String({ maxLength: 200 }));

/**
 * A query string is text. It is declared as text and parsed here, rather than
 * leaning on Ajv coercion — the same coercion that destroys nulls in a union.
 */
const CriteriaQuery = Type.Object({
  text: field,
  priceMin: field, priceMax: field,
  kmMin: field, kmMax: field,
  yearMin: field, yearMax: field,
  psMin: field, psMax: field,
  fuel: field, gearbox: field, sellerType: field, bodyStyle: field,
  markets: field, postalCode: field, radiusKm: field,
  excludeDamaged: field,
  active: field,
  held: field,
  months: field,
  force: field,
});

type Query = Static<typeof CriteriaQuery>;

function int(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

const text = (value: string | undefined): string | null =>
  value === undefined || value.trim() === "" ? null : value.trim();

const flag = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : value === "true" || value === "1";

/**
 * A query string is untrusted text, so every enumerated value is narrowed by the
 * core parser rather than asserted into its union. Asserting made `?fuel=diesel!`
 * a criterion the filter then compared against the column.
 */
function toCriteria(q: Query): Criteria {
  const markets = (q.markets ?? "")
    .split(",")
    .map((code) => toMarket(code))
    .filter((market): market is Market => market !== null);

  return {
    ...EMPTY_CRITERIA,
    text: q.text ?? "",
    priceEur: { min: int(q.priceMin), max: int(q.priceMax) },
    mileageKm: { min: int(q.kmMin), max: int(q.kmMax) },
    registrationYear: { min: int(q.yearMin), max: int(q.yearMax) },
    powerPs: { min: int(q.psMin), max: int(q.psMax) },
    fuel: toFuel(text(q.fuel)),
    gearbox: toGearbox(text(q.gearbox)),
    sellerType: toSellerType(text(q.sellerType)),
    bodyStyle: toBodyStyle(text(q.bodyStyle)),
    markets,
    postalCode: text(q.postalCode),
    radiusKm: int(q.radiusKm),
    excludeDamaged: flag(q.excludeDamaged, false),
  };
}

/**
 * Parsing and range validation are the same job on every endpoint that takes
 * criteria, so they happen once here instead of being repeated per handler.
 */
function criteriaFromQuery(q: Query): Criteria {
  const criteria = toCriteria(q);
  assertRangesValid(criteria);
  return criteria;
}

const toDto = (r: PricedResult): Static<typeof ResultSchema> => ({ ...r, sources: [...r.sources] });

/** Readonly domain arrays copied once into the mutable shape the schema declares. */
const toReportDto = (r: MarketReport): Static<typeof MarketSchema> => ({
  ...r,
  periods: r.periods.map((p) => ({ ...p })),
  series: r.series.map((p) => ({ ...p })),
  bands: r.bands.map((b) => ({ ...b })),
  factors: r.factors.map((f) => ({ ...f })),
});

const RunSchema = Type.Object({
  sourceId: Type.String(), status: Type.String(),
  fetched: Type.Integer(), kept: Type.Integer(), created: Type.Integer(),
  merged: Type.Integer(), delisted: Type.Integer(), photos: Type.Integer(),
  note: Type.Union([Type.String(), Type.Null()]),
});

const JobSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  startedAt: Type.String(),
  finishedAt: Type.Union([Type.String(), Type.Null()]),
  total: Type.Integer(),
  done: Type.Integer(),
  current: Type.Union([Type.String(), Type.Null()]),
  runs: Type.Array(RunSchema),
  stored: Type.Integer(),
  timedOut: Type.Boolean(),
});

const toJobDto = (job: CollectionJob): Static<typeof JobSchema> => ({
  ...job,
  runs: job.runs.map(({ sourceId, status, fetched, kept, created, merged, delisted, photos, note }) =>
    ({ sourceId, status, fetched, kept, created, merged, delisted, photos, note })),
});

const market: FastifyPluginAsyncTypebox = async (app) => {
  /**
   * Starts a run and returns at once. Progress is polled; the portals are far
   * too slow to hold a request open for.
   */
  app.post("/collect", {
    schema: { querystring: CriteriaQuery, response: { 202: JobSchema, 400: ErrorSchema } },
    preHandler: app.requireScope(SCOPE.write),
  }, async (req, reply) => {
    const criteria = criteriaFromQuery(req.query);
    const job = app.startCollection(
      { id: collectionKey(criteria), name: criteria.text || "Ad-hoc", criteria },
      flag(req.query.force, false),
    );
    reply.code(202);
    return toJobDto(job);
  });

  app.get("/collect", {
    schema: { response: { 200: Type.Union([JobSchema, Type.Null()]) } },
  }, async () => {
    const job = app.currentJob();
    return job === null ? null : toJobDto(job);
  });

  app.get("/vehicles", {
    schema: { querystring: CriteriaQuery, response: { 200: Type.Array(ResultSchema), 400: ErrorSchema } },
  }, async (req) => {
    const criteria = criteriaFromQuery(req.query);
    return app.market.priced(criteria, flag(req.query.active, true), flag(req.query.held, false)).map(toDto);
  });

  app.get("/market", {
    schema: { querystring: CriteriaQuery, response: { 200: MarketSchema, 400: ErrorSchema } },
  }, async (req) => {
    const criteria = criteriaFromQuery(req.query);
    return toReportDto(app.market.report(criteria, int(req.query.months) ?? DEFAULT_WINDOW_MONTHS));
  });
};

/** Kept so a saved search resolves to its own criteria without the client repeating them. */
export const searchScoped: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/:id/vehicles", {
    schema: { params: IdParams, response: { 200: Type.Array(ResultSchema), 404: ErrorSchema } },
  }, async (req) => {
    const search = app.searches.findById(req.params.id);
    if (search === null) throw new NotFound("search");
    return app.market.priced(search.criteria, true).map(toDto);
  });

  app.get("/:id/market", {
    schema: { params: IdParams, response: { 200: MarketSchema, 404: ErrorSchema } },
  }, async (req) => {
    const search = app.searches.findById(req.params.id);
    if (search === null) throw new NotFound("search");
    return toReportDto(app.market.report(search.criteria, DEFAULT_WINDOW_MONTHS));
  });
};

export default market;
