import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import helmet from "@fastify/helmet";
import storage from "./plugins/db.ts";
import collector from "./plugins/collector.ts";
import scheduler from "./plugins/scheduler.ts";
import searches from "./routes/searches.ts";
import vehicles from "./routes/vehicles.ts";
import market, { searchScoped } from "./routes/market.ts";
import events from "./routes/events.ts";
import sources from "./routes/sources.ts";
import { HttpProblem } from "./errors.ts";
import type { Config } from "./config.ts";

export interface BuildOptions {
  readonly config: Config;
  readonly withScheduler?: boolean;
}

export async function build(opts: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: opts.config.logLevel, redact: ["req.headers.cookie", "req.headers.authorization"] },
    // Ajv coerces by default, and on a `integer | null` union that turns every
    // null into 0 — which silently rewrote saved search criteria. Bodies arrive
    // as typed JSON and need no coercion; query strings are parsed explicitly.
    ajv: { customOptions: { coerceTypes: false } },
  });

  // One place maps failures to responses; routes only throw.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpProblem) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
    if (error.validation) {
      return reply.code(400).send({ error: "invalid", message: error.message });
    }
    // Fastify's own errors already classify themselves. Treating every one of
    // them as a 500 hides client mistakes behind a server fault.
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      request.log.info({ err: error }, "rejected request");
      return reply.code(status).send({ error: error.code ?? "invalid", message: error.message });
    }
    request.log.error({ err: error }, "unhandled request failure");
    return reply.code(500).send({ error: "internal", message: "request failed" });
  });

  // The SPA and the stored photos are served from this origin, so it gets a real
  // policy rather than none: scripts and styles come from the build's own assets,
  // images may also come from a portal that a listing still hot-links, and the
  // page is never framed. Vite emits no inline script, so none is allowed.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  });
  if (opts.config.corsOrigin.length > 0) {
    await app.register(cors, { origin: [...opts.config.corsOrigin] });
  }

  await app.register(storage, {
    databaseFile: opts.config.databaseFile,
    defaultSources: opts.config.collect.enabledSources,
  });
  await app.register(collector, { config: opts.config });
  if (opts.withScheduler !== false) await app.register(scheduler, { config: opts.config });

  await app.register(searches, { prefix: "/api/searches" });
  await app.register(searchScoped, { prefix: "/api/searches" });
  await app.register(market, { prefix: "/api" });
  await app.register(events, { prefix: "/api" });
  await app.register(vehicles, { prefix: "/api/vehicles" });
  await app.register(sources, { prefix: "/api/sources" });

  // Stored photos are served from the data directory, never hot-linked back to
  // the portal: a delisted advert takes its images with it.
  await app.register(fastifyStatic, {
    root: resolve(opts.config.dataDir),
    prefix: "/media/",
    decorateReply: false,
    index: false,
    setHeaders: (res) => res.setHeader("cache-control", "public, max-age=604800, immutable"),
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  // In a container the API also serves the built SPA; in dev Vite proxies instead.
  const webRoot = opts.config.webRoot === null ? null : resolve(opts.config.webRoot);
  if (webRoot !== null && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, decorateReply: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "not_found", message: "unknown endpoint" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
