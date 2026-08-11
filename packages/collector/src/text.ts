import { psToWatt, kwToWatt } from "@carscope/core";

/**
 * German-locale parsing shared by the portal adapters. All three render the same
 * conventions — thousands dots, "206 kW (280 PS)", "EZ 05/1999" — so this lives
 * once rather than in each parser.
 */

/** "162.500 €" and "103.000 km" both mean the same thing to a German reader. */
export function germanNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = /-?\d[\d.]*(?:,\d+)?/.exec(text.replace(/\u00a0/g, " "));
  if (!match) return null;
  const value = Number.parseFloat(match[0].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * Portals print both units: "206 kW (280 PS)". The PS figure is the advertised
 * one, so it wins — reading the kW and converting back would turn 280 into 280
 * only by luck.
 */
export function powerLabelToWatt(text: string | null | undefined): number | null {
  if (!text) return null;
  const clean = text.replace(/\u00a0/g, " ");
  const ps = /(\d[\d.]*)\s*PS/i.exec(clean);
  if (ps) {
    const value = germanNumber(ps[1]);
    if (value !== null && value > 0) return psToWatt(value);
  }
  const kw = /(\d[\d.]*)\s*kW/i.exec(clean);
  if (kw) {
    const value = germanNumber(kw[1]);
    if (value !== null && value > 0) return kwToWatt(value);
  }
  return null;
}

/**
 * Accepts "EZ 05/1999", "05-1999", "1999-06" and "1999". Which side carries the
 * year decides the order, because portals disagree: AutoScout24 reports MM-YYYY
 * and schema.org dates are YYYY-MM.
 */
export function registrationToIso(text: string | null | undefined): string | null {
  if (!text) return null;

  const yearFirst = /\b((?:19|20)\d{2})[/-](\d{1,2})\b/.exec(text);
  if (yearFirst) return `${yearFirst[1] ?? ""}-${(yearFirst[2] ?? "1").padStart(2, "0")}`;

  const monthFirst = /\b(\d{1,2})[/-]((?:19|20)\d{2})\b/.exec(text);
  if (monthFirst) return `${monthFirst[2] ?? ""}-${(monthFirst[1] ?? "1").padStart(2, "0")}`;

  const yearOnly = /\b(?:19|20)\d{2}\b/.exec(text);
  return yearOnly ? yearOnly[0] : null;
}

/**
 * German classifieds date a listing relatively — "Heute, 09:12", "Gestern,
 * 15:40" — or absolutely. Returns the day the advert went online.
 */
export function postedAt(text: string | null | undefined, now = new Date()): string | null {
  if (!text) return null;

  const absolute = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/.exec(text);
  if (absolute) {
    const [, day, month, year] = absolute;
    return `${year ?? ""}-${(month ?? "").padStart(2, "0")}-${(day ?? "").padStart(2, "0")}`;
  }

  const relative = /\b(Heute|Gestern|Vorgestern)\b/i.exec(text);
  if (relative === null) return null;

  const back = { heute: 0, gestern: 1, vorgestern: 2 }[(relative[1] ?? "").toLowerCase()] ?? 0;
  const day = new Date(now);
  day.setDate(day.getDate() - back);
  return day.toISOString().slice(0, 10);
}

export interface Place {
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly country: string | null;
}

/** "AT-4030 Linz" and "57520 Steinebach (Sieg)" are the two shapes in use. */
export function parsePlace(text: string | null | undefined): Place {
  if (!text) return { postalCode: null, city: null, country: null };
  const match = /(?:([A-Z]{2})-)?(\d{4,5})\s+(.+)/.exec(text.trim());
  if (!match) return { postalCode: null, city: text.trim() || null, country: null };
  return {
    country: match[1] ?? null,
    postalCode: match[2] ?? null,
    city: match[3]?.trim() ?? null,
  };
}

const DECODE: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/g, " "], [/&amp;/g, "&"], [/&lt;/g, "<"], [/&gt;/g, ">"],
  [/&quot;/g, '"'], [/&#0?39;/g, "'"], [/&euro;/g, "€"], [/&szlig;/g, "ß"],
];

export function decodeEntities(text: string): string {
  let out = text;
  for (const [pattern, replacement] of DECODE) out = out.replace(pattern, replacement);
  return out.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

const BREAKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<br\s*\/?>/gi, "\n"],
  [/<\/(p|div|li|h[1-6]|tr)>/gi, "\n"],
];

/**
 * Seller text with its line breaks intact. A classified ad is usually a list —
 * one modification per line — and collapsing it to a paragraph destroys the
 * only structure it had.
 */
