import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ErrorSchema, IdParams, SearchBody, SearchSchema, toSearchDto } from "../schemas.ts";
import { NotFound } from "../errors.ts";
import { assertRangesValid } from "../validation.ts";
import { SCOPE } from "../services/api-keys.ts";

const searches: FastifyPluginAsyncTypebox = async (app) => {
  app.get("/", {
    schema: { response: { 200: Type.Array(SearchSchema) } },
  }, async () => app.searches.list().map(toSearchDto));

  app.post("/", {
    schema: { body: SearchBody, response: { 201: SearchSchema, 400: ErrorSchema } },
    preHandler: app.requireScope(SCOPE.write),
  }, async (req, reply) => {
    assertRangesValid(req.body.criteria);
    reply.code(201);
    return toSearchDto(app.searches.create(req.body.name, req.body.criteria));
  });

  app.put("/:id", {
    schema: { params: IdParams, body: SearchBody, response: { 200: SearchSchema, 404: ErrorSchema } },
    preHandler: app.requireScope(SCOPE.write),
  }, async (req) => {
    assertRangesValid(req.body.criteria);
    const updated = app.searches.update(req.params.id, req.body.name, req.body.criteria);
    if (updated === null) throw new NotFound("search");
    return toSearchDto(updated);
  });

  app.delete("/:id", {
    schema: { params: IdParams, response: { 204: Type.Null(), 404: ErrorSchema } },
    preHandler: app.requireScope(SCOPE.write),
  }, async (req, reply) => {
    if (!app.searches.remove(req.params.id)) throw new NotFound("search");
    reply.code(204);
    return null;
  });

  app.post("/:id/collect", {
    schema: {
      params: IdParams,
      response: {
        202: Type.Object({ id: Type.String(), total: Type.Integer(), done: Type.Integer() }),
        404: ErrorSchema,
      },
    },
    preHandler: app.requireScope(SCOPE.write),
  }, async (req, reply) => {
    const search = app.searches.findById(req.params.id);
    if (search === null) throw new NotFound("search");
    const job = app.startCollection(search, true);
    reply.code(202);
    return { id: job.id, total: job.total, done: job.done };
  });
};

export default searches;
