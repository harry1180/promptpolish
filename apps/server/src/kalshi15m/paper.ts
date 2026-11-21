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
  /** EMERGENCY: start halted (KALSHI15M_KILL_SWITCH=1) — no entries at all */
  killSwitch: boolean;
  /** feed silent this long -> automatic halt until frames return (ms) */
  haltStaleMs: number;
  /** strategies that place PASSIVE bids (fee-free) instead of crossing the book */
  makerStrategies: string[];
  /** a resting bid unfilled within this window is cancelled (ms) */
  makerFillTimeoutMs: number;
  /** resting take-profit offset above a maker entry (pp) */
  makerTakeProfitPp: number;
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
    killSwitch: env.KALSHI15M_KILL_SWITCH === '1' || env.KALSHI15M_KILL_SWITCH === 'true',
    haltStaleMs: num(env.KALSHI15M_PAPER_HALT_STALE_MS, 30_000),
    // F's edge is computed fee-free at the BID: charging it taker economics
    // made every trade structurally negative (measured: avg fees 15.6c vs an
    // average move of -0.46pp). Maker strategies therefore place resting bids.
    makerStrategies: (env.KALSHI15M_PAPER_MAKER_STRATS ?? 'F_MAKER')
      .split(',').map((s) => s.trim()).filter(Boolean),
    makerFillTimeoutMs: num(env.KALSHI15M_PAPER_MAKER_FILL_MS, 10_000),
    makerTakeProfitPp: num(env.KALSHI15M_PAPER_MAKER_TP_PP, 2),
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

/** A passive order waiting for the market to come to it (maker execution). */
export interface RestingOrder {
  eventTicker: string;
  marketTicker: string;
  strategy: string;
  side: 'YES' | 'NO';
  /** resting price in this side's own dollars */
  price: number;
  ts: number;
  netPp: number | null;
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
  readonly counters = {
    entries: 0, rejected: 0, exits: 0, settled: 0, halts: 0,
    resting: 0, makerFills: 0, makerCancels: 0,
  };
  /** resting (maker) orders awaiting a fill — in memory: lost on restart */
  private readonly restingOrders = new Map<string, RestingOrder>();
  private lastPrint: { price: number; ts: number } | null = null;
  readonly rejects: Record<string, number> = {};
  /** manual: kill switch / operator. Auto: feed or data failure. Both block entries. */
  private manualHalt = false;
  private autoHaltReason: string | null = null;

  constructor(db: DatabaseSync, cfg: PaperConfig) {
    this.db = db;
    this.cfg = cfg;
    this.manualHalt = cfg.killSwitch;
    if (cfg.killSwitch) this.counters.halts += 1;
    ensurePaperTables(db);
  }

  /** maker strategies place passive orders; everyone else crosses the book */
  isMaker(strategy: string): boolean {
    return this.cfg.makerStrategies.includes(strategy);
  }

  /** snapshot of the live resting orders (for status/tests) */
  restingList(): RestingOrder[] {
    return [...this.restingOrders.values()];
  }

  /* ---------------- kill switch / automatic halts ---------------- */

  get halted(): boolean { return this.manualHalt || this.autoHaltReason !== null; }

  halt(): void { // operator emergency stop — persists until resume()
    if (!this.manualHalt) this.counters.halts += 1;
    this.manualHalt = true;
  }

  resume(): void { this.manualHalt = false; }

  /** Feed supervision: silent feed halts entries; frames returning clears it. */
  setFeedOk(ok: boolean, reason = 'feed_stale'): void {
    const next = ok ? null : reason;
    if (next !== this.autoHaltReason && next !== null) this.counters.halts += 1;
    this.autoHaltReason = next;
  }

