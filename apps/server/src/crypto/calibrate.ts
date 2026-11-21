/**
 * Walk-forward entry threshold — "what does the recorded history actually
 * support?" instead of a hand-picked confidence cut.
 *
 * WHY THIS EXISTS: the shipped entry threshold is `minSignalConfidence` on the
 * fused confidence, and the recorded signal history cannot calibrate it —
 * every BUY candidate the book has ever emitted carries the SAME confidence
 * (0.5137), the same fused score (+0.5205) and the same technical part (+1.0),
 * so no cut on those features separates anything: it keeps all of them or
 * none. Measured on the live book 2026-11-21: 39 BUY rows, 1 distinct value
 * each. That is stated, not worked around.
 *
 * WHAT IT DOES INSTEAD: evaluate an ordered list of candidate features over
 * the recorded signals (rows strictly BEFORE the current session — no
 * same-day leakage), score each cut against the realised next-session return
 * from `market_bars`, and activate the FIRST feature that
 *   1. clears the evidence floor (`minSamples` usable rows),
 *   2. actually varies (>= 2 distinct values),
 *   3. keeps a better side than it cuts (the direction the gate would impose),
 *   4. is not contradicted by the BUY-only sub-sample.
 * If nothing qualifies the state is INSUFFICIENT_DATA / NOT_SUPPORTED and the
 * gate does not block — a threshold without evidence is never invented here.
 *
 * Read-only: it selects rows from `signals` and `market_bars` and writes
 * nothing. The engine calls it once per scan and stores the verdict in the
 * signal's audit payload + the /entrygate endpoint.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { EntryThresholdConfig } from './config.ts';

export type ThresholdStatus = 'ACTIVE' | 'INSUFFICIENT_DATA' | 'NOT_SUPPORTED' | 'DISABLED';
export type ThresholdDirection = 'lte' | 'gte';

export interface FeatureEvidence {
  feature: string;
  /** rows with this feature AND a complete forward window */
  samples: number;
  distinct: number;
  direction: ThresholdDirection;
  /** percentile cut applied to the recorded feature values */
  threshold: number | null;
  /** side the gate would KEEP */
  kept: { n: number; up: number; accPct: number | null; meanPct: number | null };
  /** side the gate would CUT */
  cut: { n: number; up: number; accPct: number | null; meanPct: number | null };
  /** every usable row: the unconditional next-session hit rate */
  baseRatePct: number | null;
  verdict: 'USABLE' | 'TOO_THIN' | 'CONSTANT' | 'WRONG_DIRECTION';
  reason: string;
}

export interface ThresholdState {
  enabled: boolean;
  status: ThresholdStatus;
  feature: string | null;
  threshold: number | null;
  direction: ThresholdDirection | null;
  percentile: number;
  minSamples: number;
  samples: number;
  /** session_date window actually used (walk-forward: strictly before `asOf`) */
  from: string | null;
  asOf: string | null;
  candidates: FeatureEvidence[];
  /** BUY-only consistency check on the active feature (the rows it gates) */
  buyCheck: { feature: string; samples: number; keptAccPct: number | null; cutAccPct: number | null; agrees: boolean } | null;
  reason: string;
}

interface Row {
  ticker: string;
  signal: string;
  confidence: number;
  weighted: number | null;
  sessionDate: string;
  /** recorded signal price (the quote the scan saw — point-in-time) */
  price: number;
}

interface BarIndex {
  dates: string[];
  close: Map<string, number>;
}

function barIndex(db: DatabaseSync, ticker: string, cache: Map<string, BarIndex | null>): BarIndex | null {
  if (cache.has(ticker)) return cache.get(ticker) ?? null;
  const rows = db
    .prepare('SELECT date, close FROM market_bars WHERE ticker = ? ORDER BY date')
    .all(ticker) as unknown as Array<{ date: string; close: number }>;
  const idx: BarIndex | null = rows.length >= 2
    ? { dates: rows.map((r) => r.date), close: new Map(rows.map((r) => [r.date, r.close])) }
    : null;
  cache.set(ticker, idx);
  return idx;
}

