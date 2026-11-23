# Domain rules

What counts as the same car, what a search word means, and what the statistics do
and do not claim.

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

A car's own model field has the last word. A Stagea advertised as "Skyline
RB26" mentions the searched word in its title but is not a Skyline, so when the
search names a model, the collector and the SQL query both require the car's
model to be one of the searched words or an alias of one (`MODEL_ALIASES` in
`packages/core/src/criteria.ts`: R32, R33 and R34 are Skylines). A portal with
no model field is judged by the word after the make in the title. The SQL rule
needs the `model` field of the criteria; a search typed only as free text is not
checked against the stored model.

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

## How deduplication works

The same car cross-posted to three portals must become one vehicle, or the price
history is meaningless.

1. **Exact source identity.** A `(source_id, source_listing_id)` already seen is
   the same car by definition. Fuzzy matching never runs for it.
2. **Candidate narrowing.** A coarse `identityKey` of make, model, first
   registration, a 2.000 km mileage bucket and market, plus, separately, any
   vehicle of the same make with a mileage within 250 km. Without that second
   lookup, two portals that name the model differently are never even compared.
3. **Certainty.** Same make, same mileage to the kilometre and the same price to
   the euro is one car listed twice. The **model is deliberately not part of this
   test**: one portal calls a car a Skyline and another an R34, and that
   disagreement says nothing about whether it is the same car. Registration is
   compared by common prefix, because one portal may know only the year where
   another knows the month.
4. **Attributes.** Portals round: one prints 89,750 km and a registration of
   June, the other 89,745 km and July, at the same price. `isAttributeMatch`
   merges when make and gearbox are equal, power is within 1 kW, mileage within
   250 km, price within 1 %, and registration within 2 months (a bare year fits
   any month in it). Every value must be known on both sides: a missing gearbox
   is not agreement. The tolerances are constants in `packages/core/src/identity.ts`.
   The 1 % price limit is what keeps an R34 at €44,900 apart from one at
   €44,444 when their other figures are close.
5. **Re-posted adverts.** A seller re-posts when an advert runs out and edits it:
   a cheaper price, a corrected odometer. `isSamePlaceMatch` merges two adverts
   of one make in the same known town (neither from a dealer) when mileage is
   within 5 %, registration within 12 months, known power and gearbox agree and
   the titles share half their words. The price is not compared. A title that
   is only make, model, year and power (an aggregator card) cannot be compared,
   so the price has to be within 15 % instead.
6. **Sparse cards.** A card with at most one of mileage, registration, power and
   gearbox matches by `isSparseMatch`: same make, same town, exactly the same
   price, and nothing it does state contradicts the other advert.
7. **Scoring.** `matchScore` weights a shared image-set hash most heavily, then
   the identity key, title overlap, seller, price, mileage and power. Merge at
   0.72.

The threshold is deliberately conservative. Duplicates are visible and annoying;
a false merge silently corrupts a price series.

Unknown is never evidence. Two cards that state neither a registration nor a
mileage share the key `nissan|skyline|x|x|DE` whatever they are, so the key only
counts when something in it is known on both sides. A Nismo card once joined the
Rodenbach card that way. When several stored cars fit, `matchRank` picks the one
with the strongest rule and then the highest score, not the first the database
returns. Places compare by postal code when both sides have one (a district and
its city share a code, two towns of one name do not) and by city otherwise.

When two cars merge, each fact comes from the fresher one (for sale before
ended, then the later sighting), because after a re-post the old advert's
odometer and registration are the stale ones. Two prices seen at the same
instant from the same source both stay: the clashing one moves a millisecond.

Rules 3 to 6 also run over what is already stored, once at the end of every
collection job (`VehicleRepository.consolidate`). A duplicate that predates a
rule, or whose gearbox only arrived with the detail page, would otherwise stay
split, because a known advert skips matching. Merging keeps the vehicle with the
lower rowid, since the webhook watermark and the public cursor ride on it, and
moves the listings and price snapshots over. Hidden cars are not merged. Photos
of an advert that was still being fetched while its vehicle was merged can fail
to save; the next run repeats them.

## Held listings

Some adverts are not cars for sale. They are stored, because the next run has
to recognise them, but they are held: left out of lists, statistics, the feed and
webhooks. `holdReason` in `packages/core/src/hold.ts` decides, and it decides
again after every price and every detail page, so a hold lifts itself.

- **wanted:** a buyer's advert. A title or URL slug that starts with "Suche",
  "Gesuch" or "Ankauf", or a description that says "suche" within 40 characters
  of the car's name. "Suche neuen Besitzer" and "suche keinen Tausch" are
  sellers. A wanted ad never takes part in duplicate matching. Its km and
  registration are the buyer's limits, not a car's.
- **placeholder_price:** under 100 EUR (Kleinanzeigen shows "VB" as 1 EUR), or a
  description that calls the price a placeholder. Digit patterns such as 44444
  decide nothing: that is a price some sellers choose on purpose. The car is
  listed as soon as it reports a real price.

A person can overrule either with "Freigeben" on the held list. The car then
stays listed whatever the rules say. A car released later is not announced to
webhooks (see the cursor note in `http-api.md`).

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

