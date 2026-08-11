# carscope

Self-hosted aggregator for used-car listings across German and neighbouring EU
marketplaces. It deduplicates the same car across portals, snapshots asking
prices over time, and reports the price distribution behind a search.

Two modes share one data model: browsing current offers, and reading the market
those offers sit in.

## How it works

A search is a set of criteria, not a query string. Each portal adapter turns
those criteria into that portal's own URL, expressing what it can and declaring
what it cannot; whatever it cannot express is verified afterwards and reported,
so a source never quietly widens a search.

Portals are read with a real browser where they demand one, behind a per-host
throttle. Pages are parsed into listings, and a listing is matched against the
cars already stored: same make, model, registration and mileage bucket, then a
score over price, photos and title. A match becomes a second advert for one car
rather than a second car. Prices are appended, never overwritten, so a snapshot
keeps the rate and the amount observed on the day.

The result is a database where one row is one physical car, with every portal it
appears on and everything it has ever been asked for.

## Getting started

Requires Node 24 and a Chromium that Playwright can drive.

```
cp .env.example .env
npm install
npx playwright install chromium
npm run dev                       # API on :8080, Vite on :5173
```

Or with Docker, which needs neither Node nor Chromium on the host:

```
cp .env.example .env
docker compose up -d --build
```

The same `.env` drives both. A challenge solver is optional and not started by
default; see [docs/operating.md](docs/operating.md) for that, for every setting,
and for what to do when a source stops working.

## Documentation

| Document | Covers |
|---|---|
| [operating.md](docs/operating.md) | Running it, every setting, debugging a run |
| [collecting.md](docs/collecting.md) | How pages are fetched, what each portal yields, adding a source |
| [domain.md](docs/domain.md) | Searching, deduplication, delisting, what the statistics claim |
| [architecture.md](docs/architecture.md) | The four modules and the seams between them |
| [conventions.md](docs/conventions.md) | Types, casts, errors, naming |
| [data-layer.md](docs/data-layer.md) | Schema, repositories, migrations |
| [http-api.md](docs/http-api.md) | Endpoints, validation, the SSE stream |
| [frontend.md](docs/frontend.md) | Layering, composables, design tokens |
| [testing.md](docs/testing.md) | The four gates and what earns a test |

## Layout

```
packages/core        domain types, statistics, dedup scoring. No I/O.
packages/collector   one resilient HTTP client, source adapters, the run loop
apps/api             Fastify, SQLite, repositories, the market service
apps/web             Vue 3 + Vite
```

Dependencies point inward. `core` imports nothing; `collector` depends on it and
on a storage port, never on SQLite; `api` implements that port. `apps/web` reads
the criteria shape and the domain lists from `core` too, so the client cannot
offer a filter the API would reject.

## Tests

```
npm test
npm run typecheck                 # tsc + vue-tsc
npm -w @carscope/web run build    # the web build is a gate too
```

CI runs all four on Node 24 and a change lands when every one is green.

## Status

| Part | State |
|---|---|
| `packages/core` | Complete, tested |
| `packages/collector` | Complete; parsers verified against captured pages |
| `apps/api` | Complete, tested |
| `apps/web` | Angebote, Markt and vehicle detail |
| Photo download and local serving | Complete, tested |
| Blocket / SE | Currency handling ready, adapter not written |

There is no authentication. carscope is a single-user self-hosted tool and
assumes a trusted network; exposing it publicly needs an authenticating proxy in
front.
