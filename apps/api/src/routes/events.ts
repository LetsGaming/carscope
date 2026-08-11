import type { FastifyPluginAsyncTypebox } from "@fastify/type-provider-typebox";

const HEARTBEAT_MS = 20_000;
const TICK_MS = 500;

/**
 * Progress is pushed rather than polled, so a source that finishes early shows
 * its offers immediately instead of waiting for the slowest portal. The stream
 * is a snapshot diff over the job the collector already maintains, which keeps
 * it a read model with no second source of truth.
 */
const events: FastifyPluginAsyncTypebox = async (app) => {
  const open = new Set<() => void>();

  // Registered once, not per connection. A stream killed by a restart shows up
  // as ECONNRESET in whatever is proxying; ending it first makes shutdown clean.
  app.addHook("onClose", async () => {
    for (const stop of open) stop();
    open.clear();
  });

  app.get("/events", (req, reply) => {
    // Hijacking hands the socket over: Fastify stops tracking the reply, so an
    // open stream can never hold up a graceful shutdown.
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let previous = "";
    const tick = setInterval(() => {
      const job = app.currentJob();
      const snapshot = JSON.stringify(job);
      if (snapshot === previous) return;
      previous = snapshot;
      send("job", job);
    }, TICK_MS);

    const heartbeat = setInterval(() => { reply.raw.write(": keep-alive\n\n"); }, HEARTBEAT_MS);
    tick.unref();
    heartbeat.unref();

    send("job", app.currentJob());

    const stop = (): void => {
      clearInterval(tick);
      clearInterval(heartbeat);
      open.delete(stop);
      reply.raw.end();
    };
    open.add(stop);
    req.raw.on("close", stop);
  });
};

export default events;
