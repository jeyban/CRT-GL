/**
 * scheduler.js
 *
 * AUTO SCAN (saves to Supabase):
 *   4H → 1AM, 5AM, 9AM, 1PM, 5PM, 9PM UTC
 *   1D → 8PM UTC only
 *
 * MANUAL SCAN (does NOT save to Supabase):
 *   Triggered by scan buttons — results in UI only
 *
 * FIXES:
 *  - _scan() now calls setScanState / updateScanProgress / clearScanState
 *    so the /api/status endpoint can expose live progress
 *  - Streaming SSE now emits richer events: "progress", "found", "done", "fatal"
 *  - runManualScan() returns results so the route can confirm completion
 *  - startScheduler guard: won't double-register crons if called twice
 */

const cron        = require("node-cron");
const { fetchKlines, fetchPrice, getPairs } = require("./mexc");
const { detectCRT }                         = require("./crtLogic");
const {
  setAlerts,
  setMemoryOnly,
  setScanState,
  updateScanProgress,
  clearScanState,
} = require("../data/store");

const DELAY_MS   = 200;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let schedulerStarted = false;

// ─── Core scan engine ─────────────────────────────────────────────────────────
async function _scan(tf, saveToDb, emit) {
  const debug = typeof emit === "function";

  const send = (event) => {
    if (debug) {
      try { emit(event); } catch (_) {}
    }
  };

  const log = (type, symbol, msg, extra) => {
    // Always emit SSE events so streaming route gets everything
    send({ type, symbol, tf, msg, extra: extra || null, ts: Date.now() });
    // Console: only meaningful events
    if (["found","error","save_error","start","done","store_saved","fatal"].includes(type)) {
      console.log(`  [${tf.toUpperCase()}] ${symbol || "—"} — ${msg}`);
    }
  };

  let pairs;
  try {
    pairs = await getPairs();
  } catch (err) {
    log("fatal", null, `Failed to fetch pairs: ${err.message}`);
    clearScanState(tf);
    throw err;
  }

  // Register scan state so /api/status shows progress
  setScanState(tf, saveToDb ? "auto" : "manual", pairs.length);

  log("start", null, `${saveToDb ? "AUTO" : "MANUAL"} scan started — ${tf.toUpperCase()} — ${pairs.length} pairs`);

  const alerts = [];
  let scanned  = 0;
  let errors   = 0;

  for (const symbol of pairs) {
    try {
      log("scanning", symbol, `Scanning ${symbol}…`);

      const candles = await fetchKlines(symbol, tf, 3);
      if (!candles || candles.length < 2) {
        log("skip", symbol, `No candle data`);
        errors++;
        updateScanProgress(tf, { errors: 1 });
        await sleep(DELAY_MS);
        continue;
      }

      const price = await fetchPrice(symbol);
      if (!price) {
        log("skip", symbol, `No price data`);
        errors++;
        updateScanProgress(tf, { errors: 1 });
        await sleep(DELAY_MS);
        continue;
      }

      const alert = detectCRT(symbol, tf, candles, price);

      if (alert) {
        alerts.push(alert);
        updateScanProgress(tf, { scanned: 1, found: 1 });
        log("found", symbol,
          `CRT FOUND → ${symbol} ${alert.direction}`,
          { direction: alert.direction, price, alert }
        );
      } else {
        updateScanProgress(tf, { scanned: 1 });
        log("clean", symbol, `No setup`);
      }

      scanned++;
    } catch (err) {
      log("error", symbol, `Error → ${err.message}`);
      errors++;
      updateScanProgress(tf, { errors: 1 });
    }

    await sleep(DELAY_MS);
  }

  // ── Persist results ───────────────────────────────────────────────────────
  if (saveToDb) {
    try {
      await setAlerts(tf, alerts);
      log("store_saved", null, `Saved ${alerts.length} alerts to database (auto scan)`);
    } catch (storeErr) {
      log("save_error", null, `FAILED TO SAVE TO DB → ${storeErr.message}`);
    }
  } else {
    setMemoryOnly(tf, alerts);
    log("start", null, `Manual scan — ${alerts.length} results in UI (not saved to history)`);
  }

  clearScanState(tf);

  log("done", null,
    `Scan complete — ${scanned} scanned, ${alerts.length} found, ${errors} errors`,
    { scanned, found: alerts.length, errors, total: pairs.length }
  );

  return alerts;
}

// ─── Public functions ─────────────────────────────────────────────────────────

/** Auto scan — saves to Supabase. Called by cron and startup. */
async function runScan(tf) {
  console.log(`\n🔍 [AUTO SCAN] ${tf.toUpperCase()} — ${new Date().toUTCString()}`);
  const results = await _scan(tf, true, null);
  console.log(`✅ [AUTO DONE] ${tf.toUpperCase()} — ${results.length} alerts saved to DB`);
  return results;
}

/** Manual scan — does NOT save to Supabase. Called by POST /api/scan/:tf */
async function runManualScan(tf) {
  console.log(`\n🔍 [MANUAL SCAN] ${tf.toUpperCase()} — ${new Date().toUTCString()}`);
  const results = await _scan(tf, false, null);
  console.log(`✅ [MANUAL DONE] ${tf.toUpperCase()} — ${results.length} alerts shown in UI only`);
  return results;
}

/** Streaming scan — manual (no DB save), emits SSE events for live progress UI */
async function runScanWithStream(tf, emit) {
  return _scan(tf, false, emit);
}

// ─── Cron Scheduler ───────────────────────────────────────────────────────────
function startScheduler() {
  if (schedulerStarted) {
    console.log("⏰ Scheduler already running — skipping duplicate registration");
    return;
  }
  schedulerStarted = true;

  console.log("⏰ Starting scheduler (UTC times)...");

  cron.schedule("0 1,5,9,13,17,21 * * *", () => {
    const utcHour = new Date().getUTCHours();
    console.log(`\n⏰ [CRON] 4H auto scan triggered at UTC hour ${utcHour}`);
    runScan("4h").catch(console.error);
  }, { timezone: "UTC" });

  console.log("  • 4H: 1AM, 5AM, 9AM, 1PM, 5PM, 9PM UTC");

  cron.schedule("0 20 * * *", () => {
    const utcHour = new Date().getUTCHours();
    console.log(`\n⏰ [CRON] 1D auto scan triggered at UTC hour ${utcHour}`);
    runScan("1d").catch(console.error);
  }, { timezone: "UTC" });

  console.log("  • 1D: 8PM UTC daily");
  console.log("  • Note: 4H and 1D run on completely separate schedules\n");
}

module.exports = { runScan, runManualScan, runScanWithStream, startScheduler };
