import { Type, type Static } from "@sinclair/typebox";
import {
  BODY_STYLES, FUELS, GEARBOXES, MARKETS, SELLER_TYPES,
} from "@carscope/core";
import type { SavedSearch } from "@carscope/collector";

const Range = Type.Object({
  min: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  max: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});

/**
 * TypeBox's string-enum recipe, fed from the core vocabulary rather than a
 * second copy of it: a fuel added to the domain is accepted here without a
 * matching edit, and can never drift from what the row reader will accept.
 */
const stringEnum = <T extends readonly string[]>(values: T) =>
  Type.Unsafe<T[number]>({ type: "string", enum: [...values] });

const nullableEnum = <T extends readonly string[]>(values: T) =>
  Type.Union([stringEnum(values), Type.Null()]);

export const CriteriaSchema = Type.Object({
  text: Type.String({ maxLength: 200 }),
  make: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
  model: Type.Union([Type.String({ maxLength: 60 }), Type.Null()]),
  priceEur: Range,
  mileageKm: Range,
  registrationYear: Range,
  powerPs: Range,
  fuel: nullableEnum(FUELS),
  gearbox: nullableEnum(GEARBOXES),
  sellerType: nullableEnum(SELLER_TYPES),
  bodyStyle: nullableEnum(BODY_STYLES),
  excludeDamaged: Type.Boolean(),
  markets: Type.Array(stringEnum(MARKETS)),
  postalCode: Type.Union([Type.String({ maxLength: 10 }), Type.Null()]),
  radiusKm: Type.Union([Type.Integer({ minimum: 1, maximum: 2000 }), Type.Null()]),
});

export const SearchBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  criteria: CriteriaSchema,
});

export const SearchSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  criteria: CriteriaSchema,
});

export const IdParams = Type.Object({ id: Type.String({ minLength: 1 }) });

export const ErrorSchema = Type.Object({
  error: Type.String(),
  message: Type.String(),
});

export type SearchBodyType = Static<typeof SearchBody>;

/** Domain objects are readonly; the wire contract is not. Map, never cast. */
export function toSearchDto(search: SavedSearch): Static<typeof SearchSchema> {
  return {
    id: search.id,
    name: search.name,
    criteria: { ...search.criteria, markets: [...search.criteria.markets] },
  };
}