/** position of `date` inside the series: the exact date, or the first bar on
 *  or after it (a signal stamped mid-session settles on the next close). */
function atOrAfter(idx: BarIndex, date: string): number {
  const exact = idx.dates.indexOf(date);
  if (exact >= 0) return exact;
  let lo = 0;
  let hi = idx.dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (idx.dates[mid] < date) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Close of the last COMPLETED session before `date` — the only bar a
 *  point-in-time feature may be measured against. */
function prevSessionClose(idx: BarIndex, date: string): number | null {
  const i = atOrAfter(idx, date);
  if (i < 1) return null;
  return idx.close.get(idx.dates[i - 1]) ?? null;
}

/** The engine's copy of the same feature: how far `price` has run since the
 *  last completed session. Same rule as the calibration, so a candidate is
 *  scored against exactly what the history was scored against. */
export function entryMove(
  bars: Array<{ date: string; close: number }>,
  sessionDate: string,
  price: number,
): number | null {
  if (!(price > 0) || bars.length < 2) return null;
  let i = bars.findIndex((b) => b.date >= sessionDate);
  if (i < 0) i = bars.length;
  if (i < 1) return null;
  const prevClose = bars[i - 1].close;
  return prevClose > 0 ? price / prevClose - 1 : null;
}

function forwardReturn(idx: BarIndex, date: string, days: number): number | null {
  const i = atOrAfter(idx, date);
  if (i < 0 || i + days >= idx.dates.length) return null;
  const base = idx.close.get(idx.dates[i]);
  const later = idx.close.get(idx.dates[i + days]);
  if (!base || !later) return null;
  return later / base - 1;
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  const k = ((s.length - 1) * p) / 100;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
}

function mean(v: number[]): number | null {
  return v.length > 0 ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function round(v: number | null, places = 4): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

interface Scored {
  row: Row;
  feature: number;
  outcome: number;
}

function side(n: number, up: number, outcomes: number[]): FeatureEvidence['kept'] {
  const m = outcomes.length > 0 ? mean(outcomes) : null;
  return {
    n, up,
    accPct: n > 0 ? Math.round((up / n) * 1000) / 10 : null,
    meanPct: m === null ? null : round(m * 100, 3),
  };
}

/** Candidate features in FIXED order — first supported wins, never "best of". */
const FEATURES: Array<{
  name: string;
  direction: ThresholdDirection;
  extract: (r: RowWithFeature) => number | null;
}> = [
  // How far the entry price has already run since the last COMPLETED session.
  // This is the only feature of the three that varies across BUY candidates
  // (39 distinct values vs 1 for confidence/fused/technical), it is
  // point-in-time (signal price vs the previous close), and its relationship
  // to the next session is monotone across the recorded history: quartiles
  // 49.3 / 37.3 / 25.4 / 11.8% next-day hit rate, walk-forward p50 cut
  // 37.5% kept (n=104) vs 11.4% cut (n=88), BUY-only 45.0% vs 15.8% (n=39).
  { name: 'entry_move_vs_prev_close', direction: 'lte', extract: (r) => r.move },
  { name: 'confidence', direction: 'gte', extract: (r) => r.confidence },
  { name: 'weighted', direction: 'gte', extract: (r) => r.weighted },
];

type RowWithFeature = Row & { move: number | null };

export function entryThreshold(
  db: DatabaseSync,
  cfg: EntryThresholdConfig,
  opts: { asOf: string; strategy: string },
): ThresholdState {
  const base: ThresholdState = {
    enabled: cfg.enabled,
    status: cfg.enabled ? 'INSUFFICIENT_DATA' : 'DISABLED',
    feature: null, threshold: null, direction: null,
    percentile: cfg.percentile, minSamples: cfg.minSamples,
    samples: 0, from: null, asOf: opts.asOf,
    candidates: [], buyCheck: null,
    reason: cfg.enabled ? 'not evaluated' : 'CRYPTO_ENTRY_THRESHOLD=0',
  };
  if (!cfg.enabled) return base;

  const raw = db
    .prepare(
      `SELECT ticker, signal, confidence, price, audit_json, session_date
         FROM signals
        WHERE session_date < ? AND strategy = ?
        ORDER BY session_date ASC, id ASC`,
    )
    .all(opts.asOf, opts.strategy) as unknown as Array<{
      ticker: string; signal: string; confidence: number; price: number;
      audit_json: string | null; session_date: string;
    }>;

  const cache = new Map<string, BarIndex | null>();
  const rows: RowWithFeature[] = [];
  for (const r of raw) {
    let weighted: number | null = null;
    try {
      const audit = JSON.parse(r.audit_json ?? '{}') as { weighted?: unknown };
      const w = Number(audit.weighted);
      weighted = Number.isFinite(w) ? w : null;
    } catch { weighted = null; }
    const idx = barIndex(db, r.ticker, cache);
    const prevClose = idx ? prevSessionClose(idx, r.session_date) : null;
    const move = prevClose && Number.isFinite(r.price) && r.price > 0 ? r.price / prevClose - 1 : null;
    rows.push({
      ticker: r.ticker, signal: r.signal, confidence: r.confidence, price: r.price,
      weighted, sessionDate: r.session_date, move,
    });
  }

  const candidates: FeatureEvidence[] = [];
  let chosen: { feature: string; threshold: number; direction: ThresholdDirection; scored: Scored[] } | null = null;
  let samples = 0;

  for (const f of FEATURES) {
    const scored: Scored[] = [];
    for (const row of rows) {
      const v = f.extract(row);
      if (v === null || !Number.isFinite(v)) continue;
      const idx = barIndex(db, row.ticker, cache);
      const outcome = idx ? forwardReturn(idx, row.sessionDate, cfg.forwardDays) : null;
      if (outcome === null) continue;
      scored.push({ row, feature: v, outcome });
    }
    const values = scored.map((s) => s.feature);
    const distinct = new Set(values.map((v) => Math.round(v * 1e6))).size;
    const threshold = values.length > 0 ? percentile(values, cfg.percentile) : null;
    const keep = (v: number): boolean => (f.direction === 'lte' ? v <= (threshold ?? 0) : v >= (threshold ?? 0));
    const keptRows = scored.filter((s) => keep(s.feature));
    const cutRows = scored.filter((s) => !keep(s.feature));
    const keptOut = keptRows.map((s) => s.outcome);
    const cutOut = cutRows.map((s) => s.outcome);
    const kept = side(keptRows.length, keptOut.filter((o) => o > 0).length, keptOut);
    const cut = side(cutRows.length, cutOut.filter((o) => o > 0).length, cutOut);
    const all = scored.map((s) => s.outcome);
    const baseRate = all.length > 0 ? Math.round((all.filter((o) => o > 0).length / all.length) * 1000) / 10 : null;

    let verdict: FeatureEvidence['verdict'] = 'USABLE';
    let reason = 'measured cut keeps a higher next-session hit rate than it cuts';
    if (scored.length < cfg.minSamples) {
      verdict = 'TOO_THIN';
      reason = `${scored.length} usable rows < evidence floor ${cfg.minSamples}`;
    } else if (distinct < 2) {
      verdict = 'CONSTANT';
      reason = `feature has ${distinct} distinct value(s) across ${scored.length} rows — no cut can separate anything`;
    } else if (kept.n === 0 || cut.n === 0) {
      verdict = 'TOO_THIN';
      reason = `cut leaves ${kept.n} kept / ${cut.n} cut — an empty side proves nothing`;
    } else if ((kept.accPct ?? 0) <= (cut.accPct ?? 0)) {
      verdict = 'WRONG_DIRECTION';
      reason = `kept ${(kept.accPct ?? 0).toFixed(1)}% <= cut ${(cut.accPct ?? 0).toFixed(1)}% — the recorded history does not support this cut`;
    }

    candidates.push({
      feature: f.name, samples: scored.length, distinct, direction: f.direction,
      threshold: round(threshold), kept, cut, baseRatePct: baseRate, verdict, reason,
    });

    if (!chosen && verdict === 'USABLE') {
      chosen = { feature: f.name, threshold: threshold as number, direction: f.direction, scored };
      samples = scored.length;
    }
  }

  if (!chosen) {
    const best = candidates[0];
    return {
      ...base, candidates,
      samples: best?.samples ?? 0,
      from: rows[0]?.sessionDate ?? null,
      reason: candidates.length > 0
        ? `no candidate feature cleared the evidence floor: ${candidates.map((c) => `${c.feature}=${c.verdict}`).join(', ')}`
        : 'no recorded signal history',
    };
  }

  // BUY-only consistency check: the rows the gate actually decides about.
  const buyScored = chosen.scored.filter((s) => s.row.signal === 'BUY');
  const buyKeep = (v: number): boolean => (chosen.direction === 'lte' ? v <= (chosen.threshold as number) : v >= (chosen.threshold as number));
  const buyKept = buyScored.filter((s) => buyKeep(s.feature)).map((s) => s.outcome);
  const buyCut = buyScored.filter((s) => !buyKeep(s.feature)).map((s) => s.outcome);
  const buyCheck = buyScored.length > 0
    ? {
        feature: chosen.feature,
        samples: buyScored.length,
        keptAccPct: buyKept.length > 0 ? Math.round((buyKept.filter((o) => o > 0).length / buyKept.length) * 1000) / 10 : null,
        cutAccPct: buyCut.length > 0 ? Math.round((buyCut.filter((o) => o > 0).length / buyCut.length) * 1000) / 10 : null,
        agrees: buyKept.length > 0 && buyCut.length > 0
          ? buyKept.filter((o) => o > 0).length / buyKept.length > buyCut.filter((o) => o > 0).length / buyCut.length
          : true, // untestable sub-sample: does not veto an evidence-backed cut
      }
    : null;

  if (buyCheck && buyCheck.agrees === false) {
    return {
      ...base, status: 'NOT_SUPPORTED', candidates, buyCheck,
      samples, from: rows[0]?.sessionDate ?? null,
      reason: `BUY-only rows contradict the cut (kept ${buyCheck.keptAccPct}% vs cut ${buyCheck.cutAccPct}%, n=${buyCheck.samples})`,
    };
  }

  return {
    ...base, status: 'ACTIVE',
    feature: chosen.feature, threshold: round(chosen.threshold), direction: chosen.direction,
    candidates, buyCheck, samples,
    from: rows[0]?.sessionDate ?? null,
    reason: `${chosen.feature} ${chosen.direction} ${round(chosen.threshold)} @p${cfg.percentile} over ${samples} recorded rows (walk-forward: sessions strictly before ${opts.asOf})`,
  };
}

export interface ThresholdVerdict {
  ok: boolean;
  code: 'PASS' | 'INACTIVE' | 'BLOCKED';
  status: ThresholdStatus;
  feature: string | null;
  value: number | null;
  threshold: number | null;
}

/** Apply a computed state to one candidate's feature value. */
export function evaluateThreshold(state: ThresholdState, value: number | null): ThresholdVerdict {
  if (state.status !== 'ACTIVE') {
    return { ok: true, code: 'INACTIVE', status: state.status, feature: state.feature, value, threshold: null };
  }
  if (value === null || !Number.isFinite(value) || state.threshold === null) {
    // no measurable value for this candidate -> the cut cannot be applied;
    // recorded, never silently treated as a pass or a fail
    return { ok: true, code: 'INACTIVE', status: state.status, feature: state.feature, value, threshold: state.threshold };
  }
  const ok = state.direction === 'lte' ? value <= state.threshold : value >= state.threshold;
  return {
    ok, code: ok ? 'PASS' : 'BLOCKED',
    status: state.status, feature: state.feature, value: Math.round(value * 1e6) / 1e6,
    threshold: state.threshold,
  };
}
