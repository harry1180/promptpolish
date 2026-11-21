/**
 * Pre-entry confirmation gate (paper only): "don't buy the local high, and
 * don't buy while the two venues disagree about which way the market is going."
 *
 * Two legs, both fed by data the book ALREADY collects — no second socket and
 * no extra polling anywhere:
 *
 *  1. PULLBACK — the in-memory Kraken tape (stream tick observer, tape.ts).
 *     The entry must have retraced from the recent tape high by at least a
 *     volatility-scaled amount (ATR14 x CRYPTO_PULLBACK_ATR_MULTIPLE, floored
 *     and capped). Measured on this book's own history: a limit 1% under the
 *     signal price filled on 38/39 recorded BUY days, and recorded signals
 *     whose PRIOR session was down carried a 43% next-day hit rate vs 18.7%
 *     after an up session (n=269) — buying strength was the expensive half.
 *
 *  2. MULTI-VENUE — Kraken vs Coinbase mid direction over the last
 *     CRYPTO_VENUE_WINDOW_MS, read from `xchange_samples` (the observer's
 *     5s grid) through the existing `priceAgreement()` helper. Coinbase only
 *     quotes BTC/ETH, so an alt entry is confirmed on the BTC tape — the same
 *     benchmark the regime leg already uses — and the entry symbol is tried
 *     first in case a venue is ever added for it.
 *
 * Missing or stale data never blocks and never silently passes: each leg
 * returns NO_DATA/STALE with its age, and the reason is stored with the order
 * decision. Rollback: `CRYPTO_ENTRY_CONFIRM=0`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { EntryConfirmConfig } from './config.ts';
import { CRYPTO_BENCHMARK } from './broker.ts';
import { priceAgreement, venueWindow } from '../xchange/features.ts';
import { loadSamples } from '../xchange/store.ts';
import type { TickTape } from './tape.ts';

export type PullbackCode = 'PASS' | 'AT_LOCAL_HIGH' | 'NO_TAPE' | 'DISABLED';
export type VenueCode = 'PASS' | 'FALLING' | 'DIVERGE' | 'NO_DATA' | 'STALE' | 'DISABLED';

const BLOCKING_PULLBACK: ReadonlySet<PullbackCode> = new Set(['AT_LOCAL_HIGH']);
const BLOCKING_VENUE: ReadonlySet<VenueCode> = new Set(['FALLING', 'DIVERGE']);

export interface ConfirmResult {
  ok: boolean;
  pullback: {
    code: PullbackCode;
    /** fraction of price the entry must have retraced */
    requiredPct: number | null;
    /** how far below the tape high the price actually is (fraction, >= 0) */
    observedPct: number | null;
    ticks: number | null;
    lastAgeMs: number | null;
  };
  venue: {
    code: VenueCode;
    symbol: string | null;
    majority: 'UP' | 'DOWN' | 'FLAT' | null;
    agreement: number | null;
    referenceAgrees: boolean | null;
    krakenPct: number | null;
    coinbasePct: number | null;
    ageMs: number | null;
  };
  /** '' when ok — otherwise the first blocking code */
  reason: string;
}

/** Volatility-scaled pullback, clamped to the configured floor and ceiling. */
export function requiredPullback(atrPct: number, cfg: EntryConfirmConfig): number {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return cfg.minPct;
  return Math.min(Math.max(atrPct * cfg.atrMultiple, cfg.minPct), cfg.maxPct);
}

function pullbackLeg(
  tape: TickTape | undefined,
  symbol: string,
  price: number,
  atrPct: number,
  cfg: EntryConfirmConfig,
  now: number,
): ConfirmResult['pullback'] {
  const requiredPct = requiredPullback(atrPct, cfg);
  if (!tape) {
    return { code: 'NO_TAPE', requiredPct, observedPct: null, ticks: null, lastAgeMs: null };
  }
  const w = tape.window(symbol, now, cfg.minTicks);
  if (!w) {
    return { code: 'NO_TAPE', requiredPct, observedPct: null, ticks: 0, lastAgeMs: null };
  }
  if (w.ageMs > cfg.maxAgeMs) {
    return { code: 'NO_TAPE', requiredPct, observedPct: null, ticks: w.ticks, lastAgeMs: w.ageMs };
  }
  const observedPct = w.high > 0 ? (w.high - price) / w.high : 0;
  const ok = observedPct + 1e-9 >= requiredPct;
  return {
    code: ok ? 'PASS' : 'AT_LOCAL_HIGH',
    requiredPct: Math.round(requiredPct * 1e5) / 1e5,
    observedPct: Math.round(Math.max(0, observedPct) * 1e5) / 1e5,
    ticks: w.ticks,
    lastAgeMs: w.ageMs,
  };
}

