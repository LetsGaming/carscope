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
| `GET` | `/api/vehicles` | Results for criteria on the query string. `?active=false` adds ended adverts, `?held=true` lists the held cars instead |
| `GET` | `/api/vehicles/:id` | One vehicle with prices, photos and listings |
| `GET` | `/api/vehicles/:id/prices` | Price history |
| `DELETE` | `/api/vehicles/:id` | Hide a car by hand (204). Survives re-scrapes |
| `POST` | `/api/vehicles/:id/restore` | Undo a hide (204) |
| `POST` | `/api/vehicles/:id/release` | Overrule a hold: this car is real and stays listed (204) |
| `GET` | `/api/market` | Distribution, monthly series, bands, factors |
| `POST` | `/api/collect` | 202, starts a run for ad-hoc criteria |
| `GET` | `/api/collect` | The current job, or `null` |
| `GET` | `/api/events` | SSE stream of job progress |
| `GET` | `/api/sources` | Sources with state and health |
| `PATCH` | `/api/sources/:id` | Enable or disable one, returns the list |
| `GET` | `/api/webhooks` | Registered webhooks (admin) |
| `POST` | `/api/webhooks` | Register one against a saved search (admin), 201 shows the secret once |
| `DELETE` | `/api/webhooks/:id` | Remove one (admin) |
| `GET` | `/media/*` | Stored photos, cached for a week |
| `GET` | `/api/public/v1/searches` | Saved search names, `{id, name}` only |
| `GET` | `/api/public/v1/searches/:id/vehicles` | Public vehicle summaries, `?limit=` |
| `GET` | `/api/public/v1/searches/:id/market` | A narrow public market summary |
| `GET` | `/api/public/v1/searches/:id/feed` | Change feed, `?cursor=&limit=` |

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

There is no authentication on `/api/*` by default — carscope is still a
single-user self-hosted tool and assumes a trusted network there. What changed
is that a second, narrow surface now exists for exposing the data itself.

## The public namespace

`/api/public/v1/*` is the only part of the API meant to be reachable from the
internet. Three decisions make that safe to do without touching anything else:

- **Read-only, saved-searches-only.** No arbitrary criteria on the query
  string — a caller reads `/searches`, then a specific search's vehicles,
  market or feed. That makes the whole response set finite and enumerable,
  which is what makes a 30 s TTL memo (`PUBLIC_CACHE_TTL_MS`,
  `services/public-cache.ts`) an effective defence: repeating the same request
  costs nothing after the first hit, rather than being merely rate-limited.
- **Its own DTOs** (`routes/public/dto.ts`), narrower than the internal
  schemas and never re-exporting them — `ResultSchema` in `routes/market.ts`
  is free to change shape without breaking a promise made to an outside
  consumer.
- **`access-control-allow-origin: *` unconditionally**, regardless of
  `CORS_ORIGIN` — a browser on any origin can read it, and it never carries
  credentials. The internal namespace's CORS is unaffected: with `CORS_ORIGIN`
  unset it still sends no CORS headers at all. Both are one `@fastify/cors`
  registration using the delegate form, keyed on the request path
  (`app.ts`), so there is exactly one place deciding either policy.

`/media/*` photos served through the public namespace need
`cross-origin-resource-policy: cross-origin` on top of CORS — helmet's default
`same-origin` blocks an `<img>` loading them in `no-cors` mode even though a
`fetch` would be fine. `routes/public/index.ts` sets that header on every
response it returns.

### The change feed

`GET /api/public/v1/searches/:id/feed?cursor=&limit=` returns vehicles newly
first-seen for that search, oldest first, as `{ items, nextCursor }`. The
cursor rides on `vehicles.rowid`, not `first_seen_at`: several collector
workers resolve vehicles concurrently
(`packages/collector/src/plugins/collector.ts` runs `cfg.concurrency` of them
at once), and `VehicleRepository.resolve` stamps its timestamp inside the same
synchronous block as the `INSERT`, so a tight loop can produce several rows
sharing one millisecond. A `>` cursor on that skips ties; a `>=` cursor
redelivers them. `rowid` is assigned at insert and never ties, so reading with
the same cursor twice is exactly idempotent — see `repositories/vehicles.ts`
`since()`. `?since=<iso>` is deliberately not offered as a cursor for the same
reason; a plain timestamp filter would need the same guarantee and cannot give it.

