---
approved: 2026-11-23T21:51:49.278Z
session: f6ca2212-69ae-4eb8-8096-4994e35d649b
status: active
---

<!-- Written by the save-plan hook. Record deviations below the plan. -->
# Carscope: market-accurate filter, merger and aggregation, then a prod cleanup

## Context

The last round fixed the visible problems, but the market numbers are still skewed. This round starts with a full read of the prod database (read-only, 2026-11-23): 22 vehicles, 33 listings, 8,289 price snapshots, 149 photo rows, 1,017 runs, one saved search. Prod still runs `c819fbf`. The commits `bc8851b`, `78a6611` and `ae33ffc` are pushed but not deployed. The deploy was blocked by the permission classifier and needs your OK or a permission rule.

Order you asked for: this review, then the implementation, then a summary of what the filter would do and its effect, then the prod cleanup. The prod database is not cleaned before you approve that summary.

**Phase 0 (your decision): deploy the three pushed commits first**, because the real run on prod can change parts of this plan. See "Phase 0" below.

## What I found

### A. Wrong or missing merges (the "double entries")

| Finding | Evidence |
|---|---|
| 3 duplicates still split | Niesky `aff93dde` + `13697373` (3 Kleinanzeigen ads, 16500 and 17000 €). Hückeswagen `14195382` + `b48b8325`. Rodenbach `85c1cad9` + `a372d143`. The new tiers merge all three (dry run on a copy: 3 merges). |
| **A wrong merge** | AutoUncle card 229720598 "Nissan Skyline **Nismo** 280 PS", 1999, 40000 € is stored on the Rodenbach vehicle `a372d143`. Run 1001 on 22 Nov says `created 0, merged 3`, so it merged on arrival. It is almost certainly the Magdeburg car `3bdecf8f` (Kleinanzeigen "GTR Nismo JDM 40.000€", 1999-02, 36500 km, 40000 €). Merging the Rodenbach pair now would carry this foreign listing and five 40000 € snapshots into the Rodenbach car. |
| Cause of the wrong merge (not proven) | Both AutoUncle cards had no mileage and no registration, so both have the identity key `nissan\|skyline\|x\|x\|DE`: unknown equals unknown. The candidate loop in `resolve` also takes the **first** candidate that passes, not the best. I could not reproduce the exact score from the stored data, so step 1 reproduces it with a test before the fix. |
| Place is only compared by city | Four vehicles have a postal code but no city (`1a566afb` 14547, `f6d6c883` 55543, `19423db0` 89233). The postal code is the stronger signal and also tells two cars apart. |
| Merge keeps the old advert's values | When the old and the live advert of one car merge, the lower rowid wins every field. Hückeswagen would show 169800 km and 1998-06 from the dead ad next to the live price 24490. |

### B. Fake and search listings

- The 4 cars you hid by hand are exactly the 4 the hold rule catches: `2a3f48d0` and `2bc75571` (wanted ads), `f2ad0321` (1 €), `a771e4ce` (11111 €, text says placeholder). That confirms the rule. A fifth hidden car is the Stagea.
- The hold rule only runs after the next collection job. Nothing is held on prod yet.
- No new fake or wanted ad appeared since 19 Nov among the 17 visible cars. I checked titles, prices, descriptions and attributes of all of them. `3bdecf8f` ("40.000€ bis Sonntag !!!!") reads like a real sale with pressure wording.

### C. The market numbers are wrong (the biggest finding)

- `monthlySeries` takes **every snapshot** as one observation. A car listed for 60 days counts 700 times, a car listed for 2 days counts 12 times. Measured on prod, per month, median by snapshot against median by car: Aug 34500 / 33000, **Sep 25990 / 33000 (21 % too low)**, Oct 24490 / 23500, **Nov 44444 / 40000**. One long-listed car decides the month.
- `confidence(observations.length)` shows 5 of 5 stars at 400 or more snapshots. Prod has 8,289 snapshots for 13 distinct cars. The "reliable" flag per month counts snapshots too.
- 8,289 snapshots hold **40** distinct (vehicle, price) pairs: 99.5 % are copies of an earlier price. The table grows with runs, not with market events. `priceChangeCount` is computed over it.

