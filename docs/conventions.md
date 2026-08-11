# Conventions

TypeScript, everywhere, at the strictest settings the compiler offers.

## Compiler settings are not negotiable

The root `tsconfig.json` sets `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`noUnusedLocals`, `verbatimModuleSyntax` and `erasableSyntaxOnly`. `apps/web` has
its own config for the DOM and Vue, at the same strictness.

`erasableSyntaxOnly` exists because the server runs TypeScript through Node's
type stripping. There is no build step and no emit, so no `enum`, no parameter
properties, and no other syntax that would need one. `tsc` is a checker.

## No escape hatches

No `any`, no `@ts-ignore`, no `@ts-expect-error`, and no disabling a rule to make
something compile. Where indexed or optional access yields `T | undefined`,
narrow it rather than asserting it away with `!`.

## Casts

An assertion on untyped data is `any` with extra steps: it claims a shape without
checking one, so a changed field still compiles and fails at runtime, at exactly
the boundary the types existed to guard.

Three sources of untyped data matter here, and each has one reader:

```ts
// SQL results: db/index.ts
const rows = allRows<VehicleRow>(db.prepare(VEHICLE_BY_ID), id);

// Query strings and stored columns: the core parsers
const fuel = toFuel(query.fuel);        // Fuel | null, never "banana"

// Parsed JSON: a checked reader per shape
const criteria = readCriteria(row.criteria);   // repositories/criteria-json.ts
```

The assertions that remain are each inside a single audited function, after a
membership check or behind a compiled response schema:

| Location | Why it is allowed |
|---|---|
| `db/index.ts` `allRows` / `getRow` | SQL shapes are not knowable to the compiler. Two functions, both feeding a mapper. |
| The core parsers, `toRunStatus`, `toBrowserMode` | Assertion follows a `Set` membership check in the same expression. |
| `apps/web/src/lib/api.ts` `request<T>` | Every route serialises through a compiled response schema, so the shape is enforced server-side. |
| `useCollectionProgress.ts` `readJob` | The SSE payload is the contract the polling endpoint already serves. |

Adding a fifth needs a reason of that kind. Sprinkling one at a call site does
not qualify.

## Shapes

- **A `const` object plus a derived type, never an `enum`.** `erasableSyntaxOnly`
  forbids `enum` anyway, but the pattern is also what lets one object drive a
  request schema, a parser and a value list.
- **Discriminated unions over a loose `status: string`,** so an unhandled case is
  a compile error.
- **`readonly` on domain types.** Wire types are mutable because the serialiser
  needs them to be; the mapping from one to the other is explicit
  (`toSearchDto`, `toReportDto`, `toVehicleDto`).
- **One definition per shape.** A type needed by more than one layer lives in
  `core`. Redefining `Criteria` in the client is what let the UI and the API
  disagree about which countries exist.

## Errors

Expected failures are return values. `throw` is for the genuinely exceptional.

```ts
const body = await http.getText(url, { browser: true });
if (!body.ok) return { status: RUN_STATUS.blocked, note: body.error.message };
```

A portal being slow, blocked or unparseable is normal, so `Result<T, AppError>`
carries it with a `FAILURE` kind and a `retryable` flag. The collector never
throws for these.

Inside `apps/api`, a route throws `NotFound` or `Invalid` and one
`setErrorHandler` maps it to a status and a body. Handlers never build
`reply.code(400).send(...)` themselves. A 5xx response says `request failed` and
nothing else; the detail goes to the log.

`catch {}` that swallows everything hides bugs. Catch the expected case and let
the rest surface. Where a failure is deliberately tolerated, the comment says
what is being tolerated and why.

## Magic values

A literal that carries meaning gets a name, in the module that owns it.

```ts
// no
if (r.seller_type === "dealer") …
const ageDays = (Date.now() - t) / 86_400_000;

// yes
if (r.seller_type === SELLER.dealer) …
const ageDays = (Date.now() - t) / DAY_MS;
```

A shared constant that holds nested objects is frozen, and comes with a factory
beside it for callers that will write to the result. `EMPTY_CRITERIA` is one
object with one `EMPTY_RANGE` in all four range fields, so a shallow copy plus a
write to `priceEur.min` used to reach `mileageKm`, `registrationYear`, `powerPs`
and the constant itself. `emptyCriteria()` and `copyCriteria()` rebuild the
nesting; the freeze makes the mistake throw at the line that makes it.

Shared values live in `core`: `MARKET`, `FUEL`, `GEARBOX`, `SELLER`, `BODY`,
`CURRENCY`, `SECOND_MS` / `MINUTE_MS` / `HOUR_MS` / `DAY_MS`,
`DEFAULT_WINDOW_MONTHS`, `LOW_MILEAGE_KM` and the sample thresholds. Values used
in one module stay there as a named constant: `BAND_SIZE_EUR` in the market
service, `MAX_PHOTOS_PER_VEHICLE` in the photo store, `GRACE_MS` in the collector
plugin.

Style values are tokens. See [frontend.md](frontend.md).

## Naming and comments

Names state intent. Booleans read as predicates. A file called `useSearches.ts`
exporting `useWorkspace` is a defect of the same kind as a wrong type.

Comments explain **why**, not what. The codebase is full of the useful kind:

```ts
// Recorded before anything slow: between creating a vehicle and giving it
// a listing, it looks abandoned to the delisting sweep.
```

That comment stops someone reordering two lines and reintroducing a bug. A
comment restating the code beneath it is noise. Commented-out code is deleted;
git remembers it.

## Language

Code, comments, documentation and log messages are English. Text a user reads is
German, because the UI is German. `note` fields on a collection run reach the UI,
so they are German; the log line beside them is not.
