# Cosmic Return Navigator - frontend

Node + TypeScript. **No framework, no bundler.** `tsc` emits browser-native ES
modules into `public/dist/`, and a small Express server serves `public/` and
proxies the API.

## Run it

```bash
npm install

# terminal 1 - backend (must be on :4000)
cd ../backend && npm install && npm run dev

# terminal 2 - frontend
npm start            # builds the client once, then serves on :3000
```

Then open <http://localhost:3000>.

While working on client code, get incremental rebuilds with two terminals:

```bash
npm run watch:client   # tsc --watch -> public/dist
npm run dev            # tsx watch src/server.ts
```

`npm run typecheck` checks both the client and the server without emitting.

## Backend connection

The server proxies `/api/v1/*` to `http://localhost:4000` (override with
`BACKEND_URL`), so client code always uses same-origin relative paths and never
hits CORS. If the backend is down the proxy returns a 502 and the dashboard
falls back to a bundled sample snapshot, showing a "Sample data" badge.

## Layout

```
src/server.ts              static server + API proxy        [shared]
src/client/types.ts        backend contract mirror          [shared]
src/client/api.ts          envelope-aware fetch + unwrap    [shared]
src/client/format.ts       number/currency formatters       [shared]
src/client/main.ts         entry point - swap for a router  [shared]
src/client/mock.ts         fallback KPI snapshot
src/client/kpi-dashboard.ts   the executive KPI dashboard
public/index.html
public/styles.css          scoped to .viz-root
```

Files marked `[shared]` are deliberately thin and are expected to grow as other
pages land. Everything else belongs to the executive KPI dashboard.

## Adding a page

1. Add the response type to `src/client/types.ts`.
2. Add a loader to `src/client/api.ts` using the existing `unwrap` helper.
3. Write `src/client/<page>.ts` exporting `mount<Page>(root: HTMLElement)`.
4. Mount it from `main.ts` (or introduce a router there).

Note that `styles.css` is scoped under `.viz-root` so the dashboard's palette
cannot leak into other pages. Either reuse that scope or add your own.

## The executive KPI dashboard

Reads `GET /api/v1/analytics/kpis` (`KpiSnapshot`) and renders all 19 metrics.
The snapshot carries no time series, so the form is one hero figure plus stat
tiles rather than charts. Trend series live at `GET /api/v1/analytics/trends`
and belong to a separate trends page.

Two details worth knowing before editing `kpi-dashboard.ts`:

- **`direction` on each metric is load-bearing.** A falling cost and a falling
  CSAT are both negative deltas but opposite news, so delta colour is
  `direction x sign`. Setting this wrong silently reports good news as bad.
- **Delta direction is never colour-alone.** Each delta ships an arrow, an
  explicit `+`/`-` sign, and a "vs prior 30d" label. Keep all three.

A table view (toggle in the header) exposes every figure as text, and the page
has a selected dark mode rather than an inverted light mode.
