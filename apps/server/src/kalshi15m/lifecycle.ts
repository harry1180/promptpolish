/**
 * KXBTC15M window lifecycle — PURE, no IO.
 *
 * A 15-minute market is one contract: YES iff the 60-second CF Benchmarks
 * BRTI average before CLOSE >= the 60-second average before OPEN (tie -> YES).
 * Kalshi encodes the CLOSE time, in US-Eastern local time, into the event
 * ticker: `KXBTC15M-26NOV201545` = 2026-NOV-20 15:45 ET close, so the window
 * is [15:30, 15:45) ET. The per-window market adds an occurrence suffix
 * (`KXBTC15M-26NOV201545-45`).
 *
 * Everything here is derived from timestamps we control or from the
 * authoritative REST fields (open_time / close_time / expected_expiration_time
 * are UTC ISO strings and always win over the ticker parse).
 *
 * Phases (relative to the trading window):
 *   PRE_OPEN     before open — discoverable, not tradable
 *   OPEN         open .. close-60s — normal trading
 *   FINAL_MINUTE close-60s .. close — the settlement prints are being taken
 *   SETTLING     close .. expected expiration — book dead, result pending
 *   EXPIRED      after expected expiration — resolved or awaiting the result
 */

export type WindowPhase = 'PRE_OPEN' | 'OPEN' | 'FINAL_MINUTE' | 'SETTLING' | 'EXPIRED';

export const WINDOW_MS = 15 * 60_000;
/** the settlement average consumes the last 60 seconds before close */
export const FINAL_MINUTE_MS = 60_000;
/** Kalshi sets expected_expiration_time ~5 minutes after close */
export const DEFAULT_EXPIRE_GRACE_MS = 5 * 60_000;

export interface WindowBounds {
  /** epoch ms the contract starts trading (window open) */
  openTs: number;
  /** epoch ms trading stops and the settlement value is fixed */
  closeTs: number;
  /** epoch ms Kalshi finalizes the market (close + grace when unknown) */
  expireTs: number;
  /** 'TICKER' when parsed from the event ticker, 'REST' when read from API */
  source: 'TICKER' | 'REST';
}

export interface ParsedEvent {
  series: string;
  eventTicker: string;
  /** close time, US-Eastern local, as calendar fields */
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

const ET = 'America/New_York';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** UTC offset of America/New_York at instant `ts` (ms, negative west). */
export function etOffsetMs(ts: number): number {
  const parts: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(new Date(ts))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Epoch ms of a wall-clock time in US-Eastern (DST-aware, 2-pass). */
export function etToUtc(
  year: number, month: number, day: number, hour: number, minute: number,
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = asUtc - etOffsetMs(asUtc);
  guess = asUtc - etOffsetMs(guess); // second pass settles DST boundaries
  return guess;
}

/**
 * `KXBTC15M-26NOV201545` -> close-time calendar fields.
 * Returns null for anything that is not an event ticker (never guesses).
 */
export function parseEventTicker(eventTicker: string): ParsedEvent | null {
  const m = /^([A-Z0-9]+)-(\d{2})([A-Z]{3})(\d{2})(\d{4})$/.exec(eventTicker);
  if (!m) return null;
  const month = MONTHS[m[3]];
  if (!month) return null;
  const year = 2000 + Number(m[2]);
  const day = Number(m[4]);
  const hh = Number(m[5].slice(0, 2));
  const mm = Number(m[5].slice(2, 4));
  if (day < 1 || day > 31 || hh > 23 || mm > 59) return null;
  return { series: m[1], eventTicker, year, month, day, hour: hh, minute: mm };
}

/** Market ticker -> its event ticker (`KXBTC15M-26NOV201545-45` -> `...1545`). */
export function eventOfMarket(marketTicker: string): string {
  const idx = marketTicker.lastIndexOf('-');
  if (idx <= 0) return marketTicker;
  const tail = marketTicker.slice(idx + 1);
  return /^\d{2}$/.test(tail) ? marketTicker.slice(0, idx) : marketTicker;
}

/** Window bounds parsed from the event ticker alone (close encoded in ET). */
export function windowFromEventTicker(eventTicker: string): WindowBounds | null {
  const parsed = parseEventTicker(eventTicker);
  if (!parsed) return null;
  const closeTs = etToUtc(parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute);
  if (!Number.isFinite(closeTs)) return null;
  return {
    openTs: closeTs - WINDOW_MS,
    closeTs,
    expireTs: closeTs + DEFAULT_EXPIRE_GRACE_MS,
    source: 'TICKER',
  };
}

/** Minimal REST market shape this module trusts (all optional). */
export interface RestMarketTimes {
  open_time?: string | null;
  close_time?: string | null;
  expected_expiration_time?: string | null;
}

/** Authoritative window bounds from REST fields; falls back to the ticker. */
export function windowFromRest(marketTicker: string, m: RestMarketTimes): WindowBounds | null {
  const openTs = m.open_time ? Date.parse(m.open_time) : NaN;
  const closeTs = m.close_time ? Date.parse(m.close_time) : NaN;
  if (Number.isFinite(openTs) && Number.isFinite(closeTs) && closeTs > openTs) {
    const expire = m.expected_expiration_time ? Date.parse(m.expected_expiration_time) : NaN;
    return {
      openTs, closeTs,
      expireTs: Number.isFinite(expire) ? expire : closeTs + DEFAULT_EXPIRE_GRACE_MS,
      source: 'REST',
    };
  }
  return windowFromEventTicker(eventOfMarket(marketTicker));
}

export function phaseAt(b: WindowBounds, now: number): WindowPhase {
  if (now < b.openTs) return 'PRE_OPEN';
  if (now < b.closeTs - FINAL_MINUTE_MS) return 'OPEN';
  if (now < b.closeTs) return 'FINAL_MINUTE';
  if (now < b.expireTs) return 'SETTLING';
  return 'EXPIRED';
}

/** ms until close (negative once past it) — the clock every strategy reads. */
export function msToClose(b: WindowBounds, now: number): number {
  return b.closeTs - now;
}

/** Fraction of the window elapsed, 0..1 (clamped; never NaN). */
export function windowProgress(b: WindowBounds, now: number): number {
  const span = b.closeTs - b.openTs;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (now - b.openTs) / span));
}

/** True when `eventTicker` belongs to the 15-minute window containing `now`. */
export function isCurrentWindow(b: WindowBounds, now: number): boolean {
  return now >= b.openTs && now < b.closeTs + DEFAULT_EXPIRE_GRACE_MS;
}

/**
 * Next window boundary strictly after `now` — discovery polls around it
 * instead of hammering REST through the whole window.
 */
export function nextDiscoveryAt(b: WindowBounds, now: number): number {
  return now < b.closeTs ? b.closeTs : b.expireTs;
}