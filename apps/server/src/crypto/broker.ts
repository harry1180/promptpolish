/**
 * Crypto paper broker — the ONLY execution destination (PAPER_ONLY): one
 * spot book (CRYPTO_SPOT), long-only, no leverage, 24/7.
 *
 * What differs from the TradingUSA broker, and why:
 *  - FEES ARE REAL HERE. Exchange taker fees (~0.25% per side, configurable)
 *    are charged on BOTH entry and exit; `net_pnl` and `return_pct` are
 *    fee-inclusive, so the learning loop sees what a real account would have
 *    seen. (On US equities the fee is a rounding error — not here: a round
 *    trip costs ~0.5%.)
 *  - Crypto never closes: fills are never blocked by a session, and
 *    `sessions_held` counts calendar days (daily bars come from Kraken).
 *  - The benchmark is BTC, not SPY.
 *  - No market-regime gate in v1: regime flipping is a US-equities concept
 *    (there is no market_regimes table for crypto). Exits run on price,
 *    ATR-widened stop, target, trailing stop and max hold via tucore.checkExit.
 */
import type { DatabaseSync } from 'node:sqlite';
import { checkExit, etDate } from '@promptslim/tucore';
import type { ExitReason, Quote } from '@promptslim/tucore';
import type { CryptoConfig } from './config.ts';
import { validateEntryGeometry } from './guard.ts';
import type { CryptoMarketDataProvider } from './providers/types.ts';

export const CRYPTO_BENCHMARK = 'BTC';
export const CRYPTO_PORTFOLIO = 'CRYPTO_SPOT';

interface Bar {
  date: string; open: number; high: number; low: number; close: number; volume: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function loadBars(db: DatabaseSync, ticker: string, limit?: number): Bar[] {
  const sql = limit
    ? 'SELECT date, open, high, low, close, volume FROM market_bars WHERE ticker = ? ORDER BY date DESC LIMIT ?'
    : 'SELECT date, open, high, low, close, volume FROM market_bars WHERE ticker = ? ORDER BY date';
  const rows = (limit
    ? db.prepare(sql).all(ticker, limit)
    : db.prepare(sql).all(ticker)) as unknown as Bar[];
  return limit ? rows.reverse() : rows;
}

export function upsertBar(db: DatabaseSync, ticker: string, bar: Bar, provider = 'kraken'): void {
  db.prepare(
    `INSERT INTO market_bars (ticker, date, open, high, low, close, volume, provider, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(ticker, date) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low,
       close=excluded.close, volume=excluded.volume, provider=excluded.provider, fetched_at=excluded.fetched_at`,
  ).run(ticker, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, provider, Date.now());
}

export function upsertQuote(db: DatabaseSync, q: Quote & { bid?: number; ask?: number }): void {
  db.prepare(
    `INSERT INTO market_quotes (symbol, price, prev_close, ts, bid, ask, volume, provider, freshness)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol) DO UPDATE SET price=excluded.price, prev_close=excluded.prev_close,
       ts=excluded.ts, bid=excluded.bid, ask=excluded.ask, volume=excluded.volume,
       provider=excluded.provider, freshness=excluded.freshness`,
  ).run(
    q.symbol, q.price, q.prevClose, q.ts,
    q.bid ?? null, q.ask ?? null, q.volume ?? null,
    q.provider ?? 'kraken', q.freshness ?? 'REALTIME',
  );
}

export function latestQuote(db: DatabaseSync, symbol: string): (Quote & { bid?: number; ask?: number }) | null {
  const row = db
    .prepare('SELECT symbol, price, prev_close, ts, bid, ask, volume, provider, freshness FROM market_quotes WHERE symbol = ?')
    .get(symbol) as
    | { symbol: string; price: number; prev_close: number; ts: number; bid: number | null; ask: number | null; volume: number | null; provider: string; freshness: string }
    | undefined;
  if (!row) return null;
  return {
    symbol: row.symbol, price: row.price, prevClose: row.prev_close, ts: row.ts,
    bid: row.bid ?? undefined, ask: row.ask ?? undefined, volume: row.volume ?? undefined,
    provider: row.provider, freshness: row.freshness as Quote['freshness'],
  };
}

/* ------------------------------------------------------------------ */
/* fills — fee-aware, 24/7                                             */
/* ------------------------------------------------------------------ */

export interface CryptoFill {
  filled: boolean;
  price: number;
  /** price moved vs the reference, as a fraction (0.0001 = 1bp) */
  slippage: number;
  /** exchange fee charged on this fill, in quote currency */
  fee: number;
  notional: number;
  note: string;
}

/**
 * Fill against the book when we have one (buy the ask, sell the bid) and
 * against a liquidity-scaled slippage model when we do not. Fees are always
 * charged — that is the whole point of modelling them here.
 */
export function simulateCryptoFill(req: {
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  bid?: number;
  ask?: number;
  feePct: number;
  liquidityScore: number;
}): CryptoFill {
  const { side, qty, price, feePct } = req;
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
    return { filled: false, price: 0, slippage: 0, fee: 0, notional: 0, note: 'rejected' };
  }
  const liq = clamp(req.liquidityScore, 0, 1);
  let exec = price;
  let note: string;

