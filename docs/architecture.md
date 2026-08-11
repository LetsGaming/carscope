# Architecture

Four modules and one rule: dependencies point inward. `core` sits at the centre
and imports nothing.

```
packages/core        domain types, statistics, dedup scoring. No I/O, no framework.
  ↑
packages/collector   HTTP client, source adapters, the run loop. Depends on a
  ↑                  storage port, never on SQLite.
apps/api             Fastify, SQLite, repositories, services. Implements the port.

apps/web             Vue 3 + Vite. Depends on core for the criteria shape,
                     the domain lists and the unit conversions.
```

Nothing reaches sideways or upward. `core` never imports from `collector`,
`collector` never imports from `api`, and no module imports from `apps/web`.

## packages/core

The vocabulary every other module speaks.

| File | Holds |
|---|---|
| `vehicle.ts` | `Vehicle`, `Listing`, `Photo`, `PriceSnapshot`, and the `MARKET` / `FUEL` / `GEARBOX` / `SELLER` / `BODY` constants with their parsers |
| `criteria.ts` | `Criteria`, range helpers, text tokenising, `marketsFor` |
| `units.ts` | Watt conversions, `CURRENCY`, `Money`, `convert` |
| `result.ts` | `Result<T, E>`, `ok`, `err`, `FAILURE`, `failure` |
| `stats.ts` | Percentiles, monthly series, price factors, sample thresholds |
| `identity.ts` | `identityKey` and `matchScore` for deduplication |
| `source.ts` | The `SourceAdapter` interface and time constants |

Every domain list is a `const` object with a derived type and a parser beside it:

```ts
export const FUEL = { petrol: "petrol", diesel: "diesel", /* … */ } as const;
export type Fuel = (typeof FUEL)[keyof typeof FUEL];
export const FUELS = valuesOf(FUEL);
export const toFuel = parser(FUEL);
```

`FUELS` feeds the request schema, `toFuel` narrows a query string and a database
column, and `FUEL.petrol` replaces the string literal everywhere else. Adding a
fuel means editing this object and nothing else.

## packages/collector

Everything that is not portal-specific lives here, so an adapter stays small.

- `http.ts` is the one resilient client. Every request gets a timeout, a
  per-host throttle, blocked-status detection and challenge-marker detection,
  and comes back as `Result<string>` rather than throwing. Assets have their own
  throttle, because pacing a CDN like a search page cost more than the rest of a
  run combined.
- `runner.ts` is the run loop: paging, gap filtering, identity resolution,
  snapshotting, delisting, run bookkeeping.
- `adapters/` is one file per portal, plus `custom.ts` for portals described in
  `sources.json` and `mock.ts` for tests.
- `ports.ts` declares `CollectorStore`, `LookupCache` and `PhotoFetcher`. The
  collector depends on these interfaces; `apps/api` implements them.

A portal quirk belongs inside its adapter. Anything an adapter cannot express in
its query goes in `unsupported`, and the collector filters it afterwards and
reports what it dropped, so a source never quietly widens a search.

## apps/api

Layering is route → schema → service or repository → SQLite.

```
routes/         validate and wire. No rules, no SQL.
services/       decisions: the market report, the photo budget, the storage port.
repositories/   every query, returning domain types.
plugins/        db, collector and scheduler, each registered as its own plugin.
db/             connection, pragmas, migrations, the two audited row readers.
schemas.ts      TypeBox request and response shapes, derived from core.
validation.ts   the range rule the five criteria endpoints share.
errors.ts       HttpProblem, mapped to a response in one place.
```

Repositories are constructed once in `plugins/db.ts` and reached through the
Fastify instance (`app.vehicles`, `app.market`), not imported as singletons.

A handler that contains an `if` encoding a rule is in the wrong place. Input
shape is the schema's job; a rule the schema cannot express, like a range whose
minimum exceeds its maximum, is `validation.ts`; anything above that is a
service.

## apps/web

```
views/          route-level containers, thin
components/     render and emit, nothing else
lib/            composables, the API client, formatters, wire types
styles/         tokens
```

`useWorkspace` owns searches, results and the report. `useCollectionProgress`
owns the SSE stream and its polling fallback. Components never call `fetch`.

## Where a change goes

| The change | Where it belongs |
|---|---|
| A new fuel, country or body style | `packages/core/src/vehicle.ts`, once |
| A new portal | `packages/collector/src/adapters/`, or `sources.json` if it publishes schema.org |
| A new statistic | `packages/core/src/stats.ts` as a pure function, called by `services/market.ts` |
| A new endpoint | A route with a schema, calling a service or a repository |
| A new query | The repository that owns the table |
| A new colour, radius or spacing | `apps/web/src/styles/tokens.css` |
| Component logic | A composable in `apps/web/src/lib/` |
