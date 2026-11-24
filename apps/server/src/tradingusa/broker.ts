/**
 * PaperBrokerService — the ONLY execution destination (ExecutionGuard
 * PAPER_ONLY). Fills are realistic: spread + slippage, market-hours aware,
 * never better than the market, no retrospective best-price fills, gaps
 * handled at the open. Positions track MFE/MAE, exits run through
 * tucore.checkExit, closed trades record predicted-vs-actual and feed the
 * learning pipeline.
 */
import type { DatabaseSync } from 'node:sqlite';
import { atr, checkExit, etDate, sessionKindAt, simulateFill } from '@promptslim/tucore';
import type { ExitReason, Quote } from '@promptslim/tucore';
import type { TuConfig } from './config.ts';
import type { MarketDataProvider } from './providers/yahoo.ts';
import { loadBars, ADVERSE_LONG_REGIMES } from './engine.ts';

/** True when the position's entry regime has since flipped INTO an adverse
 *  market regime. checkExit then returns REGIME_CHANGE (priority after
 *  stop/target/thesis/sell — a stop still wins). Previously this flag was
 *  hardcoded false, so a BULL_TREND -> RISK_OFF flip during a hold could
 *  never exit: the top logged mistake kind went unactioned. */
export function regimeChangedDuringHold(
  db: DatabaseSync,
  signalId: number | null,
): boolean {
  if (!signalId) return false;
  const sig = db.prepare('SELECT regime FROM signals WHERE id = ?').get(signalId) as
    | { regime: string }
    | undefined;
  if (!sig?.regime) return false;
  const now = db
    .prepare('SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1')
    .get() as { regime: string } | undefined;
  if (!now?.regime) return false;
  return (
    now.regime !== sig.regime &&
    (ADVERSE_LONG_REGIMES as string[]).includes(now.regime)
  );
}

/* ------------------------------------------------------------------ */
/* 2026-11-24 exits fix: ATR ratchet + dead-trade cleanup              */
/* ------------------------------------------------------------------ */

/** ATR14 of a ticker from its daily bars, null when history is too thin. */
function atrOf(db: DatabaseSync, ticker: string): number | null {
  const bars = loadBars(db, ticker, 30);
  if (bars.length < 15) return null;
  const values = atr(bars, 14);
  const last = values.length > 0 ? values[values.length - 1] : null;
  return last !== null && Number.isFinite(last) && last > 0 ? last : null;
}

/** Initial risk per share (entry -> placed stop) as a FRACTION of entry. */
function riskFraction(p: Pick<PositionRow, 'entry_price' | 'stop'>): number | null {
  const r = p.entry_price - p.stop;
  return r > 0 ? r / p.entry_price : null;
}

/**
 * Ratchet: once MFE reaches trailingArmRMultiple x R, trail the stop at
 * trailingAtrMultiple x ATR14 behind the peak — never tighter than the
 * original stop and never moving DOWN (a stop only ever locks profit).
 * Returns the trailing stop to hand to checkExit (null while unarmed).
 */
export function updateTrailingStop(
  db: DatabaseSync,
  p: Pick<PositionRow, 'id' | 'ticker' | 'entry_price' | 'stop' | 'mfe' | 'trailing_stop'>,
  config: TuConfig,
  peakPrice: number,
): number | null {
  if (config.trailingArmRMultiple <= 0 || config.trailingAtrMultiple <= 0) return p.trailing_stop;
  const rFrac = riskFraction(p);
  if (rFrac === null) return p.trailing_stop;
  if (!(p.mfe >= config.trailingArmRMultiple * rFrac)) return p.trailing_stop; // not armed yet
  const a = atrOf(db, p.ticker);
  if (a === null) return p.trailing_stop;
  const candidate = Math.max(peakPrice - config.trailingAtrMultiple * a, p.stop);
  const previous = p.trailing_stop;
  const next = previous === null || previous === undefined ? candidate : Math.max(previous, candidate);
  if (!(next > (previous ?? -Infinity))) return previous ?? null;
  db.prepare('UPDATE paper_positions SET trailing_stop = ? WHERE id = ?').run(next, p.id);
  return next;
}

/** Dead-trade cleanup: a position that has sat for N sessions without ever
 *  reaching M x R is closed at the day's price (exit_reason TIME_LIMIT — the
 *  existing time-limit reason, so every downstream report keeps working). */