function venueFor(db: DatabaseSync, symbol: string, cfg: EntryConfirmConfig, now: number): ConfirmResult['venue'] | null {
  const rows = loadSamples(db, now - cfg.venueWindowMs, symbol);
  if (rows.length === 0) return null;
  const ageMs = now - rows.reduce((m, r) => Math.max(m, r.ts), 0);
  const blank = {
    symbol, majority: null, agreement: null, referenceAgrees: null,
    krakenPct: null, coinbasePct: null, ageMs,
  } as const;
  if (ageMs > cfg.maxAgeMs) return { ...blank, code: 'STALE' };
  const group = priceAgreement(rows, symbol, now, 'kraken').find((g) => g.quoteGroup === 'USD');
  if (!group) return null;
  if (!group.sufficient) return { ...blank, code: 'NO_DATA' };
  const kraken = venueWindow(rows, 'kraken', symbol, now);
  const coinbase = venueWindow(rows, 'coinbase', symbol, now);
  const detail = {
    symbol,
    majority: group.majority,
    agreement: group.agreement,
    referenceAgrees: group.referenceAgrees,
    krakenPct: kraken?.returnPct ?? null,
    coinbasePct: coinbase?.returnPct ?? null,
    ageMs,
  };
  // Sign rules on the two venues' own window returns (priceAgreement's
  // `majority` breaks a 1-1 tie as 'UP', which would call a genuine
  // disagreement agreement — so divergence is decided here, on the signs):
  //   both non-flat and opposite  -> DIVERGE (blocked)
  //   neither up, at least one down -> FALLING (blocked, long-only book)
  //   anything else               -> PASS (flat counts as agreement)
  const TOL = 0.005; // the same flat band priceAgreement uses, in percent
  const sign = (v: number | null): number =>
    v === null || !Number.isFinite(v) ? 0 : v > TOL ? 1 : v < -TOL ? -1 : 0;
  const k = sign(detail.krakenPct);
  const c = sign(detail.coinbasePct);
  if (k !== 0 && c !== 0 && k !== c) return { ...detail, code: 'DIVERGE' };
  const up = k > 0 || c > 0;
  const down = k < 0 || c < 0;
  if (cfg.venueRequireUp && down && !up) return { ...detail, code: 'FALLING' };
  return { ...detail, code: 'PASS' };
}

const NO_VENUE_DATA: ConfirmResult['venue'] = {
  code: 'NO_DATA', symbol: null, majority: null, agreement: null,
  referenceAgrees: null, krakenPct: null, coinbasePct: null, ageMs: null,
};

function venueLeg(
  db: DatabaseSync,
  symbol: string,
  cfg: EntryConfirmConfig,
  now: number,
): ConfirmResult['venue'] {
  // entry symbol first (only BTC/ETH are covered today), then the BTC tape
  const candidates = [...new Set([symbol, CRYPTO_BENCHMARK])];
  let stale: ConfirmResult['venue'] | null = null;
  try {
    for (const c of candidates) {
      const res = venueFor(db, c, cfg, now);
      if (!res) continue;
      if (res.code === 'STALE' && !stale) stale = res;
      else if (res.code !== 'STALE') return res;
    }
  } catch {
    // no xchange_samples table (tests, or the observer layer off) = NO DATA,
    // never a crash and never a silent pass
    return NO_VENUE_DATA;
  }
  if (stale) return stale;
  return NO_VENUE_DATA;
}

export interface ConfirmInput {
  db: DatabaseSync;
  cfg: EntryConfirmConfig;
  tape: TickTape | undefined;
  symbol: string;
  price: number;
  /** daily ATR14 as a fraction of price (0/NaN -> floor) */
  atrPct: number;
  now: number;
}

export function evaluateConfirmation(input: ConfirmInput): ConfirmResult {
  const { cfg, symbol, price, now } = input;
  if (!cfg.enabled) {
    return {
      ok: true,
      pullback: { code: 'DISABLED', requiredPct: null, observedPct: null, ticks: null, lastAgeMs: null },
      venue: {
        code: 'DISABLED', symbol: null, majority: null, agreement: null,
        referenceAgrees: null, krakenPct: null, coinbasePct: null, ageMs: null,
      },
      reason: '',
    };
  }
  // A gate may never be the thing that breaks a scan: every leg degrades to
  // NO_DATA (pass + record) if its data source misbehaves.
  let pullback: ConfirmResult['pullback'];
  let venue: ConfirmResult['venue'];
  try {
    pullback = pullbackLeg(input.tape, symbol, price, input.atrPct, cfg, now);
  } catch {
    pullback = { code: 'NO_TAPE', requiredPct: null, observedPct: null, ticks: 0, lastAgeMs: null };
  }
  try {
    venue = venueLeg(input.db, symbol, cfg, now);
  } catch {
    venue = NO_VENUE_DATA;
  }
  const blocked = BLOCKING_PULLBACK.has(pullback.code)
    ? pullback.code
    : BLOCKING_VENUE.has(venue.code) ? venue.code : '';
  return { ok: blocked === '', pullback, venue, reason: blocked };
}
