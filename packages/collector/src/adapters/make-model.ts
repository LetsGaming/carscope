import type { Criteria } from "@carscope/core";
import { MOBILE_DE_MAKES, normaliseMake } from "./mobilede-makes.ts";

export interface MakeModel {
  readonly make: string | null;
  readonly model: string | null;
  /** Everything after the model, kept for verifying results rather than querying. */
  readonly rest: string;
}

const MAX_MAKE_WORDS = 3;
const SHORT_MODEL_CHARS = 2;

export { normaliseMake };

export const isKnownMake = (value: string): boolean => normaliseMake(value) in MOBILE_DE_MAKES;

/**
 * Portals search by make and model, not by free text: mobile.de wants a numeric
 * make id and AutoScout24 puts the make in the URL path. Free text therefore has
 * to be split first.
 *
 * Makes can run to several words — Alfa Romeo, Land Rover, Aston Martin — so the
 * longest window that names a known make wins. Anything after the model stays as
 * free text and is used to verify results, not to query.
 */
export function splitMakeModel(c: Criteria): MakeModel {
  if (c.make) {
    return { make: c.make, model: c.model, rest: c.text.trim() };
  }

  const words = c.text.trim().split(/\s+/).filter(Boolean);

  for (let start = 0; start < words.length; start += 1) {
    for (let length = Math.min(MAX_MAKE_WORDS, words.length - start); length >= 1; length -= 1) {
      const candidate = words.slice(start, start + length).join(" ");
      if (!isKnownMake(candidate)) continue;

      const after = words.slice(start + length);
      return {
        make: candidate,
        model: c.model ?? modelFrom(after),
        rest: [...words.slice(0, start), ...after].join(" "),
      };
    }
  }
  return { make: null, model: c.model, rest: c.text.trim() };
}

/**
 * Portal model slugs are usually one word — golf, skyline, 3er. The exception is
 * a bare letter code whose number follows it, as in "C 200"; a trim name after a
 * complete code, as in "A4 Avant", is not part of the model.
 */
function modelFrom(words: readonly string[]): string | null {
  const first = words[0];
  if (first === undefined) return null;
  const next = words[1];
  const isBareCode = first.length <= SHORT_MODEL_CHARS && !/\d/.test(first);
  if (isBareCode && next !== undefined && /^\d+$/.test(next)) return `${first} ${next}`;
  return first;
}
