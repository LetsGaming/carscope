import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { MINUTE_MS } from "@carscope/core";
import type { Config } from "../config.ts";

/** Ticks six times per configured interval so a source is never much overdue. */
const TICKS_PER_INTERVAL = 6;

/**
 * Adapters declare their own minIntervalMs, so the loop ticks often and lets
 * isDue decide. A tick never overlaps itself.
 */
export default fp(async function scheduler(app: FastifyInstance, opts: { config: Config }) {
  const tickMs = Math.max(1, Math.floor(opts.config.collect.intervalMinutes / TICKS_PER_INTERVAL))
    * MINUTE_MS;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const search of app.searches.list()) {
        app.startCollection(search, false);
        await app.collectionIdle();
      }
    } catch (e) {
      app.log.error({ err: e }, "scheduled collection failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), tickMs);
  timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); });
}, { name: "scheduler", dependencies: ["collector"] });
