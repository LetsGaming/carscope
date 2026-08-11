import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { ErrorSchema, IdParams } from "../schemas.ts";
import { RUN_STATUS, type RunStatus } from "@carscope/collector";
import { NotFound } from "../errors.ts";

const SourceSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  markets: Type.Array(Type.String()),
  enabled: Type.Boolean(),
  status: Type.String(),
  finishedAt: Type.Union([Type.String(), Type.Null()]),
  fetched: Type.Integer(),
  consecutiveFailures: Type.Integer(),
  note: Type.Union([Type.String(), Type.Null()]),
});

/** A source is also idle before its first run and off when switched off. */
const SOURCE_STATE = { idle: "idle", off: "off" } as const;

const STATUS_REASON: Readonly<Record<string, string>> = {
  [SOURCE_STATE.idle]: "Noch nie abgefragt",
  [RUN_STATUS.ok]: "Zuletzt erfolgreich",
  [RUN_STATUS.blocked]: "Vom Portal abgewiesen, meist Bot-Schutz",
  [RUN_STATUS.error]: "Abfrage oder Auswertung fehlgeschlagen",
  [RUN_STATUS.skipped]: "Übersprungen, Suche für dieses Portal nicht ausdrückbar",
  [SOURCE_STATE.off]: "Aus",
};

type SourceStatus = RunStatus | (typeof SOURCE_STATE)[keyof typeof SOURCE_STATE];

const sources: FastifyPluginAsyncTypebox = async (app) => {
  const list = (): (typeof SourceSchema)["static"][] => {
    const health = new Map(app.runs.health().map((h) => [h.sourceId, h]));
    const enabled = app.sourceSettings.enabledIds(app.adapters.map((a) => a.id));
    return app.adapters.map((a) => {
      const h = health.get(a.id);
      const status: SourceStatus = enabled.has(a.id)
        ? (h?.status ?? SOURCE_STATE.idle)
        : SOURCE_STATE.off;
      return {
        id: a.id,
        label: a.label,
        markets: [...a.markets],
        enabled: enabled.has(a.id),
        status,
        finishedAt: h?.finishedAt ?? null,
        fetched: h?.fetched ?? 0,
        consecutiveFailures: h?.consecutiveFailures ?? 0,
        note: (status === SOURCE_STATE.off ? null : h?.note) ?? STATUS_REASON[status] ?? null,
      };
    });
  };

  app.get("/", { schema: { response: { 200: Type.Array(SourceSchema) } } }, async () => list());

  app.patch("/:id", {
    schema: {
      params: IdParams,
      body: Type.Object({ enabled: Type.Boolean() }),
      response: { 200: Type.Array(SourceSchema), 404: ErrorSchema },
    },
  }, async (req) => {
    if (!app.adapters.some((a) => a.id === req.params.id)) throw new NotFound("source");
    app.sourceSettings.setEnabled(req.params.id, req.body.enabled);
    return list();
  });
};

export default sources;
