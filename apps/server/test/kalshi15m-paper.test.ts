/**
 * Paper engine: the Phase 6 state machine and Phase 7 risk limits, exercised
 * against a real (in-memory) book — with the no-real-order guarantee that the
 * module contains no execution path at all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  PaperEngine, paperConfigFromEnv, ensurePaperTables, type PaperBookView,
} from '../src/kalshi15m/paper.ts';
import type { StrategyVerdict } from '../src/kalshi15m/strategies.ts';

const T0 = Date.parse('2026-11-20T20:00:00Z');
const EV = 'KXBTC15M-26NOV201700';
const MKT = `${EV}-00`;

const cfg = (over: Record<string, unknown> = {}) => ({
  ...paperConfigFromEnv({ KALSHI15M_PAPER: '1' }), ...over,
}) as ReturnType<typeof paperConfigFromEnv>;

const book = (over: Partial<PaperBookView> = {}): PaperBookView => ({
  yesBid: 0.43, yesAsk: 0.44, depthAskDollars: 10_000, depthBidDollars: 10_000,
  ageMs: 100, ...over,
});

const sig = (over: Partial<StrategyVerdict> = {}): StrategyVerdict => ({
  strategy: 'A_LEADLAG', verdict: 'TRADE', side: 'YES', netPp: 6, costPp: 4.5,
  remainingPp: 10.5, reasons: [], gates: {},
} as unknown as StrategyVerdict);

test('config: research defaults, not optimality claims, paper OFF by default', () => {
  const c = paperConfigFromEnv({});
  assert.equal(c.enabled, false, 'no paper activity unless asked for');
  assert.equal(c.riskPerTradePct, 0.25);
  assert.equal(c.dailyLossCapPct, 2);
  assert.equal(c.maxExposurePct, 5);
  assert.equal(c.maxPositionsPerMarket, 1);
  assert.equal(c.minNetPp, 2, 'the 2c floor is the gate, configurable');
  assert.equal(c.allowPartial, false, 'a partial fill is refused, not silently shrunken');
  const on = paperConfigFromEnv({ KALSHI15M_PAPER: '1', KALSHI15M_PAPER_BANKROLL: '500000' });
  assert.equal(on.enabled, true);
  assert.equal(on.bankrollCents, 500_000);
});

test('entry sizing: fixed fraction of bankroll, capped by exposure and depth', () => {
  const db = new DatabaseSync(':memory:');
  const e = new PaperEngine(db, cfg());
  // $1,000 bankroll, 0.25% at risk = $2.50 -> cost 0.44 + fee ~1.73c = 45.7c
  const d = e.enter(sig(), EV, MKT, book(), T0);
  assert.equal(d.action, 'ENTER', d.reason);
  assert.equal(d.fill?.price, 0.44, 'taker entry fills at the ASK, never mid');
  assert.equal(d.fill?.qty, 5, `fixed-fraction size, got ${d.fill?.qty}`);
  assert.ok((d.fill?.feeC ?? 0) > 0, 'fees are charged from the first fill');
  assert.equal(e.openPositions().length, 1);
  assert.equal(e.openPositions()[0].phase, 'CONFIRM_FILL');

  // depth smaller than wanted size and partials disallowed -> refused
  const e2 = new PaperEngine(new DatabaseSync(':memory:'), cfg());
  const shallow = e2.enter(sig(), EV, MKT, book({ depthAskDollars: 1 }), T0);
  assert.equal(shallow.action, 'NONE');
  assert.equal(shallow.reason, 'risk_insufficient_depth', 'size must be supported by displayed depth');
});

test('entry gates fire in order, each with exactly one named reason', () => {
  const db = new DatabaseSync(':memory:');
  const e = new PaperEngine(db, cfg());

  // daily loss cap: a realized day below -2% of bankroll blocks new entries
  db.prepare(
    `INSERT INTO k15m_paper_trades (event_ticker, market_ticker, strategy, side, qty,
       entry_price, entry_fee_c, entry_ts, phase, status, exit_ts, exit_reason, pnl_c, updated_ts)
     VALUES ('OLD','OLD','A_LEADLAG','YES',10,0.5,10,?,'RECONCILE','CLOSED',?,'STOP_LOSS',-2500,?)`,
  ).run(T0, Date.now(), Date.now()); // the cap is DAILY: exit must be today
  assert.equal(e.riskState().blockedBy, 'risk_daily_loss_cap');
  assert.equal(e.enter(sig(), EV, MKT, book(), T0).reason, 'risk_daily_loss_cap');

  // fresh engine: the other gates
  const e2 = new PaperEngine(new DatabaseSync(':memory:'), cfg());
  assert.equal(e2.enter({ ...sig(), netPp: 1 }, EV, MKT, book(), T0).reason, 'risk_edge_below_min');
  assert.equal(e2.enter(sig(), EV, MKT, book({ ageMs: 60_000 }), T0).reason, 'data_stale_book');
  assert.equal(e2.enter(sig(), EV, MKT, book({ yesAsk: null }), T0).reason, 'data_no_executable_book');

  // one position per market: no averaging down, by construction
  assert.equal(e2.enter(sig(), EV, MKT, book(), T0).action, 'ENTER');
  assert.equal(e2.enter(sig(), EV, MKT, book(), T0 + 1_000).reason, 'risk_position_exists');

  // exposure cap: headroom exhausted by an unrelated position
  const e3 = new PaperEngine(new DatabaseSync(':memory:'), cfg());
  e3.enter(sig(), 'OTHER_EVENT', 'OTHER_MKT', book(), T0); // cost ~228c
  const loaded = new PaperEngine(new DatabaseSync(':memory:'), cfg());
  loaded.db; // (exposure test below uses a direct open row for determinism)
  const db2 = new DatabaseSync(':memory:');
  const e4 = new PaperEngine(db2, cfg());
  db2.prepare(
    `INSERT INTO k15m_paper_trades (event_ticker, market_ticker, strategy, side, qty,
       entry_price, entry_fee_c, entry_ts, phase, status, updated_ts)
     VALUES ('X','X','F_MAKER','YES',100,0.5,0,?,'CONFIRM_FILL','OPEN',?)`,
  ).run(T0, T0); // 100 * 0.5 * 100 = 5,000c = exactly the 5% cap
  assert.equal(e4.enter(sig(), EV, MKT, book(), T0).reason, 'risk_exposure_cap');
});

test('manage: time exit at the bid, and stops realize WORSE than the stop level', () => {
  const db = new DatabaseSync(':memory:');
  const e = new PaperEngine(db, cfg());

  // time exit: a +2c move still loses money once both fees are paid
  const entered = e.enter(sig(), EV, MKT, book(), T0);
  const pos = entered.position!;
  const early = e.manage(pos, book({ yesBid: 0.5 }), T0 + 5_000);
  assert.equal(early.action, 'NONE', 'inside the hold window the position is managed, not churned');
  const exit = e.manage(pos, book({ yesBid: 0.46 }), T0 + 11_000);
  assert.equal(exit.action, 'EXIT');
  assert.equal(exit.reason, 'TIME_EXIT');
  assert.equal(exit.fill?.price, 0.46, 'exit fills at the BID');
  assert.equal(e.openPositions().length, 0, 'RECONCILE left MONITOR');
  assert.ok((exit.pnlC ?? 0) < 0, `+2c gross cannot pay two fees: ${exit.pnlC}`);

  // stop: the promise is -5c, the fill is wherever the bid actually is
  const st = e.enter(sig(), EV, 'OTHER', book({ yesBid: 0.59, yesAsk: 0.60 }), T0 + 60_000);
  const pos2 = st.position!;
  const stopped = e.manage(pos2, book({ yesBid: 0.5, yesAsk: 0.51 }), T0 + 70_000);
  assert.equal(stopped.reason, 'STOP_LOSS');
  assert.equal(stopped.fill?.price, 0.5, 'the stop level is NOT a fill price');
  assert.ok((stopped.pnlC ?? 0) < -5 * pos2.qty, 'slippage makes it worse than the nominal stop');
});

test('settlement reconcile pays 1 or 0, and the daily loss cap compounds correctly', () => {
  const db = new DatabaseSync(':memory:');
  const e = new PaperEngine(db, cfg({ takeProfitPp: 999, stopLossPp: 999 })); // no early exit
  e.enter(sig(), EV, MKT, book({ yesBid: 0.59, yesAsk: 0.60 }), T0);
  const pos = e.openPositions()[0];
  const won = e.settle(pos, 'YES', T0 + 900_000);
  assert.equal(won.pnlC !== null && won.pnlC > 0, true, `settled YES on a YES: ${won.pnlC}`);
  assert.equal(e.openPositions().length, 0);
  const eq = e.equityCents();
  assert.ok(eq > 100_000, `winning paper trade adds to equity: ${eq}`);

  // a losing day trips the cap for the NEXT entry
  const e2 = new PaperEngine(new DatabaseSync(':memory:'), cfg());
  const db3 = new DatabaseSync(':memory:');
  const e3 = new PaperEngine(db3, cfg());
  db3.prepare(
    `INSERT INTO k15m_paper_trades (event_ticker, market_ticker, strategy, side, qty,
       entry_price, entry_fee_c, entry_ts, phase, status, exit_ts, exit_reason, pnl_c, updated_ts)
     VALUES ('L','L','D_MOMENTUM','YES',40,0.6,40,?,'RECONCILE','CLOSED',?,'STOP_LOSS',-2100,?)`,
  ).run(T0, Date.now(), Date.now()); // daily window: exit counted for today
  assert.equal(e3.riskState().blockedBy, 'risk_daily_loss_cap');
  assert.equal(e3.enter(sig(), EV, MKT, book(), T0 + 1_000).reason, 'risk_daily_loss_cap');
  void e2;
});

test('no re-entry without a new signal: cooldown after every exit', () => {
  const db = new DatabaseSync(':memory:');
  const e = new PaperEngine(db, cfg());
  e.enter(sig(), EV, MKT, book(), T0);
  const pos = e.openPositions()[0];
  e.manage(pos, book({ yesBid: 0.46 }), T0 + 11_000);
  assert.equal(e.openPositions().length, 0);
  // immediately after the exit, even a fresh valid signal must wait
  assert.equal(e.enter(sig(), EV, MKT, book(), T0 + 11_500).reason, 'risk_reentry_cooldown');
  // after the cooldown, a NEW signal is allowed (multiple round trips per window)
  const again = e.enter(sig(), EV, MKT, book(), T0 + 17_000);
  assert.equal(again.action, 'ENTER', again.reason);
  assert.equal(e.openPositions().length, 1);
});

test('summary reports every number the dashboard and audit need', () => {
  const db = new DatabaseSync(':memory:');
  const e = new PaperEngine(db, cfg());
  e.enter(sig(), EV, MKT, book(), T0);
  const pos = e.openPositions()[0];
  e.manage(pos, book({ yesBid: 0.46 }), T0 + 11_000);
  const s = e.summary() as Record<string, unknown>;
  assert.equal(s.enabled, true);
  assert.equal((s.equityCents as number) !== undefined, true);
  const closed = s.closed as Record<string, unknown>;
  assert.equal(closed.trades, 1);
  assert.equal((closed.byExitReason as Array<{ r: string }>)[0].r, 'TIME_EXIT');
  assert.ok((s.counters as { entries: number }).entries === 1);
  assert.ok(Array.isArray(s.open));
  assert.ok((e.riskState().openPositions === 0));
  ensurePaperTables(db); // idempotent — safe on a live database
});

test('kill switch + feed supervision: entries halt, report themselves, and recover', () => {
  // operator kill switch from env: halted from birth, every entry refused
  const e1 = new PaperEngine(new DatabaseSync(':memory:'), cfg({ killSwitch: true }));
  assert.equal(e1.halted, true, 'kill switch engages at construction');
  assert.equal(e1.enter(sig(), EV, MKT, book(), T0).reason, 'halted_manual');
  assert.equal(e1.counters.entries, 0, 'nothing slipped through while halted');
  const h1 = e1.summary().halt as { manual: boolean; halts: number };
  assert.equal(h1.manual, true);
  assert.ok(h1.halts >= 1, 'the halt is on the record');
  e1.resume();
  assert.equal(e1.enter(sig(), EV, MKT, book(), T0).action, 'ENTER', 'resume works');

  // automatic halt: a silent feed stops entries, frames returning clears it
  const e2 = new PaperEngine(new DatabaseSync(':memory:'), cfg());
  e2.setFeedOk(false, 'feed_stale');
  assert.equal(e2.halted, true);
  assert.equal(e2.enter(sig(), EV, MKT, book(), T0).reason, 'halted_feed_stale');
  assert.equal((e2.summary().halt as { reason: string | null }).reason, 'feed_stale');
  e2.setFeedOk(true);
  assert.equal(e2.halted, false, 'fresh frames lift the automatic halt');
  assert.equal(e2.enter(sig(), EV, MKT, book(), T0).action, 'ENTER');

  // manual halt is sticky: feed recovery cannot clear an operator stop
  e2.halt();
  e2.setFeedOk(true);
  assert.equal(e2.enter(sig(), 'E3', MKT, book(), T0 + 60_000).reason, 'halted_manual');
  const h2 = e2.haltState();
  assert.equal(h2.manual, true);
  assert.equal(h2.auto, false, 'the two halt sources stay distinguishable');
  assert.ok(h2.halts >= 2, 'each distinct halt was counted');
  e2.resume();
  assert.equal(e2.halted, false);
});


/* ------------------------------------------------------------------ */
/* Maker execution (the fix for F): passive bids, fee-free fills        */
/* ------------------------------------------------------------------ */

