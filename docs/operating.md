# Operating

Running carscope, configuring it, and what to do when a source stops working.

## Requirements

**Node 24 or newer, plus Chromium.** No compiler, no Python, no Visual Studio
Build Tools.

The project runs TypeScript directly through Node's type stripping, so there is
no build step for the server; `tsc` is a checker only. Storage uses Node's
built-in `node:sqlite`, so there is no native module to compile. That matters
more than it sounds: a native SQLite driver has to ship a prebuilt binary for
every Node major on every platform, and the release after a Node major lands is
exactly when it does not.

`engine-strict=true` is set, so npm refuses to install on an older Node with a
clear message instead of failing later.

## Running it

```
cp .env.example .env
npm install
npx playwright install chromium   # the portals only answer a real browser
npm run seed                      # optional: two years of generated history
npm run dev                       # API on :8080, Vite on :5173
```

`.env` is read at startup. Settings there override the defaults in the
configuration table; `ENV_FILE` points somewhere else. **An empty value means unset**: a key
with nothing after the `=` falls back to its default rather than being read as an
empty string, which is why the optional keys in `.env.example` are commented out
rather than left blank.

Docker, which needs none of that:

```
cp .env.example .env
docker compose up -d --build
```

The same `.env` drives both ways of running this. Compose passes it into the
container and overrides only the handful of keys that describe the container
itself, so `DATA_DIR=./data` stays correct for a checkout while the container
still uses `/data`. Nothing is configured in `docker-compose.yml` that belongs in
`.env`, and `.env` never enters the image.

The image installs Chromium itself. The container serves the built SPA from the
API, so only port 8080 is exposed, and the database and photos live in the
`/data` volume. `CARSCOPE_PORT` and `CARSCOPE_DATA` change where that port and
that volume land on the host. Compose sets `init: true` so Chromium's child
processes are reaped rather than accumulating as zombies.

### The solver is not started by default

```
docker compose up -d                    carscope alone
docker compose --profile solver up -d   carscope and a bundled Byparr
```

carscope does not depend on the solver: without one, the sources listed in
`COLLECT_SOLVER_SOURCES` fall back to the browser. A solver that already runs
somewhere else is used by pointing `COLLECT_SOLVER_URL` at it and leaving the
profile alone, which is the usual case when it lives in its own container, LXC or
machine:

```
COLLECT_SOLVER_URL=http://192.168.2.41:8191/v1      an LXC or another host
COLLECT_SOLVER_URL=http://host.docker.internal:8191/v1   the Docker host itself
COLLECT_SOLVER_URL=http://byparr:8191/v1            the bundled container
```

`host.docker.internal` resolves on Linux too, because compose maps it to the
host gateway. The bundled solver publishes to loopback only; `BYPARR_PORT`
changes that.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `DATA_DIR` | `./data` | SQLite file and photo store |
| `DATABASE_FILE` | `DATA_DIR/carscope.sqlite` | Overrides the database path alone |
| `ENV_FILE` | `.env` | Read settings from somewhere else |
| `LOG_LEVEL` | `info` | Pino level; `silent` in tests |
| `WEB_ROOT` | unset | Serve a built SPA from this path |
| `CORS_ORIGIN` | unset | Comma-separated allowed origins |
| `COLLECT_ENABLED_SOURCES` | the three DE portals | Initial adapter selection |
| `COLLECT_INTERVAL_MINUTES` | `360` | Scheduler tick basis |
| `COLLECT_MIN_HOST_INTERVAL_MS` | `2500` | Minimum gap between requests to one host |
| `COLLECT_MAX_PAGES` | `6` | Pages per source per run |
| `COLLECT_TIMEOUT_MS` | `15000` | Deadline for one HTTP request |
| `COLLECT_USER_AGENT` | a current Chrome string | Plain fetches only; the browser sends its own |
| `COLLECT_STORE_PHOTOS` | `true` | `false` records photo URLs without downloading |
| `COLLECT_LOCALE` | `de-DE` | Browser locale and `accept-language` |
| `COLLECT_TIMEZONE` | `Europe/Berlin` | Browser timezone |
| `COLLECT_DEADLINE_MS` | `300000` | Hard stop for one collection run |
| `COLLECT_BROWSER` | `auto` | `auto`, `always` or `never` |
| `COLLECT_BROWSER_HEADLESS` | `true` | `false` shows the window while debugging |
| `COLLECT_BROWSER_CHANNEL` | unset | `chrome` uses real Chrome, not bundled Chromium |
| `COLLECT_BROWSER_DEBUG` | `false` | Write every fetched page and a screenshot to disk |
| `COLLECT_BROWSER_USER_AGENT` | unset | Overrides Chrome's own header; usually leave it alone |
| `COLLECT_CONCURRENCY` | `3` | Sources collected at once |
| `COLLECT_MAX_DETAILS` | `0` | Detail pages per run; off by default, see [collecting.md](collecting.md) |
| `COLLECT_ASSET_INTERVAL_MS` | `150` | Pacing for images, separate from pages |
| `COLLECT_BROWSER_PROFILE_DIR` | unset | Reuse a profile warmed up once by hand |
| `COLLECT_BROWSER_CDP` | unset | Attach to a browser you already run |
| `COLLECT_BROWSER_STEALTH` | `off` | `patched` applies fingerprint corrections |
| `COLLECT_BROWSER_BLOCK_ASSETS` | `true` | `false` loads images too |
| `COLLECT_BROWSER_TRACE` | `false` | Record every browser step to a trace zip |
| `COLLECT_BROWSER_SLOWMO_MS` | `0` | Pause between actions, for watching |
| `COLLECT_DEBUG_KEEP` | `50` | Traces and debug pairs kept per host |
| `COLLECT_SOLVER_URL` | unset | Byparr or FlareSolverr endpoint |
| `COLLECT_SOLVER_SOURCES` | unset | Which sources go through it |
| `COLLECT_SOLVER_TIMEOUT_MS` | `60000` | How long a challenge may take |
| `COLLECT_SOLVER_SESSION` | `true` | Reuse one solved session |
| `COLLECT_BROWSER_SETTLE_MS` | `1500` | Wait for client-side rendering |
| `COLLECT_SOURCE_DEADLINE_MS` | `60000` | Hard stop for one source |
| `COLLECT_PHOTO_BUDGET_MB` | `2000` | Photo store size before pruning |

