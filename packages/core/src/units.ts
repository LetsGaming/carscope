/** DIN 70020: 1 metric horsepower = 735.49875 W. */
export const WATT_PER_PS = 735.49875;
export const WATT_PER_KW = 1000;

/**
 * Engine power is stored in watts. Storing kilowatts rounds 206 PS to 152 kW and
 * back to 207 PS, and a car advertised as a 206 PS GT-T should never render as
 * anything else. Watts round-trip both units exactly.
 */
export const psToWatt = (ps: number): number => Math.round(ps * WATT_PER_PS);
export const kwToWatt = (kw: number): number => Math.round(kw * WATT_PER_KW);
export const wattToPs = (w: number): number => Math.round(w / WATT_PER_PS);
export const wattToKw = (w: number): number => Math.round(w / WATT_PER_KW);

export const psToKw = (ps: number): number => wattToKw(psToWatt(ps));
export const kwToPs = (kw: number): number => wattToPs(kwToWatt(kw));

export const CURRENCY = { eur: "EUR", sek: "SEK", chf: "CHF", dkk: "DKK", pln: "PLN" } as const;
export type Currency = (typeof CURRENCY)[keyof typeof CURRENCY];
export const CURRENCIES: readonly Currency[] = Object.values(CURRENCY);

const CURRENCY_CODES = new Set<string>(CURRENCIES);

/** Narrows an untrusted currency code, so a stored or upstream value is checked once. */
export function toCurrency(code: string | null | undefined): Currency | null {
  if (code === null || code === undefined) return null;
  const upper = code.trim().toUpperCase();
  return CURRENCY_CODES.has(upper) ? (upper as Currency) : null;
}

export const BASE_CURRENCY: Currency = CURRENCY.eur;

/**
 * Money is stored in minor units of its original currency plus the base-currency
 * amount at the rate observed when the snapshot was taken, so later FX moves never
 * rewrite history.
 */
export interface Money {
  readonly amount: number;
  readonly currency: Currency;
  readonly baseAmount: number;
  readonly rate: number;
}

export function convert(amount: number, currency: Currency, rateToBase: number): Money {
  return {
    amount,
    currency,
    baseAmount: Math.round(amount * rateToBase),
    rate: rateToBase,
  };
}
