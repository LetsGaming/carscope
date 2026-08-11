# carscope

Self-hosted aggregator for used-car listings across German and neighbouring EU
marketplaces. Deduplicates the same car across portals, snapshots asking prices
over time, and reports the price distribution behind a search.

Two modes share one data model: browsing current offers, and reading the market
those offers sit in.

## Status

| Part | State |
|---|---|
| `packages/core` | Complete, tested |
| `packages/collector` | Complete; parsers verified against captured pages |
| `apps/api` | Complete, tested |
| `apps/web` | Angebote, Markt and vehicle detail |
| Photo download and local serving | Complete, tested |
| Blocket / SE | Currency handling ready, adapter not written |

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

`.env` is read at startup. Settings there override the defaults in the table
below; `ENV_FILE` points somewhere else. **An empty value means unset**: a key
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
| `COLLECT_MAX_DETAILS` | `0` | Detail pages per run; off, see below |
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

## Architecture

```
packages/core        domain types, statistics, dedup scoring. No I/O.
packages/collector   one resilient HTTP client, source adapters, the run loop
apps/api             Fastify, SQLite, repositories, the market service
apps/web             Vue 3 + Vite
docs/                architecture, conventions and contracts for contributors
tests/               core, collector and api suites, mirroring the source tree
```

Dependencies point inward. `core` imports nothing. `collector` depends on `core`
and on a `CollectorStore` port, never on SQLite. `api` implements that port.
`apps/web` depends on `core` too, for the criteria shape, the country and fuel
lists and the unit conversions, so the client cannot offer a filter the API
rejects.

`docs/` covers how the code is meant to be written and extended:
[architecture](docs/architecture.md), [conventions](docs/conventions.md),
[the data layer](docs/data-layer.md), [the HTTP contract](docs/http-api.md),
[the frontend](docs/frontend.md) and [testing](docs/testing.md). This file stays
the operator's view: running it, configuring it, and what each portal does.

### Debugging a run

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

### Seeing what a portal actually served

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

### Adding a source without writing code

A portal that publishes schema.org data can be described in
`DATA_DIR/sources.json`. See `sources.example.json`:

```json
[{
  "id": "beispielportal",
  "label": "Beispielportal",
  "markets": ["DE"],
  "needsBrowser": true,
  "requiresMake": true,
  "url": "https://portal.de/suche?marke={makeSlug}&modell={modelSlug}&preis_max={priceMax}&seite={page}",
  "unsupported": ["text", "fuel", "gearbox"]
}]
```

Tokens available: `make` `model` `makeSlug` `modelSlug` `text` `textSlug`
`priceMin` `priceMax` `kmMin` `kmMax` `yearMin` `yearMax` `psMin` `psMax`
`kwMin` `kwMax` `fuel` `gearbox` `seller` `zip` `radius` `page` `market`. A
parameter whose token comes out empty is dropped, so an unset filter is absent
rather than blank.

Every entry is checked at startup. `id`, `label`, `url` and at least one known
`markets` code are required; an entry missing one is logged with its index and
skipped, and the other entries still load. A country code the domain does not
know is dropped rather than reaching a query.

Parsing reads schema.org `Car`, `Vehicle` or `Product`, bare or inside an
`ItemList`. Smaller portals still publish it; the big three no longer do. A page
carrying none reports a parse failure rather than nothing found.

### Adding a source

Three of the four adapters here were written twice, because the first version
guessed at the markup. Do it in this order instead:

1. Run the search by hand on the portal and **keep the URL**. Every query
   parameter in `buildQuery` came from a real URL, and every one that was guessed
   turned out wrong, including a power filter that read PS as kilowatts and cut
   the results to one.
2. Save the results page and trim it into `tests/fixtures/`.
3. Write `parseList` against the fixture. It is a pure `string → Result<ListPage>`,
   so the saved page is the entire test environment.

A source is one file implementing `SourceAdapter`:

```ts
export const blocket: SourceAdapter = {
  id: "blocket",
  label: "Blocket",
  markets: [MARKET.se],
  currency: CURRENCY.sek,
  minIntervalMs: 24 * HOUR_MS,
  unsupported: [CRITERION.gearbox, CRITERION.excludeDamaged],

  buildQuery(criteria, page, ctx) { /* → RequestSpec */ },
  parseList(body, spec) { /* → Result<ListPage> */ },
};
```

