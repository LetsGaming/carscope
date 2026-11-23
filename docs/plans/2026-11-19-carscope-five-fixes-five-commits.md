---
approved: 2026-11-19T21:00:10.334Z
session: f6ca2212-69ae-4eb8-8096-4994e35d649b
status: active
---

<!-- Written by the save-plan hook. Record deviations below the plan. -->
# Carscope: five fixes, five commits

## Context

Five issues come from a Nissan Skyline R34 GT-T search: a Stagea false positive, no way to remove a car by hand, only active listings visible, one car shown twice across portals, and a broken map link. Each issue gets its own commit. For the diagnostic items (1, 4, 5) the cause is stated first. Commit order: 5, 1, 2, 3, 4. The bug fixes land first, and the dedup change, the riskiest one, lands last.

The user supplied the active-search JSON (5 results) in the planning answers. Save it as `tests/fixtures/skyline-r34-results.json`, and the tests build their listings from it. Decisions made in planning: the model rule is strict and backed by an alias table; 88bde6f7 and 575913a6 are the Velbert car, so the search must show **3 cars**.

Facts from the JSON that shape the plan:
- The Stagea is a Kleinanzeigen listing: model `Stagea`, 2001-12, 144000 km, automatic, €8900.
- Rodenbach and Hückeswagen are AutoScout24 listings with `gearbox: null`.
- The Hückeswagen city is `"Hückeswagen, Schloss-Stadt"`: a structured town epithet, also bad for an OSM query.
- All five listings have powerW 205940.

---

## 5. OSM link returns "No results found" (`fix:`)

**Cause (verified by running the parser on `tests/fixtures/kleinanzeigen-list.html`):**
- No geocoder is involved. `mapsUrl` (`apps/web/src/lib/format.ts:36`) builds `openstreetmap.org/search?query=<postal> <city> <market>`.
- The Kleinanzeigen adapter flattens each article to text (`visibleText`, `packages/collector/src/text.ts:129`). The place regex `/(\d{5}\s+[^\d•|]{2,40})/` (`kleinanzeigen.ts:210`) then runs past the city into the posting date. "Heute, 15:40" flattens to `57520 Steinebach (Sieg) Gestern, 15:40`, and the regex stops only at the digit of the time. Absolute dates start with a digit, so only Heute/Gestern/Vorgestern leak in.
- The bad value is permanent: `#fillGaps` uses `city = COALESCE(city, ?)` (`apps/api/src/repositories/vehicles.ts:467`), so a fixed parser never overwrites it.
- A null city is already handled: `mapsUrl` drops empty parts. With postal code and city both null, the query is only `DE`, which gives a useless country-level link.

**Fix:**
- `packages/collector/src/adapters/kleinanzeigen.ts`: read the location from its own element, like AutoUncle does, not from flattened text.
- `packages/collector/src/text.ts`: add a `cleanCity` sanitizer. It strips a trailing relative-date word (Heute/Gestern/Vorgestern), everything after the first comma (`"Hückeswagen, Schloss-Stadt"` becomes `"Hückeswagen"`), and trailing punctuation. Every adapter's city goes through it: `parsePlace` (which also covers the over-capture risk in `mobilede.ts:179`), and the structured readers in `autoscout24.ts:162` and `custom.ts:145`.
- New migration `NNN_clean_city.sql`: apply the same cleanup to the stored `vehicles.city` values (the relative-date suffix and the comma suffix). A migration that is already applied is never edited.
- `mapsUrl`: return null when postal code and city are both null. The existing `v-else` in `VehicleView.vue:56` then shows plain text.
- Verification step before committing: compare OSM search for `42499 Hückeswagen DE` with `42499 Hückeswagen` and `42499 Hückeswagen Deutschland`. If the bare `DE` market code hurts results, replace it with the country name from a core lookup. Note: "always fails" in the request does not fit a cause that only affects relative-date cities. The market code is the one other candidate, and this check settles it.

**Tests:** a city assertion for every Kleinanzeigen fixture row in `tests/collector/fixtures.test.ts`, `cleanCity` cases in `tests/collector/text.test.ts`, and a migration test on a seeded dirty row.

---

## 1. Stagea passes the Skyline filter (`fix:`)

