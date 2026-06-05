/**
 * mexc.js — MEXC Perpetual Futures Contract API
 *
 * Base URL : https://contract.mexc.com/api/v1/contract
 *
 * Confirmed from official docs (mexcdevelop.github.io/apidocs/contract_v1_en):
 *
 *   Kline  : GET /kline/{symbol}?interval=Hour4&start=<sec>&end=<sec>
 *   Ticker : GET /ticker?symbol={symbol}  → data.lastPrice
 *   Pairs  : GET /detail → data[] filtered by quoteCoin=USDT, state=0
 *
 * Interval strings: Min1 Min5 Min15 Min30 Min60 Hour4 Hour8 Day1 Week1 Month1
 */

const axios = require("axios");

const BASE = "https://contract.mexc.com/api/v1/contract";

const INTERVAL_MAP = {
  "4h": "Hour4",
  "1d": "Day1",
};

// ── Known commodity symbols to always include ─────────────────────────────────
const COMMODITY_SYMBOLS = new Set(["XAU_USDT", "XAG_USDT", "OIL_USDT"]);

// ── Stock ticker patterns to exclude ─────────────────────────────────────────
// MEXC lists US/HK stock perpetuals like AAPL_USDT, TSLA_USDT, 700_USDT etc.
// These follow the pattern of real stock tickers — we identify them by checking
// against a known list since there's no "type" field in the API response.
const STOCK_SYMBOLS = new Set([
  // US stocks
  "AAPL_USDT","AMZN_USDT","TSLA_USDT","GOOGL_USDT","MSFT_USDT","META_USDT",
  "NVDA_USDT","NFLX_USDT","AMD_USDT","INTC_USDT","BABA_USDT","UBER_USDT",
  "COIN_USDT","MSTR_USDT","PLTR_USDT","SHOP_USDT","SQ_USDT","PYPL_USDT",
  "SNAP_USDT","TWTR_USDT","SPOT_USDT","ABNB_USDT","RBLX_USDT","HOOD_USDT",
  "GME_USDT","AMC_USDT","BBY_USDT","F_USDT","GM_USDT","BA_USDT",
  "DIS_USDT","V_USDT","MA_USDT","JPM_USDT","GS_USDT","BAC_USDT",
  "WMT_USDT","PFE_USDT","JNJ_USDT","XOM_USDT","CVX_USDT",
  // HK stocks (numeric tickers)
  "700_USDT","9988_USDT","1810_USDT","3690_USDT","9618_USDT","2318_USDT",
  "941_USDT","388_USDT","1299_USDT","2628_USDT","3988_USDT","1398_USDT",
  // Other non-crypto
  "XAUUSD_USDT", // duplicate gold format
]);

/**
 * Returns true if the symbol looks like a real crypto perpetual
 * (or is an explicitly allowed commodity like gold/silver/oil).
 * Rejects known stock tickers.
 */
function isCryptoOrCommodity(symbol) {
  if (COMMODITY_SYMBOLS.has(symbol)) return true;   // always allow XAU, XAG, OIL
  if (STOCK_SYMBOLS.has(symbol))     return false;  // block known US stock tickers

  const base = symbol.replace(/_USDT$/, "");

  // Numeric-only bases are HK stock tickers (e.g. 700_USDT, 9988_USDT)
  if (/^\d+$/.test(base)) return false;

  // MEXC stock perpetuals end in "STOCK" (e.g. ASTSSTOCK_USDT, BABASTOCK_USDT, BWNSTOCK_USDT)
  if (base.endsWith("STOCK")) return false;

  // Other non-crypto product types MEXC lists
  if (base.endsWith("ETF"))   return false;
  if (base.endsWith("INDEX")) return false;

  return true;
}
let cachedPairs   = [];
let lastPairFetch = 0;
const PAIR_TTL    = 6 * 60 * 60 * 1000; // refresh every 6 hours

/**
 * Fetch all active USDT perpetual pairs from MEXC.
 * Falls back to hardcoded list if API call fails.
 */
async function getPairs() {
  const now = Date.now();
  if (cachedPairs.length > 0 && now - lastPairFetch < PAIR_TTL) {
    return cachedPairs;
  }

  try {
    const res  = await axios.get(`${BASE}/detail`, { timeout: 10000 });
    const list = res.data && res.data.data ? res.data.data : [];

    // state=0 means enabled; quoteCoin=USDT; filter out stocks, keep crypto + gold/silver/oil
    const pairs = list
      .filter(c => c.quoteCoin === "USDT" && c.state === 0)
      .map(c => c.symbol)
      .filter(isCryptoOrCommodity)
      .sort();

    if (pairs.length >= 50) {
      cachedPairs   = pairs;
      lastPairFetch = now;
      console.log(`[MEXC] Fetched ${pairs.length} active USDT perpetual pairs`);
      return cachedPairs;
    }

    console.warn("[MEXC] Pair list too short, using fallback");
  } catch (err) {
    console.error("[MEXC] getPairs error:", err.message);
  }

  cachedPairs   = FALLBACK_PAIRS;
  lastPairFetch = now;
  return cachedPairs;
}