export function isDeadTrade(
  p: Pick<PositionRow, 'entry_price' | 'stop' | 'mfe' | 'sessions_held'>,
  config: TuConfig,
): boolean {
  if (config.deadTradeSessions <= 0 || p.sessions_held < config.deadTradeSessions) return false;
  const rFrac = riskFraction(p);
  if (rFrac === null) return false;
  return p.mfe < config.deadTradeMfeRMultiple * rFrac;
}

export interface PortfolioRow { kind: string; start_capital: number; cash: number; created_at: number }

export function ensurePortfolios(db: DatabaseSync, config: TuConfig): void {
  const now = Date.now();
  for (const [kind, capital] of [
    ['SHORT_TERM_PORTFOLIO', config.shortCapital],
    ['LONG_TERM_PORTFOLIO', config.longCapital],
  ] as const) {
    const existing = db.prepare('SELECT kind FROM paper_portfolios WHERE kind = ?').get(kind);
    if (!existing) {
      db.prepare('INSERT INTO paper_portfolios (kind, start_capital, cash, created_at) VALUES (?, ?, ?, ?)')
        .run(kind, capital, capital, now);
      db.prepare('INSERT INTO portfolio_snapshots (portfolio, ts, equity, cash, realized, unrealized, exposure, benchmark_equity) VALUES (?, ?, ?, ?, 0, 0, 0, ?)')
        .run(kind, now, capital, capital, capital);
      db.prepare(
        `INSERT INTO tu_config (key, value) VALUES ('seeded_at', ?) ON CONFLICT(key) DO NOTHING`,
      ).run(String(now));
    }
  }
}

export interface FillSummary {
  filled: number;
  pending: number;
  closed: number;
}

function setCash(db: DatabaseSync, kind: string, cash: number): void {
  db.prepare('UPDATE paper_portfolios SET cash = ? WHERE kind = ?').run(cash, kind);
}

function getCash(db: DatabaseSync, kind: string): number {
  const row = db.prepare('SELECT cash FROM paper_portfolios WHERE kind = ?').get(kind) as { cash: number } | undefined;
  return row?.cash ?? 0;
}

/** Resolve pending paper orders against live/last quotes. */
export async function processOrders(
  db: DatabaseSync,
  provider: MarketDataProvider,
  config: TuConfig,
  now = Date.now(),
): Promise<FillSummary> {
  const summary: FillSummary = { filled: 0, pending: 0, closed: 0 };
  const session = sessionKindAt(now);
  const orders = db
    .prepare(`SELECT id, portfolio, signal_id, ticker, side, qty, limit_price, stop_price, fill_mode, created_at FROM paper_orders WHERE status = 'PENDING' ORDER BY id`)
    .all() as unknown as Array<{
      id: number; portfolio: string; signal_id: number | null; ticker: string; side: 'BUY' | 'SELL';
      qty: number; limit_price: number | null; stop_price: number | null; fill_mode: string; created_at: number;
    }>;
  if (orders.length === 0) return summary;

  const symbols = [...new Set(orders.map((o) => o.ticker))];
  const quotes = await provider.getQuotes(symbols);
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

  for (const order of orders) {
    const bars = loadBars(db, order.ticker, 3);
    const lastClose = bars[bars.length - 1]?.close ?? null;
    const q: Quote = quoteMap.get(order.ticker) ?? {
      symbol: order.ticker, price: lastClose ?? 0, prevClose: lastClose ?? 0,
      ts: bars.length >= 2 ? Date.parse(bars[bars.length - 1].date) : now,
      provider: provider.name, freshness: 'DELAYED',
    };
    if (!q.price || q.price <= 0) { summary.pending += 1; continue; }

    const fill = simulateFill({
      side: order.side, qty: order.qty, quote: q, session,
      fillMode: order.fill_mode === 'NEXT_OPEN' ? 'NEXT_OPEN' : 'AT_SIGNAL',
      liquidityScore: liquidityOf(db, order.ticker),
      nowMs: now,
      nextOpenPrice: session === 'MARKET_OPEN' || session === 'EARLY_CLOSE' ? q.price : undefined,
    });

    if (!fill.filled) { summary.pending += 1; continue; }

    if (order.side === 'BUY') {
      const cash = getCash(db, order.portfolio);
      const notional = fill.price * order.qty;
      if (notional > cash) {
        db.prepare(`UPDATE paper_orders SET status = 'REJECTED', filled_at = ?, fill_note = ? WHERE id = ?`)
          .run(now, 'insufficient virtual cash', order.id);
        continue;
      }
      const sig = order.signal_id
        ? (db.prepare('SELECT target, invalidation, max_hold, expected_return FROM signals WHERE id = ?').get(order.signal_id) as
            | { target: number; invalidation: number; max_hold: number; expected_return: number } | undefined)
        : undefined;
      db.prepare(
        `INSERT INTO paper_positions (portfolio, ticker, company, sector, qty, entry_price, entry_ts, entry_session,
           target, stop, trailing_stop, max_hold, sessions_held, mfe, mae, thesis_status, signal_id, current_price, last_update, predicted_return)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, 0, 'INTACT', ?, ?, ?, ?)`,
      ).run(
        order.portfolio, order.ticker,
        (db.prepare('SELECT company FROM signals WHERE id = ?').get(order.signal_id ?? -1) as { company: string } | undefined)?.company ?? order.ticker,
        (db.prepare('SELECT sector FROM signals WHERE id = ?').get(order.signal_id ?? -1) as { sector: string } | undefined)?.sector ?? 'Unknown',
        order.qty, fill.price, now, session,
        sig?.target ?? fill.price * 1.1, sig?.invalidation ?? fill.price * 0.95, sig?.max_hold ?? 20,
        order.signal_id, fill.price, now, sig?.expected_return ?? 0,
      );
      setCash(db, order.portfolio, cash - notional);
      db.prepare(`UPDATE paper_orders SET status = 'FILLED', filled_at = ?, fill_price = ?, slippage = ?, fill_note = ? WHERE id = ?`)
        .run(now, fill.price, fill.slippage, fill.note, order.id);
      summary.filled += 1;
    } else {
      // SELL order: close/reduce the open paper position (long-only book)
      const pos = db
        .prepare('SELECT * FROM paper_positions WHERE portfolio = ? AND ticker = ? AND exit_ts IS NULL')
        .get(order.portfolio, order.ticker) as Record<string, unknown> | undefined;
      if (!pos) {
        db.prepare(`UPDATE paper_orders SET status = 'CANCELLED', filled_at = ?, fill_note = 'no open position' WHERE id = ?`).run(now, order.id);
        continue;
      }
      closePosition(db, config, {
        portfolio: order.portfolio,
        ticker: order.ticker,
        qty: order.qty,
        exitPrice: fill.price,
        exitTs: now,
        reason: 'SELL_SIGNAL',
      });
      db.prepare(`UPDATE paper_orders SET status = 'FILLED', filled_at = ?, fill_price = ?, slippage = ?, fill_note = ? WHERE id = ?`)
        .run(now, fill.price, fill.slippage, fill.note, order.id);
      summary.filled += 1;
      summary.closed += 1;
    }
  }
  return summary;
}

