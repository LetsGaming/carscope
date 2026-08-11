import { failure, FAILURE, err, ok, type Result } from "@carscope/core";

/**
 * Portals change their markup constantly but rarely break their structured data,
 * so every adapter reads JSON-LD or an embedded state blob first and only falls
 * back to selectors. These helpers are pure so they can be tested against saved
 * fixtures without a network.
 */

const LD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  for (const match of html.matchAll(LD_RE)) {
    const raw = match[1];
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}

export function embeddedJson(html: string, variableName: string): Result<unknown> {
  const marker = html.indexOf(variableName);
  if (marker === -1) return err(failure(FAILURE.parse, `${variableName} not present`));
  const start = html.indexOf("{", marker);
  if (start === -1) return err(failure(FAILURE.parse, `${variableName} has no object`));

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return ok(JSON.parse(html.slice(start, i + 1)));
        } catch (e) {
          return err(failure(FAILURE.parse, e instanceof Error ? e.message : "bad json"));
        }
      }
    }
  }
  return err(failure(FAILURE.parse, `${variableName} object never closed`));
}

/**
 * The five entities a server-rendered page uses when it embeds JSON in an
 * attribute or a script. Enough to read such a payload; not an HTML parser.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&apos;": "'",
};

export function decodeEntities(html: string): string {
  return html.replace(/&(?:quot|amp|lt|gt|#39|apos);/g, (m) => ENTITIES[m] ?? m);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pick(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const key of path) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const digits = value.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
