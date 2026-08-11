import { readFileSync } from "node:fs";
import { EMPTY_CRITERIA, wattToPs, type Criteria } from "@carscope/core";
import { ALL_ADAPTERS, applyUnsupported } from "@carscope/collector";

/**
 * Answers "why is this car not in my results" against a saved page.
 *
 * A listing can be lost at four points, and until now telling them apart meant
 * reading the HTML by hand: the parser did not see it, the gap filter rejected
 * it, or it reached the database and the search query excluded it. This runs the
 * first two exactly as a run would and prints every listing with the numbers the
 * third would compare against.
 *
 *   npm run explain -- autouncle data/debug/www.autouncle.de/<file>.html
 *   npm run explain -- autouncle <file>.html --year 1998-2002 --ps 280- --find 224706435
 */
const [, , adapterId, file, ...rest] = process.argv;
if (adapterId === undefined || file === undefined) {
  process.stderr.write("usage: npm run explain -- <adapter> <file.html> [--year a-b] [--ps a-b] [--km a-b] [--eur a-b] [--text \"...\"] [--find <id>]\n");
  process.exit(1);
}

const adapter = ALL_ADAPTERS.find((a) => a.id === adapterId);
if (adapter === undefined) {
  process.stderr.write(`unknown adapter: ${adapterId}\nknown: ${ALL_ADAPTERS.map((a) => a.id).join(", ")}\n`);
  process.exit(1);
}

const flag = (name: string): string | null => {
  const at = rest.indexOf(`--${name}`);
  return at === -1 ? null : rest[at + 1] ?? null;
};

/** "1998-2002", "280-", "-500" or "" all mean something different. */
function range(raw: string | null): { min: number | null; max: number | null } {
  if (raw === null) return { min: null, max: null };
  const [lo = "", hi = ""] = raw.split("-");
  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));
  return { min: num(lo), max: raw.includes("-") ? num(hi) : num(lo) };
}

const criteria: Criteria = {
  ...EMPTY_CRITERIA,
  text: flag("text") ?? "",
  registrationYear: range(flag("year")),
  powerPs: range(flag("ps")),
  mileageKm: range(flag("km")),
  priceEur: range(flag("eur")),
};

const body = readFileSync(file, "utf8");
const parsed = adapter.parseList(body, { url: `https://${adapter.id}.invalid/` });

if (!parsed.ok) {
  process.stdout.write(`PARSE FAILED: ${parsed.error.kind}: ${parsed.error.message}\n`);
  process.exit(2);
}

const { kept, dropped } = applyUnsupported(adapter, criteria, parsed.value.listings);
const wanted = flag("find");

process.stdout.write(`parsed ${String(parsed.value.listings.length)} listing(s)`);
process.stdout.write(parsed.value.note === undefined ? "\n" : `  (note: ${parsed.value.note})\n`);
process.stdout.write(`kept ${String(kept.length)}, dropped ${String(dropped.length)} by criteria the adapter cannot express\n\n`);

for (const l of kept) {
  const a = l.attributes;
  const mark = wanted !== null && l.sourceListingId === wanted ? " <<<" : "";
  const ps = a.powerW == null ? "?" : String(wattToPs(a.powerW));
  process.stdout.write(
    `  ${l.sourceListingId.padEnd(12)} ${String(a.make ?? "?")} ${String(a.model ?? "?")}`
    + ` | ${String(a.firstRegistration ?? "?")} | ${ps} PS | ${String(a.mileageKm ?? "?")} km`
    + ` | ${String(l.price)} EUR | ${String(a.market ?? "?")}${mark}\n`,
  );
}

for (const d of dropped) {
  process.stdout.write(`  DROPPED [${d.criterion}] ${d.title} -> found "${d.found}"\n`);
}

if (wanted !== null) {
  const inParsed = parsed.value.listings.some((l) => l.sourceListingId === wanted);
  const inKept = kept.some((l) => l.sourceListingId === wanted);
  process.stdout.write(
    `\n${wanted}: parser ${inParsed ? "found it" : "did NOT find it"}`
    + `, filter ${inKept ? "kept it" : "removed it"}\n`,
  );
  if (inKept) {
    process.stdout.write("It reaches the database, so anything missing after this is the search query or the run being cut short.\n");
  }
}