function liquidityOf(db: DatabaseSync, ticker: string): number {
  const bars = loadBars(db, ticker, 30);
  if (bars.length < 5) return 0.3;
  const avgVol = bars.reduce((s, b) => s + b.volume, 0) / bars.length;
  const avgPrice = bars.reduce((s, b) => s + b.close, 0) / bars.length;
  const dollarVolume = avgVol * avgPrice;
  return Math.max(0.05, Math.min(1, Math.log10(Math.max(1, dollarVolume / 10_000_000)) / 1.4));
}

interface PositionRow {
  id: number; portfolio: string; ticker: string; company: string; sector: string;
  qty: number; entry_price: number; entry_ts: number; entry_session: string;
  target: number; stop: number; trailing_stop: number | null; max_hold: number;
  sessions_held: number; mfe: number; mae: number; thesis_status: string;
  signal_id: number | null; current_price: number | null; predicted_return: number;
}

export function openPositions(db: DatabaseSync, portfolio?: string): PositionRow[] {
  const sql = portfolio
    ? 'SELECT * FROM paper_positions WHERE exit_ts IS NULL AND portfolio = ? ORDER BY entry_ts DESC'
    : 'SELECT * FROM paper_positions WHERE exit_ts IS NULL ORDER BY entry_ts DESC';
  const rows = portfolio ? db.prepare(sql).all(portfolio) : db.prepare(sql).all();
  return rows as unknown as PositionRow[];
}

