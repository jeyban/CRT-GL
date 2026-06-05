-- =====================================================================
-- Gainers/Losers CRT module — Supabase schema (OPTIONAL but recommended)
-- =====================================================================
-- Run this in the Supabase SQL editor to enable redeploy-durable storage.
-- If you do NOT configure SUPABASE_URL / SUPABASE_KEY, the module falls back
-- to local JSON persistence (backend/data/gl-data.json), which still survives
-- refresh + restart (but not redeploy on ephemeral hosts like Render free).
--
-- These tables are SEPARATE from the existing `crt_alerts` table so the
-- original scanner is never affected.
-- ---------------------------------------------------------------------

-- Per-timeframe scanner state (last scan, next scan, status, counters)
create table if not exists gl_state (
  timeframe   text primary key,          -- '1h' | '4h' | '1d'
  state       jsonb not null,            -- full ScannerState object
  updated_at  timestamptz not null default now()
);

-- Full detection history (one row per CRT detection)
create table if not exists gl_history (
  id              text primary key,      -- alert id from the engine
  symbol          text not null,
  timeframe       text not null,         -- '1h' | '4h' | '1d'
  direction       text,                  -- 'BULLISH' | 'BEARISH'
  signal          text,                  -- 'LONG' | 'SHORT'
  detection_time  timestamptz,
  scan_date       date,
  quality_score   integer,
  mover_type      text,                  -- 'gainer' | 'loser' | 'both'
  change_rate     double precision,
  details         jsonb,                 -- CRT details (c1/c2/sweep/price/reclaim)
  raw             jsonb,                 -- full enriched result
  created_at      timestamptz not null default now()
);

create index if not exists gl_history_tf_time_idx
  on gl_history (timeframe, detection_time desc);
create index if not exists gl_history_symbol_idx
  on gl_history (symbol);
create index if not exists gl_history_scan_date_idx
  on gl_history (scan_date);

-- Optional: persisted logs (the module also keeps logs in JSON/memory).
create table if not exists gl_logs (
  id          bigserial primary key,
  timeframe   text not null,
  level       text,
  message     text,
  ts          timestamptz not null default now()
);
create index if not exists gl_logs_tf_ts_idx on gl_logs (timeframe, ts desc);
