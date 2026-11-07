/**
 * Fixed-horizon directional accuracy — correction phase, approved item 2.
 *
 * Evaluates EVERY historical signal at 30s / 60s / 5m / 30m / 1d, BUY and
 * SELL separately, against always-UP, always-DOWN and persistence baselines,
 * with class balance reported. The earlier 84.6% number (price now vs signal
 * price) is explicitly NOT this measurement — this one is horizon-fixed.
 *
 * Look-ahead rules:
 *  - <= 30m horizons use micro_snapshots (10s cadence, recorded from the live
 *    stream): the first snapshot at or after signal_ts + horizon, never an
 *    earlier one; if none exists inside the tolerance window -> noData.
 *  - 1d uses the first daily bar whose date is >= the horizon's calendar date;
 *    that bar's close is observed at/after the horizon -> counted, with the
 *    approximation documented in `note` (bar close lags the exact 24h mark).
 *  - persistence baseline predicts the direction of the move from the prior
 *    daily close into the signal price (information available at signal time).
 *
 * micro_snapshots are pruned at 7d, so short-horizon rows only accumulate
 * from the recording start; horizons with no data are reported as such, never
 * imputed.
 */
import type { DatabaseSync } from 'node:sqlite';
import { etDate } from '@promptslim/tucore';

export interface HorizonDef {
  key: '30s' | '60s' | '5m' | '30m' | '1d';
  ms: number;
  tolMs: number;
  source: 'micro_snapshot' | 'daily_bar';
}

export const FIXED_HORIZONS: HorizonDef[] = [
  { key: '30s', ms: 30_000, tolMs: 30_000, source: 'micro_snapshot' },
  { key: '60s', ms: 60_000, tolMs: 30_000, source: 'micro_snapshot' },
  { key: '5m', ms: 300_000, tolMs: 60_000, source: 'micro_snapshot' },
  { key: '30m', ms: 1_800_000, tolMs: 120_000, source: 'micro_snapshot' },
  { key: '1d', ms: 86_400_000, tolMs: 0, source: 'daily_bar' },
];

interface SignalRow {
  id: number; ticker: string; signal: 'BUY' | 'SELL';
  price: number; created_at: number; session_date: string;
}

interface SideStats { n: number; correct: number; pct: number | null }
interface BaselineStat { n: number; pct: number | null }

export interface AccuracyHorizon {
  key: string;
  source: string;
  horizonMs: number;
  elapsed: number;
  evaluated: number;
  flat: number;
  noData: number;
  accuracy: { BUY: SideStats; SELL: SideStats; overall: SideStats };
  classBalance: { up: number; down: number; upPct: number | null };
  baselines: { alwaysUp: BaselineStat; alwaysDown: BaselineStat; persistence: BaselineStat };
}

export interface AccuracyDetail {
  signalId: number; ticker: string; side: string;
  createdAt: number; signalPrice: number;
  horizon: string; observedTs: number; observedPrice: number;
  actualReturn: number; predicted: string; actual: string;
  correct: boolean | null; source: string;
}

export interface AccuracyReport {
  generatedAt: number;
  note: string;
  signals: { total: number; BUY: number; SELL: number };
  horizons: AccuracyHorizon[];
  detail: AccuracyDetail[];
}

function microOutcome(db: DatabaseSync, symbol: string, t: number, h: HorizonDef): { ts: number; price: number } | null {
  const row = db
    .prepare(
      `SELECT ts, payload FROM micro_snapshots
        WHERE symbol = ? AND ts >= ? AND ts <= ? ORDER BY ts LIMIT 1`,
    )
    .get(symbol, t + h.ms, t + h.ms + h.tolMs) as { ts: number; payload: string } | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload) as { mid?: number; price?: number };
    const price = Number(parsed.mid ?? parsed.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { ts: row.ts, price };
  } catch {
    return null;
  }
}

function barOutcome(db: DatabaseSync, symbol: string, horizonMs: number, t: number): { ts: number; price: number; date: string } | null {
  const horizonDate = etDate(t + horizonMs);
  const row = db
    .prepare('SELECT date, close FROM market_bars WHERE ticker = ? AND date >= ? ORDER BY date LIMIT 1')
    .get(symbol, horizonDate) as { date: string; close: number } | undefined;
  if (!row) return null;
  // observed at (or after) that day's close — never before the horizon
  return { ts: Date.parse(`${row.date}T23:59:59Z`), price: row.close, date: row.date };
}

function priorClose(db: DatabaseSync, symbol: string, sessionDate: string): number | null {
  const row = db
    .prepare('SELECT close FROM market_bars WHERE ticker = ? AND date < ? ORDER BY date DESC LIMIT 1')
    .get(symbol, sessionDate) as { close: number } | undefined;
  return row && Number.isFinite(row.close) && row.close > 0 ? row.close : null;
}

