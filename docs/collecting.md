# Collecting

How a page is fetched, what each portal gives back, and what happens to a listing
between the portal and the database.

## Fetching a page

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
`COLLECT_MAX_DETAILS` (see [operating.md](operating.md)) above zero if you want
it, at roughly seven seconds per car
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

## What each source yields

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

## Adding a source without writing code

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

## Adding a source

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
