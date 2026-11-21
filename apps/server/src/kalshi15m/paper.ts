/**
 * Paper execution layer (Phase 6 state machine + Phase 7 risk limits).
 *
 * PAPER ONLY — this module contains NO order placement: fills are simulated
 * against the live executable book (entry at the ASK, exit at the BID, never
 * midpoints, capped by displayed depth). It exists so the state machine and
 * the risk limits run against real market data before anything real happens.
 *
 * State machine per position:
 *   MONITOR -> SIGNAL -> VALIDATE -> ENTER -> CONFIRM_FILL -> MANAGE -> EXIT
 *   -> RECONCILE -> MONITOR
 * Rules enforced here, not hoped for:
 *   - no new entry without a fresh, independently evaluated signal
 *     (cooldown after any exit; a position cannot be added to),
 *   - one open position per market (no averaging down, by construction),
 *   - sizing is a fixed fraction of bankroll — never martingale,
 *   - daily loss cap, total exposure cap and per-trade risk cap gate ENTRY
 *     and are reported when they fire,
 *   - partial fills: size is capped by displayed depth; if the wanted size
 *     does not fit and partials are disallowed the trade is refused.
 */
import type { DatabaseSync } from 'node:sqlite';
import { takerFee, KXBTC15M_FEES } from './fee.ts';
import type { StrategyVerdict } from './strategies.ts';

export interface PaperConfig {
  enabled: boolean;
  bankrollCents: number;
  riskPerTradePct: number;
  dailyLossCapPct: number;
  maxExposurePct: number;
  maxPositionsPerMarket: number;
  minNetPp: number;
  holdSec: number;
  stopLossPp: number;
  takeProfitPp: number;
  reentryCooldownMs: number;
  allowPartial: boolean;
  /** reject when the decision book is older than this (ms) */
  maxBookAgeMs: number;
}

export function paperConfigFromEnv(env: Record<string, string | undefined> = process.env): PaperConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const bool = (v: string | undefined): boolean => v === '1' || v === 'true';
  return {
    enabled: bool(env.KALSHI15M_PAPER),
    bankrollCents: num(env.KALSHI15M_PAPER_BANKROLL, 100_000), // $1,000 paper
    riskPerTradePct: num(env.KALSHI15M_PAPER_RISK_PCT, 0.25),
    dailyLossCapPct: num(env.KALSHI15M_PAPER_DAILY_LOSS_PCT, 2),
    maxExposurePct: num(env.KALSHI15M_PAPER_EXPOSURE_PCT, 5),
    maxPositionsPerMarket: 1,
    minNetPp: num(env.KALSHI15M_PAPER_MIN_NET_PP, 2),
    holdSec: num(env.KALSHI15M_PAPER_HOLD_SEC, 10),
    stopLossPp: num(env.KALSHI15M_PAPER_STOP_PP, 5),
    takeProfitPp: num(env.KALSHI15M_PAPER_TAKE_PP, 10),
    reentryCooldownMs: num(env.KALSHI15M_PAPER_COOLDOWN_MS, 5_000),
    allowPartial: env.KALSHI15M_PAPER_ALLOW_PARTIAL === '1',
    maxBookAgeMs: num(env.KALSHI15M_PAPER_MAX_BOOK_AGE_MS, 5_000),
  };
}

export type PaperPhase = 'MONITOR' | 'SIGNAL' | 'VALIDATE' | 'ENTER' | 'CONFIRM_FILL'
  | 'MANAGE' | 'EXIT' | 'RECONCILE';

export interface PaperBookView {
  yesBid: number | null;
  yesAsk: number | null;
  /** dollars of resting size behind the top level, when known */
  depthBidDollars?: number | null;
  depthAskDollars?: number | null;
  ageMs: number;
}

export interface OpenPosition {
  id: number;
  eventTicker: string;
  strategy: string;
  side: 'YES' | 'NO';
  qty: number;
  entryPrice: number; // dollars
  entryFeeC: number;
  entryTs: number;
  phase: PaperPhase;
  signalNetPp: number | null;
}

export interface PaperDecision {
  action: 'ENTER' | 'EXIT' | 'NONE';
  reason: string;
  position?: OpenPosition;
  fill?: { qty: number; price: number; feeC: number };
  pnlC?: number;
}

const DOLLARS_TO_CENTS = 100;

/** dollars -> whole cents, rounded against the trader (ceil fee, floor nothing else) */
function cents(dollars: number): number {
  return dollars * DOLLARS_TO_CENTS;
}