  if (side === 'BUY' && Number.isFinite(req.ask as number) && (req.ask as number) > 0) {
    exec = req.ask as number;
    note = 'filled on the ask';
  } else if (side === 'SELL' && Number.isFinite(req.bid as number) && (req.bid as number) > 0) {
    exec = req.bid as number;
    note = 'filled on the bid';
  } else {
    // no book in the quote: liquidity-scaled slippage, wider than equities
    // because thin alt/memecoin books deserve it
    const bps = clamp(2 + 18 * (1 - liq), 2, 60);
    exec = side === 'BUY' ? price * (1 + bps / 10_000) : price * (1 - bps / 10_000);
    note = `filled at last price with ${bps.toFixed(1)} bps slippage (no book quoted)`;
  }

  const notional = exec * qty;
  const fee = notional * feePct;
  return {
    filled: true,
    price: exec,
    slippage: Math.abs(exec - price) / price,
    fee,
    notional,
    note: `${note}, fee ${feePct * 100}% (${fee.toFixed(2)})`,
  };
}

/* ------------------------------------------------------------------ */
/* portfolio                                                           */
/* ------------------------------------------------------------------ */

export function ensureSpotPortfolio(db: DatabaseSync, config: CryptoConfig): void {
  const now = Date.now();
  const existing = db.prepare('SELECT kind FROM paper_portfolios WHERE kind = ?').get(CRYPTO_PORTFOLIO);
  if (existing) return;
  db.prepare('INSERT INTO paper_portfolios (kind, start_capital, cash, created_at) VALUES (?, ?, ?, ?)')
    .run(CRYPTO_PORTFOLIO, config.startCapital, config.startCapital, now);
  db.prepare(
    'INSERT INTO portfolio_snapshots (portfolio, ts, equity, cash, realized, unrealized, exposure, benchmark_equity) VALUES (?, ?, ?, ?, 0, 0, 0, ?)',
  ).run(CRYPTO_PORTFOLIO, now, config.startCapital, config.startCapital, config.startCapital);
  db.prepare(`INSERT INTO tu_config (key, value) VALUES ('seeded_at', ?) ON CONFLICT(key) DO NOTHING`)
    .run(String(now));
}

function getCash(db: DatabaseSync): number {
  const row = db.prepare('SELECT cash FROM paper_portfolios WHERE kind = ?').get(CRYPTO_PORTFOLIO) as
    | { cash: number }
    | undefined;
  return row?.cash ?? 0;
}

function setCash(db: DatabaseSync, cash: number): void {
  db.prepare('UPDATE paper_portfolios SET cash = ? WHERE kind = ?').run(cash, CRYPTO_PORTFOLIO);
}

