# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Self-hosted aggregator for used-car listings across German and neighbouring EU
marketplaces. It deduplicates the same car across portals, snapshots asking
prices over time, and reports the price distribution behind a search. See
`README.md` for the one-paragraph pitch and `docs/domain.md` for how searching,
dedup and delisting actually work.

## Commands

```
npm install && npx playwright install chromium   # setup; Node >= 24 required (engine-strict)
npm run dev                        # API on :8080, Vite on :5173 (npm-run-all --parallel)

npm test                           # node:test over tests/**/*.test.ts, via Node's type stripping
node --test --experimental-strip-types tests/core/stats.test.ts             # one file
node --test --experimental-strip-types --test-name-pattern "<name>" tests/**/*.test.ts   # one test

npm run typecheck                  # tsc (packages + api) then vue-tsc -p apps/web/tsconfig.json
npm -w @carscope/web run build     # vue-tsc --noEmit && vite build

npm run seed                       # two years of generated history into the db
npm run start                      # run the server without --watch

npm run capture -- "<url>"         # fetch one page and save it (debugging a portal)
npm run explain -- <source> <debug-file.html> --year 1998-2002 --ps 280- --find <id>
npm run warmup -- <url>            # open a browser to warm/save a session profile
npm run session -- export|import <dir>
npm run fingerprint [-- <url>]     # run bot-detection test pages, screenshot the result
```

**CI has four gates, and all four must be green**: `tsc`, `vue-tsc`, `npm test`,
and the web build (`npm -w @carscope/web run build`). The web build is its own
gate because `vue-tsc` checks templates `tsc` never sees.

No transpile step for the server: it runs TypeScript directly via Node's type
stripping (`--experimental-strip-types`), so `tsc` is a checker only, never a
build. Storage is `node:sqlite` — no native module to compile.

## Architecture

Four modules, dependencies point **inward only** — nothing reaches sideways or
upward, and `core` imports nothing:

```
packages/core        domain types, statistics, dedup scoring. No I/O.
  ↑
packages/collector    one resilient HTTP client, source adapters, the run loop.
  ↑                   Depends on a storage port (ports.ts), never on SQLite.
apps/api              Fastify, SQLite, repositories, the market service.
                       Implements the collector's storage port.
apps/web              Vue 3 + Vite. Depends on core for the criteria shape,
                       domain lists and unit conversions — never redefines them.
```

**Domain model**: a **vehicle** is one physical car; a **listing** is one advert
for it on one portal, unique on `(source_id, source_listing_id)`. A match
across portals becomes a second listing on the same vehicle, not a second car.
`price_snapshots` is append-only — prices are appended, never overwritten.

**apps/api layering**: route → schema → service or repository → SQLite. A
handler containing an `if` that encodes a rule is in the wrong place: input
shape is the schema's job, a rule the schema can't express (e.g. min > max) is
`validation.ts`, anything above that is a service. Repositories are
constructed once in `plugins/db.ts` and reached through the Fastify instance
(`app.vehicles`, `app.market`), never imported as singletons.

**apps/web layering**: `views/` are thin route containers, `components/`
render and emit only (no `fetch`, no routing, no rules), `lib/` holds
composables, the API client and formatters. `useWorkspace` owns searches and
results; `useCollectionProgress` owns the SSE stream and its polling fallback
— kept in a separate file on purpose.

**Where a change goes:**

| Change | Location |
|---|---|
| A new fuel, country or body style | `packages/core/src/vehicle.ts`, once |
| A new portal | `packages/collector/src/adapters/`, or `sources.json` if it publishes schema.org |
| A new statistic | `packages/core/src/stats.ts` as a pure function, called by `services/market.ts` |
| A new endpoint | A route with a schema, calling a service or repository |
| A new query | The repository that owns the table |
| A new colour, radius or spacing | `apps/web/src/styles/tokens.css` |
| Component logic | A composable in `apps/web/src/lib/` |

## Constraints that came from real bugs

Each of these is a rule *because* violating it once broke something — see
`docs/README.md` and `docs/conventions.md` for the full list and stories.

- **No escape hatches.** No `any`, `@ts-ignore`, `@ts-expect-error`, or `!` to
  silence `noUncheckedIndexedAccess`. The compiler runs at `strict` plus
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `noUnusedLocals`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (no `enum`, no
  parameter properties — nothing needing an emit).
- **Untrusted data goes through one checked reader per source**, never an
  assertion: SQL rows through `allRows`/`getRow` in `db/index.ts` + a mapper;
  query strings and stored columns through the core parsers (`toFuel`,
  `toMarket`, …); parsed JSON through `repositories/criteria-json.ts`
  `readCriteria`. Only four cast sites are audited-in; a fifth needs a reason
  of the same kind.
- **Never copy a domain list or type.** `MARKET`, `FUEL`, `GEARBOX`, `SELLER`,
  `BODY`, `CURRENCY`, `DAY_MS`/`HOUR_MS`/…, `Criteria` etc. live once in
  `packages/core` and are imported everywhere else.
