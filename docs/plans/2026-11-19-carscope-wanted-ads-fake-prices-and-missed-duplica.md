---
approved: 2026-11-19T22:04:23.123Z
session: f6ca2212-69ae-4eb8-8096-4994e35d649b
status: active
---

<!-- Written by the save-plan hook. Record deviations below the plan. -->
# Carscope: wanted ads, fake prices and missed duplicates (from prod data)

## Context

The last five fixes were tuned on five hand-picked rows. The all-time view shows 22 vehicles on prod (read-only dump, 2026-11-19). That is enough to show what the tuning missed. This plan covers four problems found there: wanted ads, fake prices, duplicates the new rule still misses, and data-quality defects behind them. Decisions from the user: wanted ads are not aggregated at all. Fake or placeholder prices are held back, and the car counts as a real listing once real information arrives. The Hückeswagen pair is one car. A relist merges even when the price changed.

## What prod shows

| Finding | Evidence (vehicle id prefix) |
|---|---|
| Wanted ads, 2 of 21 | `2bc75571`: description "Suche Nissan Skyline ... Budget liegt bei 45.000", URL `/-suche-nissan-...`, price 1, make stored as `[Suche]`. `2a3f48d0`: "ich suche nach einem Nissan Skyline R34 GT-T", price 25000 (the budget). Both show 200000 km and 1998-01, the buyer's limits read as car data (inference, to confirm on a capture). |
| Fake prices, 2 real sales | `f2ad0321`: price 1, 12 snapshots. `a771e4ce`: price 11111, text says "PREIS IN DER ANZEIGE DIENT NUR ALS PLATZHALTER". Both count in median and vs-median today (`price > 0` filters in `services/market.ts`). |
| Missed duplicate A, relist | `aff93dde` + `13697373` (Niesky): same town, 132000 km, 1998-05, same gearbox. Three Kleinanzeigen ads from one seller, prices 16500 and 17000. The 1 % price limit blocks the merge. |
| Missed duplicate B, relist with corrected data | `14195382` + `b48b8325` (Hückeswagen): same town, private seller, near-identical titles. 169800 vs 178000 km, 1998-06 vs 1999-03, 26990 vs 24490. The user says: same car, new listing. |
| Missed duplicate C, sparse card | `85c1cad9` + `a372d143` (Rodenbach): same town, price 44900 on both. The AutoUncle card has no km, registration, power or gearbox, even after the detail fetch. |
| Gearbox looks wrong | 12 of 21 are `automatic`. `ed1aea8b` says "Schaltgetriebe" and "Schalter" but is stored automatic. Kleinanzeigen detail runs `/Automatik/i` over the whole page text (`kleinanzeigen.ts:117`), so "Klimaautomatik" counts. A wrong gearbox also blocks the new attribute rule. |
| Inference damage | `2bc75571` got make `[Suche]` and model `Nissan` from the first two title words (`vehicles.ts` resolve). My SQL model rule (`v.model LIKE`) hides any car stored with a wrong model. Only one such car on prod, but the failure mode is real. |
| Variant leak | `1a566afb` variant is "R34 nur noch 2 Tage online" (AutoUncle badge text, `autouncle.ts:126`). |

Not proven, left alone: `f6d6c883` (AutoUncle, 45000 €, 83000 km) may be an older state of Rodenbach. Nothing in the data confirms it.

Expected on prod after this plan: 20 visible vehicles, minus 4 held, minus 3 merges, gives 13. (The plan said 21 and 14. Miscount: 22 vehicles are stored, one is hidden, and one id was merged away earlier.)

## Order of commits

1. Hold mechanism (`feat`). Wanted ads and placeholder prices.
2. Duplicate tiers (`feat`).
3. Data quality (`fix`): make/model inference, gearbox, variant leak. Capture real pages first.
4. Deploy with a fresh database backup.

## 1. Hold mechanism

A held vehicle is stored but excluded from lists, statistics, dedup candidates (wanted only), public feed and webhooks. The state is recomputed, so it releases itself.

