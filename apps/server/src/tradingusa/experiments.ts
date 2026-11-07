/**
 * Rule experiments — SHADOW mode.
 *
 * A measurable "setup" is evaluated against every signal in a date window and
 * compared with the rest: did the signals that matched the setup actually
 * make more money than the ones that did not?
 *
 * Two hard rules, both deliberate:
 *  1. NOTHING HERE BLOCKS OR CHANGES A TRADE. The module is read-only — it
 *     never writes to the DB and `runScan` never imports it. It answers
 *     "would this have been a good idea?", nothing more. When an experiment
 *     ever graduates, the only legal action is a BIAS UP (more conviction for
 *     setups that proved out), never a filter that removes trades: the goal
 *     is smarter entries, not fewer of them.
 *  2. Evidence floor. An experiment with fewer than MIN_TRADES matched closed
 *     trades reports OBSERVING instead of a verdict — the same floor the
 *     fusion-weight refit uses, so a handful of lucky fills can't crown a
 *     setup.
 *
 * Conditions are derived from fields the signal already stores (evidence
 * kinds, scores, regime, confidence, audit entry checks), so historical
 * signals are evaluable too — no backfill migration is needed.
 */
import type { DatabaseSync } from 'node:sqlite';
import { MIN_TRADES } from './adaptive.ts';

export type ExperimentStatus = 'OBSERVING' | 'PROMOTE_CANDIDATE' | 'NO_EDGE';

export interface ExperimentRow {
  key: string;
  label: string;
  description: string;
  evaluableSignals: number;
  matchedSignals: number;
  matchedClosed: number;
  matchedWinRatePct: number | null;
  matchedAvgReturnPct: number | null;
  baselineClosed: number;
  baselineWinRatePct: number | null;
  baselineAvgReturnPct: number | null;
  /** matched avg return minus the rest, in percentage points */
  deltaReturnPct: number | null;
  status: ExperimentStatus;
}

export interface ExperimentsResponse {
  from: string;
  to: string;
  signals: number;
  closedTrades: number;
  note: string;
  conditions: ExperimentRow[];
}

interface SignalSample {
  id: number;
  signal: string;
  regime: string;
  confidence: number;
  evidence: Array<{ kind?: string; detail?: string; positive?: boolean }>;
  entryChecks: Record<string, number>;
  retPct: number | null; // realized return in PERCENT, null when still open
}

type Verdict = { holds: boolean } | { holds: null };

const ADVERSE = new Set(['BEAR_TREND', 'RISK_OFF', 'LIQUIDITY_STRESS', 'HIGH_VOLATILITY', 'UNCERTAIN']);
const FAVORABLE = new Set(['BULL_TREND', 'MOMENTUM', 'RISK_ON']);

function evidenceHas(s: SignalSample, kind: string): Verdict {
  const hit = s.evidence.find((e) => e.kind === kind);
  if (!hit) return { holds: null }; // setup not present in this signal's evidence
  return { holds: hit.positive !== false };
}

function volumeConfirmed(s: SignalSample): Verdict {
  const fromChecks = s.entryChecks.relativeVolume;
  if (Number.isFinite(fromChecks)) return { holds: fromChecks >= 1.15 };
  // historical signals: the strategy wrote "…on 1.32x volume" only when the
  // breakout had volume behind it, and "without volume confirmation" otherwise
  const breakout = s.evidence.find((e) => e.kind === 'breakout');
  if (!breakout) return { holds: null };
  const m = /on\s+(\d+(?:\.\d+)?)x volume/.exec(breakout.detail ?? '');
  if (!m) return { holds: null };
  return { holds: Number(m[1]) >= 1.15 };
}

export interface ExperimentCondition {
  key: string;
  label: string;
  description: string;
  evaluate: (s: SignalSample) => Verdict;
}

/** The setup library. Adding a condition is additive — it never changes how
 *  any signal was produced, it only adds a column to the comparison. */