`markets` is a list, not a single country: AutoScout24 is one portal in eight of
them, and the collector queries a source once per country the search asks for.
Countries, fuels, gearboxes and body styles come from the constants in
`@carscope/core` rather than string literals, so a value the API rejects cannot
be written into an adapter.

Register it in `packages/collector/src/adapters/index.ts` and enable it through
`COLLECT_ENABLED_SOURCES`.

`unsupported` is required. Criteria a source cannot express in its query are
applied afterwards by the collector and surfaced in the UI, so a source that
ignores a filter never quietly widens a search.

Everything else (scheduling, throttling, timeouts, challenge detection,
deduplication, snapshotting, delisting, run bookkeeping) lives in the collector
and is not reimplemented per source.

## Searching

A search reaches the portals, not only the database. Submitting returns local
results at once and starts a **background collection job** for the same criteria.
Progress is pushed over SSE (`GET /api/events`) **per offer**, not per source, so
cars appear as they are parsed rather than when a portal finishes. The client
re-queries on a fixed cadence rather than once per event, which would be a request
per car. A proxy that buffers event streams falls back to polling automatically.

Portals search by make and model, not by free text: mobile.de wants numeric make
**and model** ids, and AutoScout24 puts both in the URL path. Free text is
therefore split before it is sent.

The vocabulary is mobile.de's own make list, 182 manufacturers extracted from
its search form, so this is not a hand-maintained list of a few brands. Makes of
several words are matched whole and longest-first, because `Rover` is a make in
its own right and `Land Rover Discovery` must not resolve to it. Common short
names map to what the portals call them (`VW` → Volkswagen, `mercedes` →
Mercedes-Benz, `alfa` → Alfa Romeo), and the canonical name is what goes into a
URL path.

Model names are translated to ids per portal by reading the model selector once
per make and caching it for a month; a model that cannot be resolved falls back
to searching the make and filtering afterwards. A query with no recognisable make
is **skipped with a reason** rather than sent as a bare `/lst`, which would
return the entire site.

Whatever a portal cannot express is verified against the results afterwards, so a
source can never widen a search by ignoring part of it.

Each source has its own deadline on top of the run's, so one portal that never
answers cannot consume the whole budget.

Collection never happens inside a request. Three portals behind a politeness
throttle, with blocked ones burning their full timeout, runs into minutes, long
enough that a synchronous request simply never returns. `POST /api/collect`
answers `202` with the job; `GET /api/collect` reports progress and the
per-source outcome. `COLLECT_DEADLINE_MS` stops a run that overruns and marks the
results partial rather than hanging.

That is safe to do on every submit because each adapter declares its own
`minIntervalMs` and the run is keyed by a hash of the criteria, so repeating a
A run that stopped at its page limit, or was cut off by its deadline, does not
start that window: it saw part of what the portal offered, and treating it as a
read left a source unasked for six hours while every search answered from half a
portal. Such a run is retried after five minutes, doubling per consecutive
failure up to the normal interval, so a portal that keeps refusing is not asked
by every search.

Makes and models are settled on the way in: a portal shouting "NISSAN SKYLINE"
is stored as "Nissan Skyline", so one car does not read as two. Only a word that
is entirely upper case is touched, and only when it is longer than three letters,
so BMW, VW and GMC keep their capitals; anything carrying a digit is left exactly
as found, because R34, RB25DET and 320d mean what they say.

A listing also records the portal it is actually on. AutoUncle is an aggregator,
and its results are adverts on mobile.de, AutoScout24 and others, so the result
list names that portal rather than answering "where is this car" with "AutoUncle".
Which source found it is still recorded on the listing.

When the same car appears on a second portal, each empty column is filled from
whichever advert knows it, and the fuller gallery wins. A source never overwrites
what another already established, so two disagreeing sources cannot make a row
flip between runs. The only exception is `first_registration`, where "1998-08"
replaces "1998" because it is the same fact stated more precisely. Prices are
never merged; they belong to a listing and live per source in `price_snapshots`.

search inside that window collects nothing. Nothing has to be saved first:
saving a search only adds it to the rail and to the scheduler.

Location can be narrowed two ways, and they combine:

Collecting is deliberately broader than searching. An adapter that cannot express
the free text says so in `unsupported`, and the collector then verifies only the
make and model, because requiring every word would discard a "Nissan Skyline
Nismo" for a search that said "Nissan Skyline R34". The SQL query behind the
result list does require every word. A search for "Nissan Skyline R34" therefore
stores every Skyline the portal returned and lists the ones whose make, model,
variant or advert title carry all three words.