- Core, new `packages/core/src/hold.ts`, pure: `holdReason({ titles, description, priceBase }): "wanted" | "placeholder_price" | null`.
  - **wanted:** a marker in a title or URL slug (`[Suche]`, `Gesuch`, `Ankauf`, `Wir kaufen`), or `such(e|en)` followed within 40 characters by a make or model word in the first 300 characters of the description. A guard skips "neuen Besitzer/Zuhause/Halter/Liebhaber". Never released while the text says so.
  - **placeholder_price:** price below 100 € (1 € is how Kleinanzeigen shows "VB"), or "Platzhalter" near "Preis" in the description. Deviation, 2026-11-19: the plan also listed repeated digits (11111) and runs (12345). Dropped, because the Velbert car on prod really costs 44444 € and the rule would hold it. The 11111 € placeholder car is caught by its own text.
  - Reuses `MODEL_ALIASES` and `textTokens` from `criteria.ts` where useful. Constants named in core.
- Migration `005_held.sql`: `vehicles.held_reason TEXT`, `held_released_at TEXT`. `HELD_EXCLUDED = "v.held_reason IS NULL"` next to `HIDDEN_EXCLUDED` in `repositories/filter.ts`, added to `buildFilter` and `#periodEvidence`.
- `VehicleRepository.#reassess(id)`: runs `holdReason` on the vehicle's titles, description and latest price. Sets or clears `held_reason`, unless `held_released_at` is set. Called at the end of `upsertListing`, `recordPrice` and `saveDetail`. `reassessAll()` for the backfill, run once per collection job before `consolidate`, so the webhook dispatch afterwards never sees a held car.
- Statistics: `observations()` also drops snapshots under 100 € (old 1 € snapshots stay out of the series after release). Old 11111 snapshots of a released car remain in its history. Accepted.
- Release by hand: `POST /api/vehicles/:id/release` sets `held_released_at`, so a classifier mistake can be overruled. `GET /api/vehicles?held=true` lists held cars. Web: a line under the list, "N Anzeigen zurückgehalten (Gesuche, Platzhalterpreise)", with a link that shows them and a "Freigeben" button. This is the safety net for false positives. A silently hidden real car is the main risk of this feature.
- Known consequence: the webhook and public cursor read `vehicles.rowid`. A car released later has an old rowid and does not produce a notification. Document it in `docs/http-api.md`.
- Tests, with excerpts of the real prod descriptions as fixtures: both wanted ads are held, both fake-price ads are held, a seller text "Suche neuen Besitzer" is not held, a held car with a new real price is released, a released-by-hand car stays visible, held cars are absent from search, stats and feed.

## 2. Duplicate tiers

Keep tier A (`isAttributeMatch`, price within 1 %, gearbox required). Add two tiers in `packages/core/src/identity.ts`, all tolerances as named constants. Dealers are excluded from tiers B and C: a dealer holds several similar cars.

- **Tier B, same place:** make equal, town equal and known (normalised, plus postal code when both have one), registration within 12 months, mileage within 5 %, title overlap of 0.5 or more (`titleOverlap` exists), power and gearbox equal when both are known. Price is ignored (user decision). Covers A and B above.
- Deviation, 2026-11-19: tier B compares titles by their headline (text before an aggregator tagline "| Seltenes Fahrzeug") and takes the best pair across all titles of both cars. A car whose titles are only make, model, year and power is "quiet": it passes the title test and is held to a price within 15 % instead. Reason: without this, an AutoUncle card could not join its own car when it arrived second (reverse arrival order left Hückeswagen split in a test of the prod snapshot).
- **Tier C, sparse card:** one side has at most one of km, registration, power, gearbox. Make equal, town equal, price exactly equal, every attribute known on both sides agrees. Covers Rodenbach.
- `MatchInput` gets `city` and `sellerType` (optional, like `gearbox`). `toMatchInput` in `repositories/vehicles.ts` fills them. `isDuplicate` becomes certain or A or B or C. `consolidate()` groups by make and town as well as the mileage sweep, since tier C has no mileage.
- Risk, stated plainly: tier B and C tolerances come from three prod pairs. That is overfitting by construction. Mitigation: the dump of all 21 vehicles is the test fixture, and every other pair in it (about 230) must stay apart. Any new merge shows up in the next prod dry run before deploy.
- Risk: `mergeInto` puts two same-source ads on one vehicle, so the snapshots of both ads alternate in time. `priceChangeCount` (LAG over all snapshots) is inflated for such cars. Follow-up if it matters: add `listing_id` to `price_snapshots`. Not in this change.
- Tests: A, B and C merge. Hückeswagen merges, and the live ad survives as listing set union. All other prod pairs stay apart. Dealers are never merged by B or C.

