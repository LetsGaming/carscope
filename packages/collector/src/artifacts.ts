import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_KEEP = 50;

let sequence = 0;

/**
 * A name for one fetch's artefacts: sortable, unique, and saying which page it
 * was. A file named after the host alone is overwritten by the next fetch of the
 * same host, which turns a trace into a snapshot of whatever happened last.
 */
export function artifactName(url: string, at: Date = new Date()): string {
  sequence = (sequence + 1) % 1_000;
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const counter = String(sequence).padStart(3, "0");
  return `${stamp}-${counter}--${pageSlug(url)}`;
}

const MAX_SLUG_CHARS = 60;

/** Enough of the path and query to tell two fetches of one host apart. */
function pageSlug(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unknown";
  }
  const slug = `${parsed.pathname}-${parsed.search}`
    .replace(/[^\w]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug === "" ? "root" : slug.slice(0, MAX_SLUG_CHARS).replace(/-$/, "");
}

export async function artifactDir(root: string, host: string): Promise<string> {
  const dir = join(root, host);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Keeps the newest artefacts and deletes the rest. Retention belongs here rather
 * than in the naming: a debug directory that grows without bound is its own
 * problem, and one that overwrites is not a record at all.
 */
export async function pruneArtifacts(dir: string, keep = DEFAULT_KEEP): Promise<number> {
  const entries = await readdir(dir).catch(() => null);
  if (entries === null) return 0;

  const dated = await Promise.all(entries.map(async (name) => ({
    name,
    at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0,
  })));

  const doomed = dated.sort((a, b) => b.at - a.at).slice(keep);
  for (const { name } of doomed) await rm(join(dir, name), { force: true }).catch(() => null);
  return doomed.length;
}