/**
 * Fetch the last `limit` klines for a symbol + timeframe.
 *
 * From the docs:
 *   "If neither start nor end time is provided, the 2000 pieces of data
 *    closest to the current time are queried."
 * So we CAN omit start/end and just pass a small limit via the response size.
 * But the API doesn't have a direct `limit` param — it uses time range.
 * We pass `end = now` and `start = now - (limit * intervalSeconds)` to get
 * exactly the candles we need.
 */
async function fetchKlines(symbol, tf, limit = 3) {
  const interval = INTERVAL_MAP[tf];
  if (!interval) throw new Error(`Unknown timeframe: ${tf}`);

  // Calculate start/end in seconds
  const intervalSeconds = tf === "4h" ? 4 * 3600 : 24 * 3600;
  const end   = Math.floor(Date.now() / 1000);
  const start = end - (limit + 2) * intervalSeconds; // +2 buffer

  try {
    const res = await axios.get(`${BASE}/kline/${symbol}`, {
      params: { interval, start, end },
      timeout: 8000,
    });

    const d = res.data && res.data.data;

    // Validate response shape: must have time array with data
    if (!d || !d.time || !Array.isArray(d.time) || d.time.length === 0) {
      return null;
    }

    // Build candle objects from parallel arrays
    const len    = d.time.length;
    const from   = Math.max(0, len - limit);
    const candles = [];

    for (let i = from; i < len; i++) {
      candles.push({
        openTime: d.time[i],
        open:     parseFloat(d.open[i]),
        high:     parseFloat(d.high[i]),
        low:      parseFloat(d.low[i]),
        close:    parseFloat(d.close[i]),
      });
    }

    return candles.length >= 2 ? candles : null;

  } catch (err) {
    // 404 = pair doesn't support this timeframe, skip silently
    if (!err.response || err.response.status !== 404) {
      console.error(`  [MEXC] kline ${symbol} ${tf}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Fetch the live price for a perpetual symbol.
 *
 * From the docs:
 *   GET /ticker?symbol=BTC_USDT
 *   Response: data.lastPrice (single object, not array)
 */
async function fetchPrice(symbol) {
  try {
    const res = await axios.get(`${BASE}/ticker`, {
      params: { symbol },
      timeout: 5000,
    });

    const d = res.data && res.data.data;
    if (!d) return null;

    // API returns single object when symbol is provided
    const price = parseFloat(d.lastPrice);
    return isNaN(price) ? null : price;

  } catch (err) {
    return null;
  }
}

// ── Fallback pair list (crypto only + gold/silver/oil) ───────────────────────
const FALLBACK_PAIRS = [
  "BTC_USDT","ETH_USDT","BNB_USDT","SOL_USDT","XRP_USDT",
  "DOGE_USDT","ADA_USDT","AVAX_USDT","DOT_USDT","LTC_USDT",
  "LINK_USDT","UNI_USDT","ATOM_USDT","ETC_USDT","XLM_USDT",
  "BCH_USDT","FIL_USDT","APT_USDT","ARB_USDT","OP_USDT",
  "MATIC_USDT","NEAR_USDT","ALGO_USDT","VET_USDT","ICP_USDT",
  "GRT_USDT","SAND_USDT","MANA_USDT","AXS_USDT","AAVE_USDT",
  "MKR_USDT","COMP_USDT","CRV_USDT","SNX_USDT","SUSHI_USDT",
  "DYDX_USDT","GMX_USDT","INJ_USDT","SUI_USDT","SEI_USDT",
  "TIA_USDT","WLD_USDT","FET_USDT","RENDER_USDT","RUNE_USDT",
  "STX_USDT","CFX_USDT","FLOW_USDT","ROSE_USDT","ZIL_USDT",
  "IOTA_USDT","XTZ_USDT","EOS_USDT","TRX_USDT","HBAR_USDT",
  "LDO_USDT","GALA_USDT","ENJ_USDT","CHZ_USDT","BAT_USDT",
  "ANKR_USDT","CELR_USDT","BAND_USDT","OCEAN_USDT","BLUR_USDT",
  "PENDLE_USDT","WIF_USDT","PEPE_USDT","FLOKI_USDT","BONK_USDT",
  "SHIB_USDT","NOT_USDT","EIGEN_USDT","DRIFT_USDT","ZRO_USDT",
  "ALT_USDT","JUP_USDT","DYM_USDT","PYTH_USDT","STRK_USDT",
  "TAO_USDT","AGIX_USDT","ONE_USDT","KLAY_USDT","NEO_USDT",
  "IOTX_USDT","NMR_USDT","BAL_USDT","RPL_USDT",
  "SAFE_USDT","LISTA_USDT","IO_USDT","OMNI_USDT","TURBO_USDT",
  // Commodities
  "XAU_USDT","XAG_USDT","OIL_USDT",
];

module.exports = { fetchKlines, fetchPrice, getPairs };
