import { invalidRanges, type Criteria } from "@carscope/core";
import { Invalid } from "./errors.ts";

/**
 * The one rule every endpoint that accepts criteria enforces: a range whose
 * minimum exceeds its maximum matches nothing, so it is a client mistake rather
 * than an empty result. Schemas cannot express it, and five handlers repeating
 * it is five chances for one of them to forget.
 */
export function assertRangesValid(criteria: Criteria): void {
  const inverted = invalidRanges(criteria);
  if (inverted.length > 0) throw new Invalid(`inverted range: ${inverted.join(", ")}`);
}