## 3. Data quality

Start with `npm run capture -- "<url>"` of one Kleinanzeigen wanted ad, one Kleinanzeigen sale ad, and the AutoUncle ad `a372d143`. `CLAUDE.md` says every guessed selector turned out wrong. Save trimmed fixtures in `tests/fixtures/`.

- **Make and model:** where the adapter filters by make and model in the URL (Kleinanzeigen does), `parseList` sets `attributes.make` and `model` from the search. Check first what `RequestSpec` carries. Strip leading bracket tags (`[Suche]`) before the title fallback in `resolve`.
- **Gearbox:** Kleinanzeigen: read the structured "Getriebe" field if the capture shows one, else a word-bounded `\bAutomatik(getriebe)?\b` on the description only. On a disagreement between sources, store null, not the first source's value.
- **AutoUncle variant:** strip badge text ("nur noch N Tage online") in `autouncle.ts` before storing the variant. Migration cleans stored values.
- **AutoUncle `a372d143`:** find out from the capture why the detail fetch returns nothing. Fix only if it is a parser defect.

## 4. Deploy

Same as last time: push, fresh copy of `/data/carscope.sqlite*` on `docker`, `git pull --ff-only` in `/apps/carscope`, `docker compose up -d --build`. Before the push, run the new `reassessAll` and `consolidate` as a dry run against a read-only copy of the prod database, and compare with the expected result (13 visible, the 4 held ids, the 3 merges). The earlier migrations cannot be rolled back by the image, so the backup is the way back.

## Verification

1. Per commit: `npm run typecheck`, `npm test`, `npm -w @carscope/web run build`. The 3 Windows `EPERM` temp-cleanup failures exist without my changes.
2. Dry run on prod data: the held ids are `2a3f48d0`, `2bc75571`, `f2ad0321`, `a771e4ce`. The merges are `aff93dde`+`13697373`, `14195382`+`b48b8325`, `85c1cad9`+`a372d143`. Nothing else changes.
3. In the browser: the held line and the Freigeben button work, and the Skyline list shows 13 cars with sane median figures.

## Blind spots, for the record

- I shipped a merge rule and called the test data "the three distinct cars" without looking at the delisted rows. Three real duplicates were already in the database.
- I treated the 1 % price limit as safe because it separated Rodenbach from Velbert by 0.016 percentage points. That margin was luck, not design.
- The held mechanism is the risky part. Heuristics that hide cars need a visible list and a release button from the first commit. Do not ship the classifier without them.

## Deviations in step 3 (2026-11-19)

- Not done: make and model from the search. `parseList` gets no criteria, and the cheap part (stripping `[Suche]`-style tags before the title fallback in `resolve`) fixes the case seen on prod.
- Not done: "store null when sources disagree on the gearbox". It needs a conflict marker, or the next source fills the null again and the value flips. The structured read removes the observed wrong values at the source. Revisit only if conflicts show up again.
- Done instead: the AutoUncle detail parser. The capture showed that `parseDetail` returned no attributes at all, and that the page lists first registration, mileage, gearbox, power, fuel and body. That is why the Rodenbach card (`a372d143`) was bare: not a parse defect on the card, but a detail parser that never read the facts.
- Captures were made with `npm run capture` from the local machine: one Kleinanzeigen ad (found the `Getriebe` details list, structured `Marke` and `Modell`) and the Rodenbach AutoUncle ad.