### D. Bugs and bad UX

| # | Finding | Impact |
|---|---|---|
| 1 | The saved search is text only (`"Nissan Skyline"`, make and model empty). My SQL model rule needs `criteria.model`, so it does **not** run for this search. The Stagea passed the list until you hid it. | The Stagea fix is not active for your real search. |
| 2 | Photo links get lost. `#fillGaps` replaces the whole photo set when a list page has more pictures than stored (15 against 6). The new rows have no `local_path`. Files exist on disk (6 each for `b48b8325`, `88bde6f7`, `85c1cad9`) but the database says 0 local. 5 ended cars have no file at all. | Ended cars point at the portal CDN. I checked 5 ended cars: 2 return **404** (`f2ad0321`, `c027ec5c`), so the "Alle" view shows broken thumbnails. |
| 3 | Titles repeat words: "Nissan Skyline **Nissan Skyline** R34 GTT" (`85c1cad9`, AutoScout24 builds make + model + version, and the version already holds both), "Nissan Skyline **Skyline** R34 GTT" (`a372d143`). | Visible in the list. |
| 4 | Kleinanzeigen runs end "nach 6 Seiten abgebrochen" in all 343 runs, `complete = 0` always. `parseList` returns `hasMore: listings.length > 0`, and the portal fills later pages with other ads. Each run spends 6 page loads for 12 results, 6 of them dropped. The runner calls `markDelisted` even for incomplete runs. | Wasted requests, a permanent warning in the source panel, and delisting that rests on luck. |
| 5 | The SQL filter drops cars with unknown power or registration (`powerPs 280..280`, years 1998 to 2002), the collector keeps them. | Cars silently missing, no counter like "excludedByText". |
| 6 | Wrong stored gearbox: `ed1aea8b` says automatic, its ad says "Schaltgetriebe" and "Schalter". Body "sedan" on a "GT-T Coupé". | Wrong labels. Gearbox is fixed at the source for new data (commit `ae33ffc`), not for stored data. |
| 7 | Local checkout has CRLF files, the Linux host has LF. Migration checksums differ, so a prod copy does not open on Windows without patching checksums. | Dev trap only. |

Reported, not fixed here: typed-looking mileage (`123456`), body style inconsistent between portals, the same car showing different cities across portals.

## Phase 0: deploy `ae33ffc` and watch the first real run

1. Fresh consistent snapshot on the host (`VACUUM INTO`, then `docker cp`), next to the older one in `/root/backup-carscope-20261119b/`.
2. On `docker:/apps/carscope`: `git pull --ff-only`, then `docker compose up -d --build`. Migrations 005 (hold columns) and 006 (variant clean) apply on boot. The pull worked cleanly last time (tree clean, only an untracked `.env.bak`).
3. Wait for the first collection job. The container starts one a few minutes after boot (last deploy: a run 3 minutes after start). At its end `reassessAll()` and `consolidate()` run for the first time on real data.
4. Read-only check of what happened, then report to you:
   - held cars (expected: the 4 you hid are also held; nothing new)
   - merges (expected: Niesky, Hückeswagen, Rodenbach)
   - **expected damage:** the Rodenbach merge will pull the Nismo listing (229720598) and its 40000 € snapshots into `85c1cad9`. Nothing is lost, only misplaced. The repair in step 5 therefore finds the listing by id, in whichever vehicle it sits, and the snapshots by source `autouncle`, amount 40000 and the time window 22 Nov 11:47 to 23 Nov 08:47.
   - the run notes, the new detail parsers (AutoUncle facts, Kleinanzeigen gearbox) filling the bare Rodenbach card, and any warnings in the container log
5. **Checkpoint:** I report what changed against this plan and adjust steps 1 to 5 before writing code. Nothing else is deployed in Phase 0.

The remote commands were denied by the permission classifier last time. You asked for the deploy in this conversation, so I try again. If it is denied again, I stop and say so.

## Phase 0 result (2026-11-23, deployed `ae33ffc`, one job run by hand)