- **Never spread parsed JSON over a default object** (e.g. `EMPTY_CRITERIA`) —
  it can reintroduce a retired value. Use `readCriteria`, `emptyCriteria()`,
  `copyCriteria()`.
- **Errors are return values, not throws, for expected failures.** The
  collector never throws for a blocked/slow/unparseable portal — it returns
  `Result<T, AppError>` with a `FAILURE` kind and `retryable`. Inside
  `apps/api`, routes throw `NotFound`/`Invalid` and one `setErrorHandler` maps
  them; handlers never build `reply.code(...).send(...)` themselves.
- **Migrations are checksummed.** Never edit an applied file under
  `apps/api/src/db/migrations/`; add a new `NNN_….sql` instead — an edited
  checksum throws at startup by design.
- **Units**: engine power stored in **watts** (round-trips exactly; kW does
  not), money as integers in the currency's minor unit, timestamps as ISO 8601
  UTC strings.
- **Photos are trusted by bytes, not URL or content-type.** Only PNG/JPEG/WebP
  are written to disk, decided by leading bytes — they're served from this
  origin, so anything else is script-as-the-app.
- **Language split**: code, comments, docs and log lines are English; text a
  user reads (UI, a run's `note` field) is German.
- **Frontend**: no `v-html`; components never call `fetch` (that's `lib/api.ts`
  only); two-way child→parent binding uses `defineModel`, not writing into a
  prop; every style value is a token from `styles/tokens.css`, never a raw
  colour/spacing literal; `<style scoped>` on every component.
- **Adding a source adapter**: capture a real search URL by hand first (every
  guessed query parameter has turned out wrong), save a trimmed fixture into
  `tests/fixtures/`, then write `parseList` (pure `string → Result<ListPage>`)
  against it. `unsupported` criteria are required on every adapter so the
  collector can post-filter and report what it dropped — a source must never
  quietly widen a search.

## Docs

`docs/` is the full reference; read the relevant one before touching that area
rather than re-deriving it from source:

| Doc | Covers |
|---|---|
| `docs/operating.md` | Running it, every env var, debugging a collection run, troubleshooting |
| `docs/collecting.md` | How pages are fetched per portal, bot-protection notes, adding a source |
| `docs/domain.md` | Searching, deduplication, delisting, what the statistics claim |
| `docs/architecture.md` | The four modules and the seams between them, in full |
| `docs/conventions.md` | Types, casts, errors, magic values, naming — the rules above, expanded |
| `docs/data-layer.md` | Schema, repositories, row mapping, migrations, SQLite pragmas |
| `docs/http-api.md` | Endpoints, validation layers, error shape, the SSE job stream |
| `docs/frontend.md` | Layering, composables, design tokens, in full |
| `docs/testing.md` | The four gates, what each suite covers, what earns a test |

## Public API, keys, webhooks

`/api/public/v1/*` is the only namespace meant to face the internet: read-only,
saved-searches-only (no arbitrary criteria — see `docs/http-api.md` on why),
`access-control-allow-origin: *` regardless of `CORS_ORIGIN`, rate-limited by IP
when anonymous and by key id when keyed. The internal `/api/*` surface still has
no CORS unless `CORS_ORIGIN` is set.

`API_KEYS_REQUIRED` defaults **false** — every write stays open on the trusted
network exactly as before, which is what keeps `npm run dev` and the whole
existing test suite unauthenticated by default. Set it `true` only once the
origin is actually exposed. Keys are issued only via `npm run keys -- issue`, a
CLI against the database — never through the API itself, since a key is only as
trustworthy as whoever can already reach the deployment. Scopes are `write` and
`admin` (`admin` ⊃ `write`); there is deliberately no `read` scope — a key with
neither just lifts its holder into the higher rate tier.

New-advert notification (webhooks and the `?cursor=` feed) reads from
`vehicles.rowid`, not `first_seen_at`. Several collector workers resolve
vehicles concurrently, so timestamps can tie inside one millisecond and a
`>`/`>=` comparison on them either skips or redelivers a row; `rowid` is
assigned at insert and cannot tie. See `packages/collector/src/runner.ts`'s
`onStored` for why a webhook is *not* dispatched from a collector-side hook: the
stall watchdog in `plugins/collector.ts` races an adapter but does not cancel
the loser, so an abandoned worker keeps inserting for minutes after a job
"finishes" — dispatch instead happens from the durable `webhooks.notified_through`
watermark in `services/webhooks.ts`, after `Promise.all(workers)`.

## Notes

- Single-user, self-hosted, trusted-network assumption by default — but no
  longer strictly "no authentication anywhere": see the section above.
  Anything reachable only at `/api/*` (not `/api/public/v1/*`) still assumes a
  trusted caller unless `API_KEYS_REQUIRED=true`.
- Automated collection from these portals is against their terms of service;
  this is built for polite, single-user, self-hosted use — keep that in mind
  for anything touching request rate or concurrency.
