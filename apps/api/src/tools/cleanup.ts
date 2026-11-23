import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/index.ts";
import { SearchRepository } from "../repositories/searches.ts";
import { VehicleRepository } from "../repositories/vehicles.ts";
import { MarketService } from "../services/market.ts";
import { runCleanup, type CleanupReport, type MarketLine } from "../services/cleanup.ts";

/**
 * Brings the database in line with the current matching, holding and counting
 * rules. A dry run is the default: it works on a copy and prints what it would
 * do. `--apply` takes a backup next to the database, then changes the database.
 *
 *   npm run cleanup                     dry run on a copy
 *   npm run cleanup -- --apply          backup, then change the database
 *   npm run cleanup -- --db <file> --data <dir>
 *
 * Stop the server first when applying: a collection job that runs at the same
 * time would merge or hold cars under the cleanup.
 */
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const config = loadConfig();
const file = flag("--db") ?? config.databaseFile;
const dataDir = flag("--data") ?? (flag("--db") === undefined ? config.dataDir : null);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const copyTo = (target: string): void => {
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    source.prepare("VACUUM INTO ?").run(target);
  } finally {
    source.close();
  }
};

const workFile = apply ? file : join(tmpdir(), `carscope-cleanup-${stamp}.sqlite`);
if (apply) {
  const backup = `${file}.before-cleanup-${stamp}`;
  copyTo(backup);
  process.stdout.write(`backup: ${backup}\n`);
} else {
  copyTo(workFile);
}

const db = openDatabase(workFile);
try {
  const vehicles = new VehicleRepository(db);
  const report = runCleanup({
    vehicles, searches: new SearchRepository(db), market: new MarketService(vehicles), dataDir,
  });
  process.stdout.write(format(report, apply));
  if (apply) db.exec("VACUUM");
} finally {
  db.close();
  if (!apply) rmSync(workFile, { force: true });
}

function format(r: CleanupReport, applied: boolean): string {
  const row = (c: CleanupReport["before"]): string =>
    `${String(c.vehicles)} vehicles (${String(c.listed)} listed, ${String(c.held)} held, ${String(c.hidden)} hidden), `
    + `${String(c.listings)} adverts, ${String(c.snapshots)} price rows, `
    + `${String(c.photosOnDisk)} of ${String(c.photos)} photo rows linked to a file`;
  const lines = [
    applied ? "CLEANUP APPLIED" : "CLEANUP DRY RUN (a copy was changed, the database was not)",
    `before: ${row(r.before)}`,
    `names:  ${String(r.renamed)} cars got the make and model their title names`,
    `hold:   ${String(r.holdChanges)} cars changed their held state`,
    ...r.repairs.map((x) => `repair: ${x.moved ? "moved" : "nothing to move"}: ${x.why}`),
    `merge:  ${String(r.merged)} cars merged into another`,
    `photos: ${r.photosRelinked === null ? "skipped (no photo directory)" : `${String(r.photosRelinked)} rows linked to their file`}`,
    `prices: ${String(r.snapshotsDeleted)} price rows deleted (first and last of each run stay)`,
    `after:  ${row(r.after)}`,
    "",
    ...marketBlock("market before", r.marketBefore),
    ...marketBlock("market after", r.marketAfter),
  ];
  return `${lines.join("\n")}\n`;
}

function marketBlock(title: string, lines: readonly MarketLine[]): string[] {
  return lines.flatMap((m) => [
    `${title}, search "${m.search}": ${String(m.activeCars)} cars for sale, median ${String(m.medianNow)} EUR, `
    + `${String(m.carsInHistory)} cars in the history, confidence ${String(m.confidence)} of 5`,
    "  month     by car (new)  cars  by sighting (old)",
    ...m.months.map((x) =>
      `  ${x.month}  ${String(x.byCar).padStart(12)}  ${String(x.carsThatMonth).padStart(4)}  ${String(x.bySighting).padStart(17)}`),
  ]);
}