The scheduler ticks once per hour after boot and does not run at boot, so no job started by itself. I started one with `POST /api/searches/:id/collect`, the same call as the "Suchen" button. Job: 3 sources, 22:04 to 22:05 UTC.

As predicted: 4 held (`2a3f48d0`, `2bc75571`, `f2ad0321`, `a771e4ce`, all four already hidden by you), 3 merged (Niesky into `aff93dde`, Hückeswagen into `14195382`, Rodenbach into `85c1cad9`), 22 vehicles became 19. The UI list for the saved search now shows 3 active and 14 all-time cars, which is the expected number. The Nismo listing 229720598 and its 40000 € snapshots now sit on `85c1cad9`, as predicted.

New findings that change the plan:

1. **Kleinanzeigen pagination returns the same results on every page.** The run kept 6 and merged 6 while only one Kleinanzeigen ad is live (Velbert), and the Stagea was rejected 6 times in the log, once per page. So the paging stop rule is clear: stop when a page adds no unseen ad. No capture needed to know the cause; step 4 still captures to confirm the markup.
2. **The merge lost price points.** `UPDATE OR IGNORE` on `price_snapshots` drops a row when both cars have a snapshot at the same instant and source (994 rows, 8,289 to 7,295). Mostly equal copies, but not always: Hückeswagen lost the live ad's 25990 € (`24490, 24990, 26990` remain). Step 1 resolves such conflicts in favour of the fresher advert and keeps the other price when the amounts differ in a way that matters. The old rows are in the backup.
3. **The merge keeps stale values.** `14195382` now shows 169800 km and 1998-06 from the dead ad next to the live price 24490. Confirms the "fresher wins" rule in step 1.
4. **The new AutoUncle detail parser did not backfill.** `needsDetail` is false once a car has more than one photo, so cars with a bare card are not fetched again. Step 4 makes `needsDetail` true while mileage, registration or gearbox is unknown.
5. **Baseline of what the UI shows now:** market median 39999 € (3 active cars), confidence 5 of 5 with 5,646 snapshots for 14 cars, monthly medians Aug 35000, Sep 33000, Oct 36800, Nov 44444. "Nissan Skyline Nissan Skyline R34 GTT" is visible for Rodenbach.
6. The collector filter works: the Stagea is rejected each run with `model Stagea`.

## Kleinanzeigen fetcher analysis (2026-11-23, 9 live captures with `npm run capture`)

I captured result pages of the saved search and of broader searches, parsed them with the real adapter and compared them with the database.

| # | Finding | Evidence | Effect |
|---|---|---|---|
| K1 | **The saved search sees 2 ads.** The portal returns 2 results for make + model + price max 45000 + year 1998 to 2002 + power 280 to 280 (`1 - 2 von 2`): Velbert and the Stagea. Without the power filter it returns 6, with only make and model **40**. | `ka-p1`, `ka-nopower`, `ka-broad` | The market of one portal is seen through a keyhole. Cards carry **no power**, so the portal filter is the only power check and drops every car whose seller typed another value or none. |
| K2 | **A car that is repriced above the cap is marked "ended" although it is live.** Magdeburg `3bdecf8f` shows 49000 € on the portal now (posted 22 Nov), our database says ended on 22 Nov at 40000 €. It left the results because of `preis::45000`, and `markDelisted` reads "not in the results" as "removed". | `ka-broad` vs prod | Wrong end dates, lost price changes, survivorship in the statistics. The same holds for AutoScout24 (`priceto`) and AutoUncle (`max_price`). |
| K3 | **Cards without a number are dropped silently.** 6 of 40 cards show only "VB" (no amount) and `toRawListing` returns nothing for them. Among them: the live Hückeswagen re-post `3561267761` (178000 km, EZ 03/1999) and the Bad Kreuznach R34 `3542376273` (83000 km, EZ 10/1998), which is `f6d6c883` (AutoUncle, zip 55543). | `<p ...> VB</p>` with no `€` | Those cars never enter, so they cannot be matched to their AutoUncle copy. AutoScout24 and AutoUncle also skip cards without a price. |
| K4 | **Wanted ads are in the results.** `anzeige:gesuche` returns exactly 2 ads ("Suche R32 GTR ...", "Suche Nissan Silvia ..."). Both sit in the default result set, `anzeige:angebote` removes them. Their km and registration are the buyer's limits (99999 km, EZ 1990-01; 1 km, EZ 1997-09). | `ka-gesuche`, `ka-angebote-s` | This is the source of the wanted ads on prod. |
| K5 | **Paging never stops.** `hasMore` is `listings.length > 0`. The portal shows the last page again for any page beyond the end (page 3 equals page 2, 15 of 15 ids). The page states its own range: `<span id="srp-breadcrumb-summary">26 - 40 von 40 ...` and an `aria-label="Nächste"` link only while a next page exists. | `ka-broad-s2`, `ka-broad-s3` | 6 page loads per run for results that fit on 1 page; `complete` is false in all 343 runs. |
| K6 | One page lists an ad twice (top ad and organic): 26 articles, 25 distinct. | `ka-broad` | Harmless, but it inflates "fetched". |
| K7 | Wrong category noise passes the portal filter: a garage-space ad and an engine ad (`3560531884`, `3567188918`). The title check in the collector rejects them (no "nissan" in the title). | `ka-broad` | Works today; keep the test. |