function liquidityOf(db: DatabaseSync, ticker: string): number {
  const bars = loadBars(db, ticker, 30);
  if (bars.length < 5) return 0.3;
  const avgVol = bars.reduce((s, b) => s + b.volume, 0) / bars.length;
  const avgPrice = bars.reduce((s, b) => s + b.close, 0) / bars.length;
  const dollarVolume = avgVol * avgPrice; // quote currency, not USD
  // crypto volume is quoted in base units: scale so BTC (~$1B+) reads high
  return Math.max(0.05, Math.min(1, Math.log10(Math.max(1, dollarVolume)) / 3));
}

/* ------------------------------------------------------------------ */
/* orders / positions / exits                                          */
/* ------------------------------------------------------------------ */

export interface FillSummary { filled: number; pending: number; closed: number }

export async function processOrders(
  db: DatabaseSync,
  provider: CryptoMarketDataProvider,
  config: CryptoConfig,
  now = Date.now(),
): Promise<FillSummary> {
  const summary: FillSummary = { filled: 0, pending: 0, closed: 0 };
  const orders = db
    .prepare(
      `SELECT id, portfolio, signal_id, ticker, side, qty, limit_price, stop_price, fill_mode
         FROM paper_orders WHERE status = 'PENDING' ORDER BY id`,
    )
    .all() as unknown as Array<{
      id: number; portfolio: string; signal_id: number | null; ticker: string;
      side: 'BUY' | 'SELL'; qty: number; limit_price: number | null;
      stop_price: number | null; fill_mode: string;
    }>;
  if (orders.length === 0) return summary;

  const symbols = [...new Set(orders.map((o) => o.ticker))];
  const quotes = await provider.getQuotes(symbols);
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));

  for (const order of orders) {
    const bars = loadBars(db, order.ticker, 2);
    const lastClose = bars[bars.length - 1]?.close ?? 0;
    const q = quoteMap.get(order.ticker) as (Quote & { bid?: number; ask?: number }) | undefined;
    const price = q?.price ?? lastClose;
    if (!price || price <= 0) { summary.pending += 1; continue; }

    // limit guard: a BUY limit fills only at or below it (crypto trades 24/7,
    // so there is no "wait for the open" branch)
    if (order.side === 'BUY' && order.limit_price != null && price > order.limit_price) {
      summary.pending += 1;
      continue;
    }

    const fill = simulateCryptoFill({
      side: order.side, qty: order.qty, price,
      bid: q?.bid, ask: q?.ask,
      feePct: config.feePct, liquidityScore: liquidityOf(db, order.ticker),
    });
    if (!fill.filled) { summary.pending += 1; continue; }

    // Entry/stop geometry guard, fill-time layer (approved correction item 1):
    // a BUY fill that lands below stop + buffer would open a position that is
    // already invalidated — reject it here with a reason code, before any
    // position exists. No clamping, no stop changes; the flag is the rollback.
    if (
      config.entryStopGuard && order.side === 'BUY' &&
      order.stop_price != null && order.stop_price > 0
    ) {
      const verdict = validateEntryGeometry({
        side: 'BUY', executablePrice: fill.price,
        invalidation: order.stop_price, bufferPct: config.entryStopBufferPct,
      });
      if (!verdict.ok) {
        db.prepare(`UPDATE paper_orders SET status = 'REJECTED', filled_at = ?, fill_note = ? WHERE id = ?`)
          .run(now, `${verdict.code}: ${verdict.detail ?? ''}`, order.id);
        db.prepare('INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?, ?, ?, ?, ?)')
          .run(now, 'order_rejected', 'order', String(order.id), JSON.stringify({
            code: verdict.code, ticker: order.ticker, fillPrice: fill.price,
            stop: order.stop_price, bufferPct: config.entryStopBufferPct, detail: verdict.detail,
          }));
        continue;
      }
    }

    if (order.side === 'BUY') {
      const cash = getCash(db);
      const cost = fill.notional + fill.fee;
      if (cost > cash) {
        db.prepare(`UPDATE paper_orders SET status = 'REJECTED', filled_at = ?, fill_note = ? WHERE id = ?`)
          .run(now, 'insufficient virtual cash (incl. fee)', order.id);
        continue;
      }
      const sig = order.signal_id
        ? (db.prepare('SELECT target, invalidation, max_hold, expected_return, company, sector FROM signals WHERE id = ?')
            .get(order.signal_id) as
            | { target: number; invalidation: number; max_hold: number; expected_return: number; company: string; sector: string }
            | undefined)
        : undefined;
      db.prepare(
        `INSERT INTO paper_positions (portfolio, ticker, company, sector, qty, entry_price, entry_ts, entry_session,
           target, stop, trailing_stop, max_hold, sessions_held, mfe, mae, thesis_status, signal_id,
           current_price, last_update, predicted_return, entry_fee)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,0,0,0,'INTACT',?,?,?,?,?)`,
      ).run(
        CRYPTO_PORTFOLIO, order.ticker,
        sig?.company ?? order.ticker, sig?.sector ?? 'Crypto',
        order.qty, fill.price, now, 'DAY_0',
        sig?.target ?? fill.price * 1.2, sig?.invalidation ?? fill.price * 0.94, sig?.max_hold ?? config.maxHoldSessions,
        order.signal_id, fill.price, now, sig?.expected_return ?? 0, fill.fee,
      );
      setCash(db, cash - cost);
      db.prepare(
        `UPDATE paper_orders SET status = 'FILLED', filled_at = ?, fill_price = ?, slippage = ?, fill_note = ? WHERE id = ?`,
      ).run(now, fill.price, fill.slippage, fill.note, order.id);
      summary.filled += 1;
    } else {
      const pos = db
        .prepare('SELECT id FROM paper_positions WHERE ticker = ? AND exit_ts IS NULL AND portfolio = ?')
        .get(order.ticker, CRYPTO_PORTFOLIO) as { id: number } | undefined;
      if (!pos) {
        db.prepare(`UPDATE paper_orders SET status = 'CANCELLED', filled_at = ?, fill_note = 'no open position' WHERE id = ?`)
          .run(now, order.id);
        continue;
      }
      closePosition(db, config, {
        ticker: order.ticker, qty: order.qty, exitPrice: fill.price, exitTs: now,
        reason: 'SELL_SIGNAL', exitFee: fill.fee,
      });
      db.prepare(
        `UPDATE paper_orders SET status = 'FILLED', filled_at = ?, fill_price = ?, slippage = ?, fill_note = ? WHERE id = ?`,
      ).run(now, fill.price, fill.slippage, fill.note, order.id);
      summary.filled += 1;
      summary.closed += 1;
    }
  }
  return summary;
}