**Cause:**
- **Collector post-filter** (`packages/collector/src/filter.ts:36-49`): only the make and model words (`nissan`, `skyline`) are required. They are matched as substrings in one text built from `title + make + model + variant`. The structured model "Stagea" never gets compared on its own, so a title that mentions "Skyline" passes.
- **SQL result list** (`apps/api/src/repositories/filter.ts:31-40`): `textClause` accepts each word if it appears in `make||model||variant` **or in any listing title** on the vehicle. The stored Stagea passes the same way. A fixed collector would still show the car that is already stored.
- Kleinanzeigen has no structured model. `resolve` takes the second title word (`vehicles.ts:237`), so "Nissan Stagea ..." gives model `Stagea`.
- The Stagea title has no "R34". In SQL it can still pass the "R34" word through the period rule (`filter.ts:67`): R34 is inferred as a period and 2001 falls inside the padded window. The first implementation step confirms the exact path with the saved search's criteria, using the user's database or an API test with the fixture.

**Fix: the model field decides when it exists, and the title is the fallback.**
- New pure function in `packages/core/src/criteria.ts`: `modelAgrees(model, variant, searchWords)`. It is true when the model is missing, or when model + variant shares a token with the search words in either direction (the model in the phrase, or a word in the model/variant).
- Move the "model from the second title word" rule from `vehicles.ts:237` into a core helper (`inferModel`). Then the collector filter and `resolve` derive the same model.
- `packages/collector/src/filter.ts`: reject with `CRITERION.text` when `modelAgrees` is false. The `dropped` entry shows the conflicting model, so the drop is explained in the run log.
- `apps/api/src/repositories/filter.ts`: the same rule as one SQL clause in `buildFilter` (`v.model` against the bound, lowercased search phrase).
- Applies only when the search names a model (`splitMakeModel` returns one). A plain "R34" search is unchanged.
- **Alias table (chosen in planning):** `MODEL_ALIASES` lives once in `packages/core`, starting with `skyline: ["r32", "r33", "r34"]`. `modelAgrees` expands the search words through it, so "Nissan R34" still keeps a car modelled "Skyline". The SQL clause gets the expanded words as bound parameters, so the list is not duplicated in SQL. A new entry is a one-line change in core.

**Tests:** the five described listings as `RawListing`s through `applyUnsupported`: the Stagea is dropped and the four R34s are kept. An API search test with the Stagea stored. A `modelAgrees` unit test.

---

## 2. Manual delete that survives a re-scrape (`feat:`)

**Design: hide, do not delete.** A deleted row comes back on the next run as a new vehicle. A hidden row keeps its listings, so `resolve` finds the known `(source_id, source_listing_id)` and returns the same, still hidden vehicle. `delisted_at` cannot carry the flag: `#fillGaps` (`vehicles.ts:456`) and `upsertListing` (`:320`) both reset it to NULL.

- Migration `NNN_hidden.sql`: `ALTER TABLE vehicles ADD COLUMN hidden_at TEXT`.
- `VehicleRepository.hide(id, now)` / `unhide(id)`. Throw `NotFound` for an unknown id.
- `buildFilter`: `v.hidden_at IS NULL`, always, independent of `activeOnly`. That covers `search`, `since` (public feed, webhooks), `observations` and the market statistics. The same clause also goes into `#periodEvidence` (`vehicles.ts:400`).
- Routes in `apps/api/src/routes/vehicles.ts`: `DELETE /api/vehicles/:id` (hide) and `POST /api/vehicles/:id/restore`, with schemas, behind the existing write-scope guard.
- Web: `ResultRow.vue` emits `remove`. `useWorkspace` gets `remove(id)` with an optimistic list update and keeps the last removed id. `api.ts` gets `hideVehicle` / `restoreVehicle`. `WorkspaceView` shows one "Rückgängig" button after a removal. No browser `confirm()`.
- The collector keeps recording prices for a hidden car. Unhiding then shows a complete history.

**Tests:** hide, re-run the collector over the same listing, still hidden. Hidden cars are excluded from search, feed and stats. Restore works.

---

## 3. Active-only vs all-time toggle (`feat:`)

The server already supports this: `GET /api/vehicles?active=false` (`apps/api/src/routes/market.ts:201`). Two things block it in the web app: `queryString` drops every `false` value (`apps/web/src/lib/api.ts:52`), and `useWorkspace.ts:70` hardcodes `true`.

- `api.ts`: send `active=false` explicitly.
- `useWorkspace`: `scope: "active" | "all"` ref, a refresh on change, and the existing `issued` counter for stale responses.
- `WorkspaceView.vue` toolbar: a two-state pill ("Aktiv" / "Alle"), using the existing `aria-pressed` pattern.
- `delistedAt` added to `PricedResult` (`services/market.ts`), to `ResultSchema` (`routes/market.ts:45`, required, or Fastify drops the field) and to `Result` (`lib/types.ts`). `ResultRow` shows an "Inseriert bis <date>" badge when it is set. Token-only styles.
- The search-scoped and public routes keep active-only. The request concerns the workspace view.

**Tests:** an API test that `active=false` returns a delisted vehicle with `delistedAt`. `vue-tsc` and the web build cover the UI.

