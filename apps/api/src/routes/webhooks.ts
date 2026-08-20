import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { randomBytes } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { ErrorSchema, IdParams } from "../schemas.ts";
import { NotFound } from "../errors.ts";
import { SCOPE } from "../services/api-keys.ts";
import type { WebhookRow } from "../repositories/webhooks.ts";

const WebhookSchema = Type.Object({
  id: Type.String(),
  searchId: Type.String(),
  url: Type.String(),
  enabled: Type.Boolean(),
  notifiedThrough: Type.Integer(),
  lastDeliveryAt: Type.Union([Type.String(), Type.Null()]),
  lastStatus: Type.Union([Type.Integer(), Type.Null()]),
  consecutiveFailures: Type.Integer(),
});

const WebhookBody = Type.Object({
  searchId: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1, maxLength: 2000 }),
});

/** The secret is shown only here, at creation, the same way an issued API key is. */
const CreatedWebhookSchema = Type.Intersect([WebhookSchema, Type.Object({ secret: Type.String() })]);

const toDto = (row: WebhookRow): Static<typeof WebhookSchema> => ({
  id: row.id, searchId: row.search_id, url: row.url, enabled: row.enabled === 1,
  notifiedThrough: row.notified_through, lastDeliveryAt: row.last_delivery_at,
  lastStatus: row.last_status, consecutiveFailures: row.consecutive_failures,
});

/**
 * All admin-only: registering a webhook is telling carscope to POST to a URL
 * of the caller's choosing, which is exactly the capability an anonymous or
 * merely-`write`-scoped caller must not have.
 */
const webhooks: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/", {
    schema: { response: { 200: Type.Array(WebhookSchema) } },
    preHandler: app.requireScope(SCOPE.admin),
  }, async () => app.webhooks.list().map(toDto));

  app.post("/", {
    schema: { body: WebhookBody, response: { 201: CreatedWebhookSchema, 404: ErrorSchema } },
    preHandler: app.requireScope(SCOPE.admin),
  }, async (req, reply) => {
    if (app.searches.findById(req.body.searchId) === null) throw new NotFound("search");
    const secret = randomBytes(24).toString("base64url");
    const row = app.webhooks.insert({ searchId: req.body.searchId, url: req.body.url, secret });
    reply.code(201);
    return { ...toDto(row), secret };
  });

  app.delete("/:id", {
    schema: { params: IdParams, response: { 204: Type.Null(), 404: ErrorSchema } },
    preHandler: app.requireScope(SCOPE.admin),
  }, async (req, reply) => {
    if (!app.webhooks.remove(req.params.id)) throw new NotFound("webhook");
    reply.code(204);
    return null;
  });
};

export default webhooks;