Some search words name a build period rather than a word an advert must carry.
"R34" is one, and so are E46, W124, Mk4, 993, B7 and every other generation or
chassis code, in every market. No list of them could be kept complete, so they
are recognised from the collected data: if the adverts carrying a word occupy
less than half the years the rest of the search spans, and at least four do, the
word is read as that period. A car built in it then counts even when its seller
never wrote the code, which is how a genuine R34 headlined "GT-R V-Spec" used to
be missing from every search for one.

A word spread across the generations stays a word. "GTR" covered twelve of
twenty-one collected Skyline years, so it is matched literally rather than
pulling in every Skyline of the era.

This only ever widens: a car the literal match returns is always returned, so a
wrong guess costs a few rows to skim rather than a car the search will never
reveal. The report says which words were read this way and over which years, and
`excludedByText` says how many stored cars the wording still leaves out.

- **Country.** Nothing selected means every country a source covers.
- **Radius.** A postal code plus a distance.

Country is a search criterion, never a source setting. Choosing NL asks
AutoScout24 about `autoscout24.nl`; it does not turn a different source on.

A vehicle is filed under the country it **stands in**, not the portal that
advertised it. A car in Linz listed on mobile.de is AT, which is the only way a
country filter can mean anything.

## How pages are fetched

mobile.de sits behind Akamai and AutoScout24 behind DataDome. Neither answers a
plain HTTP request, so adapters that need a real browser say so:

```ts
export const mobileDe: SourceAdapter = {
  needsBrowser: true,
  …
};
```

`COLLECT_BROWSER=auto` launches Chromium only for those, and uses plain `fetch`
for everything else. `always` routes every request through the browser; `never`
disables it, and the adapters that need one then fail loudly instead of quietly
returning nothing.

One Chromium instance is launched lazily and reused. Each request gets a fresh
context, images and fonts are aborted, and the page is scrolled once after load
to trigger lazy-rendered rows. Photos are downloaded over plain `fetch`,
rendering an image in a browser is waste.

The browser sends **Chrome's own** user agent. Overriding it is how a request
gets caught: a header claiming a Chrome version the binary does not have is
inconsistent, and mobile.de checks that the browser is no more than twelve months
old. `COLLECT_BROWSER_USER_AGENT` exists but is best left unset.

### mobile.de

mobile.de runs Akamai Bot Manager. Every approach here has been tried against it
and none holds:

| Attempt | Result |
|---|---|
| Plain `fetch` | 403 |
| Headless Chromium, corrected fingerprint | 403 |
| Consent handling, warm-up navigation, sensor wait | 403 |
| Headed, real Chrome, persistent profile | 403 |

The same machine, the same connection and the same residential IP are served
normally by an ordinary browser, so this is not about the network. What is left
is the automation layer.

Fingerprint patching is **off by default**, and deliberately so. Replacing
`navigator.webdriver` with a getter that returns `undefined` leaves
`Object.getOwnPropertyDescriptor(navigator, 'webdriver').get.toString()` reading
`() => undefined` where a real browser reads `function get webdriver() { [native
code] }`. The same applies to every other patch. Against a naive check they help;
against a good one each one is a fresh tell, so an unpatched Chrome passes more
of them than a patched one. `--disable-blink-features=AutomationControlled` does
the same job in the browser rather than in the page.

To see which check actually fails rather than guessing:

```
npm run fingerprint                                        # bot.sannysoft.com
npm run fingerprint -- https://abrahamjuliot.github.io/creepjs/
```

It loads the test page with the browser exactly as configured and saves a
screenshot under `DATA_DIR/fingerprint`. The red rows name what to change.

**The route that works is AutoUncle.** It is a meta-search that already
aggregates the portals, and it labels every listing with the one it came from. A
single search for a Nissan Skyline returned nineteen listings: eight from
Kleinanzeigen, seven from AutoScout24 and **four from mobile.de**. So mobile.de's
offers arrive after all, without touching mobile.de.

`mobile.de` is therefore off by default and `autouncle` is on. Leaving the direct
adapter in place costs nothing and it will start working again if the checks ever
relax.

### Portals behind Cloudflare

