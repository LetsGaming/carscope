import { HOLD, modelTerms, psToWatt, type Criteria, type Period } from "@carscope/core";
import { splitMakeModel } from "@carscope/collector";
import type { SqlRow } from "../db/index.ts";

export interface ResultRow extends SqlRow {
  id: string; make: string; model: string; variant: string | null;
  body_style: string | null; first_registration: string | null;
  mileage_km: number | null; power_w: number | null;
  fuel: string | null; gearbox: string | null;
  seller_type: string | null; seller_name: string | null;
  market: string; city: string | null; postal_code: string | null;
  current_price: number; first_price: number | null; held_reason: string | null;
  price_changes: number; days_listed: number | null;
  photo_count: number; thumb_path: string | null; thumb_url: string | null;
  first_listed_at: string | null; delisted_at: string | null; days_listed_exact: number;
  sources: string | null; listing_url: string | null;
}

export type Param = string | number;

/**
 * A car removed by hand stays out of every list, feed and statistic, whether or
 * not its adverts are still live. `delisted_at` cannot carry this: a re-scrape
 * clears it whenever the advert is seen again.
 */
export const HIDDEN_EXCLUDED = "v.hidden_at IS NULL";

/**
 * A held car is stored but not aggregated: a wanted ad is no car, and a car with
 * a placeholder price has no price yet. Unlike a hidden car it releases itself.
 */
export const HELD_EXCLUDED = "v.held_reason IS NULL";

/** A wanted ad never takes part in matching: it describes a search, not a car. */
export const NOT_WANTED = `(v.held_reason IS NULL OR v.held_reason <> '${HOLD.wanted}')`;

const YEAR ="CAST(substr(v.first_registration, 1, 4) AS INTEGER)";

/** The words a search is made of: the make and model fields plus the free text. */
export const searchWords = (c: Criteria): string[] =>
  [c.make, c.model, c.text].filter(Boolean).join(" ").trim().split(/\s+/).filter(Boolean);

/**
 * Where one search word has to appear. The same shape decides both what a query
 * returns and, in the period statistics, which cars carry a word, so it is
 * written once.
 */
export function textClause(word: string): { sql: string; params: Param[] } {
  const like = `%${escapeLike(word)}%`;
  return {
    sql: `(
      v.make || ' ' || v.model || ' ' || COALESCE(v.variant, '') LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM listings l WHERE l.vehicle_id = v.id AND l.title LIKE ? ESCAPE '\\')
    )`,
    params: [like, like],
  };
}

/**
 * Turns neutral criteria into a parameterised WHERE clause. Every value is bound,
 * never interpolated, and the clause is the only place criteria become SQL.
 */
export function buildFilter(
  c: Criteria,
  activeOnly: boolean,
  periods: readonly Period[] = [],
  held = false,
  lenient = false,
): { where: string; params: Param[] } {
  const clauses: string[] = [HIDDEN_EXCLUDED, held ? "v.held_reason IS NOT NULL" : HELD_EXCLUDED];
  const params: Param[] = [];

  if (activeOnly) clauses.push("v.delisted_at IS NULL");

  for (const word of searchWords(c)) {
    const said = textClause(word);
    const period = periods.find((p) => p.token === word.toLowerCase());

    if (period === undefined) {
      clauses.push(said.sql);
      params.push(...said.params);
    } else {
      // The word names a period, so a car built in it counts even when the
      // advert never says the word. Cars that do say it still match, whatever
      // their registration year, so this only ever adds.
      clauses.push(`(${said.sql} OR (${YEAR} BETWEEN ? AND ?))`);
      params.push(...said.params, period.fromYear, period.toYear);
    }
  }

  // The words above may be met by any listing's title, which lets a car with
  // another model (a Stagea advertised as Skyline gear) through. The vehicle's
  // own model has the last word.
  //
  // The web client sends make, model and text as one string, so the model is
  // read from the same split the collector uses, not from `c.model` alone.
  const searchedModel = splitMakeModel(c).model;
  const terms = searchedModel === null ? [] : modelTerms(searchedModel);
  if (terms.length > 0) {
    clauses.push(`(${terms.map(() => "v.model LIKE ? ESCAPE '\\'").join(" OR ")})`);
    params.push(...terms.map((t) => `%${escapeLike(t)}%`));
  }

  // A car that does not state a value cannot be placed in a range. Strictly it is
  // left out; `lenient` lets it through, so the number left out can be counted.
  const between = (column: string, min: number | null, max: number | null, scale = (n: number): number => n): void => {
    const unknown = lenient ? `${column} IS NULL OR ` : "";
    if (min !== null) { clauses.push(`(${unknown}${column} >= ?)`); params.push(scale(min)); }
    if (max !== null) { clauses.push(`(${unknown}${column} <= ?)`); params.push(scale(max)); }
  };

  between("v.mileage_km", c.mileageKm.min, c.mileageKm.max);
  between("v.power_w", c.powerPs.min, c.powerPs.max, psToWatt);
  between(YEAR, c.registrationYear.min, c.registrationYear.max);

  if (c.priceEur.min !== null) { clauses.push("latest.amount >= ?"); params.push(c.priceEur.min); }
  if (c.priceEur.max !== null) { clauses.push("latest.amount <= ?"); params.push(c.priceEur.max); }

  const equals = (column: string, value: string | null): void => {
    if (value !== null && value !== "") { clauses.push(`${column} = ?`); params.push(value); }
  };
  equals("v.fuel", c.fuel);
  equals("v.gearbox", c.gearbox);
  equals("v.seller_type", c.sellerType);
  equals("v.body_style", c.bodyStyle);

  if (c.markets.length > 0) {
    clauses.push(`v.market IN (${c.markets.map(() => "?").join(",")})`);
    params.push(...c.markets);
  }
  if (c.excludeDamaged) clauses.push("(v.damaged IS NULL OR v.damaged = 0)");

  return { where: clauses.join(" AND "), params };
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (m) => `\\${m}`);
