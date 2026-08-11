# Testing

`node:test`, run directly against TypeScript through Node's type stripping. No
Jest, no Vitest, no transform step.

```
npm test                          # 199 tests
npm run typecheck                 # tsc + vue-tsc
npm -w @carscope/web run build    # vue-tsc + vite build
```

## The four gates

CI runs `tsc`, `vue-tsc`, the test suite and the web build on Node 24, and every
one has to be green. The build is a gate because `vue-tsc` checks templates that
`tsc` never sees, and because a broken import only shows up when Vite resolves it.

The same strictness applies to test code. A test that needs an assertion to
compile is testing the wrong thing or reading a value the wrong way.

## Layout

```
tests/core/       statistics and dedup scoring, called directly
tests/collector/  parsing, the run loop, adapters against fixtures
tests/api/        the HTTP surface through app.inject, on an in-memory database
tests/fixtures/   captured result pages, trimmed to three listings each
```

The suites mirror the source tree. A test for `packages/core/src/stats.ts` goes
in `tests/core/stats.test.ts`.

## What each layer tests

**core** is pure functions, so tests call them with values and assert the result.
Percentile interpolation, monthly reliability thresholds, the effect gate on
price factors, `identityKey` bucketing and `matchScore` thresholds are all
testable without any environment.

**collector** tests parsers against saved pages. `parseList` is a pure
`string → Result<ListPage>`, so a fixture is the entire test environment. The run
loop is tested against `mock`, a deterministic in-process adapter, and a store
double. `HttpClient` takes a `transport`, so a test serves a canned `Response`
without a network.

**api** builds a real app with `DATABASE_FILE=":memory:"` and
`COLLECT_ENABLED_SOURCES="mock"`, then drives it with `app.inject`. Collection is
a background job, so `helpers.ts` exposes `finish(app)`, which waits for the job
rather than the response.

Nothing in the suite touches the network. Photos and detail pages are switched
off in most API tests and exercised deliberately in `photos.test.ts`.

## What earns a test

- **A fixed bug gets a regression test**, named for the behaviour rather than the
  function. `tests/api/contracts.test.ts` and `tests/collector/photos.test.ts`
  exist because each case in them was a real defect.
- **A new adapter** gets a fixture and a `parseList` test before the adapter is
  finished. Three of the four adapters here were written twice because the first
  version guessed at the markup.
- **A new contract** between layers gets a test that would fail if the two sides
  drifted, such as asserting the request schema offers exactly the domain's
  country list.

Assertions carry a message where the failure would otherwise be a bare
`false !== true`. "It renders" is not a test.

## Fixtures

Real captures, trimmed to a handful of listings. To refresh one, run the search
by hand, save the page and cut it down. `COLLECT_BROWSER_DEBUG=true` writes every
fetched page and a screenshot to `DATA_DIR/debug`, which is the fastest way to get
a current capture of a portal that only answers a browser. Pages fetched through
the challenge solver are written there too, without a screenshot, since the
solver drives its own browser and does not hand one back.