export function richText(html: string): string {
  let out = html.replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ");
  for (const [pattern, replacement] of BREAKS) out = out.replace(pattern, replacement);
  return decodeEntities(out.replace(/<[^>]+>/g, ""))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Visible text of a markup fragment, with scripts, styles and tags removed. */
export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

/** Splits a document on a repeated opening tag, keeping each block whole. */
export function blocksBy(html: string, pattern: RegExp): string[] {
  const starts = [...html.matchAll(pattern)].map((m) => m.index);
  return starts.map((start, i) => html.slice(start, starts[i + 1] ?? html.length));
}

/**
 * Markup of the element carrying a data-testid, close tag included. Counting the
 * tag properly matters because these nodes wrap inline SVG icons — a fixed-size
 * window reads path data instead of the seller's address.
 */
export function elementByTestId(html: string, testId: string): string | null {
  const marker = html.indexOf(`data-testid="${testId}"`);
  if (marker === -1) return null;
  const start = html.lastIndexOf("<", marker);
  if (start === -1) return null;

  const name = /^<([a-zA-Z][\w-]*)/.exec(html.slice(start))?.[1];
  if (!name) return null;

  const open = new RegExp(`<${name}\\b`, "g");
  const close = new RegExp(`</${name}>`, "g");
  open.lastIndex = start + 1;
  close.lastIndex = start + 1;

  let depth = 1;
  while (depth > 0) {
    const next = close.exec(html);
    if (!next) return html.slice(start);
    let opened = 0;
    let hit = open.exec(html);
    while (hit && hit.index < next.index) {
      opened += 1;
      hit = open.exec(html);
    }
    depth += opened - 1;
    if (depth === 0) return html.slice(start, next.index + next[0].length);
    open.lastIndex = next.index + next[0].length;
    close.lastIndex = next.index + next[0].length;
  }
  return html.slice(start);
}

export function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match?.[1] ?? null;
}

const DESCRIPTION_SOURCES: ReadonlyArray<RegExp> = [
  /<meta[^>]+property="og:description"[^>]+content="([^"]{40,})"/i,
  /<meta[^>]+name="description"[^>]+content="([^"]{40,})"/i,
];

/**
 * Seller text, from wherever a portal keeps it. A container id is tried first
 * because the meta tags are usually a truncated teaser.
 */
export function extractDescription(html: string, containerId?: string): string | null {
  if (containerId !== undefined) {
    const marker = html.indexOf(`id="${containerId}"`);
    if (marker !== -1) {
      const start = html.indexOf(">", marker);
      const tag = /<(\w+)[^>]*$/.exec(html.slice(Math.max(0, marker - 200), marker))?.[1] ?? "div";
      const end = html.indexOf(`</${tag}>`, start);
      if (start !== -1 && end !== -1) {
        const text = richText(html.slice(start + 1, end));
        if (text.length > 20) return text;
      }
    }
  }
  for (const pattern of DESCRIPTION_SOURCES) {
    const match = pattern.exec(html);
    const text = match?.[1];
    if (text !== undefined) return decodeEntities(text).replace(/\s+/g, " ").trim();
  }
  return null;
}

const IMAGE_ATTRIBUTES = /(?:src|data-src|data-imgsrc|data-lazy-src|data-original|content)="(https:\/\/[^"]+)"/g;
const SRCSET = /srcset="([^"]+)"/g;
// JSON in a script tag escapes its slashes, so the URL is unescaped after matching.
const JSON_IMAGE = /"(?:image|imageUrl|contentUrl|url)"\s*:\s*"(https:[^"]+)"/g;
// Galleries often set the picture as a CSS background rather than an <img>.
const CSS_URL = /url\(\s*['"]?(https:\/\/[^'")\s]+)/g;

/**
 * Gallery images, from wherever the page keeps them. A lazy-loading gallery only
 * ever writes `src` when a picture is about to be shown, and the collector
 * aborts image requests, so `src` alone finds exactly one photo — the cover.
 */
export function imageUrls(html: string, host: RegExp): string[] {
  const found: string[] = [];

  for (const match of html.matchAll(IMAGE_ATTRIBUTES)) {
    if (match[1] !== undefined) found.push(match[1]);
  }
  for (const match of html.matchAll(SRCSET)) {
    for (const candidate of (match[1] ?? "").split(",")) {
      const url = candidate.trim().split(/\s+/)[0];
      if (url !== undefined && url.startsWith("https://")) found.push(url);
    }
  }
  for (const match of html.matchAll(JSON_IMAGE)) {
    if (match[1] !== undefined) found.push(match[1].replace(/\\\//g, "/"));
  }
  for (const match of html.matchAll(CSS_URL)) {
    if (match[1] !== undefined) found.push(match[1]);
  }

  // The same asset appears at several sizes; keep one entry per picture.
  const byAsset = new Map<string, string>();
  for (const raw of found) {
    const url = raw.replace(/['")\\]+$/, "");
    if (!host.test(url)) continue;
    const asset = url.split("?")[0] ?? url;
    if (!byAsset.has(asset)) byAsset.set(asset, url);
  }
  return [...byAsset.values()];
}