export const EXPERIMENT_CONDITIONS: ExperimentCondition[] = [
  {
    key: 'volume_confirmed',
    label: 'Volume-confirmed entry',
    description: 'Relative volume >= 1.15 at entry — the lesson the system already enforces.',
    evaluate: volumeConfirmed,
  },
  {
    key: 'trend_aligned',
    label: 'Trend alignment',
    description: 'Bullish stack (SMA20 > SMA50 > long MA) at entry.',
    evaluate: (s) => evidenceHas(s, 'trend_alignment'),
  },
  {
    key: 'relative_strength',
    label: 'Relative strength vs SPY',
    description: '90d relative strength of at least +5% against the benchmark.',
    evaluate: (s) => evidenceHas(s, 'relative_strength'),
  },
  {
    key: 'breakout',
    label: 'Breakout setup',
    description: 'Price broke the 20-day high (volume confirmation tracked separately).',
    evaluate: (s) => evidenceHas(s, 'breakout'),
  },
  {
    key: 'event_alignment',
    label: 'Fresh material event',
    description: 'A positive, high-materiality event inside the last 3 sessions.',
    evaluate: (s) => {
      const hits = s.evidence.filter((e) => (e.kind ?? '').startsWith('event:') && e.positive !== false);
      if (hits.length === 0) return { holds: null };
      return { holds: true };
    },
  },
  {
    key: 'regime_confirmed',
    label: 'Favourable regime',
    description: 'Entry taken while the market regime was BULL_TREND / MOMENTUM / RISK_ON.',
    evaluate: (s) => {
      if (s.signal !== 'BUY') return { holds: null }; // regime gates LONG entries only
      if (FAVORABLE.has(s.regime)) return { holds: true };
      if (ADVERSE.has(s.regime)) return { holds: false };
      return { holds: null };
    },
  },
  {
    key: 'high_confidence',
    label: 'High fused confidence',
    description: 'Signal confidence at or above 0.75.',
    evaluate: (s) => ({ holds: s.confidence >= 0.75 }),
  },
];

function rate(wins: number, n: number): number | null {
  return n > 0 ? Math.round((wins / n) * 1000) / 10 : null;
}

/** Mean of values that are ALREADY in percent, rounded to one decimal. */
function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

function parseJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Compare every setup against the rest of the window. Read-only. */
export function experimentSummary(db: DatabaseSync, from: string, to: string): ExperimentsResponse {
  const rows = db
    .prepare(
      `SELECT s.id, s.signal, s.regime, s.confidence, s.evidence_json, s.audit_json,
              t.return_pct AS ret
         FROM signals s
         LEFT JOIN paper_trades t ON t.signal_id = s.id AND t.exit_ts IS NOT NULL
        WHERE s.session_date >= ? AND s.session_date <= ?`,
    )
    .all(from, to) as unknown as Array<{
      id: number; signal: string; regime: string; confidence: number;
      evidence_json: string; audit_json: string; ret: number | null;
    }>;

  const samples: SignalSample[] = rows.map((r) => {
    const evidence = (parseJson(r.evidence_json) ?? []) as SignalSample['evidence'];
    const audit = (parseJson(r.audit_json) ?? {}) as { entryChecks?: Record<string, number> };
    return {
      id: r.id, signal: r.signal, regime: r.regime, confidence: Number(r.confidence),
      evidence: Array.isArray(evidence) ? evidence : [],
      entryChecks: audit.entryChecks ?? {},
      retPct: r.ret == null ? null : Number(r.ret) * 100,
    };
  });

  const closed = samples.filter((s) => s.retPct != null);

  const conditions: ExperimentRow[] = EXPERIMENT_CONDITIONS.map((c) => {
    const evaluable = samples.map((s) => ({ s, v: c.evaluate(s) }))
      .filter((x) => x.v.holds !== null) as Array<{ s: SignalSample; v: { holds: boolean } }>;
    const matched = evaluable.filter((x) => x.v.holds);
    const rest = evaluable.filter((x) => !x.v.holds);

    const matchedClosed = matched.map((x) => x.s).filter((s) => s.retPct != null);
    const restClosed = rest.map((x) => x.s).filter((s) => s.retPct != null);

    const matchedReturns = matchedClosed.map((s) => s.retPct as number);
    const restReturns = restClosed.map((s) => s.retPct as number);
    const matchedAvg = avg(matchedReturns);
    const restAvg = avg(restReturns);
    const delta = matchedAvg != null && restAvg != null
      ? Math.round((matchedAvg - restAvg) * 10) / 10
      : null;

    let status: ExperimentStatus = 'OBSERVING';
    if (matchedClosed.length >= MIN_TRADES && delta != null) {
      status = delta > 0 ? 'PROMOTE_CANDIDATE' : 'NO_EDGE';
    }

    return {
      key: c.key,
      label: c.label,
      description: c.description,
      evaluableSignals: evaluable.length,
      matchedSignals: matched.length,
      matchedClosed: matchedClosed.length,
      matchedWinRatePct: rate(matchedClosed.filter((s) => (s.retPct as number) > 0).length, matchedClosed.length),
      matchedAvgReturnPct: matchedAvg,
      baselineClosed: restClosed.length,
      baselineWinRatePct: rate(restClosed.filter((s) => (s.retPct as number) > 0).length, restClosed.length),
      baselineAvgReturnPct: restAvg,
      deltaReturnPct: delta,
      status,
    };
  });

  return {
    from, to,
    signals: samples.length,
    closedTrades: closed.length,
    note: 'Shadow mode — these experiments observe outcomes only. Nothing is blocked; '
      + `a verdict needs ${MIN_TRADES} matched closed trades, and any graduation can only add conviction to a proven setup, never remove trades.`,
    conditions,
  };
}
