import { BASE_CURRENCY, type Currency } from "@carscope/core";
import { getRow, type Db, type SqlRow } from "../db/index.ts";

interface RateRow extends SqlRow { rate: number }

/**
 * Rates are read at collection time and stored on the snapshot, so this only
 * has to answer "what was today's rate". A missing rate falls back to 1 and the
 * snapshot records that, rather than silently distorting the base amount later.
 */
export class FxRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  rateFor(currency: string, day = new Date().toISOString().slice(0, 10)): number {
    if (currency === BASE_CURRENCY) return 1;
    const row = getRow<RateRow>(this.#db.prepare(
      "SELECT rate FROM fx_rates WHERE currency = ? AND day <= ? ORDER BY day DESC LIMIT 1",
    ), currency, day);
    return row?.rate ?? 1;
  }

  put(currency: Currency, rate: number, day = new Date().toISOString().slice(0, 10)): void {
    this.#db.prepare(
      "INSERT INTO fx_rates (day, currency, rate) VALUES (?,?,?) ON CONFLICT DO UPDATE SET rate = excluded.rate",
    ).run(day, currency, rate);
  }
}