test('maker strategy places a resting bid instead of crossing the book', () => {
  const db = new DatabaseSync(':memory:');
  const e = new PaperEngine(db, cfg());
  const d = e.enter({ ...sig(), strategy: 'F_MAKER' }, EV, MKT, book(), T0);
  assert.equal(d.reason, 'resting_bid_placed', 'F quotes, it does not lift');
  assert.equal(d.fill?.price, 0.43, 'rests ON the touch (yes bid), never at the ask');
  assert.equal(d.fill?.feeC, 0, 'maker entry costs nothing');
  assert.equal(e.openPositions().length, 0, 'nothing is positioned until the market trades through');
  assert.equal(e.restingList().length, 1);
  assert.equal(e.counters.resting, 1);

  // a print AWAY from our price does not fill us
  e.onTick(T0 + 2_000, book(), { price: 0.46, ts: T0 + 2_000 });
  assert.equal(e.restingList().length, 1, 'still resting');

  // no trade-through within the window: cancel, never fake a fill
  e.onTick(T0 + 11_000, book(), null);
  assert.equal(e.restingList().length, 0);
  assert.equal(e.counters.makerCancels, 1);
  assert.equal(e.counters.entries, 0, 'an unfilled order is not a trade');
  assert.equal((e.summary().rejects as Record<string, number>).maker_fill_timeout, 1);
});