AutoUncle sits behind Cloudflare's interstitial, which is a different problem
from Akamai's scoring: it can be passed, it just has to be passed by something
that waits it out. That is delegated to
[Byparr](https://github.com/ThePhaseless/Byparr) or FlareSolverr rather than
solved here, where it would be the same arms race again:

```
COLLECT_SOLVER_URL=http://127.0.0.1:8191/v1
COLLECT_SOLVER_SOURCES=autouncle
```

The solver drives its own browser, so for those sources it replaces ours. One
session is created and reused where the solver has sessions, because solving the
challenge again for every page is the slow part, and handed back on shutdown.

Not every FlareSolverr-compatible solver does. Byparr accepts `cmd` for
compatibility and ignores it, so it reads the session probe as an ordinary fetch
and never names a session. carscope then runs sessionless against it and logs
`solver runs without a session` once, with the reason. The probe carries the page
that was about to be requested anyway, for two reasons: Byparr's own `url`
default is the bare string `https://`, which its browser cannot navigate to, and
a solver that answers the probe with the page has already done the work, so that
answer is used rather than asking the portal for the same URL a second time.

**The solver does not replace the browser.** Where a source is listed in
`COLLECT_SOLVER_SOURCES`, the solver is tried first, because getting past an
interstitial is what it is for. The two are not interchangeable: they present
differently to bot protection, and AutoUncle refuses the solver's headless
browser while serving ours. A refusal from the solver therefore falls through to
the browser the adapter asked for, and only when both are refused does the source
report `refused both the solver and the browser`. Previously the solver
superseded the browser outright, so a portal we could fetch was reported
unavailable while a working transport sat unused.

**Headless Chrome names itself.** It writes `HeadlessChrome` into its user
agent, its client hints and `navigator.userAgent`, and Cloudflare reads all
three. A trace of a headless run against AutoUncle showed `HeadlessChrome/151`
on every request, a challenge on the first navigation, and a 403 that never
cleared. The correction is now applied whenever the binary names itself that
way, along with matching client hints and the JS property, rather than only
under `COLLECT_BROWSER_STEALTH=patched`. Headful Chrome names itself correctly
and is left alone.

That is a name, not a fingerprint. It gets past a check that reads the string;
it does not make a headless browser look headful to one that measures rendering,
so `COLLECT_BROWSER_HEADLESS=false` remains the stronger setting.

**A solved page can arrive carrying the interstitial's status.** Byparr reports
the status of the first navigation and only rewrites it to 200 when it
recognised the challenge by page title. Cloudflare's managed challenge answers
403 and then clears itself, so a full results page arrives with a 403 on it.
Reading that status alone reported the portal as having refused the request. The
body decides instead: a page under 20 kB, or one still carrying a challenge
marker, stays blocked; a substantial page that no longer looks like a challenge
is treated as the page it is. `docker compose --profile solver` runs Byparr
alongside; one running elsewhere is used by address instead.

It is wired in as a transport behind the same client as everything else, so a
solver that is down reads as *that source* being unavailable, with the solver's
own words attached, rather than as a source that found nothing.

### When a portal refuses a synthesised browser

mobile.de runs Akamai Bot Manager, which scores a session from telemetry its own
script posts and records the verdict in an `_abck` cookie. Matching its checks by
hand is a race that gets re-run on every Akamai update, so the durable answer is
to stop synthesising a browser and use a real one.

**A warmed profile.** One-time setup, unattended afterwards, works in Docker:

```
npm run warmup -- https://suchen.mobile.de/
```

A window opens. Accept consent, solve whatever it asks, browse for a moment,
close it. The profile under `DATA_DIR/browser-profile` keeps the cookies and
local storage that follow, and `COLLECT_BROWSER_PROFILE_DIR` makes the collector
reuse that same profile from then on.

`data/` is runtime state and is not in git, so a profile warmed on a desktop does
not reach a server by itself, and it must never be committed, because it holds live
session cookies. Move it deliberately:

```
npm run session -- export ./mobile-session     # on the machine you warmed up
scp -r ./mobile-session server:/srv/carscope/
npm run session -- import ./mobile-session     # on the server
```

Caches and crash logs are skipped, so what travels is the session rather than a
few hundred megabytes of Chromium scratch space.

**This does not defeat Akamai.** A warmed profile helps with consent walls and
with portals that merely dislike a cold session. mobile.de detects the automation
protocol itself, which no profile fixes. See below.

**Attaching to a browser you already run.** `COLLECT_BROWSER_CDP=http://127.0.0.1:9222`
against a browser started with `--remote-debugging-port=9222`. Strongest
fingerprint of all, but it needs that browser running, so it suits a desktop
rather than a container.

If a portal still refuses, set `COLLECT_BROWSER_CHANNEL=chrome` and install it
with `npx playwright install chrome`. Bundled Chromium differs from real Chrome
in ways bot protection reads (codecs, build flags, whether the user-agent it
claims matches the binary), and that is the strongest remaining lever. The Docker
image installs Chrome and uses it by default.

Stylesheets are deliberately **not** blocked: a page that renders without any CSS
is itself a headless tell. For the same reason an init script runs before any
page script to hide the obvious ones (`navigator.webdriver`, an empty plugin
list, a missing `window.chrome`), and the context declares a viewport, a locale
and a timezone.

Every German portal puts a consent wall in front of its results, and a page that
is nothing but a cookie dialog is not a bot block. The wall is dismissed under a
hard 2.5 s budget: all selectors go into one locator, and only frames belonging
to a consent vendor are considered, because a results page carries a dozen advertising
iframes, and probing each selector in each of them costs more than the whole
source is allowed to take.

Cookies are kept per host under `DATA_DIR/browser-state`, but only when consent
was actually given and only for twelve hours. Writing state on every request
persists whatever cookie a challenge handed out, and the block then sticks across
attempts.

**Failure is never silent.** The browser is wired in as a transport behind the
same client every other request uses, so a launch failure, a missing binary, a
timeout or a bot challenge all become a typed `AppError` and land in the run's
per-source status. A source that cannot fetch reads *blocked* or *error* with the
reason attached, never "0 results". A missing Chromium reports the exact command
that installs it.

## Detail pages

A list row carries a fraction of what a listing says: Kleinanzeigen shows one
thumbnail and no seller text at all. The detail page is fetched once per vehicle,
and again for any car left with at most a cover photo. Marking a fetch done
permanently means a parser that improves later can never reach the cars collected
before it, which is exactly how a gallery fix left every existing car with one
picture.

Galleries are read from lazy-loading attributes, `srcset`, CSS
`background-image` and embedded JSON as well as `src`, across every image host a
portal uses. Kleinanzeigen moved from the shared classifieds CDN to
`img.kleinanzeigen.de`, and matching only the old host reduced a 17-photo
gallery to the single cover thumbnail. A lazy gallery only writes `src` when a picture is about to be
shown, and the collector aborts image requests, so `src` alone finds exactly one
photo, the cover. Descriptions keep their line breaks: a classified ad is
usually a list, one modification per line, and collapsing it to a paragraph
destroys the only structure it had. `detail_fetched_at` is what makes that
once-only; it costs one request per new car and nothing thereafter.

Detail pages are **off by default**, because the two things they were fetched for
are largely on the list page already.

Photos were the expensive one. Kleinanzeigen's list page ships the data its own
client hydrates from, and that carries every advert's full gallery, not just the
thumbnail in the article markup: eleven to twenty-six pictures per car, against
the six `MAX_PHOTOS_PER_VEHICLE` stores. Reading it there costs nothing, where a
detail page cost about seven seconds each and spent a whole run's budget on
eleven cars.

Descriptions are the part that is not free. The list page carries a 250-character
teaser; the full text, around 3.500 characters, is only on the ad page. Set
`COLLECT_MAX_DETAILS` above zero if you want it, at roughly seven seconds per car
and knowing the source deadline bounds how many fit. A detail page is only
started while a full `COLLECT_TIMEOUT_MS` of the budget is left; the rest keep
`detail_fetched_at` unset for the next run, and the source says how many it
deferred.

## Photos

Photos are downloaded on the run that first sees a vehicle, or when its image set
changes, and written under `DATA_DIR/photos/<prefix>/<vehicle-id>/`. The API
serves them from `/media/`, and the client only ever sees a local path.

Only PNG, JPEG and WebP are stored, decided by the file's leading bytes rather
than its URL or its `content-type`. Stored photos are served from the app's own
origin, so an SVG accepted here would be script running as the app. Anything else
keeps its remote URL and nothing is written to disk.

The image-set hash is taken **after** enrichment. Hashing the list page's single
picture never changes, so the gallery behind it never gets fetched.

Photos are fetched together rather than one at a time, and paced by their own
interval: the politeness delay that belongs on a search page turned six images
into fifteen seconds per car, which was more than everything else in a run
combined.

Portals serve several sizes of each asset, so a gallery-sized variant is
requested rather than the original, roughly an order of magnitude smaller.
Once the store passes `COLLECT_PHOTO_BUDGET_MB`, photos of **delisted** vehicles
are pruned oldest-first: their price history is the part worth keeping, and
nobody browses a car that sold two years ago.

Hot-linking would be simpler and useless: an advert takes its images offline the
moment it is delisted, which is exactly when the price history becomes worth
looking at. Re-fetching is keyed on the image-set hash, so an unchanged set costs
nothing on later passes. `MAX_PHOTOS_PER_VEHICLE` caps storage at eight per car.

Set `COLLECT_STORE_PHOTOS=false` to record source URLs without downloading.

## Days on market

How long an advert has been up is a property of the advert, not of when we
started watching. `first_listed_at` holds the portal's own figure where it
publishes one (AutoUncle states `laytime` outright, Kleinanzeigen dates its
listings "Gestern, 15:40"), and a later run fills it in if a source that knows
it turns up after one that did not.

Where no source says, the figure is how long **we** have been watching, and the
UI says so: *seit 12 Tagen beobachtet* rather than *seit 12 Tagen online*, and
*neu erfasst* rather than *0 Tage online*, which is a claim about the advert that
a first sighting cannot support.

## Units

Engine power is stored in **watts**, not kilowatts. A 206 PS advert stored as
152 kW reads back as 207 PS, and a tool for judging cars should never round the
number on the windscreen. Watts round-trip both units exactly; the UI shows PS.

## Schema

There is no authentication. carscope is a single-user self-hosted tool and
assumes a trusted network; exposing it publicly needs an authenticating proxy in
front, and the write endpoints would need rate limiting.

`001_init.sql` is the whole schema. There is nothing to migrate from yet, so it
is kept as one baseline rather than a chain recording how it was arrived at.
While there are no deployments, that history is development noise. Once something
is running on it, changes become numbered migrations and the baseline is frozen.

Migrations run in one transaction each and are recorded in `schema_migrations`
with a SHA-256 of the file. Editing a migration that has already run makes the
server refuse to start, because the alternative is one database on the old schema
and the next on the new one with nothing saying so. Adding `002_…sql` is all it
takes.

## Delisting

A vehicle is retired when none of its listings are live any more. Two details
keep that from retiring cars that are simply mid-collection:

- The listing row is written **immediately** after the vehicle is resolved,
  before the detail page and the photos. Those take seconds, and for that whole
  window the vehicle would otherwise look like one with no listings at all.
- The sweep only considers vehicles **not seen during the current run**. Sources
  collect concurrently, so an unscoped sweep lets one source retire a car another
  source is still writing.

Retiring a car removes it from active results and keeps every price ever observed
for it, which is the part the market view is built on.

## How deduplication works

The same car cross-posted to three portals must become one vehicle, or the price
history is meaningless.

1. **Exact source identity.** A `(source_id, source_listing_id)` already seen is
   the same car by definition. Fuzzy matching never runs for it.
2. **Candidate narrowing.** A coarse `identityKey` of make, model, first
   registration, a 2.000 km mileage bucket and market, plus, separately, any
   vehicle of the same make with the exact same mileage. Without that second
   lookup, two portals that name the model differently are never even compared.
3. **Certainty.** Same make, same mileage to the kilometre and the same price to
   the euro is one car listed twice. The **model is deliberately not part of this
   test**: one portal calls a car a Skyline and another an R34, and that
   disagreement says nothing about whether it is the same car. Registration is
   compared by common prefix, because one portal may know only the year where
   another knows the month.
4. **Scoring.** `matchScore` weights a shared image-set hash most heavily, then
   the identity key, title overlap, seller, price, mileage and power. Merge at
   0.72.

The threshold is deliberately conservative. Duplicates are visible and annoying;
a false merge silently corrupts a price series.

## What the statistics will and will not claim

- **History cannot be backfilled.** Nothing public exposes historical asking
  prices. The database starts empty and accumulates from the first run.
- **Thin months are marked.** Below five vehicles a month is flagged unreliable
  and drawn faded. A rising line built on three cars is not a trend.
- **Price factors are gated twice.** A factor is hidden unless both groups have
  at least 15 vehicles *and* the median gap exceeds 35 % of the pooled
  interquartile range. A large sample makes a small difference reportable, not
  meaningful. These are unadjusted group differences, not a hedonic model.
- **Currency is fixed at observation time.** Snapshots store the original amount,
  the rate used, and the base-currency amount, so later FX moves never rewrite
  history.

## What each source actually yields

Parsers are pure `string → Result<ListPage>` and are tested against captured
result pages in `tests/fixtures/`. The three portals expose very different
amounts of data on a list page:

| Field | mobile.de | Kleinanzeigen | AutoScout24 | AutoUncle |
|---|---|---|---|---|
| Price, mileage, first registration | yes | yes | yes | yes, month precision |
| Power | yes | **no** | yes | yes |
| Gearbox | **no** | **no** | yes | yes |
| Body style | **no** | **no** | **no** | yes |
| Seller type | yes | **no** | yes | yes |
| Postal code and city | yes | yes | yes | yes |
| Photos | several | one | all | several |
| Days on market | **no** | posting date | **no** | yes |

The gaps are the pages, not the parsers. mobile.de omits gearbox from its result
rows; Kleinanzeigen shows only price, mileage and registration. Both would need a
detail fetch per listing to fill in, which multiplies request volume by roughly
the page size, deliberately not done. Filtering is unaffected: Kleinanzeigen
accepts `autos.power_i` and `autos.shift_s` in the query even though it does not
print them.

Each source reads its data from a different place, and none of them from the same
one:

- **mobile.de** renders to DOM with no JSON-LD vehicle block and no state blob.
  Parsing anchors on `base-result-listing-N` ids and `data-testid` attributes;
  the CSS class names are hashed per deploy and nothing keys on them.
- **Kleinanzeigen** renders to DOM. Each `<article data-adid>` embeds its own
  JSON-LD `ImageObject` carrying the advert title and cover photo.
- **AutoScout24** ships a Next.js payload; listings come from
  `props.pageProps.listings`.
- **AutoUncle** is a Next.js App Router document. The **rendered cards** are the
  set of listings, and the RSC flight payload pushed through `self.__next_f` is
  merged in for its cleaner values. Taking the payload alone missed cards added
  during hydration, which exist on the page and in no streamed chunk. It also
  states its own result count, which is compared against what was understood. The listings arrive complete in
  the RSC flight payload, pushed as string chunks through `self.__next_f`. The
  payload is not valid JSON as a whole, so each listing is recovered by
  brace-matching outwards from a key only listings carry. Every record names the
  portal it came from, which is why one request covers three.

Automated collection from these portals is against their terms of service. This
is built for single-user, self-hosted use at a polite request rate.

### Kleinanzeigen URL grammar

Two filter grammars share one URL, which is worth knowing before editing:

```
/s-autos/anbieter:privat/preis:20000:60000/nissan-skyline-r34/k0c216l4279+autos.power_i:280,+autos.shift_s:manuell
         └─ generic filters, path segments ─┘ └─ keyword ─┘ └ category ┘└ location ┘└─ attributes, joined with + ─┘
```

Ranges after `k0c216` use a **comma**; the `preis:` segment before it uses
colons. Attribute values are German (`manuell`, `automatik`, `limousine`).

### Why is this car not in my results

A listing can be lost at four points, and reading the HTML by hand cannot tell
them apart. `npm run explain` runs the first two exactly as a collection run
does, against a page already on disk:

```
npm run explain -- autouncle data/debug/www.autouncle.de/<file>.html \
  --year 1998-2002 --ps 280- --find 224706435
```

It prints every listing the parser found with the values the search query
compares against, every listing the gap filter rejected and which criterion did
it, and, with `--find`, whether that one listing survived both. If it did, the
loss is the search query or a run that was cut short, not the parser.

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

## Tests

```
npm test                                    # 199 tests
npm run typecheck                           # tsc + vue-tsc
npm -w @carscope/web run build              # the web build is a gate too
```

CI runs all four on Node 24. A change lands when every one is green; see
[docs/testing.md](docs/testing.md) for what belongs in which suite.

Suites live in `tests/`, mirroring the source tree:

```
tests/core/       statistics and dedup scoring, pure functions, tested directly
tests/collector/  German-locale parsing, the run loop, and adapters against fixtures
tests/api/        the HTTP surface via app.inject, on an in-memory database
tests/fixtures/   captured result pages, trimmed to three listings each
```

The fixtures are real captures. To refresh one, save a result page from the
portal and trim it to a handful of listings. The parsers never touch a network,
so a saved page is the whole test environment.
