# Frontend

Vue 3 with `<script setup lang="ts">`, Vite, vue-router. No state library: the
app has one workspace and one detail page, and a store would be ceremony.

## Layering

```
views/       route-level containers. Wire children, hold page state, stay thin.
components/  render and emit. No fetching, no routing, no business rules.
lib/         composables (reactive state), the API client, formatters, wire types.
styles/      tokens.
```

The test for placement: logic you cannot unit-test without mounting a component
is in the wrong layer.

- `WorkspaceView.vue` composes the filter bar, the search rail, the result list
  and the market pane, and holds view-only state such as the active tab and the
  sort order.
- `useWorkspace` owns searches, criteria, results and the report.
- `useCollectionProgress` owns the SSE stream, the reconnect attempts and the
  polling fallback.
- `api.ts` is the only module that calls `fetch`.

Splitting the two composables is deliberate. One file did both, so reading how a
search is saved meant reading exponential polling backoff.

## The domain comes from core

`apps/web` depends on `@carscope/core`. `Criteria`, the country and fuel lists,
`wattToPs`, `DAY_MS`, `DEFAULT_WINDOW_MONTHS` and `LOW_MILEAGE_KM` are imported,
not restated. The client held its own copies once, and the lists drifted: the API
accepted eleven countries and the UI offered eight.

`lib/types.ts` keeps only what is genuinely wire-shaped, plus `EditableCriteria`,
a mutable mapping of the readonly domain `Criteria` for form binding.

## Props and models

Props go down, events come up, and a component never writes to a prop. Where a
child edits a parent's object, it takes a model:

```ts
const criteria = defineModel<EditableCriteria>({ required: true });
defineProps<{ loading: boolean; collecting: boolean }>();
const emit = defineEmits<{ search: [] }>();
```

`FilterBar` used to receive `criteria` as a prop and push into
`props.criteria.markets`. `defineModel` gives the same two-way binding without a
component reaching into its parent's state.

Derived values are `computed`. Watchers are for side effects, not for mirroring
one piece of state into another.

## Design tokens

`styles/tokens.css` holds every colour, spacing step, radius and font stack, plus
the dark theme under `[data-theme="dark"]`. Components reference tokens and never
a raw value:

```css
.chip { padding: 5px var(--s3); border: 1px solid var(--line-2); }
.step { background: var(--scrim); color: var(--on-scrim); }
```

That includes overlays over photography (`--scrim`, `--scrim-strong`,
`--scrim-soft`) and the placeholder illustration palette (`--tone-1-back` through
`--tone-6-fore`), which a component picks by index. Inline SVG reads them the
same way. A component holding its own colour array is the half-tokenised failure:
finish the token set instead, and add a token before introducing a raw value.

`<style scoped>` on every component, so none can leak CSS into another. `App.vue`
carries no styles at all; the global layer is `tokens.css`.

## App shell

`index.html` declares an SVG favicon, a 180 px apple-touch-icon and a web
manifest, all served from `public/` and versioned with the build. Fonts are the
system stack; there are no third-party style or font requests.

## Safety and accessibility

No `v-html` anywhere. Inputs carry real labels or `aria-label`, the country and
sort toggles report `aria-pressed`, the button that opens the source panel
reports `aria-expanded`, and the error line is `role="alert"`. Contrast comes
from the tokens, so it stays consistent across both themes.

## Dev and build

`npm run dev` starts the API on 8080 and Vite on 5173, with `/api` and `/media`
proxied. `npm -w @carscope/web run build` runs `vue-tsc` and then Vite, and is one
of the four CI gates. In the container the API serves the built SPA itself, and
`setNotFoundHandler` returns `index.html` for anything that is not `/api/`.
