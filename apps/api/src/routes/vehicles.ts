import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ErrorSchema, IdParams } from "../schemas.ts";
import type { VehicleWithPrice } from "@carscope/core";
import type { Static } from "@sinclair/typebox";
import { NotFound } from "../errors.ts";
import { photoUrl } from "./media.ts";
import { SCOPE } from "../services/api-keys.ts";

const PhotoSchema = Type.Object({
  url: Type.String(),
  localPath: Type.Union([Type.String(), Type.Null()]),
  position: Type.Integer(),
});

const PriceSchema = Type.Object({
  observedAt: Type.String(),
  baseAmount: Type.Integer(),
  amount: Type.Integer(),
  currency: Type.String(),
  sourceId: Type.String(),
});

const VehicleSchema = Type.Object({
  id: Type.String(),
  make: Type.String(),
  model: Type.String(),
  variant: Type.Union([Type.String(), Type.Null()]),
  bodyStyle: Type.Union([Type.String(), Type.Null()]),
  firstRegistration: Type.Union([Type.String(), Type.Null()]),
  mileageKm: Type.Union([Type.Integer(), Type.Null()]),
  powerW: Type.Union([Type.Integer(), Type.Null()]),
  fuel: Type.Union([Type.String(), Type.Null()]),
  gearbox: Type.Union([Type.String(), Type.Null()]),
  sellerType: Type.Union([Type.String(), Type.Null()]),
  sellerName: Type.Union([Type.String(), Type.Null()]),
  market: Type.String(),
  city: Type.Union([Type.String(), Type.Null()]),
  postalCode: Type.Union([Type.String(), Type.Null()]),
  description: Type.Union([Type.String(), Type.Null()]),
  daysListed: Type.Integer(),
  firstListedAt: Type.Union([Type.String(), Type.Null()]),
  priceChangeCount: Type.Integer(),
  currentPrice: PriceSchema,
  firstPrice: PriceSchema,
  photos: Type.Array(PhotoSchema),
  listings: Type.Array(Type.Object({
    sourceId: Type.String(), url: Type.String(), title: Type.String(),
    firstSeenAt: Type.String(), delistedAt: Type.Union([Type.String(), Type.Null()]),
  })),
});

const vehicles: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/:id", {
    schema: { params: IdParams, response: { 200: VehicleSchema, 404: ErrorSchema } },
  }, async (req) => {
    const vehicle = app.vehicles.findById(req.params.id);
    if (vehicle === null) throw new NotFound("vehicle");
    return toVehicleDto(vehicle);
  });

  app.delete("/:id", {
    schema: { params: IdParams, response: { 204: Type.Null(), 404: ErrorSchema } },
    preHandler: app.requireScope(SCOPE.write),
  }, async (req, reply) => {
    if (!app.vehicles.hide(req.params.id, new Date().toISOString())) throw new NotFound("vehicle");
    reply.code(204);
    return null;
  });

  app.post("/:id/restore", {
    schema: { params: IdParams, response: { 204: Type.Null(), 404: ErrorSchema } },
    preHandler: app.requireScope(SCOPE.write),
  }, async (req, reply) => {
    if (!app.vehicles.unhide(req.params.id)) throw new NotFound("vehicle");
    reply.code(204);
    return null;
  });

  app.get("/:id/prices", {
    schema: { params: IdParams, response: { 200: Type.Array(PriceSchema), 404: ErrorSchema } },
  }, async (req) => {
    if (app.vehicles.findById(req.params.id) === null) throw new NotFound("vehicle");
    return app.vehicles.priceHistory(req.params.id).map((p) => ({
      observedAt: p.observedAt, baseAmount: p.baseAmount,
      amount: p.amount, currency: p.currency, sourceId: p.sourceId,
    }));
  });
};

export default vehicles;

function toVehicleDto(v: VehicleWithPrice): Static<typeof VehicleSchema> {
  const price = (p: VehicleWithPrice["currentPrice"]): Static<typeof PriceSchema> => ({
    observedAt: p.observedAt, baseAmount: p.baseAmount,
    amount: p.amount, currency: p.currency, sourceId: p.sourceId,
  });
  return {
    id: v.id, make: v.make, model: v.model, variant: v.variant,
    bodyStyle: v.bodyStyle, firstRegistration: v.firstRegistration,
    mileageKm: v.mileageKm, powerW: v.powerW, fuel: v.fuel, gearbox: v.gearbox,
    sellerType: v.sellerType, sellerName: v.sellerName, market: v.market, city: v.city,
    postalCode: v.postalCode, description: v.description,
    daysListed: v.daysListed, firstListedAt: v.firstListedAt, priceChangeCount: v.priceChangeCount,
    currentPrice: price(v.currentPrice), firstPrice: price(v.firstPrice),
    photos: v.photos.map((p) => ({ url: photoUrl(p), localPath: p.localPath, position: p.position })),
    listings: v.listings.map((l) => ({
      sourceId: l.sourceId, url: l.url, title: l.title,
      firstSeenAt: l.firstSeenAt, delistedAt: l.delistedAt,
    })),
  };
}
