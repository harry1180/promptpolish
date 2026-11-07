/**
 * Fill simulation and exit checks.
 *
 * Realism rules:
 * - BUY always fills at or above quote.price, SELL at or below (never better
 *   than market).
 * - spreadBps = clamp(1 + 9*(1-liquidity), 1, 12); live-session slippage =
 *   (spreadBps/2 + 6*(1-liquidity)) scaled by qty participation
 *   (qty / (10000*liquidity)), +4 bps for PREMARKET/POSTMARKET, capped at
 *   60 bps.
 * - Closed market (MARKET_CLOSED/WEEKEND/HOLIDAY): AT_SIGNAL fills at the last
 *   price with 5 bps reported; NEXT_OPEN without a next-open price queues.
 * - NEXT_OPEN with a next-open price fills at exactly that price with 3 bps
 *   reported and a note that includes the gap direction.
 */
import type { ExitReason, FillResult, Quote, SessionKind } from './types.ts';

export interface FillRequest {
  side: 'BUY' | 'SELL';
  qty: number;
  quote: Quote;
  session: SessionKind;
  fillMode: 'AT_SIGNAL' | 'NEXT_OPEN';
  liquidityScore: number;
  nowMs: number;
  nextOpenPrice?: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function simulateFill(req: FillRequest): FillResult {
  const { side, qty, session, fillMode, liquidityScore, nowMs } = req;
  const price0 = req.quote.price;
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price0) || price0 <= 0 || !Number.isFinite(liquidityScore) || liquidityScore <= 0) {
    return { filled: false, price: 0, slippage: 0, notional: 0, note: 'rejected' };
  }

  const liq = clamp(liquidityScore, 0, 1);
  const spreadBps = clamp(1 + 9 * (1 - liq), 1, 12);

  if (fillMode === 'NEXT_OPEN') {
    const nextOpen = req.nextOpenPrice;
    if (nextOpen !== undefined && Number.isFinite(nextOpen) && nextOpen > 0) {
      const gap = (nextOpen - price0) / price0;
      const dir = gap >= 0 ? 'gap up' : 'gap down';
      return {
        filled: true,
        price: nextOpen,
        slippage: 3 / 10000,
        notional: nextOpen * qty,
        note: `filled at next session open, ${dir} ${Math.abs(gap * 100).toFixed(2)}% vs last price`,
      };
    }
    return { filled: false, price: 0, slippage: 0, notional: 0, note: 'queued for next session open', pendingUntil: nowMs };
  }

  // AT_SIGNAL
  const closed = session === 'MARKET_CLOSED' || session === 'WEEKEND' || session === 'HOLIDAY';
  if (closed) {
    return {
      filled: true,
      price: price0,
      slippage: 5 / 10000,
      notional: price0 * qty,
      note: 'filled at last available price while market closed',
    };
  }

  const extended = session === 'PREMARKET' || session === 'POSTMARKET';
  const baseBps = spreadBps / 2 + 6 * (1 - liq);
  const clip = 10000 * liq;
  const participation = qty / clip;
  let bps = baseBps * (1 + participation);
  if (extended) bps += 4; // extended-hours +4 bps applied after participation scaling
  bps = Math.min(60, bps);
  const slippage = bps / 10000;
  const price = side === 'BUY' ? price0 * (1 + slippage) : price0 * (1 - slippage);
  const note = extended
    ? `filled at signal during ${session.toLowerCase()} with ${bps.toFixed(1)} bps slippage`
    : `filled at signal with ${bps.toFixed(1)} bps slippage`;
  return { filled: true, price, slippage, notional: price * qty, note };
}

export interface ExitPosition {
  side: 'LONG';
  entryPrice: number;
  qty: number;
  target: number;
  stop: number;
  trailingStop: number | null;
  maxHoldSessions: number;
  sessionsHeld: number;
  thesisInvalidated: boolean;
  sellSignal: boolean;
  regimeChanged: boolean;
}

export interface ExitBar {
  open: number;
  high: number;
  low: number;
  close: number;
  date: string;
}

/**
 * Exit priority: STOP (a bar that is both stop- and target-through exits on
 * the stop — conservative), TARGET, THESIS_INVALIDATED, SELL_SIGNAL,
 * REGIME_CHANGE, TIME_LIMIT, TRAILING_STOP. An open below the stop still stops
 * out (gap handling falls out of low <= stop). Returns null for hold.
 */
export function checkExit(position: ExitPosition, bar: ExitBar): ExitReason | null {
  if (bar.low <= position.stop) return 'STOP_REACHED';
  if (bar.high >= position.target) return 'TARGET_REACHED';
  if (position.thesisInvalidated) return 'THESIS_INVALIDATED';
  if (position.sellSignal) return 'SELL_SIGNAL';
  if (position.regimeChanged) return 'REGIME_CHANGE';
  if (position.sessionsHeld >= position.maxHoldSessions) return 'TIME_LIMIT';
  if (position.trailingStop !== null && bar.low <= position.trailingStop) return 'TRAILING_STOP';
  return null;
}