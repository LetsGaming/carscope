import type { Currency } from "./units.ts";

/**
 * Every layer that names a fuel, a gearbox or a country reads it from here.
 * The lists and the parsers are derived from the same const object, so a value
 * added below reaches the API schema, the SQL reader and the UI at once rather
 * than needing the same list edited in four places.
 */
const valuesOf = <T extends Readonly<Record<string, string>>>(
  source: T,
): readonly T[keyof T][] => Object.values(source) as T[keyof T][];

/** Narrows an untrusted string to a member of the set, or null. */
const parser = <T extends Readonly<Record<string, string>>>(
  source: T,
  normalise: (raw: string) => string = (raw) => raw,
): ((value: string | null | undefined) => T[keyof T] | null) => {
  const allowed = new Set<string>(Object.values(source));
  return (value) => {
    if (value === null || value === undefined) return null;
    const candidate = normalise(value.trim());
    return allowed.has(candidate) ? (candidate as T[keyof T]) : null;
  };
};

/**
 * How a make or model is written down.
 *
 * Portals shout: one advert stored "NISSAN SKYLINE" while the next stored
 * "Nissan Skyline", and the list showed both. Dedup was never affected, since
 * identity keys are case-folded, but the same car read as two different cars.
 *
 * Only a word that is entirely upper case is touched, and only when it is long
 * enough that the shouting is style rather than the name: BMW, VW, MG, DS, GMC
 * and RAM are how those makes are actually written, while NISSAN and PORSCHE are
 * not. A word carrying a digit is left exactly as found, because that is where
 * the meaning lives: R34, RB25DET, 911, 320d.
 *
 * Hyphenated names are judged one part at a time, so GT-R keeps both letters
 * while MERCEDES-BENZ becomes Mercedes-Benz and C-KLASSE becomes C-Klasse.
 */
const SHOUTED_ACRONYM_MAX = 3;

const settle = (part: string): string =>
  part.length <= SHOUTED_ACRONYM_MAX ? part : part.charAt(0) + part.slice(1).toLowerCase();

export function displayName(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => {
      if (word !== word.toUpperCase()) return word;
      if (/\d/.test(word)) return word;
      return word.split("-").map(settle).join("-");
    })
    .join(" ");
}

export const MARKET = {
  de: "DE", at: "AT", nl: "NL", be: "BE", lu: "LU",
  it: "IT", es: "ES", fr: "FR", se: "SE", ch: "CH", pl: "PL",
} as const;
export type Market = (typeof MARKET)[keyof typeof MARKET];
export const MARKETS = valuesOf(MARKET);
export const toMarket = parser(MARKET, (raw) => raw.toUpperCase());

export const FUEL = {
  petrol: "petrol", diesel: "diesel", electric: "electric",
  hybrid: "hybrid", lpg: "lpg", cng: "cng", other: "other",
} as const;
export type Fuel = (typeof FUEL)[keyof typeof FUEL];
export const FUELS = valuesOf(FUEL);
export const toFuel = parser(FUEL);

export const GEARBOX = { manual: "manual", automatic: "automatic" } as const;
export type Gearbox = (typeof GEARBOX)[keyof typeof GEARBOX];
export const GEARBOXES = valuesOf(GEARBOX);
export const toGearbox = parser(GEARBOX);

export const SELLER = { private: "private", dealer: "dealer" } as const;
export type SellerType = (typeof SELLER)[keyof typeof SELLER];
export const SELLER_TYPES = valuesOf(SELLER);
export const toSellerType = parser(SELLER);

export const BODY = {
  sedan: "sedan", coupe: "coupe", wagon: "wagon", hatchback: "hatchback",
  convertible: "convertible", suv: "suv", van: "van", other: "other",
} as const;
export type BodyStyle = (typeof BODY)[keyof typeof BODY];
export const BODY_STYLES = valuesOf(BODY);
export const toBodyStyle = parser(BODY);

export interface Photo {
  readonly url: string;
  readonly localPath: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly position: number;
}

/** One advert as a single source published it. */
export interface Listing {
  readonly id: string;
  readonly vehicleId: string;
  readonly sourceId: string;
  /** The portal the advert is on, when the source is an aggregator. */
  readonly origin: string | null;
  readonly sourceListingId: string;
  readonly url: string;
  readonly title: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly delistedAt: string | null;
  readonly photos: readonly Photo[];
}

/** One physical car, possibly advertised on several sources at once. */
export interface Vehicle {
  readonly id: string;
  readonly make: string;
  readonly model: string;
  readonly variant: string | null;
  readonly bodyStyle: BodyStyle | null;
  readonly firstRegistration: string | null;
  readonly mileageKm: number | null;
  readonly powerW: number | null;
  readonly fuel: Fuel | null;
  readonly gearbox: Gearbox | null;
  readonly sellerType: SellerType | null;
  readonly sellerName: string | null;
  readonly market: Market;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly damaged: boolean | null;
  /** When the portal says the advert went online, if it says so at all. */
  readonly firstListedAt: string | null;
  readonly description: string | null;
  readonly identityKey: string;
  readonly imageHash: string | null;
}

/** Observed asking price at one point in time. Append-only. */
export interface PriceSnapshot {
  readonly vehicleId: string;
  readonly observedAt: string;
  readonly amount: number;
  readonly currency: Currency;
  readonly baseAmount: number;
  readonly rate: number;
  readonly sourceId: string;
}

export interface VehicleWithPrice extends Vehicle {
  readonly currentPrice: PriceSnapshot;
  readonly firstPrice: PriceSnapshot;
  readonly priceChangeCount: number;
  readonly daysListed: number;
  readonly listings: readonly Listing[];
  readonly photos: readonly Photo[];
}
