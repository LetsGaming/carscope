# Documentation

How the code is meant to be written and extended. The [project README](../README.md)
covers the other half: running it, configuring it, and what each portal does.

| Document | Covers |
|---|---|
| [architecture.md](architecture.md) | The four modules, which way dependencies point, and the seams between them |
| [conventions.md](conventions.md) | Types, casts, magic values, errors, naming, comments |
| [data-layer.md](data-layer.md) | Schema, repositories, row mapping, migrations, SQLite settings |
| [http-api.md](http-api.md) | Endpoints, validation, error shape, the SSE stream |
| [frontend.md](frontend.md) | View and logic separation, composables, design tokens |
| [testing.md](testing.md) | The four gates, what each suite covers, what earns a test |

## The short version

Three questions decide most changes:

1. **What boundary does this belong behind?** A service decides, a repository
   answers, a composable holds component logic, an adapter talks to a portal, a
   token carries a style value. Code that is about to go into a route handler or
   a Vue template is usually one of those instead.
2. **Does this shape already exist?** Countries, fuels, gearboxes, body styles,
   currencies, time constants and the market window all live in
   `packages/core`. Import them. A second copy of a list is a copy that drifts.
3. **Is it type-safe at the boundary?** No `any`, no suppressions, and no
   assertion on a query result, a query string or parsed JSON. Those go through
   a checked reader.

## The rules that came from a real bug

Each of these was a defect first and a rule second.

- **Do not assert an untrusted string into a union.** `?fuel=petrol'--` used to
  become a criterion the SQL filter compared against a column.
- **Do not copy a domain list.** The API accepted eleven countries and the UI
  offered eight, so Sweden, Switzerland and Poland could be collected and never
  selected.
- **Do not spread parsed JSON over a default.** A criteria blob written by an
  older build put a retired fuel back into a live search.
- **Trust the bytes, not the URL.** Photos are served from this origin, so an SVG
  stored as a photo is script running as the app.
- **Record a checksum for every migration.** Editing an applied one leaves old
  and new databases on different schemas with nothing reporting it.
- **Copy nested state deeply, or not at all.** Four criteria ranges shared one
  object, so typing a minimum price filled the mileage, year and power fields
  with the same number.