export interface PositionRow {
  id: number; portfolio: string; ticker: string; company: string; sector: string;
  qty: number; entry_price: number; entry_ts: number; entry_session: string;
  target: number; stop: number; trailing_stop: number | null; max_hold: number;
  sessions_held: number; mfe: number; mae: number; thesis_status: string;
  signal_id: number | null; current_price: number | null; predicted_return: number;
  entry_fee?: number;
}

export function openPositions(db: DatabaseSync): PositionRow[] {
  return db
    .prepare('SELECT * FROM paper_positions WHERE exit_ts IS NULL ORDER BY entry_ts DESC')
    .all() as unknown as PositionRow[];
}

/** Mark to market, track MFE/MAE, fire price-triggered exits. 24/7. */
export async function monitorPositions(
  db: DatabaseSync,
  provider: CryptoMarketDataProvider,
  config: CryptoConfig,
  now = Date.now(),
): Promise<{ marked: number; exited: number }> {
  const positions = openPositions(db);
  if (positions.length === 0) return { marked: 0, exited: 0 };
  const quotes = await provider.getQuotes(positions.map((p) => p.ticker));
  const quoteMap = new Map(quotes.map((q) => [q.symbol, q]));
  let marked = 0;
  let exited = 0;

  for (const p of positions) {
    const q = quoteMap.get(p.ticker);
    const price = q?.price ?? p.current_price ?? p.entry_price;
    if (!price || price <= 0) continue;
    const high = Math.max(price, p.entry_price, p.current_price ?? price);
    const low = Math.min(price, p.entry_price, p.current_price ?? price);
    const mfe = Math.max(p.mfe, (high - p.entry_price) / p.entry_price);
    const mae = Math.min(p.mae, (low - p.entry_price) / p.entry_price);
    db.prepare('UPDATE paper_positions SET current_price = ?, last_update = ?, mfe = ?, mae = ? WHERE id = ?')
      .run(price, now, mfe, mae, p.id);
    marked += 1;

    const reason = checkExit(
      {
        side: 'LONG', entryPrice: p.entry_price, qty: p.qty, target: p.target, stop: p.stop,
        trailingStop: p.trailing_stop, maxHoldSessions: p.max_hold, sessionsHeld: p.sessions_held,
        thesisInvalidated: p.thesis_status === 'INVALIDATED', sellSignal: false,
        regimeChanged: false, // crypto has no regime table in v1 (see header)
      },
      { open: price, high, low, close: price, date: etDate(now) },
    );
    if (reason) {
      const bid = (q as { bid?: number } | undefined)?.bid;
      const exitPrice = reason === 'STOP_REACHED'
        ? Math.min(p.stop, bid && bid > 0 ? bid : price)
        : reason === 'TARGET_REACHED'
          ? Math.max(p.target, bid && bid > 0 ? bid : price)
          : price;
      const fee = exitPrice * p.qty * config.feePct;
      closePosition(db, config, { ticker: p.ticker, qty: p.qty, exitPrice, exitTs: now, reason, exitFee: fee });
      exited += 1;
    }
  }
  return { marked, exited };
}