The parser itself is right where it finds a price: 34 of 40 cars parse with correct price, mileage, registration, postal code, city and date.

**Fix (new step 4, before the UX step):**
1. Portal query carries only stable criteria. Price, mileage and power are not sent to any portal (Kleinanzeigen, AutoScout24, AutoUncle). The year range stays (registration never changes). The local filter (SQL) applies price, mileage and power when the list is built, so lists and statistics keep your criteria. Storage grows to what the portal calls "Nissan Skyline" in the year range; the hold and the SQL filter keep the rest out of view.
2. Kleinanzeigen: add `anzeige:angebote`; `hasMore` from the summary span (`to < total`), fall back to the "Nächste" link, then to "no unseen id"; drop repeated ids on a page.
3. Cards without an amount ("VB") are stored with price 0 and held as `placeholder_price` until a price appears. Same for AutoScout24 and AutoUncle cards without a price. The held list label becomes "Preis fehlt oder Platzhalter".
4. `markDelisted` runs only for complete runs. With working paging, a complete Kleinanzeigen run is the normal case.
5. Tests with trimmed real captures: a page with a priced card, a "VB" card, a wanted card, a duplicate article and the summary span; a last-page repeat; the query URL with and without the volatile criteria.
6. Revival needs no cleanup: `upsertListing` clears `delisted_at` when an ad is seen again, so Magdeburg comes back at 49000 € on the next run. The 40000 € Nismo repair in the cleanup script stays.

## Plan (after the Phase 0 checkpoint)

One commit per step. Tests run per step with the prod snapshot as fixture (extend `tests/fixtures/prod-skyline-2026-11-19.json` with postal codes and the Nismo case).

1. **Merger** (`feat`). Files: `packages/core/src/identity.ts`, `apps/api/src/repositories/vehicles.ts`.
   - Unknown attributes never make two cars equal: the identity key and the identity score weight apply only when registration or mileage is known on both sides.
   - `resolve` scores all candidates and takes the best one, not the first.
   - Place rules use the postal code: equal codes match without a city, two different known codes veto tiers B and C.
   - `mergeInto`: the survivor stays the lower rowid, but each field takes the value from the fresher advert (live before ended, then later `last_seen_at`). Snapshot conflicts (same vehicle, instant and source) keep the fresher advert's price instead of ignoring the moved row.
   - Reproduce the Nismo merge in a test first. If it does not reproduce, I report that and keep the safeguards.
2. **Filter** (`fix`). Files: `apps/api/src/services/market.ts`, `apps/api/src/repositories/filter.ts`, `packages/collector/src/adapters/make-model.ts`.
   - Effective criteria: `MarketService` fills make and model from `splitMakeModel` when the search is text only, and moves the rest into `text`. One place, used by list, report and feed. The model rule then works for your search.
   - Report the number of cars hidden only because power or registration is unknown (new `unknownCount` next to `heldCount`, same UI line).
