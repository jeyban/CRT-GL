/**
 * glScheduler.js — Three INDEPENDENT cron schedulers for the Gainers/Losers module.
 *
 * All times are UTC. The current user's exchange (MEXC) daily candle closes at
 * 00:00 UTC, which corresponds to the 8:00 AM example given (UTC+8).
 *
 *   1H Scanner   : every hour at :15  (15 minutes after each 1H candle close)
 *                  cron: "15 * * * *"
 *
 *   4H Scanner   : 1 hour after each 4H candle close.
 *                  4H candles close at 00,04,08,12,16,20 UTC -> scan at
 *                  01,05,09,13,17,21 UTC.
 *                  cron: "0 1,5,9,13,17,21 * * *"
 *
 *   Daily Scanner: 6 hours after the daily candle close (00:00 UTC) -> 06:00 UTC.
 *                  (00:00 UTC close = 8:00 AM local UTC+8; +6h = 2:00 PM local.)
 *                  Exactly one scan per daily candle.
 *                  cron: "0 6 * * *"
 *
 * Each scanner is registered separately and calls glScanner.runScan(tf, "auto")
 * independently — one schedule can never affect another.
 */

const cron = require("node-cron");
const { runScan } = require("./glScanner");
const store = require("./glStore");

let started = false;
const tasks = {};

/** Cron expression per timeframe (UTC). */
const CRON = {
  "1h": "15 * * * *",
  "4h": "0 1,5,9,13,17,21 * * *",
  "1d": "0 6 * * *",
};

/**
 * Compute the next scheduled scan time (ISO) for a timeframe, in UTC.
 * @param {"1h"|"4h"|"1d"} tf
 * @param {Date} [from]
 * @returns {string} ISO timestamp
 */
function computeNextScan(tf, from = new Date()) {
  const d = new Date(from.getTime());
  if (tf === "1h") {
    const next = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 15, 0, 0)
    );
    if (next <= d) next.setUTCHours(next.getUTCHours() + 1);
    return next.toISOString();
  }
  if (tf === "4h") {
    const hours = [1, 5, 9, 13, 17, 21];
    for (let addDay = 0; addDay <= 1; addDay++) {
      for (const h of hours) {
        const cand = new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + addDay, h, 0, 0, 0)
        );
        if (cand > d) return cand.toISOString();
      }
    }
  }
  if (tf === "1d") {
    let cand = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 6, 0, 0, 0)
    );
    if (cand <= d) cand = new Date(cand.getTime() + 24 * 60 * 60 * 1000);
    return cand.toISOString();
  }
  return null;
}

/** Refresh the stored nextScan field for every timeframe. */
function refreshNextScans() {
  for (const tf of store.TFS) {
    store.setNextScan(tf, computeNextScan(tf));
  }
}

/**
 * Run an auto scan for a timeframe and then refresh its next-scan time.
 * Errors are logged but never thrown (so cron keeps running).
 */
async function autoScan(tf) {
  try {
    console.log(`\n⏰ [GL CRON] ${tf.toUpperCase()} auto scan @ ${new Date().toISOString()}`);
    await runScan(tf, "auto");
  } catch (err) {
    console.error(`[GL CRON] ${tf} auto scan error:`, err.message);
    store.appendLog(tf, "error", `Auto scan failed: ${err.message}`);
  } finally {
    store.setNextScan(tf, computeNextScan(tf));
  }
}

/** Register all three independent cron jobs. */
function startGlScheduler() {
  if (started) {
    console.log("⏰ [GL] Scheduler already running — skipping duplicate registration");
    return;
  }
  started = true;

  console.log("⏰ [GL] Starting Gainers/Losers schedulers (UTC):");
  for (const tf of store.TFS) {
    tasks[tf] = cron.schedule(CRON[tf], () => autoScan(tf), { timezone: "UTC" });
    console.log(`  • ${tf.toUpperCase()}: ${CRON[tf]}`);
  }

  refreshNextScans();
  // Keep nextScan fresh even if the process stays up across a boundary.
  setInterval(refreshNextScans, 60 * 1000);
}

/**
 * Fire one background startup scan per timeframe so the dashboard is never
 * empty on first boot. Non-blocking and staggered to avoid hammering the API.
 */
function runGlStartupScans() {
  const order = ["1h", "4h", "1d"];
  order.forEach((tf, i) => {
    setTimeout(() => {
      autoScan(tf).catch((e) => console.error(`[GL startup ${tf}]`, e.message));
    }, i * 5000); // 0s, 5s, 10s
  });
}

module.exports = {
  startGlScheduler,
  runGlStartupScans,
  computeNextScan,
  refreshNextScans,
  CRON,
};
