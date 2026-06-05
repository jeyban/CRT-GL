/**
 * glMexc.js — MEXC Futures data service for the Gainers/Losers CRT module.
 *
 * This file is COMPLETELY INDEPENDENT from services/mexc.js.
 * The original scanner's mexc.js is left untouched.
 *
 * Responsibilities:
 *   1. Fetch ALL contract tickers and rank Top 30 Gainers / Top 30 Losers
 *      (using the 24h `riseFallRate` field).
 *   2. De-duplicate the gainers + losers into a single scan universe.
 *   3. Fetch klines for 1h / 4h / 1d.
 *   4. Fetch the live price for a symbol.
 *
 * MEXC contract v1 endpoints (https://contract.mexc.com/api/v1/contract):
 *   All tickers : GET /ticker             -> data[]  { symbol, lastPrice, riseFallRate, volume24, ... }
 *   Single tick : GET /ticker?symbol=...  -> data    { lastPrice, ... }
 *   Kline       : GET /kline/{symbol}?interval=Min60|Hour4|Day1&start=<sec>&end=<sec>
 *
 * Interval strings: Min1 Min5 Min15 Min30 Min60 Hour4 Hour8 Day1 Week1 Month1
 */

const axios = require("axios");

const BASE = "https://contract.mexc.com/api/v1/contract";

/** Supported timeframes for the gainers/losers module. */
const INTERVAL_MAP = {
  "1h": "Min60",
  "4h": "Hour4",
  "1d": "Day1",
};

const INTERVAL_SECONDS = {
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
};

// ── Symbol universe filtering (crypto + gold/silver/oil, reject stock perps) ──
const COMMODITY_SYMBOLS = new Set(["XAU_USDT", "XAG_USDT", "OIL_USDT"]);

const STOCK_SYMBOLS = new Set([
  "AAPL_USDT","AMZN_USDT","TSLA_USDT","GOOGL_USDT","MSFT_USDT","META_USDT",
  "NVDA_USDT","NFLX_USDT","AMD_USDT","INTC_USDT","BABA_USDT","UBER_USDT",
  "COIN_USDT","MSTR_USDT","PLTR_USDT","SHOP_USDT","SQ_USDT","PYPL_USDT",
  "SNAP_USDT","TWTR_USDT","SPOT_USDT","ABNB_USDT","RBLX_USDT","HOOD_USDT",
  "GME_USDT","AMC_USDT","BBY_USDT","F_USDT","GM_USDT","BA_USDT",
  "DIS_USDT","V_USDT","MA_USDT","JPM_USDT","GS_USDT","BAC_USDT",
  "WMT_USDT","PFE_USDT","JNJ_USDT","XOM_USDT","CVX_USDT",
  "700_USDT","9988_USDT","1810_USDT","3690_USDT","9618_USDT","2318_USDT",
  "941_USDT","388_USDT","1299_USDT","2628_USDT","3988_USDT","1398_USDT",
  "XAUUSD_USDT",
]);

/**
 * @param {string} symbol
 * @returns {boolean} true if the symbol is a crypto perpetual (or allowed commodity).
 */
function isCryptoOrCommodity(symbol) {
  if (typeof symbol !== "string") return false;
  if (COMMODITY_SYMBOLS.has(symbol)) return true;
  if (STOCK_SYMBOLS.has(symbol)) return false;

  const base = symbol.replace(/_USDT$/, "");
  if (/^\d+$/.test(base)) return false;       // HK numeric tickers
  if (base.endsWith("STOCK")) return false;   // MEXC stock perps
  if (base.endsWith("ETF")) return false;
  if (base.endsWith("INDEX")) return false;
  return true;
}

/**
 * Fetch all contract tickers and compute the Top N gainers / losers.
 *
 * @param {number} limit - how many gainers and how many losers (default 30 each).
 * @returns {Promise<{gainers: Array, losers: Array, universe: string[], rates: Object}>}
 *   gainers/losers: [{ symbol, rate, lastPrice }]
 *   universe: de-duplicated list of symbols to scan
 *   rates: { symbol: ratePercent }
 */