3. **Aggregation** (`fix`). Files: `repositories/vehicles.ts` (`observations`), `packages/core/src/stats.ts`, `services/market.ts`, `repositories/vehicles.ts` (`recordPrice`).
   - `observations()` returns one price per car per month: the price in effect (carried forward from the last snapshot), for months in which the car was listed. Months of a car's life come from listing first seen to last seen or delisted.
   - `confidence` and `reliable` count cars, not snapshots.
   - `recordPrice` skips the insert when the latest snapshot of that vehicle and source has the same amount. Presence is already recorded by `last_seen_at`.
4. **UX and bugs** (`fix`).
   - Photos: `#replacePhotos` keeps `local_path` for URLs it already has and does not replace a set that has local files.
   - Titles: a core helper strips leading make and model words from a variant. Applied when storing (`resolve`, `#fillGaps`) and in the AutoScout24 adapter. Migration `007` cleans stored variants.
   - Kleinanzeigen paging and the other fetcher problems: moved to their own step, see "Kleinanzeigen fetcher analysis".
   - `needsDetail` also returns true while mileage, registration or gearbox is unknown, so bare cards get the new detail parser.
5. **Cleanup script** (`feat`). New `apps/api/src/tools/cleanup.ts`, `npm run cleanup`. Dry run is the default, `--apply` writes. Steps, in this order:
   1. `reassessAll()` (hold), `consolidate()` (merge).
   2. One explicit repair: move listing 229720598 and its 40000 € snapshots to `3bdecf8f`, wherever they sit after Phase 0. Without Phase 0 the repair runs before the merge. It rests on year, model name and price, because the card is gone and stores no attributes of its own.
   3. Re-link photo files to rows by position (`<position>.<ext>` on disk).
   4. Compact snapshots: keep the first, every change and the last per (vehicle, source).
   5. `VACUUM`.
6. **Deploy and apply** after your approval of the dry-run summary: fresh snapshot, `git pull --ff-only`, `docker compose up -d --build`, then the cleanup with `--apply`. This is the second deploy; Phase 0 is the first.

## Expected effect (to be confirmed by the dry run in step 5)

- 22 stored vehicles become 19 (3 merges). Hidden stay hidden (5). Visible: 17 become **14** cars all-time; 3 of them are active (Hückeswagen, Rodenbach, Velbert).
- The Nismo listing moves to Magdeburg, so the Rodenbach car keeps one listing and its own price 44900 €.
- Snapshots: 8,289 become roughly 60 to 100. All price changes stay.
- Monthly median becomes per car: Sep about 33000 instead of 25990, Nov about 40000 instead of 44444 (re-measured after the merges).
- Confidence drops from 5 of 5 to 2 of 5 at 14 cars. That is the honest value.
- Photos: file links restored for the 3 live cars; the 5 ended cars without files stay on remote URLs. They cannot be repaired.
- No webhook fires for merged or released cars (cursor is rowid based).

## Verification

1. Per step: `npm run typecheck`, `npm test`, `npm -w @carscope/web run build`. The 3 Windows `EPERM` tests fail without my changes.
2. Dry run of `npm run cleanup` on a fresh `VACUUM INTO` snapshot, opened with the CRLF checksum patch. Compare with the expected numbers above and show you the summary.
3. After the apply: read-only queries on prod for vehicle count, hold and merge state, snapshot count, photo links, and the market report (`/api/market`) compared with the per-car numbers.
4. Backup stays at `docker:/root/backup-carscope-20261119b/` and a new snapshot is taken before the apply.

## Blind spots

- I fixed the dedup tolerances on three pairs last time and a fourth case (the Nismo card) already broke them in prod within three days. The new tests use all 22 stored vehicles plus that case, and the dry run on real data is the real gate.
- The snapshot weighting bug was there from the start. Nobody noticed because 5 of 5 stars looks fine. A statistic that shows confidence needs a test with a long-lived car and a short-lived one.
- The Nismo repair is an inference. If you know the AutoUncle ad, say so before the apply.
