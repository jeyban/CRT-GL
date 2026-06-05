# Top 30 Gainers & Losers — CRT Scanner Module

A **completely separate, additive module** bolted onto the existing CRT Scanner project.
It scans only the **Top 30 Gainers** and **Top 30 Losers** on MEXC Futures (duplicates
removed) using the **exact same CRT engine** as the core project (`backend/services/crtLogic.js`),
which is imported and reused **as-is** — no CRT rule, calculation, validation, filtering,
or signal logic was changed or duplicated.

The existing scanner (`/api`) is untouched. This module lives entirely under `/api/gl`
and new `gl*` files.

---

## What was added (no existing file logic changed)

```
backend/
  routes/gainersLosers.js        # Express router mounted at /api/gl
  services/gl/
    glMexc.js                    # Top 30 gainers/losers fetch + dedupe + klines/price
    glScanner.js                 # Scan pipeline — REQUIRES ../crtLogic and calls detectCRT as-is
    glScheduler.js               # Independent 1H / 4H / Daily crons + next-scan math
    glStore.js                   # Persistence: in-memory + local JSON + optional Supabase
    types.d.ts                   # TypeScript ambient types for the module
  gl-schema.sql                  # Optional Supabase schema (gl_state, gl_history, gl_logs)
frontend/
  index.html                     # NEW ENTRY POINT — full responsive GL dashboard (new workflow/environment)
  gainers-losers.html            # Same dashboard, kept as an alias of index.html
  legacy-crt-scanner.html        # Original CRT scanner UI, preserved (was the old index.html)
```

`backend/server.js` was edited **additively only**: it mounts `/api/gl` and starts the
GL scheduler + persistence inside a guarded `try/catch` so the existing scanner is never affected.

**Files explicitly NOT modified:** `crtLogic.js`, `mexc.js`, `scheduler.js`, `data/store.js`,
`routes/scanner.js`, `frontend/index.html`, `frontend/vercel.json`.

---

## CRT engine reuse

`glScanner.js` does:

```js
const { detectCRT } = require("../crtLogic");
```

and calls `detectCRT(symbol, timeframe, candles, currentPrice)` exactly like the core scanner.
The returned alert (direction `BULLISH`/`BEARISH`, `c1High/c1Low/c2High/c2Low`, `sweepLevel`,
`reclaimPercent`, `currentPrice`, `timestamp`) is used unchanged. The module only **maps**
BULLISH→LONG / BEARISH→SHORT for display and adds a **display-only** quality score; it never
filters or alters detections.

---

## Three independent scanners

Each timeframe (`1h`, `4h`, `1d`) has its **own** scheduler, state, results, logs and history.
A per-timeframe run lock means one scanner can never block or corrupt another.

### Schedule (cron, UTC)
| Scanner | Rule | Cron | Example |
|--------|------|------|---------|
| **1H** | :15 after each hourly close | `15 * * * *` | 08:00 close → scan 08:15 |
| **4H** | 1h after each 4H close | `0 1,5,9,13,17,21 * * *` | 08:00 close → scan 09:00 |
| **Daily** | 6h after daily (00:00 UTC) close | `0 6 * * *` | 00:00 UTC close (08:00 Manila) → scan 06:00 UTC (14:00 / 2 PM Manila) |

Only **one** scan runs per daily candle.

---

## Scan workflow (every run)

1. Fetch **Top 30 gainers** + **Top 30 losers** from MEXC Futures (`/ticker`).
2. Filter to tradable USDT crypto/commodity contracts (stocks excluded).
3. **Remove duplicates** → scan universe (≤ 60 symbols).
4. For each symbol: fetch klines + current price → run **existing `detectCRT`**.
5. Persist results, append history, write logs, update state + next-scan time.

If MEXC is unreachable the scan fails **gracefully**: the error is logged, state is marked
`error`, and previously stored results/history stay intact.

---

## Persistence (survives refresh / restart / redeploy)

- **Always on:** in-memory + debounced local JSON at `backend/data/gl-data.json`.
- **Optional:** Supabase mirror — enabled automatically when `SUPABASE_URL` and `SUPABASE_KEY`
  are set. Run `backend/gl-schema.sql` once to create `gl_state`, `gl_history`, `gl_logs`.

Stored data: scanner state (last/next scan, status), CRT results (symbol, timeframe,
long/short, detection time, CRT details, quality score), full history, and logs.

---

## API (mounted at `/api/gl`)

| Method | Endpoint | Description |
|-------|----------|-------------|
| GET | `/dashboard` | Totals today, per-TF counts, last & next scan, all states |
| GET | `/scanners` | All three scanner states |
| GET | `/:tf/state` | One scanner's state |
| GET | `/:tf/results` | Latest CRT results (stay until next scan) |
| GET | `/:tf/logs?limit=` | Logs for that scanner |
| POST | `/:tf/logs/clear` | Clear that scanner's logs |
| GET | `/:tf/history?search=&direction=&sort=&limit=` | Searchable/sortable history |
| POST | `/:tf/scan` | Trigger a manual scan |
| GET | `/health` | Module health + persistence mode |

`:tf` ∈ `1h` \| `4h` \| `1d` (invalid → HTTP 400).

---

## Frontend

This is a **new environment running the new workflow**, so the gainers/losers dashboard is now the
site entry point: **`frontend/index.html`** (an identical copy is also kept at `frontend/gainers-losers.html`).
The original CRT scanner UI is preserved at **`frontend/legacy-crt-scanner.html`** and is no longer the
landing page. It is a self-contained responsive single-page app:

- **Dashboard** — Total CRTs Today, 1H / 4H / Daily counts, Last Scan, Next Scan (auto-updates).
- **Three scanner tabs** — each shows status, last/next scan, symbols scanned, CRTs found,
  a "Run scan now" button + live progress bar.
- **CRT Results** — dedicated card section (Symbol, Timeframe, Long/Short, detection time,
  quality score, quick chart link); kept **separate from logs** and stays visible after scans.
- **Logs** — per-timeframe, readable, color-coded (started / symbols / found / errors / completed).
- **History** — per-timeframe table, **searchable & sortable**.
- **Auto-refresh** — dashboard/results/logs poll every 15s; no manual refresh needed.
- Loading, empty and error states throughout.

The API base is configurable via `window.GL_BASE` (defaults to `/api/gl`, which works behind the
existing Vercel `/api/:path*` rewrite). To point at a remote backend directly, set it before the
script loads, e.g. `<script>window.GL_BASE="https://your-backend/api/gl"</script>`.

---

## Run locally

```bash
cd backend
npm install
npm start        # boots existing scanner + GL module on PORT (default 3001)
```

Then open `frontend/index.html` (or serve the `frontend/` folder). No new dependencies
are required — the module reuses `express`, `axios`, `node-cron`, and `@supabase/supabase-js`
already in `package.json`.

### Environment variables
| Var | Purpose |
|-----|---------|
| `PORT` | Server port (default 3001) |
| `SUPABASE_URL`, `SUPABASE_KEY` | Enable Supabase persistence (optional) |
| `RENDER_EXTERNAL_URL` | Used by the existing self-ping (unchanged) |

---

## Tests

An offline integration harness exercised the real module code (with the actual `crtLogic.js`
engine and stubbed network) covering engine reuse, gainers/losers ranking + dedupe, scheduler
timing math, the full scan pipeline, persistence + scanner independence, history search/sort,
the dashboard, all API routes, and graceful offline error handling — **59/59 passed**.