test('maker fill at our resting price, then a fee-free take-profit exit', () => {
  const db = new DatabaseSync(':memory:');
  const e = new PaperEngine(db, cfg());
  e.enter({ ...sig(), strategy: 'F_MAKER' }, EV, MKT, book(), T0);

  // the market trades DOWN into our bid -> fill AT the bid, no fee
  const fill = e.onTick(T0 + 2_000, book(), { price: 0.43, ts: T0 + 2_000 })[0];
  assert.equal(fill.reason, 'maker_fill_resting_price');
  assert.equal(fill.fill?.price, 0.43, 'filled at the resting price, not the ask');
  assert.equal(fill.fill?.feeC, 0, 'maker entry: no fee — the fix for F');
  const pos = e.openPositions()[0];
  assert.ok(pos && pos.qty > 0);
  assert.equal(e.restingList().length, 0, 'order consumed');
  assert.equal(e.counters.makerFills, 1);

  // price rises to entry + 2c: the resting ask fills fee-free
  const tp = e.onTick(T0 + 5_000, book({ yesBid: 0.45, yesAsk: 0.46 }), null)[0];
  assert.equal(tp.reason, 'TAKE_PROFIT');
  assert.equal(tp.fill?.price, 0.45);
  assert.equal(tp.fill?.feeC, 0, 'maker exit: no fee either');
  assert.ok(Math.abs((tp.pnlC ?? 0) - 2 * pos.qty) < 1e-9, `+2c x qty, got ${tp.pnlC}`);
  assert.equal(e.openPositions().length, 0);

  // and with no take-profit, the TIME exit still crosses (taker fee) at the bid
  e.enter({ ...sig(), strategy: 'F_MAKER' }, 'EV2', 'M2', book({ yesBid: 0.43, yesAsk: 0.44 }), T0 + 60_000);
  e.onTick(T0 + 61_000, book(), { price: 0.43, ts: T0 + 61_000 });
  const open = e.openPositions().find((x) => x.eventTicker === 'EV2');
  assert.ok(open, 'second maker position filled');
  const timeExit = e.onTick(T0 + 72_000, book({ yesBid: 0.44, yesAsk: 0.45 }), null)
    .find((x) => x.position?.eventTicker === 'EV2');
  assert.ok(timeExit, 'time exit taken');
  assert.equal(timeExit?.reason, 'TIME_EXIT');
  assert.ok((timeExit?.fill?.feeC ?? 0) > 0, 'crossing to exit pays the taker fee');
});

test('taker strategies keep crossing the book — maker mode is per-strategy', () => {
  const db = new DatabaseSync(':memory:');
  const e = new PaperEngine(db, cfg());
  assert.equal(e.isMaker('F_MAKER'), true);
  assert.equal(e.isMaker('B_MICRO'), false, 'B trades TAKER unless configured otherwise');
  assert.equal(e.isMaker('A_LEADLAG'), false);
  // an A signal still fills immediately at the ask with a fee
  const d = e.enter(sig(), EV, MKT, book(), T0);
  assert.equal(d.action, 'ENTER');
  assert.equal(d.fill?.price, 0.44, 'taker entry at the ASK');
  assert.ok((d.fill?.feeC ?? 0) > 0);
  assert.equal(e.restingList().length, 0, 'no resting order for takers');
});
