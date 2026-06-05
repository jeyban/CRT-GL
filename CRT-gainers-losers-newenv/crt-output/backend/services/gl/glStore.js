/**
 * glStore.js — Persistence layer for the Gainers/Losers CRT module.
 *
 * COMPLETELY INDEPENDENT from data/store.js. The original store is untouched.
 *
 * Durability strategy (data must survive Refresh / Restart / Redeploy):
 *   - In-memory cache   -> survives page refresh & API polling (fast reads)
 *   - Local JSON file   -> survives process restart        (backend/data/gl-data.json)
 *   - Supabase (option) -> survives redeploy / ephemeral hosts (when env configured)
 *
 * Each timeframe ("1h", "4h", "1d") keeps fully INDEPENDENT:
 *   - state    (last scan, next scan, status, counters)
 *   - results  (latest scan output, kept visible after the scan finishes)
 *   - history  (full detection history with scan timestamps)
 *   - logs     (human-readable scan logs)
 *
 * One timeframe's data can never affect another — every map is keyed by tf.
 */

const fs = require("fs");
const path = require("path");

const TFS = ["1h", "4h", "1d"];
const DATA_FILE = path.join(__dirname, "..", "..", "data", "gl-data.json");
const MAX_LOGS = 600;       // per timeframe
const MAX_HISTORY = 1500;   // per timeframe (file fallback cap)

// ── Optional Supabase (only when configured) ──────────────────────────────
let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    const { createClient } = require("@supabase/supabase-js");
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    console.log("[GL-Store] Supabase enabled (redeploy-durable history)");
  } else {
    console.log("[GL-Store] Supabase not configured — using local JSON persistence");
  }
} catch (err) {
  console.warn("[GL-Store] Supabase init failed, using local JSON:", err.message);
  supabase = null;
}

// ── In-memory state ────────────────────────────────────────────
function emptyState(tf) {
  return {
    timeframe: tf,
    status: "idle",          // idle | scanning | error
    lastScan: null,          // ISO string
    nextScan: null,          // ISO string (set by scheduler)
    lastScanType: null,      // auto | manual
    symbolsScanned: 0,
    gainersCount: 0,
    losersCount: 0,
    universeSize: 0,
    crtFound: 0,
    errors: 0,
    progress: { scanned: 0, total: 0, found: 0, errors: 0 },
    lastError: null,
  };
}

const db = {
  state: {},      // tf -> state object
  results: {},    // tf -> [result]
  history: {},    // tf -> [historyItem]
  logs: {},       // tf -> [logEntry]
};

for (const tf of TFS) {
  db.state[tf] = emptyState(tf);
  db.results[tf] = [];
  db.history[tf] = [];
  db.logs[tf] = [];
}

// ── File persistence (debounced) ──────────────────────────────────
let writeTimer = null;
function persistFile() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      const dir = path.dirname(DATA_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify(
        {
          state: db.state,
          results: db.results,
          history: db.history,
          logs: db.logs,
          savedAt: new Date().toISOString(),
        },
        null,
        2
      );
      fs.writeFileSync(DATA_FILE, payload, "utf8");
    } catch (err) {
      console.error("[GL-Store] File persist error:", err.message);
    }
  }, 400);
}

function loadFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const tf of TFS) {
      if (raw.state && raw.state[tf]) {
        db.state[tf] = { ...emptyState(tf), ...raw.state[tf] };
        // never resume in a stuck "scanning" state after a restart
        if (db.state[tf].status === "scanning") db.state[tf].status = "idle";
      }
      if (raw.results && Array.isArray(raw.results[tf])) db.results[tf] = raw.results[tf];
      if (raw.history && Array.isArray(raw.history[tf])) db.history[tf] = raw.history[tf];
      if (raw.logs && Array.isArray(raw.logs[tf])) db.logs[tf] = raw.logs[tf];
    }
    console.log("[GL-Store] Loaded persisted data from", DATA_FILE);
  } catch (err) {
    console.warn("[GL-Store] Could not load persisted file:", err.message);
  }
}

// ── Supabase mirror (best-effort, never throws) ────────────────────────
async function supabaseUpsertHistory(items) {
  if (!supabase || !items || items.length === 0) return;
  try {
    const rows = items.map((h) => ({
      id: h.id,
      symbol: h.symbol,
      timeframe: h.timeframe,
      direction: h.direction,
      signal: h.signal,
      detection_time: h.detectionTime,
      scan_date: h.scanDate,
      quality_score: h.qualityScore,
      mover_type: h.moverType,
      change_rate: h.changeRate,
      details: h.details,
      raw: h,
    }));
    const { error } = await supabase
      .from("gl_history")
      .upsert(rows, { onConflict: "id" });
    if (error) console.error("[GL-Store] Supabase history upsert:", error.message);
  } catch (err) {
    console.error("[GL-Store] Supabase history error:", err.message);
  }
}

async function supabaseSaveState(tf) {
  if (!supabase) return;
  try {
    const s = db.state[tf];
    const { error } = await supabase.from("gl_state").upsert(
      [{ timeframe: tf, state: s, updated_at: new Date().toISOString() }],
      { onConflict: "timeframe" }
    );
    if (error) console.error("[GL-Store] Supabase state upsert:", error.message);
  } catch (err) {
    console.error("[GL-Store] Supabase state error:", err.message);
  }
}

