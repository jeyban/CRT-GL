/**
 * scanner.js — API Routes
 *
 * GET  /api/alerts           → Latest alerts (memory + Supabase fallback)
 * GET  /api/alerts/:tf       → Latest alerts for one timeframe
 * POST /api/scan/:tf         → Manual scan — blocks until complete, returns results
 * GET  /api/scan/:tf/stream  → SSE streaming manual scan with live progress events
 * GET  /api/history          → All history from Supabase
 * GET  /api/history/:tf      → History for one timeframe
 * GET  /api/status           → Health check + scan state + last scan times
 *
 * FIXES:
 *  - POST /api/scan/:tf now awaits the scan and returns actual results
 *    (previously returned immediately, leaving frontend polling in the dark)
 *  - GET /api/status now returns per-tf scanState from store
 *  - SSE stream emits structured events: scanning, found, clean, done, fatal, progress
 *  - Added /api/scan/:tf/status for quick in-progress check (used by frontend poller)
 */

const express = require("express");
const router  = express.Router();
const { getAllAlerts, getAlerts, getHistory, getScanState } = require("../data/store");
const { runManualScan, runScanWithStream } = require("../services/scheduler");

const VALID = ["4h", "1d"];

// ── GET /api/alerts ───────────────────────────────────────────────────────────
router.get("/alerts", async (req, res) => {
  try {
    const data = await getAllAlerts();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/alerts/:tf ───────────────────────────────────────────────────────
router.get("/alerts/:tf", async (req, res) => {
  const { tf } = req.params;
  if (!VALID.includes(tf))
    return res.status(400).json({ success: false, error: `Use: ${VALID.join(", ")}` });

  const alerts    = await getAlerts(tf);
  const scanState = getScanState(tf);
  res.json({ success: true, timeframe: tf, count: alerts.length, alerts, scanState });
});

// ── POST /api/scan/:tf ────────────────────────────────────────────────────────
// FIXED: awaits scan completion and returns actual results + count
// This lets the frontend immediately render results without polling
router.post("/scan/:tf", async (req, res) => {
  const { tf } = req.params;
  if (!VALID.includes(tf))
    return res.status(400).json({ success: false, error: `Use: ${VALID.join(", ")}` });

  // Check if a scan is already running for this timeframe
  const state = getScanState(tf);
  if (state.running) {
    return res.json({
      success:   true,
      scanning:  true,
      message:   `Scan already running for ${tf} — connect to SSE stream for live progress`,
      scanState: state,
    });
  }

  console.log(`[Route] Manual scan requested for ${tf}`);

  try {
    // FIXED: await scan result so we can return it immediately
    const results = await runManualScan(tf);
    res.json({
      success:   true,
      scanning:  false,
      timeframe: tf,
      found:     results.length,
      alerts:    results,
      message:   results.length > 0
        ? `Scan complete — ${results.length} CRT setups found (UI only, not saved to history)`
        : `Scan complete — no CRT setups found for ${tf}`,
    });
  } catch (err) {
    console.error(`[Route] Manual scan error (${tf}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/scan/:tf/stream ─────────────────────────────────────────────────
// SSE streaming scan — emits live progress events
// Event types: start | scanning | found | clean | skip | error | done | fatal | progress
router.get("/scan/:tf/stream", async (req, res) => {
  const { tf } = req.params;
  if (!VALID.includes(tf)) { res.status(400).end(); return; }

  res.setHeader("Content-Type",      "text/event-stream");
  res.setHeader("Cache-Control",     "no-cache");
  res.setHeader("Connection",        "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (_) {}
  };

  // Keep-alive ping every 15s (prevents proxy/load-balancer timeout)
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) {}
  }, 15000);

  req.on("close", () => {
    clearInterval(ping);
    console.log(`[SSE] Client disconnected from ${tf} stream`);
  });

  try {
    const results = await runScanWithStream(tf, send);
    // FIXED: do NOT embed results[] in this event — 300+ alerts = 90KB+ SSE message
    // which gets truncated by Render/nginx proxies, causing ev.alerts to be undefined.
    // Frontend must fetch /api/alerts/:tf after receiving this signal instead.
    send({
      type:  "complete",
      tf,
      found: results.length,
      // alerts intentionally omitted — frontend fetches /api/alerts/:tf on complete
      msg:   results.length > 0
        ? `Scan complete — ${results.length} setups found — fetching results…`
        : "Scan complete — no setups found",
      ts: Date.now(),
    });
  } catch (err) {
    send({ type: "fatal", msg: `Fatal: ${err.message}`, ts: Date.now() });
  }

  clearInterval(ping);
  res.end();
});

// ── GET /api/scan/:tf/status ──────────────────────────────────────────────────
// Quick poll endpoint — returns current scan state for a timeframe
router.get("/scan/:tf/status", (req, res) => {
  const { tf } = req.params;
  if (!VALID.includes(tf))
    return res.status(400).json({ success: false, error: `Use: ${VALID.join(", ")}` });

  const state = getScanState(tf);
  res.json({ success: true, timeframe: tf, scanState: state });
});

// ── GET /api/history ──────────────────────────────────────────────────────────
router.get("/history", async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const data = await getHistory("all", days);
  res.json({ success: true, count: data.length, days, data });
});

// ── GET /api/history/:tf ──────────────────────────────────────────────────────
router.get("/history/:tf", async (req, res) => {
  const { tf } = req.params;
  if (!VALID.includes(tf))
    return res.status(400).json({ success: false, error: `Use: ${VALID.join(", ")}` });

  const days = parseInt(req.query.days) || 7;
  const data = await getHistory(tf, days);
  res.json({ success: true, timeframe: tf, count: data.length, days, data });
});

// ── GET /api/status ───────────────────────────────────────────────────────────
router.get("/status", async (req, res) => {
  try {
    const allAlerts = await getAllAlerts();
    res.json({
      success:    true,
      status:     "online",
      serverTime: new Date().toISOString(),
      utcTime:    new Date().toUTCString(),
      lastScan:   allAlerts.lastScan,
      scanState:  allAlerts.scanState,   // NEW: per-tf running state
      counts: {
        "4h": allAlerts["4h"].length,
        "1d": allAlerts["1d"].length,
      },
      schedule: {
        "4h":    "AUTO scan at 1AM, 5AM, 9AM, 1PM, 5PM, 9PM UTC — saved to DB",
        "1d":    "AUTO scan at 8PM UTC daily — saved to DB",
        manual: "Manual scans shown in UI only, NOT saved to history",
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
