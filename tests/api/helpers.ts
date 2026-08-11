import type { FastifyInstance } from "fastify";

export interface Run {
  sourceId: string; status: string; created: number;
  merged: number; photos: number; note: string | null;
}

/** Collection is a background job, so tests wait for it rather than the response. */
export async function finish(app: FastifyInstance): Promise<Run[]> {
  await app.collectionIdle();
  return app.currentJob()?.runs.map((r) => ({ ...r })) ?? [];
}