  haltState(): { manual: boolean; auto: boolean; reason: string | null; halts: number } {
    return {
      manual: this.manualHalt, auto: this.autoHaltReason !== null,
      reason: this.autoHaltReason, halts: this.counters.halts,
    };
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
    if (this.manualHalt) return this.reject('halted_manual');   // kill switch first
    if (this.autoHaltReason) return this.reject(`halted_${this.autoHaltReason}`);
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

    // --- MAKER path: place a PASSIVE bid at the touch (never cross, no fee).
    // The order waits for the market: it fills only when price trades through
    // it, and is cancelled if it does not within makerFillTimeoutMs. Size is
    // decided AT FILL (risk budget), not from the signal's quote.
    if (this.isMaker(v.strategy)) {
      if (this.restingOrders.has(eventTicker)) return this.reject('risk_position_exists');
      const price = side === 'YES' ? book.yesBid : 1 - book.yesAsk;
      if (price === null || !(price > 0) || !(price < 1)) return this.reject('data_no_executable_book');
      const depthDollars = side === 'YES' ? book.depthBidDollars : book.depthAskDollars;
      if (typeof depthDollars === 'number' && depthDollars > 0 && depthDollars / price < 1) {
        return this.reject('risk_insufficient_depth');
      }
      this.restingOrders.set(eventTicker, {
        eventTicker, marketTicker, strategy: v.strategy, side, price, ts: now, netPp: v.netPp ?? null,
      });
      this.counters.resting += 1;
      return {
        action: 'ENTER', reason: 'resting_bid_placed',
        fill: { qty: 0, price, feeC: 0 },
      };
    }

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

  /* ---------------- MAKER: resting orders -> fills -> exits ---------- */

  /**
   * One paper pass: progress resting orders, then manage open positions.
   * `print` is the newest trade print (YES dollars) — a resting order fills
   * only when the market actually TRADED through its price (print or touch),
   * never on a mid move alone.
   */
  onTick(now: number, book: PaperBookView, print?: { price: number; ts: number } | null): PaperDecision[] {
    if (print && Number.isFinite(print.price)) this.lastPrint = print;
    const out: PaperDecision[] = [];
    if (!this.cfg.enabled) return out;
    for (const o of [...this.restingOrders.values()]) {
      const d = this.progressResting(o, book, now);
      if (d.action !== 'NONE') out.push(d);
    }
    for (const pos of this.openPositions()) {
      const d = this.isMaker(pos.strategy)
        ? this.manageMaker(pos, book, now)
        : this.manage(pos, book, now);
      if (d.action !== 'NONE') out.push(d);
    }
    return out;
  }

  /** Did price trade through this resting order? (side-mapped into YES terms) */
  private touched(o: RestingOrder, book: PaperBookView, now: number): boolean {
    const fresh = this.lastPrint !== null && now - this.lastPrint.ts <= 1_000;
    const px = this.lastPrint?.price ?? null;
    if (o.side === 'YES') {
      const level = o.price; // resting YES bid
      if (fresh && px !== null && px <= level + 1e-9) return true;
      return book.yesAsk !== null && book.yesAsk <= level + 1e-9;
    }
    const level = 1 - o.price; // NO bid <=> resting YES ask at `level`
    if (fresh && px !== null && px >= level - 1e-9) return true;
    return book.yesBid !== null && book.yesBid >= level - 1e-9;
  }

  private progressResting(o: RestingOrder, book: PaperBookView, now: number): PaperDecision {
    if (now - o.ts > this.cfg.makerFillTimeoutMs) {
      this.restingOrders.delete(o.eventTicker);
      this.counters.makerCancels += 1;
      const k = 'maker_fill_timeout';
      this.rejects[k] = (this.rejects[k] ?? 0) + 1;
      return { action: 'NONE', reason: k };
    }
    if (book.ageMs > this.cfg.maxBookAgeMs) return { action: 'NONE', reason: 'data_stale_book' };
    if (!this.touched(o, book, now)) return { action: 'NONE', reason: 'resting_unfilled' };

    const price = o.price;
    const risk = this.riskState();
    const budget = (this.cfg.bankrollCents * this.cfg.riskPerTradePct) / 100;
    const headroomC = (this.cfg.bankrollCents * this.cfg.maxExposurePct) / 100 - risk.openCostC;
    let qty = Math.min(
      Math.floor(budget / cents(price)),
      Math.floor(headroomC / cents(price)),
    );
    if (qty <= 0) {
      this.restingOrders.delete(o.eventTicker);
      return this.reject('risk_exposure_cap');
    }
    // depth at the touch still caps size (the resting quote IS the top level)
    const depthDollars = o.side === 'YES' ? book.depthBidDollars : book.depthAskDollars;
    const atTouch = o.side === 'YES' ? book.yesBid === price : book.yesAsk === 1 - price;
    if (atTouch && typeof depthDollars === 'number' && depthDollars > 0) {
      const depthQty = Math.floor(depthDollars / price);
      if (depthQty < qty) {
        if (!this.cfg.allowPartial) {
          this.restingOrders.delete(o.eventTicker);
          return this.reject('risk_insufficient_depth');
        }
        qty = depthQty;
      }
    }
    if (qty <= 0) {
      this.restingOrders.delete(o.eventTicker);
      return this.reject('risk_size_zero');
    }

    const res = this.db.prepare(
      `INSERT INTO k15m_paper_trades (event_ticker, market_ticker, strategy, side, qty,
         entry_price, entry_fee_c, entry_ts, phase, net_pp_predicted, status, updated_ts)
       VALUES (?,?,?,?,?,?,0,?, 'CONFIRM_FILL', ?, 'OPEN', ?)`,
    ).run(o.eventTicker, o.marketTicker, o.strategy, o.side, qty, price, o.ts, o.netPp, now);
    this.restingOrders.delete(o.eventTicker);
    this.counters.makerFills += 1;
    this.counters.entries += 1;
    const pos = this.openPositions().find((x) => x.id === Number(res.lastInsertRowid));
    return {
      action: 'ENTER', reason: 'maker_fill_resting_price', position: pos,
      fill: { qty, price, feeC: 0 },
    };
  }

  /** Maker position: resting take-profit ask (fee-free), else stop/time exit. */
  private manageMaker(pos: OpenPosition, book: PaperBookView, now: number): PaperDecision {
    const bid = pos.side === 'YES' ? book.yesBid : 1 - (book.yesAsk ?? 1);
    const ask = pos.side === 'YES' ? book.yesAsk : 1 - (book.yesBid ?? 1);
    if (bid === null || ask === null || book.ageMs > this.cfg.maxBookAgeMs) {
      return { action: 'NONE', reason: 'data_stale_book' };
    }
    const tp = pos.entryPrice + this.cfg.makerTakeProfitPp / 100;
    const stop = pos.entryPrice - this.cfg.stopLossPp / 100;
    const fresh = this.lastPrint !== null && now - this.lastPrint.ts <= 1_000;
    const px = this.lastPrint?.price ?? null;

    // resting TP quote: YES ask at tp (fills when YES trades up to it),
    // NO ask at tp <=> YES bid at 1-tp (fills when YES trades down to it)
    const tpFill = pos.side === 'YES'
      ? (bid >= tp - 1e-9 || (fresh && px !== null && px >= tp - 1e-9))
      : (ask <= 1 - tp + 1e-9 || (fresh && px !== null && px <= 1 - tp + 1e-9));
    if (tpFill) {
      const pnlC = Math.round((tp - pos.entryPrice) * pos.qty * DOLLARS_TO_CENTS * 100) / 100;
      this.close(pos, tp, 0, now, 'TAKE_PROFIT', pnlC); // maker exit: no fee
      return { action: 'EXIT', reason: 'TAKE_PROFIT', position: pos, fill: { qty: pos.qty, price: tp, feeC: 0 }, pnlC };
    }
    // stop and time exits must CROSS the book -> taker fee, filled at the bid
    if (bid <= stop + 1e-9) return this.exit(pos, bid, now, 'STOP_LOSS', book);
    if (now - pos.entryTs >= this.cfg.holdSec * 1_000) return this.exit(pos, bid, now, 'TIME_EXIT', book);
    return { action: 'NONE', reason: 'MANAGE' };
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
      halt: this.haltState(),
      equityCents: this.equityCents(),
      open: this.openPositions(),
      resting: this.restingList(),
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