`COLLECT_ENABLED_SOURCES` only sets the **initial** state. After that, sources
are switched in the UI under "Quellen" and the choice is stored in the database,
so an install is never one undiscovered env var away from finding nothing. Every
source shows its state and the reason for it: off, never run, blocked, or the
error from its last attempt.

`mock` is a deterministic in-process source. It needs no network and is what the
test suite exercises.

## Troubleshooting

**`EBUSY: resource busy or locked` during `npm install` on Windows.** A running
dev server or editor is holding files in `node_modules`. Stop `npm run dev`,
close any watching process, then:

```
rmdir /s /q node_modules
del package-lock.json
npm install
```

**`Unsupported engine`.** Node is older than 24. `node:sqlite` is unflagged from
Node 23.4 onward; below that it needs `--experimental-sqlite`, which the scripts
do not pass.

**Swapping the storage driver.** Everything SQLite-specific is in
`apps/api/src/db/index.ts` plus the repositories. Row types extend `SqlRow`, a
column-name map, so nothing outside that layer knows which driver is in use.

## Debugging a run

Why a car is missing has three possible answers, and each leaves a different trace.

**The portal never returned it.** The run's `fetched` count says how many came
back, and `nach N Seiten abgebrochen` says the page limit was reached with more
waiting.

**It was returned and then rejected.** Every criterion a source cannot express is
verified afterwards, and each rejection is logged with the criterion and the
value that failed it:

```json
{"source":"autouncle","criterion":"powerPs","found":"200 PS",
 "title":"Nissan Skyline R33 GTS","url":"https://…"}
```

The run also reports `N Treffer nachträglich aussortiert`, so a source whose
query is looser than the search shows up rather than looking merely unlucky.

**Something went wrong in the browser.** Record the whole session:

```
COLLECT_BROWSER_TRACE=true
npx playwright show-trace data/traces/www.autouncle.de/2026-08-09T11-44-02-123Z-001--de-gebrauchtwagen-Nissan-Skyline-page-2.zip
```

Every fetch gets its own trace and its own debug pair, under a directory per
host, named by timestamp and by the page fetched:

```
data/debug/www.autouncle.de/
  2026-08-09T11-44-02-123Z-001--de-gebrauchtwagen-Nissan-Skyline-s-min_hp-280.html
  2026-08-09T11-44-02-123Z-002--de-gebrauchtwagen-Nissan-Skyline-page-2.html
  2026-08-09T11-44-02-123Z-003--de-d-224706435-gebraucht-1998-nissan-skyline.html
```

Names sort into the order the fetches happened, so a directory listing is a
timeline of the run. `COLLECT_DEBUG_KEEP` (default 50) caps how many are kept per
host; the oldest go first. A file named after the host alone is overwritten by
the next fetch of that host, which is a snapshot of whatever happened last rather
than a record of the run.

The trace steps through every navigation, click and network call with a
screenshot and a DOM snapshot at each one. Pair `COLLECT_BROWSER_SLOWMO_MS=500`
with `COLLECT_BROWSER_HEADLESS=false` to watch it happen instead.

## Seeing what a portal actually served

A portal that refuses answers with HTTP 200 and a challenge page, so a status
code tells you nothing. Two ways to look:

```
COLLECT_BROWSER_DEBUG=true      # writes DATA_DIR/debug/<host>.{html,png} per fetch
npm run capture -- "<url>"      # fetches one page and saves it, headed if configured
```

`COLLECT_BROWSER_HEADLESS=false` opens a visible window, but a collection run
closes each page as soon as it has the markup, so the artefacts on disk are
usually more useful than watching. Both write a screenshot, which is the quickest
way to tell a bot wall from a cookie dialog.
