import { BASE_CURRENCY, DAY_MS, MINUTE_MS, wattToKw, wattToPs } from "@carscope/core";

export { wattToKw, wattToPs };

const LOCALE = "de-DE";

const EUR = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: BASE_CURRENCY,
  maximumFractionDigits: 0,
});
const NUM = new Intl.NumberFormat(LOCALE);
const PCT = new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 1 });

export const eur = (v: number): string => EUR.format(Math.round(v));
export const num = (v: number): string => NUM.format(Math.round(v));
export const pct = (v: number): string => (v > 0 ? "+" : "") + PCT.format(v);

const MINUTES_PER_HOUR = 60;

export function registration(iso: string | null): string {
  if (!iso) return "–";
  const [year, month] = iso.split("-");
  return month ? `${month}/${year?.slice(2) ?? ""}` : (year ?? "–");
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "nie";
  const elapsed = Date.now() - Date.parse(iso);
  const minutes = Math.round(elapsed / MINUTE_MS);
  if (minutes < MINUTES_PER_HOUR) return `vor ${minutes} Min.`;
  if (elapsed < DAY_MS) return `vor ${Math.round(minutes / MINUTES_PER_HOUR)} Std.`;
  return `vor ${Math.round(elapsed / DAY_MS)} Tagen`;
}

/**
 * A listing states where the car is; the obvious next question is how far that
 * is. OpenStreetMap needs no key and no account.
 */
export function mapsUrl(place: {
  postalCode: string | null;
  city: string | null;
  market: string;
}): string | null {
  const query = [place.postalCode, place.city, place.market].filter(Boolean).join(" ");
  if (query.trim() === "") return null;
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
}
