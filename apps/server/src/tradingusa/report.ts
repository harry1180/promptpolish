/**
 * Date-range daily metrics for the Report page — one row per calendar day so
 * consecutive days can be compared directly.
 *
 * Platform percent convention: every *Pct field returned here is an
 * ALREADY-PERCENT number (winRatePct: 54.9, not 0.549); netPnl/equity are
 * dollars. Win/loss/expectancy metrics are null when nothing closed.
 *
 * Day attribution uses ET session dates (etDate) everywhere: signals carry
 * session_date directly, epoch-ms columns (orders/trades/snapshots/audit)
 * are mapped through etDate with a ±26h query window so no row near a day
 * boundary is lost.
 */
import type { DatabaseSync } from 'node:sqlite';
import { etDate } from '@promptslim/tucore';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 400;
const PAD_MS = 30 * 3600_000; // ET = UTC-4/-5: query [from-30h, to+30h] so the WHOLE final ET day (ends to+1 04/05:00Z) is covered; etDate day-mapping drops any row outside the range

export interface ReportDay {
  date: string;
  regime: string | null;
  scans: number;
  signals: number;
  orders: number;
  opened: number;
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  expectancyPct: number | null;
  stops: number;
  targets: number;
  netPnl: number | null;
  equity: number | null;
  blockedRegime: number;
  blockedLowConfidence: number;
  blockedLesson: number;
}

export interface ReportTotals {
  days: number;
  signals: number;
  orders: number;
  opened: number;
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  expectancyPct: number | null;
  stops: number;
  targets: number;
  netPnl: number;
  blockedRegime: number;
  blockedLowConfidence: number;
  blockedLesson: number;
}

export interface ReportResponse {
  from: string;
  to: string;
  days: ReportDay[];
  totals: ReportTotals;
}

/** Validate ?from=&to= — both optional; default = the last 14 days. */
export function reportRange(
  from: string | null,
  to: string | null,
  now: number,
): { from: string; to: string } | { error: string } {
  const end = to && to !== '' ? to : etDate(now);
  const start = from && from !== ''
    ? from
    : etDate(Date.parse(`${end}T12:00:00Z`) - 13 * 86400_000);
  if (!ISO.test(start) || !ISO.test(end)) return { error: 'dates must be YYYY-MM-DD' };
  if (start > end) return { error: 'from must be on or before to' };
  const span = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  if (span > MAX_SPAN_DAYS * 86400_000) return { error: `range too large (max ${MAX_SPAN_DAYS} days)` };
  return { from: start, to: end };
}

function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86400_000;
  }
  return out;
}

function emptyDay(date: string): ReportDay {
  return {
    date, regime: null, scans: 0, signals: 0, orders: 0, opened: 0, closed: 0,
    wins: 0, losses: 0, winRatePct: null, avgWinPct: null, avgLossPct: null,
    expectancyPct: null, stops: 0, targets: 0, netPnl: null, equity: null,
    blockedRegime: 0, blockedLowConfidence: 0, blockedLesson: 0,
  };
}