/** Intraday monitoring: mark to market, MFE/MAE, price-triggered exits. */
export async function monitorPositions(
  db: DatabaseSync,
  provider: MarketDataProvider,
  config: TuConfig,
  now = Date.now(),
): Promise<{ marked: number; exited: number }> {
  const session = sessionKindAt(now);
  const positions = openPositions(db);
  if (positions.length === 0) return { marked: 0, exited: 0 };
  const active = session === 'MARKET_OPEN' || session === 'EARLY_CLOSE' || session === 'PREMARKET' || session === 'POSTMARKET';
  const quotes = await provider.getQuotes(positions.map((p) => p.ticker));
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
  let marked = 0;
  let exited = 0;

  for (const p of positions) {
    const q = quoteMap.get(p.ticker);
    const price = q?.price ?? p.current_price ?? p.entry_price;
    const high = Math.max(price, p.entry_price, p.current_price ?? price);
    const low = Math.min(price, p.entry_price, p.current_price ?? price);
    const mfe = Math.max(p.mfe, (high - p.entry_price) / p.entry_price);
    const mae = Math.min(p.mae, (low - p.entry_price) / p.entry_price);
    db.prepare('UPDATE paper_positions SET current_price = ?, last_update = ?, mfe = ?, mae = ? WHERE id = ?')
      .run(price, now, mfe, mae, p.id);
    marked += 1;

    if (!active) continue;
    const peak = p.entry_price * (1 + mfe);
    const trailingStop = updateTrailingStop(db, { ...p, mfe }, config, peak);
    const reason = checkExit(
      {
        side: 'LONG', entryPrice: p.entry_price, qty: p.qty, target: p.target, stop: p.stop,
        trailingStop, maxHoldSessions: p.max_hold, sessionsHeld: p.sessions_held,
        thesisInvalidated: p.thesis_status === 'INVALIDATED', sellSignal: false,
        regimeChanged: regimeChangedDuringHold(db, p.signal_id),
      },
      { open: price, high, low, close: price, date: etDate(now) },
    ) ?? (isDeadTrade({ ...p, mfe }, config) ? 'TIME_LIMIT' : null);
    if (reason) {
      // realistic stop handling: gap fills use the worse of stop/open
      const exitPrice = reason === 'STOP_REACHED' ? Math.min(p.stop, price) : reason === 'TARGET_REACHED' ? Math.max(p.target, price) : price;
      closePosition(db, config, { portfolio: p.portfolio, ticker: p.ticker, qty: p.qty, exitPrice, exitTs: now, reason });
      exited += 1;
    }
  }
  return { marked, exited };
}

/** End-of-session evaluation with real daily bars (gaps respected). */
export function settleEndOfDay(db: DatabaseSync, config: TuConfig, sessionDate?: string): { closed: number } {
  const date = sessionDate ?? etDate(Date.now());
  let closed = 0;
  for (const p of openPositions(db)) {
    // Positions opened AFTER this session must not be judged by its bar:
    // bars land up to a day late, so the newest bar can predate entries made
    // since (e.g. settling 10-19 while 10-20 entries exist would fire their
    // stops against prices from before they entered).
    if (dateOf(p.entry_ts) > date) continue;
    const bars = loadBars(db, p.ticker);
    const today = bars.find((b) => b.date === date);
    if (!today) continue;
    const sessionsHeld = bars.filter((b) => b.date > dateOf(p.entry_ts)).length;
    let reason = checkExit(
      {
        side: 'LONG', entryPrice: p.entry_price, qty: p.qty, target: p.target, stop: p.stop,
        trailingStop: p.trailing_stop, maxHoldSessions: p.max_hold, sessionsHeld,
        thesisInvalidated: p.thesis_status === 'INVALIDATED', sellSignal: false,
        regimeChanged: regimeChangedDuringHold(db, p.signal_id),
      },
      today,
    );
    db.prepare('UPDATE paper_positions SET sessions_held = ?, current_price = ? WHERE id = ?').run(sessionsHeld, today.close, p.id);
    if (!reason) {
      // end-of-day pass also runs the ratchet + dead-trade cleanup so a
      // position that only qualifies after the close is handled in the same cycle
      const peak = p.entry_price * (1 + p.mfe);
      const trailingStop = updateTrailingStop(db, p, config, peak);
      const settled = checkExit(
        {
          side: 'LONG', entryPrice: p.entry_price, qty: p.qty, target: p.target, stop: p.stop,
          trailingStop, maxHoldSessions: p.max_hold, sessionsHeld,
          thesisInvalidated: p.thesis_status === 'INVALIDATED', sellSignal: false,
          regimeChanged: regimeChangedDuringHold(db, p.signal_id),
        },
        today,
      );
      reason = settled ?? (isDeadTrade({ ...p, sessions_held: sessionsHeld }, config) ? 'TIME_LIMIT' : null);
    }
    if (reason) {
      const exitPrice = reason === 'STOP_REACHED' ? Math.min(p.stop, Math.max(today.open, p.stop))
        : reason === 'TARGET_REACHED' ? Math.max(p.target, Math.min(today.open, p.target))
        : today.close;
      closePosition(db, config, { portfolio: p.portfolio, ticker: p.ticker, qty: p.qty, exitPrice, exitTs: Date.now(), reason });
      closed += 1;
    }
  }
  return { closed };
}

