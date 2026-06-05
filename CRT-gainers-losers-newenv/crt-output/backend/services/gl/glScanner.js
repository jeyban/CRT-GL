/**
 * glScanner.js — Scan engine for the Gainers/Losers CRT module.
 *
 * ⚠️  REUSES THE EXISTING CRT ENGINE EXACTLY AS-IS.
 *     It imports `detectCRT` from ../crtLogic and does NOT modify, wrap, or
 *     re-implement any CRT rule, calculation, validation, filtering, or signal
 *     generation. The detection output is used verbatim; only PRESENTATION
 *     metadata (signal label, quality score, mover type) is layered on top.
 *
 * Per-scan workflow (matches the universe rules in the spec):
 *   1. Fetch Top 30 Gainers + Top 30 Losers from MEXC futures.
 *   2. Remove duplicate symbols.
 *   3. Scan ONLY that de-duplicated universe with detectCRT().
 *   4. Persist results + history + logs + state via glStore.
 *
 * Each timeframe runs through its own call — a per-tf `running` guard ensures one
 * scanner can never disturb another.
 */

const { getTopMovers, fetchKlines, fetchPrice } = require("./glMexc");
const { detectCRT } = require("../crtLogic"); // <-- existing engine, untouched
const store = require("./glStore");

const DELAY_MS = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-timeframe running guard — independent locks.
const running = { "1h": false, "4h": false, "1d": false };

/**
 * Compute a 1–100 CRT quality score from the engine's own output fields.
 * This is purely a DISPLAY metric — it does not change detection or filtering.
 * Inputs used: reclaimPercent (engine value) + sweep magnitude vs C1 range.
 *
 * @param {Object} alert - the object returned by detectCRT()
 * @returns {number} 1..100
 */
function computeQuality(alert) {
  const reclaim = parseFloat(alert.reclaimPercent);
  const c1Range = Math.abs(alert.c1High - alert.c1Low);
  const sweep =
    alert.direction === "BULLISH"
      ? alert.c2High - alert.c1High
      : alert.c1Low - alert.c2Low;
  const sweepRatio = c1Range > 0 ? sweep / c1Range : 0;

  // Reclaim component peaks near a clean ~50% reclaim back through the level.
  const r = isNaN(reclaim) ? 0 : Math.max(0, Math.min(reclaim, 100));
  const reclaimScore = Math.max(0, 100 - Math.abs(50 - r) * 1.2);

  // Sweep component rewards a meaningful (but not extreme) liquidity grab.
  const sweepScore = Math.max(0, Math.min(sweepRatio * 250, 100));

  const q = Math.round(reclaimScore * 0.6 + sweepScore * 0.4);
  return Math.max(1, Math.min(100, q));
}

/** Map the engine's direction to a trading signal label. */
function toSignal(direction) {
  return direction === "BULLISH" ? "LONG" : "SHORT";
}

/** MEXC futures quick chart link. */
function chartLink(symbol) {
  return "https://futures.mexc.com/exchange/" + symbol;
}

/**
 * Run a single scan for one timeframe.
 *
 * @param {"1h"|"4h"|"1d"} tf
 * @param {"auto"|"manual"} type
 * @returns {Promise<{results: Array, summary: Object}>}
 */
async function runScan(tf, type = "manual") {
  if (!store.isValidTf(tf)) throw new Error(`Invalid timeframe: ${tf}`);

  if (running[tf]) {
    store.appendLog(tf, "warn", `Scan already running for ${tf} — ignored duplicate trigger`);
    return { results: store.getResults(tf), summary: store.getState(tf), alreadyRunning: true };
  }
  running[tf] = true;

  const label = tf.toUpperCase();
  store.appendLog(tf, "info", `▶ ${type.toUpperCase()} scan started for ${label}`);

  let movers;
  try {
    movers = await getTopMovers(30);
  } catch (err) {
    store.appendLog(tf, "error", `Failed to fetch Top 30 gainers/losers: ${err.message}`);
    store.finishScan(tf, { error: err.message });
    running[tf] = false;
    return { results: store.getResults(tf), summary: store.getState(tf), error: err.message };
  }

  const universe = movers.universe;
  store.beginScan(tf, type, universe.length);
  store.appendLog(
    tf,
    "info",
    `Universe ready — ${movers.gainers.length} gainers + ${movers.losers.length} losers → ${universe.length} unique symbols`
  );

  // Lookup helpers for enrichment
  const gainerSet = new Set(movers.gainers.map((g) => g.symbol));
  const loserSet = new Set(movers.losers.map((l) => l.symbol));

  const results = [];
  let scanned = 0;
  let errors = 0;

  for (const symbol of universe) {
    try {
      const candles = await fetchKlines(symbol, tf, 3);
      if (!candles || candles.length < 2) {
        errors++;
        store.updateProgress(tf, { errors: 1 });
        await sleep(DELAY_MS);
        continue;
      }

      const price = await fetchPrice(symbol);
      if (!price) {
        errors++;
        store.updateProgress(tf, { errors: 1 });
        await sleep(DELAY_MS);
        continue;
      }

      // ─────────────────────────────────────────────────
      // EXISTING CRT ENGINE — used exactly as-is, no changes.
      const alert = detectCRT(symbol, tf, candles, price);
      // ─────────────────────────────────────────────────

      scanned++;

      if (alert) {
        const moverType = gainerSet.has(symbol)
          ? "gainer"
          : loserSet.has(symbol)
          ? "loser"
          : "both";

        const enriched = {
          ...alert,                       // verbatim engine output (CRT details)
          signal: toSignal(alert.direction),
          qualityScore: computeQuality(alert),
          moverType,
          changeRate: movers.rates[symbol] != null ? movers.rates[symbol] : null,
          chartUrl: chartLink(symbol),
          detectionTime: alert.timestamp,
          scanDate: new Date(alert.timestamp).toISOString().slice(0, 10),
          details: {
            c1High: alert.c1High,
            c1Low: alert.c1Low,
            c2High: alert.c2High,
            c2Low: alert.c2Low,
            sweepLevel: alert.sweepLevel,
            currentPrice: alert.currentPrice,
            reclaimPercent: alert.reclaimPercent,
          },
        };
        results.push(enriched);
        store.updateProgress(tf, { scanned: 1, found: 1 });
        store.appendLog(
          tf,
          "found",
          `✅ CRT FOUND — ${symbol} ${enriched.signal} (${alert.direction}) • Q${enriched.qualityScore}`
        );
      } else {
        store.updateProgress(tf, { scanned: 1 });
      }
    } catch (err) {
      errors++;
      store.updateProgress(tf, { errors: 1 });
      store.appendLog(tf, "error", `${symbol} — ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  // Sort results strongest-first for nicer presentation (does not filter any out).
  results.sort((a, b) => b.qualityScore - a.qualityScore);

  // Persist: results stay visible until the next scan; history is appended.
  store.setResults(tf, results);
  store.appendHistory(tf, results);

  const summary = {
    symbolsScanned: scanned,
    gainersCount: movers.gainers.length,
    losersCount: movers.losers.length,
    universeSize: universe.length,
    crtFound: results.length,
    errors,
  };
  store.finishScan(tf, summary);

  store.appendLog(
    tf,
    "info",
    `■ Scan complete — ${scanned}/${universe.length} scanned, ${results.length} CRT found, ${errors} errors`
  );

  running[tf] = false;
  return { results, summary };
}

function isRunning(tf) {
  return !!running[tf];
}

module.exports = { runScan, isRunning, computeQuality, toSignal, chartLink };
