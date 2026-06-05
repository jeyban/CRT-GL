/**
 * store.js — Alert Store with Supabase Persistence
 *
 * FIXES:
 *  - setAlerts() no longer overwrites cache with empty arrays (prevents blank dashboard after 0-result auto scans)
 *  - setMemoryOnly() now tracks a separate `manualCache` so auto poll cannot clobber manual scan results
 *  - getAlerts() now respects `manualScannedAt` — if a manual scan ran recently, returns manual results
 *    WITHOUT falling back to Supabase (fixes: auto poll overwriting "no setups found" state)
 *  - Added getScanState() so the frontend SSE + status system can query per-tf scanning state
 *  - Added setScanState() / clearScanState() to track in-progress scans
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ── In-memory caches ─────────────────────────────────────────────────────────
// autoCache: last AUTO scan results (saved to Supabase)
// manualCache: last MANUAL scan results (never saved to Supabase)
// manualScannedAt: when manual scan last completed — used to prefer manual over auto for N minutes
const autoCache = {
  "4h":     null,   // null = never scanned; [] = scanned but 0 results
  "1d":     null,
  lastScan: { "4h": null, "1d": null },
};

const manualCache = {
  "4h":          null,
  "1d":          null,
  scannedAt:     { "4h": null, "1d": null },
};

// scanState: tracks in-progress scans so frontend can show live progress
// { tf: { running: bool, startedAt: ISO, type: "auto"|"manual", progress: { scanned, total, found, errors } } }
const scanState = {
  "4h": { running: false, startedAt: null, type: null, progress: null },
  "1d": { running: false, startedAt: null, type: null, progress: null },
};

// How long (ms) to prefer manual scan results over auto/Supabase results
const MANUAL_PREFER_MS = 10 * 60 * 1000; // 10 minutes

// ── Scan state management ─────────────────────────────────────────────────────
function setScanState(tf, type, totalPairs) {
  scanState[tf] = {
    running:    true,
    startedAt:  new Date().toISOString(),
    type,
    progress: { scanned: 0, total: totalPairs || 0, found: 0, errors: 0 },
  };
  console.log(`[Store] Scan state SET — ${tf} ${type} (${totalPairs} pairs)`);
}

function updateScanProgress(tf, delta) {
  if (!scanState[tf] || !scanState[tf].running) return;
  const p = scanState[tf].progress;
  if (delta.scanned) p.scanned += delta.scanned;
  if (delta.found)   p.found   += delta.found;
  if (delta.errors)  p.errors  += delta.errors;
}

function clearScanState(tf) {
  scanState[tf] = { running: false, startedAt: null, type: null, progress: null };
  console.log(`[Store] Scan state CLEARED — ${tf}`);
}

function getScanState(tf) {
  return scanState[tf] || { running: false };
}

// ── setAlerts — AUTO scan only, saves to Supabase ────────────────────────────
async function setAlerts(tf, alerts) {
  // FIXED: only replace cache when we actually got results, OR when the previous
  // cache is also empty (i.e. don't blank a good result with a 0-result scan)
  const prev = autoCache[tf];
  if (alerts.length > 0 || prev === null || prev.length === 0) {
    autoCache[tf] = alerts;
  } else {
    console.log(`[Store] AUTO scan returned 0 results for ${tf} — keeping previous ${prev.length} cached results`);
  }
  autoCache.lastScan[tf] = new Date().toISOString();

  if (!alerts || alerts.length === 0) {
    console.log(`[Store] No new alerts to save for ${tf}`);
    return;
  }

  const rows = alerts.map(a => ({
    id:            a.id,
    symbol:        a.symbol,
    timeframe:     a.timeframe,
    direction:     a.direction,
    c1_high:       a.c1High,
    c1_low:        a.c1Low,
    c2_high:       a.c2High,
    c2_low:        a.c2Low,
    sweep_level:   a.sweepLevel,
    current_price: a.currentPrice,
    scanned_at:    a.timestamp,
    raw:           a,
  }));

  const { error } = await supabase
    .from("crt_alerts")
    .upsert(rows, { onConflict: "id" });

  if (error) {
    console.error("[Store] Supabase upsert error:", error.message);
  } else {
    console.log(`[Store] ✅ Saved ${rows.length} alerts to Supabase (${tf})`);
  }
}

// ── setMemoryOnly — MANUAL scan only, does NOT touch Supabase ─────────────────
// FIXED: stored in manualCache separate from autoCache so auto poll can't overwrite it
function setMemoryOnly(tf, alerts) {
  manualCache[tf]             = alerts;
  manualCache.scannedAt[tf]   = new Date().toISOString();
  console.log(`[Store] Manual scan — ${alerts.length} results in manualCache for ${tf} (not saved to DB)`);
}

// ── getAlerts — manual-first, then memory, then Supabase ─────────────────────
// FIXED: respects manual scan recency so auto poll doesn't clobber manual results
async function getAlerts(tf) {
  // 1. If a manual scan ran recently, prefer those results
  const manualAt = manualCache.scannedAt[tf];
  if (manualAt && manualCache[tf] !== null) {
    const age = Date.now() - new Date(manualAt).getTime();
    if (age < MANUAL_PREFER_MS) {
      console.log(`[Store] Returning manual cache for ${tf} (age: ${Math.round(age/1000)}s)`);
      return manualCache[tf];
    }
  }

  // 2. Use auto cache if available
  if (autoCache[tf] !== null && autoCache[tf].length > 0) {
    return autoCache[tf];
  }

  // 3. Supabase fallback — only when auto cache is completely empty
  // FIXED: don't fall back to Supabase if manual scan ran (even with 0 results)
  if (manualAt !== null) {
    // A manual scan ran — return its results (possibly empty = "no setups found")
    return manualCache[tf] || [];
  }

  try {
    const { data, error } = await supabase
      .from("crt_alerts")
      .select("raw")
      .eq("timeframe", tf)
      .order("scanned_at", { ascending: false })
      .limit(300);

    if (error) throw error;

    if (data && data.length > 0) {
      autoCache[tf] = data.map(r => r.raw).filter(Boolean);
      console.log(`[Store] Loaded ${autoCache[tf].length} alerts from Supabase (${tf})`);
    } else {
      autoCache[tf] = [];
    }
  } catch (err) {
    console.error("[Store] Supabase read error:", err.message);
    autoCache[tf] = autoCache[tf] || [];
  }

  return autoCache[tf];
}

// ── getAllAlerts — used by /api/alerts ────────────────────────────────────────
async function getAllAlerts() {
  const [alerts4h, alerts1d] = await Promise.all([
    getAlerts("4h"),
    getAlerts("1d"),
  ]);

  return {
    "4h":      alerts4h,
    "1d":      alerts1d,
    lastScan:  autoCache.lastScan,
    scanState: {
      "4h": getScanState("4h"),
      "1d": getScanState("1d"),
    },
  };
}

// ── getHistory — reads from Supabase for the History tab ─────────────────────
async function getHistory(tf, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    let query = supabase
      .from("crt_alerts")
      .select("*")
      .gte("scanned_at", since)
      .order("scanned_at", { ascending: false });

    if (tf && tf !== "all") {
      query = query.eq("timeframe", tf);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error("[Store] History fetch error:", err.message);
    return [];
  }
}

module.exports = {
  setAlerts,
  setMemoryOnly,
  getAlerts,
  getAllAlerts,
  getHistory,
  setScanState,
  updateScanProgress,
  clearScanState,
  getScanState,
};