function sideStats(rows: Array<{ predicted: string; actual: string }>): SideStats {
  const judged = rows.filter((r) => r.actual !== 'FLAT');
  const correct = judged.filter((r) => r.predicted === r.actual).length;
  return { n: judged.length, correct, pct: judged.length > 0 ? correct / judged.length : null };
}

export function evaluateFixedHorizons(db: DatabaseSync, now = Date.now()): AccuracyReport {
  const signals = db
    .prepare(
      `SELECT id, ticker, signal, price, created_at, session_date FROM signals
        WHERE signal IN ('BUY','SELL') ORDER BY created_at`,
    )
    .all() as unknown as SignalRow[];

  const horizons: AccuracyHorizon[] = [];
  const detail: AccuracyDetail[] = [];

  for (const h of FIXED_HORIZONS) {
    const rows: Array<{ side: string; predicted: string; actual: string; up: boolean | null; persisted: boolean | null }> = [];
    let elapsed = 0;
    let noData = 0;
    let flat = 0;

    for (const s of signals) {
      if (now < s.created_at + h.ms) continue; // horizon not elapsed yet
      elapsed += 1;

      let observed: { ts: number; price: number } | null;
      if (h.source === 'micro_snapshot') {
        observed = microOutcome(db, s.ticker, s.created_at, h);
      } else {
        const b = barOutcome(db, s.ticker, h.ms, s.created_at);
        observed = b ? { ts: b.ts, price: b.price } : null;
      }
      if (!observed) { noData += 1; continue; }

      const ret = (observed.price - s.price) / s.price;
      const actual = ret > 0 ? 'UP' : ret < 0 ? 'DOWN' : 'FLAT';
      const predicted = s.signal === 'BUY' ? 'UP' : 'DOWN';

      let persisted: boolean | null = null;
      if (h.source === 'daily_bar') {
        const pc = priorClose(db, s.ticker, s.session_date);
        if (pc != null && pc !== s.price) {
          const priorDir = s.price > pc ? 'UP' : 'DOWN';
          persisted = actual === 'FLAT' ? null : priorDir === actual;
        }
      }

      if (actual === 'FLAT') flat += 1;
      rows.push({ side: s.signal, predicted, actual, up: actual === 'FLAT' ? null : actual === 'UP', persisted });

      detail.push({
        signalId: s.id, ticker: s.ticker, side: s.signal,
        createdAt: s.created_at, signalPrice: s.price,
        horizon: h.key, observedTs: observed.ts, observedPrice: observed.price,
        actualReturn: ret, predicted, actual,
        correct: actual === 'FLAT' ? null : predicted === actual,
        source: h.source,
      });
    }

    const judged = rows.filter((r) => r.up !== null);
    const up = judged.filter((r) => r.up === true).length;
    const down = judged.length - up;
    const buyRows = rows.filter((r) => r.side === 'BUY');
    const sellRows = rows.filter((r) => r.side === 'SELL');
    const persistedRows = rows.filter((r) => r.persisted !== null);

    horizons.push({
      key: h.key,
      source: h.source,
      horizonMs: h.ms,
      elapsed,
      evaluated: rows.length,
      flat,
      noData,
      accuracy: {
        BUY: sideStats(buyRows),
        SELL: sideStats(sellRows),
        overall: sideStats(rows),
      },
      classBalance: {
        up, down,
        upPct: judged.length > 0 ? up / judged.length : null,
      },
      baselines: {
        alwaysUp: { n: judged.length, pct: judged.length > 0 ? up / judged.length : null },
        alwaysDown: { n: judged.length, pct: judged.length > 0 ? down / judged.length : null },
        persistence: {
          n: persistedRows.length,
          pct: persistedRows.length > 0
            ? persistedRows.filter((r) => r.persisted === true).length / persistedRows.length
            : null,
        },
      },
    });
  }

  return {
    generatedAt: now,
    note: 'Horizon-fixed evaluation: outcome taken at/after signal_ts + horizon, never before. '
      + '<=30m use micro_snapshots (10s cadence, 7d retention); 1d uses the first daily bar at/after the horizon date '
      + '(close lags the exact 24h mark). Persistence = direction from prior daily close into the signal price. '
      + 'The earlier point-in-time 84.6% figure is not comparable to these rows.',
    signals: {
      total: signals.length,
      BUY: signals.filter((s) => s.signal === 'BUY').length,
      SELL: signals.filter((s) => s.signal === 'SELL').length,
    },
    horizons,
    detail,
  };
}
