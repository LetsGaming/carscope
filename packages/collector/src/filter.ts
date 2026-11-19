import {
  CRITERION, matchesText, modelAgrees, modelTerms, textTokens, withinRange, wattToPs,
  type Criteria, type CriterionKey, type RawListing, type SourceAdapter,
} from "@carscope/core";
import { splitMakeModel } from "./adapters/make-model.ts";

export interface Dropped {
  readonly title: string;
  readonly url: string;
  readonly criterion: CriterionKey;
  readonly found: string;
}

export interface Filtered {
  readonly kept: RawListing[];
  /** Why each rejected listing was rejected, so a missing car can be explained. */
  readonly dropped: Dropped[];
}

/**
 * Applies exactly those criteria the source could not express, so an adapter
 * declaring `unsupported` never silently widens a search — and records what it
 * rejected, because "the portal had it and we do not" is otherwise invisible.
 */
export function applyUnsupported(
  adapter: SourceAdapter,
  criteria: Criteria,
  listings: readonly RawListing[],
): Filtered {
  const gaps = new Set<CriterionKey>(adapter.unsupported);
  if (gaps.size === 0) return { kept: [...listings], dropped: [] };

  // Only the make and model are verified. Requiring every word the user typed
  // would discard a listing headlined "Nissan Skyline Nismo" for a search that
  // said "Nissan Skyline R34", which is a real car the portal did return.
  const tokens = gaps.has(CRITERION.text) ? textTokens(searchedName(criteria)) : [];
  const searched = splitMakeModel(criteria);
  const terms = gaps.has(CRITERION.text) && searched.model !== null ? modelTerms(searched.model) : [];

  const kept: RawListing[] = [];
  const dropped: Dropped[] = [];

  for (const l of listings) {
    const a = l.attributes;
    const reject = (criterion: CriterionKey, found: string): void => {
      dropped.push({ title: l.title, url: l.url, criterion, found });
    };
    const verdict = ((): boolean => {
      if (tokens.length > 0) {
        const haystack = [l.title, a.make, a.model, a.variant].filter(Boolean).join(" ");
        if (!matchesText(haystack, tokens)) { reject(CRITERION.text, haystack); return false; }
      }
      if (terms.length > 0) {
        const listed = a.model ?? modelInTitle(l.title, searched.make);
        if (!modelAgrees(listed, terms)) { reject(CRITERION.text, `model ${listed ?? ""}`); return false; }
      }
      if (gaps.has(CRITERION.priceEur) && !withinRange(l.price, criteria.priceEur)) {
        reject(CRITERION.priceEur, `${String(l.price)} EUR`); return false;
      }
      if (gaps.has(CRITERION.mileageKm) && a.mileageKm != null
        && !withinRange(a.mileageKm, criteria.mileageKm)) {
        reject(CRITERION.mileageKm, `${String(a.mileageKm)} km`); return false;
      }
      if (gaps.has(CRITERION.powerPs) && a.powerW != null
        && !withinRange(wattToPs(a.powerW), criteria.powerPs)) {
        reject(CRITERION.powerPs, `${String(wattToPs(a.powerW))} PS`); return false;
      }
      if (gaps.has(CRITERION.registrationYear) && a.firstRegistration) {
        const year = Number.parseInt(a.firstRegistration.slice(0, 4), 10);
        if (!withinRange(year, criteria.registrationYear)) {
          reject(CRITERION.registrationYear, a.firstRegistration); return false;
        }
      }
      if (gaps.has(CRITERION.fuel) && criteria.fuel !== null && a.fuel != null && a.fuel !== criteria.fuel) {
        reject(CRITERION.fuel, a.fuel); return false;
      }
      if (gaps.has(CRITERION.gearbox) && criteria.gearbox !== null && a.gearbox != null && a.gearbox !== criteria.gearbox) {
        reject(CRITERION.gearbox, a.gearbox); return false;
      }
      if (gaps.has(CRITERION.sellerType) && criteria.sellerType !== null && a.sellerType != null && a.sellerType !== criteria.sellerType) {
        reject(CRITERION.sellerType, a.sellerType); return false;
      }
      if (gaps.has(CRITERION.bodyStyle) && criteria.bodyStyle !== null && a.bodyStyle != null && a.bodyStyle !== criteria.bodyStyle) {
        reject(CRITERION.bodyStyle, a.bodyStyle); return false;
      }
      if (gaps.has(CRITERION.excludeDamaged) && criteria.excludeDamaged && a.damaged === true) {
        reject(CRITERION.excludeDamaged, "Unfallschaden"); return false;
      }
      return true;
    })();
    if (verdict) kept.push(l);
  }
  return { kept, dropped };
}

/** Portals without a model field put it right after the make: "Nissan Stagea RS4 ...". */
function modelInTitle(title: string, make: string | null): string | null {
  const words = title.split(/\s+/).filter(Boolean);
  const first = textTokens(make ?? "")[0];
  if (first === undefined) return null;
  const at = words.findIndex((w) => textTokens(w)[0] === first);
  return at === -1 ? null : (words[at + 1] ?? null);
}

function searchedName(c: Criteria): string {
  const { make, model } = splitMakeModel(c);
  return [make, model].filter(Boolean).join(" ");
}
