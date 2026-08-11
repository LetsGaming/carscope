/**
 * Some search words name a period rather than a word an advert must contain.
 * "R34" is one. So are E46, W124, Mk4, 993, B7, NB, JZA80 and every other
 * generation or chassis code, in every market, and no list of them could be
 * kept complete or correct.
 *
 * They are recognised from the collected data instead. If the adverts that do
 * carry a word sit in a narrow band of registration years compared with the rest
 * of the search, the word denotes a period, and a car from that band counts even
 * when its seller never wrote it. A word that appears across the model's whole
 * lifetime denotes something else, such as a trim or a colour, and stays a word
 * that must appear.
 *
 * This only ever widens a result set. A car the strict match would have returned
 * is always returned, so a wrong inference costs a few extra rows to skim rather
 * than a car the search will never reveal, which was the failure that mattered:
 * a genuine R34 headlined "GT-R V-Spec" and nothing else.
 */
export interface PeriodEvidence {
  readonly token: string;
  /** Cars matching the rest of the search that carry the token, and their years. */
  readonly withToken: number;
  readonly withTokenFrom: number | null;
  readonly withTokenTo: number | null;
  /** Every car matching the rest of the search that has a registration year. */
  readonly total: number;
  readonly totalFrom: number | null;
  readonly totalTo: number | null;
}

export interface Period {
  readonly token: string;
  readonly fromYear: number;
  readonly toYear: number;
}

/** Below this the band is an accident of a handful of adverts. */
export const MIN_PERIOD_EVIDENCE = 4;
/**
 * A word naming one of several generations present in the results covers less
 * than half the years they span. A word covering more is spread across those
 * generations, which makes it a trim, an engine or a body style rather than a
 * period: "GTR" occupied twelve of twenty-one collected Skyline years and would
 * have pulled every Skyline of that era into a search for the GT-R.
 *
 * Erring towards rejection is deliberate. Rejecting leaves the word strict,
 * which is the old behaviour plus a visible count of what it left out.
 * Accepting wrongly floods the results, which is the thing a narrow search is
 * meant to prevent.
 */
export const MAX_PERIOD_SHARE = 0.5;
/** Registration trails production, and an import is registered later still. */
export const PERIOD_PADDING_YEARS = 1;

export function inferPeriod(evidence: PeriodEvidence): Period | null {
  const { withToken, withTokenFrom, withTokenTo, total, totalFrom, totalTo } = evidence;

  if (withToken < MIN_PERIOD_EVIDENCE) return null;
  if (withTokenFrom === null || withTokenTo === null) return null;
  if (totalFrom === null || totalTo === null) return null;
  // Nothing to be learned when the token already covers everything found.
  if (withToken >= total) return null;

  const searchSpan = totalTo - totalFrom + 1;
  const tokenSpan = withTokenTo - withTokenFrom + 1;
  if (searchSpan <= 1) return null;
  if (tokenSpan / searchSpan > MAX_PERIOD_SHARE) return null;

  return {
    token: evidence.token,
    fromYear: withTokenFrom - PERIOD_PADDING_YEARS,
    toYear: withTokenTo + PERIOD_PADDING_YEARS,
  };
}