export function buildReport(db: DatabaseSync, from: string, to: string): ReportResponse {
  const days = dayList(from, to);
  const map = new Map<string, ReportDay>(days.map((d) => [d, emptyDay(d)]));
  const lo = Date.parse(`${from}T00:00:00Z`) - PAD_MS;
  const hi = Date.parse(`${to}T00:00:00Z`) + PAD_MS;

  // closed-trade returns per day (for win rate / avg / expectancy)
  const retSum = new Map<string, number>();
  const retN = new Map<string, number>();
  const winSum = new Map<string, { sum: number; n: number }>();
  const lossSum = new Map<string, { sum: number; n: number }>();
  let tWins = 0;
  let tLosses = 0;
  let tRetSum = 0;
  let tRetN = 0;

  const forDay = (ts: number): ReportDay | undefined => {
    const day = etDate(ts);
    return ts >= lo && ts < hi ? map.get(day) : undefined;
  };

  // scans + gate counters (audit_log detail now carries skipped* fields)
  const scans = db.prepare(
    `SELECT ts, detail_json FROM audit_log WHERE action = 'scan' AND ts >= ? AND ts < ?`,
  ).all(lo, hi) as unknown as Array<{ ts: number; detail_json: string }>;
  for (const row of scans) {
    const d = forDay(row.ts);
    if (!d) continue;
    d.scans += 1;
    try {
      const j = JSON.parse(row.detail_json) as Record<string, number | undefined>;
      d.blockedRegime += j.skippedRegime ?? 0;
      d.blockedLowConfidence += j.skippedLowConfidence ?? 0;
      d.blockedLesson += j.skippedLesson ?? 0;
    } catch { /* older rows without counters contribute 0 */ }
  }

  // signals (session_date is already an ET date string)
  const sigs = db.prepare(
    `SELECT session_date AS day, COUNT(*) AS n FROM signals WHERE session_date >= ? AND session_date <= ? GROUP BY session_date`,
  ).all(from, to) as unknown as Array<{ day: string; n: number }>;
  for (const row of sigs) {
    const d = map.get(row.day);
    if (d) d.signals = row.n;
  }

  // orders created
  const orders = db.prepare(
    `SELECT created_at FROM paper_orders WHERE created_at >= ? AND created_at < ?`,
  ).all(lo, hi) as unknown as Array<{ created_at: number }>;
  for (const row of orders) {
    const d = forDay(row.created_at);
    if (d) d.orders += 1;
  }

  // trades opened
  const opened = db.prepare(
    `SELECT entry_ts FROM paper_trades WHERE entry_ts >= ? AND entry_ts < ?`,
  ).all(lo, hi) as unknown as Array<{ entry_ts: number }>;
  for (const row of opened) {
    const d = forDay(row.entry_ts);
    if (d) d.opened += 1;
  }

  // trades closed
  const closed = db.prepare(
    `SELECT exit_ts, exit_reason, net_pnl, return_pct FROM paper_trades
     WHERE exit_ts IS NOT NULL AND exit_ts >= ? AND exit_ts < ?`,
  ).all(lo, hi) as unknown as Array<{ exit_ts: number; exit_reason: string | null; net_pnl: number | null; return_pct: number | null }>;
  let tNet = 0;
  let tClosed = 0;
  let tStops = 0;
  let tTargets = 0;
  for (const row of closed) {
    const d = forDay(row.exit_ts);
    if (!d) continue;
    d.closed += 1;
    tClosed += 1;
    if (row.exit_reason === 'STOP_REACHED') { d.stops += 1; tStops += 1; }
    else if (row.exit_reason === 'TARGET_REACHED') { d.targets += 1; tTargets += 1; }
    if (row.net_pnl !== null) {
      d.netPnl = (d.netPnl ?? 0) + row.net_pnl;
      tNet += row.net_pnl;
    }
    if (row.return_pct !== null) {
      retSum.set(d.date, (retSum.get(d.date) ?? 0) + row.return_pct);
      retN.set(d.date, (retN.get(d.date) ?? 0) + 1);
      tRetSum += row.return_pct;
      tRetN += 1;
      if (row.return_pct > 0) {
        d.wins += 1; tWins += 1;
        const w = winSum.get(d.date) ?? { sum: 0, n: 0 };
        w.sum += row.return_pct; w.n += 1; winSum.set(d.date, w);
      } else if (row.return_pct < 0) {
        d.losses += 1; tLosses += 1;
        const l = lossSum.get(d.date) ?? { sum: 0, n: 0 };
        l.sum += row.return_pct; l.n += 1; lossSum.set(d.date, l);
      }
    }
  }

  // regime per day
  const regimes = db.prepare(
    `SELECT date, regime FROM market_regimes WHERE date >= ? AND date <= ?`,
  ).all(from, to) as unknown as Array<{ date: string; regime: string }>;
  for (const row of regimes) {
    const d = map.get(row.date);
    if (d) d.regime = row.regime;
  }

  // equity: latest snapshot per portfolio per day, summed
  const snaps = db.prepare(
    `SELECT portfolio, ts, equity FROM portfolio_snapshots WHERE ts >= ? AND ts < ?`,
  ).all(lo, hi) as unknown as Array<{ portfolio: string; ts: number; equity: number }>;
  const latest = new Map<string, { ts: number; equity: number }>();
  for (const row of snaps) {
    const day = etDate(row.ts);
    if (row.ts < lo || row.ts >= hi || !map.has(day)) continue;
    const key = `${day}|${row.portfolio}`;
    const cur = latest.get(key);
    if (!cur || row.ts > cur.ts) latest.set(key, { ts: row.ts, equity: row.equity });
  }
  for (const [key, snap] of latest) {
    const day = key.split('|')[0];
    const d = map.get(day);
    if (d) d.equity = (d.equity ?? 0) + snap.equity;
  }

  // per-day derived metrics
  for (const d of map.values()) {
    const n = retN.get(d.date) ?? 0;
    if (n > 0) {
      d.expectancyPct = ((retSum.get(d.date) ?? 0) / n) * 100;
      d.winRatePct = (d.wins / n) * 100;
    }
    const w = winSum.get(d.date);
    if (w && w.n > 0) d.avgWinPct = (w.sum / w.n) * 100;
    const l = lossSum.get(d.date);
    if (l && l.n > 0) d.avgLossPct = (l.sum / l.n) * 100;
  }

  const totals: ReportTotals = {
    days: days.length,
    signals: [...map.values()].reduce((s, d) => s + d.signals, 0),
    orders: [...map.values()].reduce((s, d) => s + d.orders, 0),
    opened: [...map.values()].reduce((s, d) => s + d.opened, 0),
    closed: tClosed,
    wins: tWins,
    losses: tLosses,
    winRatePct: tRetN > 0 ? (tWins / tRetN) * 100 : null,
    expectancyPct: tRetN > 0 ? (tRetSum / tRetN) * 100 : null,
    stops: tStops,
    targets: tTargets,
    netPnl: tNet,
    blockedRegime: [...map.values()].reduce((s, d) => s + d.blockedRegime, 0),
    blockedLowConfidence: [...map.values()].reduce((s, d) => s + d.blockedLowConfidence, 0),
    blockedLesson: [...map.values()].reduce((s, d) => s + d.blockedLesson, 0),
  };

  return { from, to, days: days.map((d) => map.get(d)!), totals };
}