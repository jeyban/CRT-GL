/**
 * server.js — Main Entry Point
 */

const express = require("express");
const app     = express();
const PORT    = process.env.PORT || 3001;

// ── CORS — must be FIRST, before any routes ───────────────────────────────────
// Manually set headers on every single response to guarantee CORS works
app.use(function(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Answer preflight OPTIONS requests immediately
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
});

app.use(express.json());

// ── Request logging ───────────────────────────────────────────────────────────
app.use(function(req, res, next) {
  console.log("[" + new Date().toLocaleTimeString() + "] " + req.method + " " + req.path);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
const scannerRoutes = require("./routes/scanner");
app.use("/api", scannerRoutes);

// ── Gainers/Losers module routes (separate, additive — does not touch /api) ───
const gainersLosersRoutes = require("./routes/gainersLosers");
app.use("/api/gl", gainersLosersRoutes);

app.get("/", function(req, res) {
  res.json({
    name: "CRT Scanner API",
    version: "2.0.0",
    timeframes: ["4h","1d"],
    modules: {
      core: "/api (existing CRT scanner — unchanged)",
      gainersLosers: "/api/gl (Top 30 Gainers & Losers CRT scanner)"
    }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const { startScheduler, runScan } = require("./services/scheduler");

app.listen(PORT, async function() {
  console.log("\n🚀 CRT Scanner API on port " + PORT);

  // Start cron schedules (existing scanner)
  startScheduler();

  // ── Gainers/Losers module: independent schedulers + persistence ─────────────
  try {
    const glStore = require("./services/gl/glStore");
    const { startGlScheduler, runGlStartupScans } = require("./services/gl/glScheduler");
    glStore.init();            // load persisted data (file + optional Supabase)
    startGlScheduler();        // register 1H / 4H / Daily independent crons
    runGlStartupScans();       // background startup scans so dashboard isn't empty
    console.log("✅ Gainers/Losers module initialised (/api/gl)");
  } catch (glErr) {
    console.error("[GL] init error (existing scanner unaffected):", glErr.message);
  }

  // Self-ping every 10 minutes to keep Render free tier awake
  var SELF = (process.env.RENDER_EXTERNAL_URL || "http://localhost:" + PORT) + "/api/status";
  setInterval(function() {
    fetch(SELF).then(function(r) {
      console.log("[ping] " + r.status);
    }).catch(function(e) {
      console.warn("[ping] failed:", e.message);
    });
  }, 10 * 60 * 1000);
  console.log("[ping] Self-ping registered → " + SELF);

  // Run startup scans so dashboard is never empty
  console.log("\n▶ Running startup scans...");
  try {
    await runScan("4h");
    await runScan("1d");
    console.log("✅ Startup scans complete.\n");
  } catch(e) {
    console.error("Startup scan error:", e.message);
  }
});

module.exports = app;