async function getTopMovers(limit = 30) {
  const res = await axios.get(`${BASE}/ticker`, { timeout: 12000 });
  const list = (res.data && res.data.data) || [];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("MEXC ticker response empty or malformed");
  }

  // Keep only valid USDT crypto/commodity perps with a usable change rate.
  const cleaned = list
    .filter(
      (t) =>
        t &&
        typeof t.symbol === "string" &&
        t.symbol.endsWith("_USDT") &&
        isCryptoOrCommodity(t.symbol) &&
        t.riseFallRate !== undefined &&
        t.riseFallRate !== null &&
        !isNaN(Number(t.riseFallRate))
    )
    .map((t) => ({
      symbol: t.symbol,
      // riseFallRate is a decimal fraction (0.0523 => +5.23%)
      rate: Number(t.riseFallRate) * 100,
      lastPrice: t.lastPrice !== undefined ? Number(t.lastPrice) : null,
    }));

  if (cleaned.length === 0) {
    throw new Error("No valid USDT perpetual tickers after filtering");
  }

  // Sort descending by % change.
  const sorted = [...cleaned].sort((a, b) => b.rate - a.rate);

  const gainers = sorted.slice(0, limit);                  // highest first
  const losers = sorted.slice(-limit).reverse();           // most negative first

  // De-duplicate: a symbol could (in edge cases) appear in both slices when the
  // total universe is tiny. Build a unique scan universe preserving order.
  const seen = new Set();
  const universe = [];
  for (const item of [...gainers, ...losers]) {
    if (!seen.has(item.symbol)) {
      seen.add(item.symbol);
      universe.push(item.symbol);
    }
  }

  const rates = {};
  for (const item of cleaned) rates[item.symbol] = item.rate;

  return { gainers, losers, universe, rates };
}

/**
 * Fetch the last `limit` klines for a symbol + timeframe.
 *
 * @param {string} symbol  - e.g. "BTC_USDT"
 * @param {string} tf      - "1h" | "4h" | "1d"
 * @param {number} limit   - number of candles to return (default 3)
 * @returns {Promise<Array|null>} array of { openTime, open, high, low, close } or null
 */
async function fetchKlines(symbol, tf, limit = 3) {
  const interval = INTERVAL_MAP[tf];
  if (!interval) throw new Error(`Unknown timeframe: ${tf}`);

  const intervalSeconds = INTERVAL_SECONDS[tf];
  const end = Math.floor(Date.now() / 1000);
  const start = end - (limit + 2) * intervalSeconds; // +2 buffer

  try {
    const res = await axios.get(`${BASE}/kline/${symbol}`, {
      params: { interval, start, end },
      timeout: 8000,
    });

    const d = res.data && res.data.data;
    if (!d || !d.time || !Array.isArray(d.time) || d.time.length === 0) {
      return null;
    }

    const len = d.time.length;
    const from = Math.max(0, len - limit);
    const candles = [];
    for (let i = from; i < len; i++) {
      candles.push({
        openTime: d.time[i],
        open: parseFloat(d.open[i]),
        high: parseFloat(d.high[i]),
        low: parseFloat(d.low[i]),
        close: parseFloat(d.close[i]),
      });
    }
    return candles.length >= 2 ? candles : null;
  } catch (err) {
    if (!err.response || err.response.status !== 404) {
      console.error(`  [GL-MEXC] kline ${symbol} ${tf}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Fetch the live price for a perpetual symbol.
 * @param {string} symbol
 * @returns {Promise<number|null>}
 */
async function fetchPrice(symbol) {
  try {
    const res = await axios.get(`${BASE}/ticker`, {
      params: { symbol },
      timeout: 5000,
    });
    const d = res.data && res.data.data;
    if (!d) return null;
    const price = parseFloat(d.lastPrice);
    return isNaN(price) ? null : price;
  } catch (err) {
    return null;
  }
}

module.exports = {
  getTopMovers,
  fetchKlines,
  fetchPrice,
  isCryptoOrCommodity,
  INTERVAL_MAP,
  INTERVAL_SECONDS,
};
