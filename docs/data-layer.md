# Data layer

SQLite through Node's built-in `node:sqlite`. No ORM, no query builder, no native
module to compile.

## Connection

`openDatabase` creates the directory, opens the file, applies the pragmas and
runs migrations. Every instance gets the same settings:

```sql
PRAGMA journal_mode = WAL;      -- readers do not block the writer
PRAGMA synchronous = NORMAL;    -- the safe pairing with WAL
PRAGMA foreign_keys = ON;       -- off by default in SQLite
PRAGMA busy_timeout = 5000;     -- a brief lock retries instead of erroring
```

SQLite has one writer. A collection run writes continuously, so request-path
queries stay small and indexed, and bulk work such as photo pruning runs in the
background rather than inside a handler.

## Tables

`searches`, `vehicles`, `listings`, `price_snapshots`, `photos`, `runs`,
`fx_rates`, `source_settings`, `lookup_cache`, `api_keys`, `webhooks`, plus
`schema_migrations`. Indexes cover the columns the filter sorts and searches on.

`api_keys` and `webhooks` were added in `002_public_api.sql` — `001_init.sql`
is frozen by its checksum, so a schema change is always a new numbered file,
never an edit to an existing one. `api_keys.token_hash` is a SHA-256 of the
issued secret, `UNIQUE`, and is the only thing ever stored — the plaintext is
shown once, by the `keys` CLI, and cannot be recovered. `webhooks.notified_through`
is a cursor over `vehicles.rowid`: several collector workers resolve vehicles
concurrently and stamp `first_seen_at` inside the same synchronous block as
the insert, so a tight loop can produce rows sharing one millisecond — a
timestamp cursor would skip or redeliver those, while `rowid`, assigned at
insert, cannot tie. `repositories/vehicles.ts` `since()` is the one query that
reads this cursor, shared by the public `?cursor=` feed and the webhook
dispatcher so the two can never disagree about what "new" means.

Two shapes carry the model:

- A **vehicle** is one physical car. A **listing** is one advert for it on one
  portal, unique on `(source_id, source_listing_id)`. One vehicle can have
  several listings, which is what deduplication produces.
- `price_snapshots` is append-only. A snapshot stores the original amount, its
  currency, the rate used and the base-currency amount, so a later FX move never
  rewrites history.

## Repositories

Every query lives in a repository. Routes, services and views never issue SQL.

```
repositories/vehicles.ts       vehicles, listings, snapshots, photos, resolution
repositories/searches.ts       saved searches
repositories/runs.ts           run history and source health
repositories/sources.ts        which sources are enabled
repositories/fx.ts             exchange rates
repositories/lookups.ts        cached portal lookups, implements LookupCache
repositories/filter.ts         criteria to a parameterised WHERE clause
repositories/rows.ts           row shapes and the mappers to domain types
repositories/criteria-json.ts  the checked reader for stored criteria
repositories/api-keys.ts       api_keys: lookup by hash, issue, revoke, touch
repositories/webhooks.ts       webhooks: per-search lookup, advance, disable
```

A repository answers questions. A service decides. `VehicleRepository.search`
returns rows; `MarketService.report` decides what a report contains.

## Rows are mapped, never cast

A repository returns domain types. Column casing, integer booleans and
JSON-in-text stop at the repository edge.

```ts
const rows = allRows<VehicleRow>(db.prepare(VEHICLE_BY_ID), id);
return rows.map(toVehicle);
```

`allRows` and `getRow` in `db/index.ts` are the only place a driver result is
narrowed to a declared row shape. Row interfaces extend `SqlRow`
(`Record<string, SQLOutputValue>`), so a shape that could not be a SQL result
does not compile.

`toVehicle` then narrows every enumerated column through the core parsers. A
column holding a value the domain no longer knows reads as `null` rather than
propagating a string that is typed as a union but is not a member of it:

```ts
bodyStyle: toBodyStyle(row.body_style),
market: toMarket(row.market) ?? MARKET.de,
currency: toCurrency(row.currency) ?? BASE_CURRENCY,
```

`SELECT *` is fine for a mapper that reads a known table, since the mapper names
every field it uses. Where a query projects a subset, the column list is explicit
and the row interface matches it.

## Stored JSON

`searches.criteria` is a JSON blob, which means it can hold anything an older
build wrote. `readCriteria` reads it field by field through the same parsers the
API uses. Spreading the parsed object over `EMPTY_CRITERIA` looked equivalent and
was not: it put retired values back into live searches.

## Queries are parameterised

Every value is bound. `buildFilter` is the only place criteria become SQL, and it
pushes a placeholder for each value it adds:

```ts
if (min !== null) { clauses.push(`${column} >= ?`); params.push(scale(min)); }
```

Column names are literals in the source. Values never are. `LIKE` patterns escape
`\`, `%` and `_` before they are bound.

## Migrations

`001_init.sql` is the whole schema. With nothing deployed, one baseline is
clearer than a chain recording how it was arrived at. Once something runs on it,
the baseline freezes and changes become `002_…sql`.

The runner:

- applies pending files in name order, each in its own transaction;
- records name, timestamp and a SHA-256 of the file in `schema_migrations`;
- throws on start if an already-applied file's checksum no longer matches.

That last point is the reason the checksum exists. Editing an applied migration
updates fresh databases and leaves existing ones behind, and nothing reports it
until the two disagree at runtime. Add a new file instead.

Multi-statement writes that must succeed together go through `transaction(db, fn)`,
which rolls back and rethrows.

## Time and money

Timestamps are ISO 8601 strings in UTC. Engine power is stored in watts, not
kilowatts: 206 PS stored as 152 kW reads back as 207 PS, and watts round-trip
both units exactly. Amounts are integers in the currency's minor unit.