/** End-of-day evaluation against real daily bars (gaps respected). */
export function settleEndOfDay(db: DatabaseSync, config: CryptoConfig, sessionDate?: string): { closed: number } {
  const date = sessionDate ?? etDate(Date.now());
  let closed = 0;
  for (const p of openPositions(db)) {
    if (etDate(p.entry_ts) > date) continue; // opened after this bar
    const bars = loadBars(db, p.ticker);
    const today = bars.find((b) => b.date === date);
    if (!today) continue;
    const sessionsHeld = bars.filter((b) => b.date > etDate(p.entry_ts)).length;
    const reason = checkExit(
      {
        side: 'LONG', entryPrice: p.entry_price, qty: p.qty, target: p.target, stop: p.stop,
        trailingStop: p.trailing_stop, maxHoldSessions: p.max_hold, sessionsHeld,
        thesisInvalidated: p.thesis_status === 'INVALIDATED', sellSignal: false,
        regimeChanged: false,
      },
      today,
    );
    db.prepare('UPDATE paper_positions SET sessions_held = ?, current_price = ? WHERE id = ?')
      .run(sessionsHeld, today.close, p.id);
    if (reason) {
      const exitPrice = reason === 'STOP_REACHED'
        ? Math.min(p.stop, Math.max(today.open, p.stop))
        : reason === 'TARGET_REACHED'
          ? Math.max(p.target, Math.min(today.open, p.target))
          : today.close;
      const fee = exitPrice * p.qty * config.feePct;
      closePosition(db, config, { ticker: p.ticker, qty: p.qty, exitPrice, exitTs: Date.now(), reason, exitFee: fee });
      closed += 1;
    }
  }
  return { closed };
}

export interface CloseArgs {
  ticker: string;
  qty: number;
  exitPrice: number;
  exitTs: number;
  reason: ExitReason | 'SELL_SIGNAL';
  exitFee?: number;
}

/** Close (or reduce) the spot position -> paper_trades, cash, prediction row.
 *  Returns are FEE-INCLUSIVE: net_pnl = gross - entry fee - exit fee. */
