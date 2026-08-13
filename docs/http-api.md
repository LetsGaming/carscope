# HTTP API

Fastify 5 with the TypeBox type provider. Every route declares a schema; the
schema is the validator, the serialiser and the handler's types at once.

## Endpoints

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/health` | `{ status: "ok" }` |
| `GET` | `/api/searches` | Saved searches |
| `POST` | `/api/searches` | 201, the created search |
| `PUT` | `/api/searches/:id` | The updated search |
| `DELETE` | `/api/searches/:id` | 204 |
| `POST` | `/api/searches/:id/collect` | 202, the started job |
| `GET` | `/api/searches/:id/vehicles` | Results for a saved search |
| `GET` | `/api/searches/:id/market` | Report for a saved search |
| `GET` | `/api/vehicles` | Results for criteria on the query string |
| `GET` | `/api/vehicles/:id` | One vehicle with prices, photos and listings |
| `GET` | `/api/vehicles/:id/prices` | Price history |
| `GET` | `/api/market` | Distribution, monthly series, bands, factors |
| `POST` | `/api/collect` | 202, starts a run for ad-hoc criteria |
| `GET` | `/api/collect` | The current job, or `null` |
| `GET` | `/api/events` | SSE stream of job progress |
| `GET` | `/api/sources` | Sources with state and health |
| `PATCH` | `/api/sources/:id` | Enable or disable one, returns the list |
| `GET` | `/media/*` | Stored photos, cached for a week |

## Schemas

Request and response shapes live in `schemas.ts` and beside the routes that use
them. The enumerated fields are generated from `@carscope/core`:

```ts
fuel: nullableEnum(FUELS),
markets: Type.Array(stringEnum(MARKETS)),
```

The response schema is not decoration. Fastify compiles a serialiser from it, so
a field the schema does not list cannot leak into a response.

Ajv coercion is off. On an `integer | null` union it turns every `null` into `0`,
which silently rewrote saved search criteria. Bodies arrive as typed JSON and
need no coercion.

## Criteria on the query string

A query string is text, so `CriteriaQuery` declares every field as an optional
string and `toCriteria` parses it. Enumerated values go through the core parsers:

```ts
fuel: toFuel(text(q.fuel)),
markets: (q.markets ?? "").split(",").map(toMarket).filter(isMarket),
```

Anything that is not a member reads as unset. Asserting instead of parsing is
what let `?fuel=petrol'--` reach a column comparison.

`criteriaFromQuery` combines parsing with the range check, so the four endpoints
that take criteria share one seam rather than repeating three lines each.

## Validation layers

1. **The schema** rejects a wrong type, an unknown enum member, a string over its
   length limit, an integer out of range.
2. **`validation.ts`** holds the one rule a schema cannot express: a range whose
   minimum exceeds its maximum matches nothing, so it is a client mistake, not an
   empty result. `assertRangesValid` throws `Invalid`.
3. **A service** holds anything above that.

## Errors

One `setErrorHandler` maps failures to responses.

```json
{ "error": "not_found", "message": "search not found" }
```

| Case | Status | `error` |
|---|---|---|
| `NotFound` | 404 | `not_found` |
| `Invalid` | 400 | `invalid` |
| Schema validation | 400 | `invalid` |
| A Fastify 4xx | its own | its own code |
| Anything else | 500 | `internal` |

A 4xx is logged at info, a 5xx at error with the exception. The 500 body says
`request failed` and carries no internals. Routes throw; they never build an
error response.

## Collection is a job, not a request

A run touches several portals behind a politeness throttle and takes minutes, so
it never happens inside a request. `POST /api/collect` starts one and returns 202
with the job. One run happens at a time; starting another while one is live
returns the live job.

Progress is pushed over `GET /api/events` as SSE, per stored offer rather than
per finished source, so cars appear as they are parsed. The stream is a diff over
the job the collector already maintains, so it adds no second source of truth.
The reply is hijacked, which means an open stream cannot hold up a shutdown, and
`GET /api/collect` serves the same shape for a proxy that buffers streams.

## Plugins

`plugins/db.ts` opens the database and decorates the instance with the
repositories and the market service. `plugins/collector.ts` builds the HTTP
client, the browser and solver transports, and owns the job. `plugins/scheduler.ts`
ticks and asks the collector to run; it declares `dependencies: ["collector"]`.

Services are reached through the instance (`app.vehicles`, `app.market`), never
imported as singletons, which keeps dependencies explicit and lets tests build an
app with a different config.

## Security baseline

- `@fastify/helmet` with a real CSP: `default-src 'self'`, `object-src 'none'`,
  `frame-ancestors 'none'`. Images also allow `data:` and `https:`, because a
  listing may still hot-link a portal's photo. Vite emits no inline script, so
  none is allowed.
- `upgrade-insecure-requests`, COOP and Origin-Agent-Cluster are only sent when
  `HTTPS=true`. A browser ignores the last two on an untrustworthy origin and
  logs an error, and the first makes a page served over HTTP request its own
  assets over HTTPS, which fails.
- CORS is registered only when `CORS_ORIGIN` names origins.
- The logger redacts `cookie` and `authorization`.
- Every query is parameterised.
- Stored photos are raster only, decided by the file's leading bytes.
- Shutdown closes the stream set, waits for a running job, closes the browser,
  then the database. The solver holds nothing to close; its clearances are
  in-memory and discarded with the process.

There is no authentication. carscope is a single-user self-hosted tool and
assumes a trusted network. Exposing it publicly needs an authenticating proxy in
front, and the write endpoints would need rate limiting.