async function hydrateFromSupabase() {
  if (!supabase) return;
  try {
    for (const tf of TFS) {
      if (db.history[tf].length > 0) continue; // file already had data
      const { data, error } = await supabase
        .from("gl_history")
        .select("raw")
        .eq("timeframe", tf)
        .order("detection_time", { ascending: false })
        .limit(MAX_HISTORY);
      if (!error && data && data.length > 0) {
        db.history[tf] = data.map((r) => r.raw).filter(Boolean);
        console.log(`[GL-Store] Hydrated ${db.history[tf].length} ${tf} history rows from Supabase`);
      }
    }
  } catch (err) {
    console.error("[GL-Store] Supabase hydrate error:", err.message);
  }
}

// ── Public API ───────────────────────────────────────────────
function isValidTf(tf) {
  return TFS.includes(tf);
}

function getState(tf) {
  return db.state[tf] || emptyState(tf);
}

function getAllStates() {
  const out = {};
  for (const tf of TFS) out[tf] = db.state[tf];
  return out;
}

function patchState(tf, patch) {
  db.state[tf] = { ...db.state[tf], ...patch };
  persistFile();
  supabaseSaveState(tf);
  return db.state[tf];
}

function setNextScan(tf, iso) {
  if (!db.state[tf]) return;
  db.state[tf].nextScan = iso;
  persistFile();
}

function beginScan(tf, type, universeSize) {
  db.state[tf] = {
    ...db.state[tf],
    status: "scanning",
    lastScanType: type,
    universeSize: universeSize || 0,
    lastError: null,
    progress: { scanned: 0, total: universeSize || 0, found: 0, errors: 0 },
  };
  persistFile();
  supabaseSaveState(tf);
}

function updateProgress(tf, delta) {
  const s = db.state[tf];
  if (!s || s.status !== "scanning") return;
  const p = s.progress;
  if (delta.scanned) p.scanned += delta.scanned;
  if (delta.found) p.found += delta.found;
  if (delta.errors) p.errors += delta.errors;
}

function finishScan(tf, summary) {
  db.state[tf] = {
    ...db.state[tf],
    status: summary.error ? "error" : "idle",
    lastScan: new Date().toISOString(),
    symbolsScanned: summary.symbolsScanned || 0,
    gainersCount: summary.gainersCount || 0,
    losersCount: summary.losersCount || 0,
    universeSize: summary.universeSize || 0,
    crtFound: summary.crtFound || 0,
    errors: summary.errors || 0,
    lastError: summary.error || null,
  };
  persistFile();
  supabaseSaveState(tf);
}

// Results: replace latest set for a tf (kept visible until next scan).
function setResults(tf, results) {
  db.results[tf] = results || [];
  persistFile();
}

function getResults(tf) {
  return db.results[tf] || [];
}

// History: append detections (full archive).
function appendHistory(tf, items) {
  if (!items || items.length === 0) return;
  db.history[tf] = items.concat(db.history[tf]);
  if (db.history[tf].length > MAX_HISTORY) {
    db.history[tf] = db.history[tf].slice(0, MAX_HISTORY);
  }
  persistFile();
  supabaseUpsertHistory(items);
}

function getHistory(tf, { search, direction, sort, limit } = {}) {
  let rows = [...(db.history[tf] || [])];
  if (search) {
    const q = String(search).toUpperCase();
    rows = rows.filter((r) => r.symbol && r.symbol.toUpperCase().includes(q));
  }
  if (direction && direction !== "all") {
    rows = rows.filter((r) => r.signal === direction || r.direction === direction);
  }
  const dir = sort === "oldest" ? 1 : -1;
  rows.sort((a, b) => (new Date(a.detectionTime) - new Date(b.detectionTime)) * dir);
  if (limit) rows = rows.slice(0, limit);
  return rows;
}

// Logs: append a readable entry.
function appendLog(tf, level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  db.logs[tf].push(entry);
  if (db.logs[tf].length > MAX_LOGS) {
    db.logs[tf] = db.logs[tf].slice(-MAX_LOGS);
  }
  persistFile();
  return entry;
}

function getLogs(tf, limit = 300) {
  const arr = db.logs[tf] || [];
  return arr.slice(-limit);
}

function clearLogs(tf) {
  db.logs[tf] = [];
  persistFile();
}

// Dashboard summary across all timeframes.
function getDashboard() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const counts = {};
  let totalToday = 0;
  let lastScan = null;
  let nextScan = null;

  for (const tf of TFS) {
    const todays = (db.history[tf] || []).filter((h) => h.scanDate === todayUtc).length;
    counts[tf] = todays;
    totalToday += todays;

    const ls = db.state[tf].lastScan;
    if (ls && (!lastScan || new Date(ls) > new Date(lastScan))) lastScan = ls;

    const ns = db.state[tf].nextScan;
    if (ns && (!nextScan || new Date(ns) < new Date(nextScan))) nextScan = ns;
  }

  return {
    totalToday,
    counts,                 // { "1h": n, "4h": n, "1d": n }
    lastScan,
    nextScan,
    states: getAllStates(),
  };
}

// Initialize: load file then hydrate from Supabase if file was empty.
function init() {
  loadFile();
  hydrateFromSupabase();
}

module.exports = {
  TFS,
  isValidTf,
  init,
  getState,
  getAllStates,
  patchState,
  setNextScan,
  beginScan,
  updateProgress,
  finishScan,
  setResults,
  getResults,
  appendHistory,
  getHistory,
  appendLog,
  getLogs,
  clearLogs,
  getDashboard,
  supabaseEnabled: () => !!supabase,
};