export function closePosition(db: DatabaseSync, config: CryptoConfig, args: CloseArgs): number | null {
  const pos = db
    .prepare('SELECT * FROM paper_positions WHERE ticker = ? AND exit_ts IS NULL AND portfolio = ?')
    .get(args.ticker, CRYPTO_PORTFOLIO) as unknown as PositionRow | undefined;
  if (!pos) return null;

  const qty = Math.min(args.qty, pos.qty);
  const entryNotional = pos.entry_price * qty;
  const gross = (args.exitPrice - pos.entry_price) * qty;
  const entryFee = (pos.entry_fee ?? 0) * (qty / Math.max(1, pos.qty));
  const exitFee = args.exitFee ?? args.exitPrice * qty * config.feePct;
  const net = gross - entryFee - exitFee;
  const actualReturn = entryNotional > 0 ? net / entryNotional : 0;

  const sig = pos.signal_id
    ? (db.prepare('SELECT id, strategy, strategy_version, expected_return FROM signals WHERE id = ?').get(pos.signal_id) as
        | { id: number; strategy: string; strategy_version: string; expected_return: number }
        | undefined)
    : undefined;

  const entryDate = etDate(pos.entry_ts);
  const exitDate = etDate(args.exitTs);
  const btcBars = loadBars(db, CRYPTO_BENCHMARK);
  const btcEntry = btcBars.find((b) => b.date >= entryDate)?.close ?? btcBars[btcBars.length - 1]?.close ?? 0;
  const btcExit = btcBars.filter((b) => b.date <= exitDate).pop()?.close ?? btcEntry;
  const benchmarkReturn = btcEntry > 0 ? (btcExit - btcEntry) / btcEntry : 0;

  const sessions = loadBars(db, pos.ticker).filter((b) => b.date > entryDate && b.date <= exitDate).length;
  const predicted = sig?.expected_return ?? pos.predicted_return;

  setCash(db, getCash(db) + args.exitPrice * qty - exitFee);

  const res = db
    .prepare(
      `INSERT INTO paper_trades (portfolio, ticker, company, sector, side, qty, entry_price, entry_ts, exit_price,
         exit_ts, exit_reason, capital, gross_pnl, net_pnl, return_pct, benchmark_return, excess_return,
         holding_sessions, mfe, mae, predicted_return, actual_return, prediction_error, signal_id, strategy,
         strategy_version, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      CRYPTO_PORTFOLIO, pos.ticker, pos.company, pos.sector, 'LONG', qty, pos.entry_price, pos.entry_ts,
      args.exitPrice, args.exitTs, args.reason, entryNotional, gross, net, actualReturn,
      benchmarkReturn, actualReturn - benchmarkReturn, sessions, pos.mfe, pos.mae,
      predicted, actualReturn, predicted - actualReturn, pos.signal_id,
      sig?.strategy ?? 'unknown', sig?.strategy_version ?? '1.0.0', 'CLOSED',
    );
  const tradeId = Number(res.lastInsertRowid);

  if (qty >= pos.qty) {
    db.prepare('UPDATE paper_positions SET exit_ts = ?, exit_reason = ? WHERE id = ?')
      .run(args.exitTs, args.reason, pos.id);
  } else {
    db.prepare('UPDATE paper_positions SET qty = qty - ?, entry_fee = ? WHERE id = ?')
      .run(qty, Math.max(0, pos.entry_fee ?? 0) - entryFee, pos.id);
  }

  if (sig) {
    db.prepare(
      `INSERT INTO prediction_results (signal_id, predicted_return, actual_return, prediction_error, holding_error, benchmark_return, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signal_id) DO UPDATE SET actual_return=excluded.actual_return,
         prediction_error=excluded.prediction_error, benchmark_return=excluded.benchmark_return, updated_at=excluded.updated_at`,
    ).run(sig.id, predicted, actualReturn, predicted - actualReturn, sessions, benchmarkReturn, Date.now());
    db.prepare(`UPDATE signal_status SET status = 'EXECUTED', updated_at = ? WHERE signal_id = ?`)
      .run(Date.now(), sig.id);
  }
  db.prepare('INSERT INTO audit_log (ts, action, entity, entity_id, detail_json) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), 'crypto_close', 'trade', String(tradeId),
      JSON.stringify({ ticker: pos.ticker, reason: args.reason, actualReturn, predicted, fees: entryFee + exitFee }));

  return tradeId;
}

export function openPositionRows(db: DatabaseSync): PositionRow[] {
  return openPositions(db);
}

export const _internal = { clamp, liquidityOf };