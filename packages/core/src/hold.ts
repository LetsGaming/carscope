import { textTokens } from "./criteria.ts";

/**
 * Why a stored car is kept out of lists and statistics. It is recomputed from
 * what is known about the car, so a car whose price turns real is released by
 * the next price it reports, without anyone touching it.
 */
export const HOLD = {
  /** Someone wants to buy a car. The advert describes a search, not a car. */
  wanted: "wanted",
  /** A price that is not an asking price: 1 €, or "Preis nur Platzhalter" in the text. */
  placeholderPrice: "placeholder_price",
} as const;

export type HoldReason = (typeof HOLD)[keyof typeof HOLD];

export const toHoldReason = (value: string | null): HoldReason | null =>
  value === HOLD.wanted || value === HOLD.placeholderPrice ? value : null;

/** No used car is sold for less. Kleinanzeigen shows "VB" as 1 €. */
export const PLACEHOLDER_PRICE_BELOW_EUR = 100;

const WANTED_DESCRIPTION_CHARS = 300;
/** How far after "suche" the searched car has to be named. */
const WANTED_REACH_CHARS = 40;
const MIN_WORD_CHARS = 4;

export interface HoldInput {
  readonly titles: readonly string[];
  readonly urls: readonly string[];
  readonly description: string | null;
  readonly make: string;
  readonly model: string;
  /** Latest asking price in the base currency; null before any price is known. */
  readonly priceBase: number | null;
}

/** "[Suche] Nissan Skyline", "Gesuch: ...", "Ankauf ..." as the start of a title. */
const WANTED_TITLE = /^\W*(?:such(?:e|en)|gesuch|ankauf|wir\s+kaufen)\b/i;
/** The same words as the first part of a Kleinanzeigen URL slug. */
const WANTED_SLUG = /\/s-anzeige\/-?(?:suche|suchen|gesuch|ankauf)-/i;
const WANTED_DESCRIPTION_START = /^\W*(?:ankauf|wir\s+kaufen)\b/i;
const SEEKING = /\b(?:ich\s+|wir\s+)?such(?:e|en)\b/gi;
/** "suche keinen Tausch" is a seller too. */
const NEGATED = /^\s*(?:kein|keine|keinen|nicht|nichts)\b/i;
/** "suche neuen Besitzer für meinen Nissan" is a seller. */
const OFFERING = /\bneu(?:en|es|e)?\s+(?:besitzer|zuhause|halter|liebhaber|eigentümer|fahrer)|\b(?:käufer|abnehmer|interessent)/i;

/**
 * The first match wins and the order matters: a wanted ad with a placeholder
 * price is a wanted ad, and that one is never released.
 */
export function holdReason(input: HoldInput): HoldReason | null {
  if (isWanted(input)) return HOLD.wanted;
  if (isPlaceholderPrice(input.priceBase, input.description)) return HOLD.placeholderPrice;
  return null;
}

function isWanted(input: HoldInput): boolean {
  if (input.titles.some((t) => WANTED_TITLE.test(t))) return true;
  if (input.urls.some((u) => WANTED_SLUG.test(u))) return true;

  const text = (input.description ?? "").slice(0, WANTED_DESCRIPTION_CHARS);
  if (WANTED_DESCRIPTION_START.test(text)) return true;

  const named = new Set(
    [input.make, input.model, ...input.titles]
      .flatMap((s) => textTokens(s))
      .filter((w) => w.length >= MIN_WORD_CHARS),
  );
  for (const hit of text.matchAll(SEEKING)) {
    const after = text.slice(hit.index + hit[0].length, hit.index + hit[0].length + WANTED_REACH_CHARS);
    if (NEGATED.test(after) || OFFERING.test(after)) continue;
    if (textTokens(after).some((w) => named.has(w))) return true;
  }
  return false;
}

/**
 * Only the price the seller says is not one, or one no used car has. A pattern
 * such as 44444 is a price some sellers pick on purpose, so digits alone decide
 * nothing.
 */
const PLACEHOLDER_PRICE_TEXT = /preis[^.\n]{0,60}platzhalter|platzhalter[^.\n]{0,60}preis/i;

function isPlaceholderPrice(price: number | null, description: string | null): boolean {
  if (PLACEHOLDER_PRICE_TEXT.test(description ?? "")) return true;
  if (price === null) return false;
  return price < PLACEHOLDER_PRICE_BELOW_EUR;
}
