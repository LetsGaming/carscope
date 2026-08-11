import {
  EMPTY_CRITERIA, EMPTY_RANGE,
  toBodyStyle, toFuel, toGearbox, toMarket, toSellerType,
  type Criteria, type Market, type Range,
} from "@carscope/core";

/**
 * Criteria are stored as a JSON blob, which means a row can hold anything an
 * older version of the app wrote. Spreading the parsed object over the empty
 * criteria let a stale `fuel` or a retired market code back into a live search;
 * every field is read through the domain's own parser instead.
 */
export function readCriteria(json: string): Criteria | null {
  const parsed: unknown = parseJson(json);
  if (!isRecord(parsed)) return null;

  return {
    text: asString(parsed["text"]) ?? EMPTY_CRITERIA.text,
    make: asString(parsed["make"]),
    model: asString(parsed["model"]),
    priceEur: asRange(parsed["priceEur"]),
    mileageKm: asRange(parsed["mileageKm"]),
    registrationYear: asRange(parsed["registrationYear"]),
    powerPs: asRange(parsed["powerPs"]),
    fuel: toFuel(asString(parsed["fuel"])),
    gearbox: toGearbox(asString(parsed["gearbox"])),
    sellerType: toSellerType(asString(parsed["sellerType"])),
    bodyStyle: toBodyStyle(asString(parsed["bodyStyle"])),
    excludeDamaged: parsed["excludeDamaged"] === true,
    markets: asMarkets(parsed["markets"]),
    postalCode: asString(parsed["postalCode"]),
    radiusKm: asInteger(parsed["radiusKm"]),
  };
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const asInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

const asRange = (value: unknown): Range =>
  isRecord(value) ? { min: asInteger(value["min"]), max: asInteger(value["max"]) } : EMPTY_RANGE;

function asMarkets(value: unknown): readonly Market[] {
  if (!Array.isArray(value)) return EMPTY_CRITERIA.markets;
  return value
    .map((code) => toMarket(asString(code)))
    .filter((market): market is Market => market !== null);
}
