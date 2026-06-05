/**
 * crtLogic.js — CRT (Candle Range Theory) Detection Engine
 *
 * CRT Bullish Setup:
 *   C2 sweeps ABOVE C1 high → price then reclaims BELOW C1 high
 *   Formula: (C2_high > C1_high) AND (currentPrice < C1_high)
 *
 * CRT Bearish Setup:
 *   C2 sweeps BELOW C1 low → price then reclaims ABOVE C1 low
 *   Formula: (C2_low < C1_low) AND (currentPrice > C1_low)
 *
 * Detection is LIVE — no candle close confirmation needed.
 */

/**
 * Analyze a single symbol for CRT setups.
 *
 * @param {string} symbol       - e.g. "BTCUSDT"
 * @param {string} timeframe    - e.g. "1h"
 * @param {Array}  candles      - Array of candle objects (at least 2)
 * @param {number} currentPrice - Live price from ticker
 * @returns {Object|null}       - Alert object if CRT detected, null otherwise
 */
function detectCRT(symbol, timeframe, candles, currentPrice) {
  // Need at least 2 candles: C1 (previous) and C2 (current/live)
  if (!candles || candles.length < 2) return null;
  if (!currentPrice) return null;

  // C1 = second-to-last candle (previous closed candle)
  // C2 = last candle in array (currently forming, may not be closed)
  const C1 = candles[candles.length - 2];
  const C2 = candles[candles.length - 1];

  const c1High = C1.high;
  const c1Low  = C1.low;
  const c2High = C2.high;
  const c2Low  = C2.low;

  // ── Bullish CRT ──────────────────────────────────────────────────────────
  // Step 1: C2 swept above C1's high (liquidity grab above)
  // Step 2: Price has now reclaimed back below C1's high (rejection confirmed)
  const isBullishCRT = (c2High > c1High) && (currentPrice < c1High);

  if (isBullishCRT) {
    return buildAlert(symbol, timeframe, "BULLISH", {
      c1High,
      c1Low,
      c2High,
      c2Low,
      currentPrice,
      sweepLevel: c1High, // The level that was swept
    });
  }

  // ── Bearish CRT ──────────────────────────────────────────────────────────
  // Step 1: C2 swept below C1's low (liquidity grab below)
  // Step 2: Price has now reclaimed back above C1's low (rejection confirmed)
  const isBearishCRT = (c2Low < c1Low) && (currentPrice > c1Low);

  if (isBearishCRT) {
    return buildAlert(symbol, timeframe, "BEARISH", {
      c1High,
      c1Low,
      c2High,
      c2Low,
      currentPrice,
      sweepLevel: c1Low, // The level that was swept
    });
  }

  return null; // No CRT setup detected
}

/**
 * Build a standardized alert object.
 */
function buildAlert(symbol, timeframe, direction, data) {
  return {
    id: `${symbol}-${timeframe}-${direction}-${Date.now()}`,
    symbol,
    timeframe,
    direction,          // "BULLISH" or "BEARISH"
    c1High: data.c1High,
    c1Low: data.c1Low,
    c2High: data.c2High,
    c2Low: data.c2Low,
    sweepLevel: data.sweepLevel,
    currentPrice: data.currentPrice,
    // How far price has reclaimed past the sweep level (as %)
    reclaimPercent: calcReclaimPercent(direction, data),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Calculate how aggressively price has reclaimed (useful context for traders).
 */
function calcReclaimPercent(direction, data) {
  const { c1High, c1Low, currentPrice, c2High, c2Low } = data;
  if (direction === "BULLISH") {
    // How far back below C1 high has price moved?
    const range = c2High - c1High; // Size of the sweep
    const reclaim = c1High - currentPrice;
    return range > 0 ? ((reclaim / range) * 100).toFixed(1) : "0.0";
  } else {
    // Bearish: how far back above C1 low has price moved?
    const range = c1Low - c2Low;
    const reclaim = currentPrice - c1Low;
    return range > 0 ? ((reclaim / range) * 100).toFixed(1) : "0.0";
  }
}

module.exports = { detectCRT };
