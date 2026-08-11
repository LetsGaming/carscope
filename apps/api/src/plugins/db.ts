import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { openDatabase, type Db } from "../db/index.ts";
import { VehicleRepository } from "../repositories/vehicles.ts";
import { SearchRepository } from "../repositories/searches.ts";
import { RunRepository } from "../repositories/runs.ts";
import { FxRepository } from "../repositories/fx.ts";
import { SourceSettingsRepository } from "../repositories/sources.ts";
import { LookupRepository } from "../repositories/lookups.ts";
import { MarketService } from "../services/market.ts";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    vehicles: VehicleRepository;
    searches: SearchRepository;
    runs: RunRepository;
    fx: FxRepository;
    sourceSettings: SourceSettingsRepository;
    lookups: LookupRepository;
    market: MarketService;
  }
}

export default fp(async function storage(
  app: FastifyInstance,
  opts: { databaseFile: string; defaultSources: readonly string[] },
) {
  const db = openDatabase(opts.databaseFile);
  const vehicles = new VehicleRepository(db);

  app.decorate("db", db);
  app.decorate("vehicles", vehicles);
  app.decorate("searches", new SearchRepository(db));
  app.decorate("runs", new RunRepository(db));
  app.decorate("fx", new FxRepository(db));
  app.decorate("sourceSettings", new SourceSettingsRepository(db, opts.defaultSources));
  app.decorate("lookups", new LookupRepository(db));
  app.decorate("market", new MarketService(vehicles));

  app.addHook("onClose", async () => { db.close(); });
}, { name: "storage" });