## API keys

`API_KEYS_REQUIRED` (default `false`) decides whether the write endpoints
(`POST`/`PUT`/`DELETE /api/searches*`, `DELETE /api/vehicles/:id`,
`POST /api/vehicles/:id/restore`, `POST /api/vehicles/:id/release`, `POST /api/collect`,
`PATCH /api/sources/:id`, all of `/api/webhooks`) require a key. With it unset,
nothing here changes from before — the bundled SPA and every existing script
keep working on a trusted network exactly as they did.

A key is `Authorization: Bearer csk_<prefix>_<secret>`, issued only by
`npm run keys -- issue <label> [--scope admin] [--expires <iso>]` — a CLI
against the database, not an API endpoint, because a key can only be as
trustworthy as whoever can already reach the deployment. Only its SHA-256 is
stored (`apps/api/src/db/migrations/002_public_api.sql`); the plaintext is
shown once and cannot be recovered. Scopes are `write` and `admin` (`admin`
implies `write`); there is no `read` scope — a key carrying neither still
lifts its holder into the keyed rate tier (`RATE_LIMIT_KEY_MAX`) instead of the
anonymous one, which is the whole effect of "no scopes".

Revoke with `npm run keys -- revoke <prefix>`; a revoked or expired key reads
identically to no key at all (401), not as a distinct error, so a caller
cannot use the response to tell a revoked key from a typo.

## Webhooks

Admin-only (`/api/webhooks`). Registering one against a saved search returns
its HMAC secret once, at creation. After a collection run for that search,
`services/webhooks.ts` `WebhookDispatcher.afterRun` reads the same `since()`
cursor the public feed uses and, if there is anything new, POSTs
`{ searchId, items }` with `x-carscope-timestamp` and
`x-carscope-signature: HMAC-SHA256(secret, timestamp + "." + body)`. The
per-webhook cursor (`webhooks.notified_through`) advances **only on a 2xx
response**, so a failing endpoint is retried on the next run rather than
losing the gap; past `WEBHOOK_MAX_FAILURES` consecutive failures the webhook is
disabled automatically.

Dispatch is deliberately **not** wired into the collector run loop as a
per-listing hook. `plugins/collector.ts` races each adapter against a stall
watchdog and does not cancel the loser, so an abandoned worker can keep
inserting vehicles for minutes after a job "finishes" — a hook fired during the
run would miss those silently. Reading from the durable watermark after the
run instead means nothing is lost, the payload reflects the fully enriched
vehicle (detail page and photos already fetched), and a webhook and a polling
browser hitting `/feed` can never disagree about what "new" means, since both
read the same query.

## Rate limiting

`@fastify/rate-limit`, registered with `global: false` — a route is limited
only where it opts into `config: { rateLimit }`, so `/api/health`,
`/api/events` (which hijacks its reply for an SSE stream) and `/media/*` are
never touched, by construction rather than by an exclusion list. The bucket
key is the caller's API key id when present, otherwise `req.ip` — which is
only trustworthy behind a reverse proxy that sets `TRUST_PROXY` accordingly;
see `docs/operating.md`. A 429 carries the same `{error, message}` shape as
every other error here (`{"error":"rate_limited","message":"too many
requests"}`), via a small `Error` subclass in `plugins/rate-limit.ts` — the
plugin's default `errorResponseBuilder` throws whatever it returns, and a
plain object with no `statusCode` falls through the shared error handler to a
misleading 500.

Exposing it publicly still needs an authenticating proxy in front if you want
more than the public namespace reachable, and the write endpoints should stay
behind `API_KEYS_REQUIRED=true` once they are internet-facing.

## Held cars and the cursor

A held car (wanted ad, placeholder price) is stored but left out of every list,
statistic, feed and webhook. The public cursor and the webhook watermark read
`vehicles.rowid`. A car that is released later keeps its old rowid, so it is
not announced as new: it appears in lists, but no webhook fires for it.
