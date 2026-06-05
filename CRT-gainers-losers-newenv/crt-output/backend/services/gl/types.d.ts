/**
 * types.d.ts — Shared TypeScript types for the Gainers/Losers CRT module.
 *
 * The runtime is CommonJS JavaScript (to match the existing project), but these
 * ambient types document the data shapes and can be referenced from JSDoc
 * (`@type {import("./types").GLResult}`) or by any TS tooling/IDE.
 */

export type Timeframe = "1h" | "4h" | "1d";
export type Direction = "BULLISH" | "BEARISH";
export type Signal = "LONG" | "SHORT";
export type MoverType = "gainer" | "loser" | "both";
export type ScanType = "auto" | "manual";
export type ScannerStatus = "idle" | "scanning" | "error";

/** A single ranked mover from MEXC. */
export interface Mover {
  symbol: string;
  rate: number;        // 24h change in percent
  lastPrice: number | null;
}

export interface MoversResult {
  gainers: Mover[];
  losers: Mover[];
  universe: string[];  // de-duplicated symbols to scan
  rates: Record<string, number>;
}

/** Raw candle used by the CRT engine. */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Output of the existing detectCRT() engine (unchanged). */
export interface CRTAlert {
  id: string;
  symbol: string;
  timeframe: string;
  direction: Direction;
  c1High: number;
  c1Low: number;
  c2High: number;
  c2Low: number;
  sweepLevel: number;
  currentPrice: number;
  reclaimPercent: string;
  timestamp: string;
}

/** CRT detail block (mirror of engine fields, for storage/UI). */
export interface CRTDetails {
  c1High: number;
  c1Low: number;
  c2High: number;
  c2Low: number;
  sweepLevel: number;
  currentPrice: number;
  reclaimPercent: string;
}

/** Enriched, presentation-ready result (engine output + display metadata). */
export interface GLResult extends CRTAlert {
  signal: Signal;
  qualityScore: number;     // 1..100 (display only)
  moverType: MoverType;
  changeRate: number | null;
  chartUrl: string;
  detectionTime: string;
  scanDate: string;         // YYYY-MM-DD (UTC)
  details: CRTDetails;
}

export interface ScanProgress {
  scanned: number;
  total: number;
  found: number;
  errors: number;
}

export interface ScannerState {
  timeframe: Timeframe;
  status: ScannerStatus;
  lastScan: string | null;
  nextScan: string | null;
  lastScanType: ScanType | null;
  symbolsScanned: number;
  gainersCount: number;
  losersCount: number;
  universeSize: number;
  crtFound: number;
  errors: number;
  progress: ScanProgress;
  lastError: string | null;
}

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error" | "found";
  message: string;
}

export interface DashboardData {
  totalToday: number;
  counts: Record<Timeframe, number>;
  lastScan: string | null;
  nextScan: string | null;
  states: Record<Timeframe, ScannerState>;
}