---

## 4. Cross-portal duplicates (`feat:`)

**Cause, from the given values:**
- `isCertainMatch` (`packages/core/src/identity.ts:68`) needs the mileage to the kilometre (89750 ≠ 89745). Registration 1999-06 vs 1999-07 also fails `compatibleRegistration`.
- `matchScore` reaches about 0.25: make only 0.11, title overlap of "280 PS" vs "Nissan Skyline R34 GTT" is 0, price 0.09, mileage 0.03, power 0.02. The threshold is 0.72.
- The pair is never even compared. The candidate query (`vehicles.ts:269-273`) needs the same identity key, the same image hash, or the exact mileage.
- Both cars are already stored. A known listing skips fuzzy matching (`vehicles.ts:226`), so a better rule alone never merges them.
- Gearbox is not a signal anywhere.

**Proposed rule `isAttributeMatch` (all conditions required, every value known on both sides):**

| Signal | Tolerance | Duplicate pair | Rodenbach vs dup | Hückeswagen vs dup |
|---|---|---|---|---|
| make | normalised equal | ✓ | ✓ | ✓ |
| gearbox | equal, both known | ✓ manual | ✗ null | ✗ null |
| power | ≤ 1 kW apart (PS vs kW rounding) | ✓ 205940 W | ✓ | ✓ |
| mileage | ≤ 250 km apart | ✓ 5 km | ✗ 2817 km | ✗ 88250 km |
| price | ≤ 1 % spread | ✓ 0 % | ✗ 1.02 % (thin margin) | ✗ 45 % |
| registration | ≤ 2 months apart, year-only compatible | ✓ 1 month | ✗ 12 months | ✗ 3 to 4 months |

Rodenbach and Hückeswagen each fail four signals, so they stay apart. Power gives no separation here, because all five listings have 205940 W.

**Underestimated risk:** the gearbox is null on both AutoScout24 cars. Because the rule requires the gearbox on both sides, an AutoScout24 copy of a Kleinanzeigen car would never merge through this rule. Dropping the gearbox requirement when one side is null weakens the rule a lot. Keep it required for now, and measure on real data before you loosen it. `isSameVehicle` becomes `isCertainMatch || isAttributeMatch || matchScore >= threshold`. The model is still not compared, which keeps the existing Skyline-vs-R34 behaviour (`identity.ts:77`).

**Image hashing: not in this change.** A real perceptual hash needs pixel decoding. That means a native module (`sharp`), which the project rules out, or a pure-JS JPEG/WebP decoder dependency. The current `imageSetHash` hashes URLs. It cannot match across portals that re-host photos, and it would not have caught this pair. Give it its own task once the attribute rule is measured on real data.

**Implementation:**
- `packages/core/src/identity.ts`: add `gearbox` to `MatchInput`, add `isAttributeMatch` with named tolerance constants, wire it into `isSameVehicle`.
- `vehicles.ts` candidate query: add `lower(v.make) = lower(?) AND abs(v.mileage_km - ?) <= 250`.
- Merging the existing duplicates: `VehicleRepository.mergeInto(keepId, dropId)` in one transaction. It moves `listings`, copies `price_snapshots` with `INSERT OR IGNORE` (PK includes `source_id`, so no clash across portals), keeps photos from the side with more, fills gaps, carries `hidden_at`, and deletes the dropped row.
  - The survivor is the **lower rowid**. Webhooks and the `?cursor=` feed use `vehicles.rowid`, so merging an older car into a newer one would redeliver it.
- `consolidate()` pass over active vehicles, grouped by make, pairwise `isSameVehicle`. It runs once at the end of a collection job, after `Promise.all(workers)` (`plugins/collector.ts`), not from a collector hook. The abandoned-worker race documented for webhooks applies here too.
- `docs/domain.md`: update the dedup section with the new rule and its tolerances.

**Tests:** in `tests/core/identity.test.ts`, the duplicate pair merges, and every pair of the three distinct cars stays apart. In `tests/api/merge.test.ts`, the pair is stored as two vehicles, `consolidate` merges them into one result with two `sources`, the price history is intact, and the survivor is the lower rowid.

---

## Verification

1. After each item, run all four gates: `npm run typecheck`, `npm test`, `npm -w @carscope/web run build`.
2. `npm run dev`, then check in the browser:
   - the Skyline search shows no Stagea and three cars; the Velbert car carries both the kleinanzeigen and the autouncle link;
   - remove a car, run the collection again, and it stays gone; "Rückgängig" brings it back;
   - the "Alle" toggle shows delisted cars with a badge;
   - the map link of a Kleinanzeigen car opens an OSM result.
3. One commit per item, Conventional Commits, no scope.