export function ensurePaperTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS k15m_paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_ticker TEXT NOT NULL,
      market_ticker TEXT,
      strategy TEXT NOT NULL,
      side TEXT NOT NULL,
      qty INTEGER NOT NULL,
      entry_price REAL NOT NULL,
      entry_fee_c REAL NOT NULL,
      entry_ts INTEGER NOT NULL,
      phase TEXT NOT NULL,
      exit_price REAL,
      exit_fee_c REAL,
      exit_ts INTEGER,
      exit_reason TEXT,
      pnl_c REAL,
      net_pp_predicted REAL,
      status TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_paper_open ON k15m_paper_trades(status, event_ticker);
    CREATE INDEX IF NOT EXISTS idx_paper_time ON k15m_paper_trades(entry_ts);
  `);
}

export interface RiskState {
  openCostC: number;
  openPositions: number;
  dailyRealizedC: number;
  blockedBy: string | null;
}

/**
 * The paper engine. One instance per runtime; state is derived from the DB
 * (survives restarts) and evaluated in strict gate order so every refusal has
 * exactly one named reason, like the strategy verdicts do.
 */
export class PaperEngine {
  readonly cfg: PaperConfig;
  private readonly db: DatabaseSync;
  readonly counters = { entries: 0, rejected: 0, exits: 0, settled: 0 };
  readonly rejects: Record<string, number> = {};

  constructor(db: DatabaseSync, cfg: PaperConfig) {
    this.db = db;
    this.cfg = cfg;
    ensurePaperTables(db);
  }

  /* ---------------- state ---------------- */

  openPositions(): OpenPosition[] {
    return (this.db.prepare(
      `SELECT id, event_ticker, strategy, side, qty, entry_price, entry_fee_c, entry_ts, phase, net_pp_predicted
         FROM k15m_paper_trades WHERE status = 'OPEN' ORDER BY entry_ts`,
    ).all() as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: Number(r.id),
      eventTicker: String(r.event_ticker),
      strategy: String(r.strategy),
      side: r.side === 'NO' ? 'NO' as const : 'YES' as const,
      qty: Number(r.qty),
      entryPrice: Number(r.entry_price),
      entryFeeC: Number(r.entry_fee_c),
      entryTs: Number(r.entry_ts),
      phase: String(r.phase) as PaperPhase,
      signalNetPp: r.net_pp_predicted === null ? null : Number(r.net_pp_predicted),
    }));
  }

  riskState(): RiskState {
    const open = this.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(qty * entry_price * 100 + entry_fee_c),0) AS cost
         FROM k15m_paper_trades WHERE status = 'OPEN'`,
    ).get() as { n: number; cost: number };
    const dayStart = Date.UTC(
      new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(),
    );
    const daily = this.db.prepare(
      `SELECT COALESCE(SUM(pnl_c),0) AS pnl FROM k15m_paper_trades
        WHERE status = 'CLOSED' AND exit_ts >= ?`,
    ).get(dayStart) as { pnl: number };
    const capC = (this.cfg.bankrollCents * this.cfg.dailyLossCapPct) / 100;
    return {
      openCostC: Number(open.cost),
      openPositions: Number(open.n),
      dailyRealizedC: Number(daily.pnl),
      blockedBy: daily.pnl <= -capC ? 'risk_daily_loss_cap' : null,
    };
  }

  equityCents(): number {
    const closed = this.db.prepare(
      `SELECT COALESCE(SUM(pnl_c),0) AS pnl FROM k15m_paper_trades WHERE status='CLOSED'`,
    ).get() as { pnl: number };
    return Math.round((this.cfg.bankrollCents + Number(closed.pnl)) * 100) / 100;
  }

  private reject(reason: string): PaperDecision {
    this.counters.rejected += 1;
    this.rejects[reason] = (this.rejects[reason] ?? 0) + 1;
    return { action: 'NONE', reason };
  }

  private openFor(eventTicker: string): OpenPosition | null {
    const p = this.openPositions().find((x) => x.eventTicker === eventTicker);
    return p ?? null;
  }

  private lastExitTs(eventTicker: string): number {
    const row = this.db.prepare(
      `SELECT MAX(exit_ts) AS t FROM k15m_paper_trades WHERE event_ticker = ? AND status='CLOSED'`,
    ).get(eventTicker) as { t: number | null };
    return Number(row.t ?? 0);
  }

  /* ---------------- ENTRY: SIGNAL -> VALIDATE -> ENTER -> CONFIRM_FILL ---------------- */

  enter(v: StrategyVerdict, eventTicker: string, marketTicker: string, book: PaperBookView, now: number): PaperDecision {
    if (!this.cfg.enabled) return { action: 'NONE', reason: 'paper_disabled' };
    if (v.verdict !== 'TRADE') return { action: 'NONE', reason: 'no_signal' };
    const side = (v.side ?? 'YES') as 'YES' | 'NO';

    // --- VALIDATE: risk gates, in order, each refusal named ---
    const risk = this.riskState();
    if (risk.blockedBy) return this.reject(risk.blockedBy);
    if (risk.openPositions >= 1 && this.openFor(eventTicker)) {
      return this.reject('risk_position_exists'); // one per market: no averaging down
    }
    if (now - this.lastExitTs(eventTicker) < this.cfg.reentryCooldownMs) {
      return this.reject('risk_reentry_cooldown');
    }
    if ((v.netPp ?? 0) < this.cfg.minNetPp) return this.reject('risk_edge_below_min');
    if (book.yesBid === null || book.yesAsk === null || book.yesBid >= book.yesAsk) {
      return this.reject('data_no_executable_book');
    }
    if (book.ageMs > this.cfg.maxBookAgeMs) return this.reject('data_stale_book');

    // --- sizing: fixed fraction of bankroll, capped by exposure and depth ---
    const entryPrice = side === 'YES' ? book.yesAsk : 1 - book.yesBid;
    const feePerContract = takerFee(1, entryPrice, KXBTC15M_FEES).perContract;
    const riskBudgetC = (this.cfg.bankrollCents * this.cfg.riskPerTradePct) / 100;
    let qty = Math.floor(riskBudgetC / cents(entryPrice + feePerContract));
    const headroomC = (this.cfg.bankrollCents * this.cfg.maxExposurePct) / 100 - risk.openCostC;
    qty = Math.min(qty, Math.floor(headroomC / cents(entryPrice + feePerContract)));
    if (qty <= 0) return this.reject('risk_exposure_cap');

    const depthDollars = side === 'YES' ? book.depthAskDollars : book.depthBidDollars;
    if (typeof depthDollars === 'number' && depthDollars > 0) {
      const depthQty = Math.floor(depthDollars / entryPrice);
      if (depthQty < qty) {
        if (!this.cfg.allowPartial) return this.reject('risk_insufficient_depth');
        qty = depthQty;
      }
    }
    if (qty <= 0) return this.reject('risk_size_zero');

    // --- ENTER -> CONFIRM_FILL (simulated: no order exists anywhere) ---
    const feeC = Math.round(feePerContract * qty * DOLLARS_TO_CENTS * 100) / 100;
    const res = this.db.prepare(
      `INSERT INTO k15m_paper_trades (event_ticker, market_ticker, strategy, side, qty,
         entry_price, entry_fee_c, entry_ts, phase, net_pp_predicted, status, updated_ts)
       VALUES (?,?,?,?,?,?,?,?, 'CONFIRM_FILL', ?, 'OPEN', ?)`,
    ).run(eventTicker, marketTicker, v.strategy, side, qty, entryPrice, feeC, now, v.netPp, now);
    this.counters.entries += 1;
    const pos = this.openPositions().find((p) => p.id === Number(res.lastInsertRowid));
    return {
      action: 'ENTER',
      reason: 'filled_at_ask_paper',
      position: pos,
      fill: { qty, price: entryPrice, feeC },
    };
  }

  /* ---------------- MANAGE -> EXIT ---------------- */

  manage(pos: OpenPosition, book: PaperBookView, now: number): PaperDecision {
    if (!this.cfg.enabled) return { action: 'NONE', reason: 'paper_disabled' };
    const side = pos.side;
    const bid = side === 'YES' ? book.yesBid : 1 - (book.yesAsk ?? 1);
    const ask = side === 'YES' ? book.yesAsk : 1 - (book.yesBid ?? 1);
    if (bid === null || ask === null || book.ageMs > this.cfg.maxBookAgeMs) {
      return { action: 'NONE', reason: 'data_stale_book' }; // no exit on a stale quote
    }
    const holdMs = now - pos.entryTs;
    const markPp = (bid - pos.entryPrice) * 100; // exiting at the bid
    const settled = holdMs >= this.cfg.holdSec * 1_000;
    const stopped = markPp <= -this.cfg.stopLossPp;
    const took = markPp >= this.cfg.takeProfitPp;
    if (!settled && !stopped && !took) return { action: 'NONE', reason: 'MANAGE' };

    const reason = stopped ? 'STOP_LOSS' : took ? 'TAKE_PROFIT' : 'TIME_EXIT';
    return this.exit(pos, bid, now, reason, book);
  }

  private exit(pos: OpenPosition, price: number, now: number, reason: string, book: PaperBookView): PaperDecision {
    const depthDollars = pos.side === 'YES' ? book.depthBidDollars : book.depthAskDollars;
    if (typeof depthDollars === 'number' && depthDollars > 0) {
      if (Math.floor(depthDollars / price) < pos.qty) {
        if (!this.cfg.allowPartial) {
          this.counters.rejected += 1;
          const k = 'risk_exit_insufficient_depth';
          this.rejects[k] = (this.rejects[k] ?? 0) + 1;
          return { action: 'NONE', reason: k };
        }
      }
    }
    const feeC = Math.round(takerFee(1, price, KXBTC15M_FEES).perContract * pos.qty * DOLLARS_TO_CENTS * 100) / 100;
    const grossC = (price - pos.entryPrice) * pos.qty * DOLLARS_TO_CENTS;
    const pnlC = Math.round((grossC - pos.entryFeeC - feeC) * 100) / 100;
    this.close(pos, price, feeC, now, reason, pnlC);
    return { action: 'EXIT', reason, position: pos, fill: { qty: pos.qty, price, feeC }, pnlC };
  }

  /** RECONCILE: close an unsettled position at the official result (0 or 1). */
  settle(pos: OpenPosition, result: 'YES' | 'NO', now: number): PaperDecision {
    const won = (result === 'YES' && pos.side === 'YES') || (result === 'NO' && pos.side === 'NO');
    const price = won ? 1 : 0;
    const grossC = (price - pos.entryPrice) * pos.qty * DOLLARS_TO_CENTS;
    const pnlC = Math.round((grossC - pos.entryFeeC) * 100) / 100;
    this.close(pos, price, 0, now, 'SETTLED', pnlC);
    this.counters.settled += 1;
    return { action: 'EXIT', reason: 'SETTLED', position: pos, pnlC };
  }

  private close(pos: OpenPosition, price: number, exitFeeC: number, now: number, reason: string, pnlC: number): void {
    this.db.prepare(
      `UPDATE k15m_paper_trades SET phase='RECONCILE', exit_price=?, exit_fee_c=?, exit_ts=?,
          exit_reason=?, pnl_c=?, status='CLOSED', updated_ts=? WHERE id = ? AND status='OPEN'`,
    ).run(price, exitFeeC, now, reason, pnlC, now, pos.id);
    this.counters.exits += 1;
  }

  /* ---------------- report ---------------- */

  summary(): Record<string, unknown> {
    const closed = this.db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(pnl_c),0) AS pnl, COALESCE(SUM(exit_fee_c+entry_fee_c),0) AS fees
         FROM k15m_paper_trades WHERE status='CLOSED'`,
    ).get() as { n: number; pnl: number; fees: number };
    const wins = this.db.prepare(
      `SELECT COUNT(*) AS n FROM k15m_paper_trades WHERE status='CLOSED' AND pnl_c > 0`,
    ).get() as { n: number };
    const byReason = this.db.prepare(
      `SELECT exit_reason AS r, COUNT(*) AS n FROM k15m_paper_trades
        WHERE status='CLOSED' GROUP BY exit_reason ORDER BY n DESC`,
    ).all() as unknown as Array<{ r: string; n: number }>;
    const risk = this.riskState();
    return {
      enabled: this.cfg.enabled,
      config: this.cfg,
      equityCents: this.equityCents(),
      open: this.openPositions(),
      risk,
      closed: {
        trades: Number(closed.n),
        wins: Number(wins.n),
        winRatePct: closed.n ? Math.round((Number(wins.n) / Number(closed.n)) * 1000) / 10 : null,
        netCents: Math.round(Number(closed.pnl) * 100) / 100,
        feesCents: Math.round(Number(closed.fees) * 100) / 100,
        byExitReason: byReason,
      },
      counters: this.counters,
      rejects: this.rejects,
      byStrategy: this.strategyCounts(),
    };
  }

  private strategyCounts(): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT strategy, COUNT(*) AS trades,
              COALESCE(SUM(CASE WHEN status='CLOSED' THEN pnl_c END),0) AS net_c
         FROM k15m_paper_trades GROUP BY strategy ORDER BY trades DESC`,
    ).all() as unknown as Array<Record<string, unknown>>;
  }
}