function dateOf(ts: number): string {
  return etDate(ts);
}

export interface CloseArgs {
  portfolio: string; ticker: string; qty: number; exitPrice: number; exitTs: number;
  reason: ExitReason | 'SELL_SIGNAL';
}

/** Close a paper position -> paper_trades + cash + predicted-vs-actual. */
export function closePosition(db: DatabaseSync, config: TuConfig, args: CloseArgs): number | null {
  const pos = db
    .prepare('SELECT * FROM paper_positions WHERE portfolio = ? AND ticker = ? AND exit_ts IS NULL')
    .get(args.portfolio, args.ticker) as unknown as PositionRow | undefined;
  if (!pos) return null;

  const qty = Math.min(args.qty, pos.qty);
  const gross = (args.exitPrice - pos.entry_price) * qty;
  const entryNotional = pos.entry_price * qty;
  const actualReturn = (args.exitPrice - pos.entry_price) / pos.entry_price;

  const sig = pos.signal_id
    ? (db.prepare('SELECT id, strategy, strategy_version, expected_return, created_at, session_date FROM signals WHERE id = ?').get(pos.signal_id) as
        | { id: number; strategy: string; strategy_version: string; expected_return: number; created_at: number; session_date: string } | undefined)
    : undefined;

  // benchmark (SPY) return over the same holding window
  const spyBars = loadBars(db, 'SPY');
  const entryDate = etDate(pos.entry_ts);
  const exitDate = etDate(args.exitTs);
  const spyEntry = spyBars.find((b) => b.date >= entryDate)?.close ?? spyBars[spyBars.length - 1]?.close ?? 0;
  const spyExit = spyBars.filter((b) => b.date <= exitDate).pop()?.close ?? spyEntry;
  const benchmarkReturn = spyEntry > 0 ? (spyExit - spyEntry) / spyEntry : 0;

  const sessions = loadBars(db, pos.ticker).filter((b) => b.date > entryDate && b.date <= exitDate).length;
  const predicted = sig?.expected_return ?? pos.predicted_return;

  const cash = getCash(db, args.portfolio) + args.exitPrice * qty;
  setCash(db, args.portfolio, cash);

  const res = db
    .prepare(
      `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts, exit_price,
         exit_ts, exit_reason, capital, gross_pnl, net_pnl, return_pct, benchmark_return, excess_return,
         holding_sessions, mfe, mae, predicted_return, actual_return, prediction_error, signal_id, strategy,
         strategy_version, status)
       VALUES (?, ?, ?, ?, 'LONG', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CLOSED')`,
    )
    .run(
      args.portfolio, pos.ticker, pos.company, pos.sector, qty, pos.entry_price, pos.entry_ts,
      args.exitPrice, args.exitTs, args.reason, entryNotional, gross, gross, actualReturn,
      benchmarkReturn, actualReturn - benchmarkReturn, sessions, pos.mfe, pos.mae,
      predicted, actualReturn, predicted - actualReturn, pos.signal_id,
      sig?.strategy ?? 'unknown', sig?.strategy_version ?? '1.0.0',
    );
  const tradeId = Number(res.lastInsertRowid);

  if (qty >= pos.qty) {
    db.prepare('UPDATE paper_positions SET exit_ts = ?, exit_reason = ? WHERE id = ?').run(args.exitTs, args.reason, pos.id);
  } else {
    db.prepare('UPDATE paper_positions SET qty = qty - ? WHERE id = ?').run(qty, pos.id);
  }

  // predicted-vs-actual record + ablation resolution + audit
  if (sig) {
    db.prepare(
      `INSERT INTO prediction_results (signal_id, predicted_return, actual_return, prediction_error, holding_error, benchmark_return, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signal_id) DO UPDATE SET actual_return=excluded.actual_return,
         prediction_error=excluded.prediction_error, benchmark_return=excluded.benchmark_return, updated_at=excluded.updated_at`,
    ).run(sig.id, predicted, actualReturn, predicted - actualReturn, sessions, benchmarkReturn, Date.now());
    db.prepare(`UPDATE signal_status SET status = 'EXECUTED', updated_at = ? WHERE signal_id = ?`).run(Date.now(), sig.id);
  }
  db.prepare('INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), 'paper_close', 'trade', String(tradeId), JSON.stringify({ ticker: pos.ticker, reason: args.reason, actualReturn, predicted }));

  void config;
  return tradeId;
}
