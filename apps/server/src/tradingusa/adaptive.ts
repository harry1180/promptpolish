/**
 * Adaptive knowledge refresh — the loop that lets the book learn from BOTH
 * outcomes instead of only counting its losses.
 *
 * Three mechanisms, each bounded so that ONE trade can never move production
 * (the guardrail written in learning.ts stays in force — no LLM edits
 * strategy code, and Champion promotion still needs backtest + walk-forward
 * evidence; this module only moves weights inside a band):
 *
 *  1. OUTCOME feedback: every closed trade (win or loss) writes an
 *     OUTCOME_RECORDED learning event. When a VALIDATED lesson has a
 *     measurable prescription that held at entry, a win bumps its
 *     `validations` and a loss bumps its `contradictions` — that is the
 *     missing positive half of the loop.
 *  2. LEARNED FUSION WEIGHTS: per (strategy, horizon) the six score-part
 *     weights are re-fit from realized excess returns of closed trades that
 *     carry their signal's `scores_json`. Evidence-shrunk and band-limited:
 *     nothing is written before MIN_TRADES outcomes exist, no part moves more
 *     than ±MAX_SHIFT of its shipped default and none is silenced below
 *     MIN_SHARE of it. `engine.runScan` reads the result and passes it to
 *     `fuse()`; absent/insufficient rows leave the shipped defaults in place.
 *  3. REFRESH: consolidate() + weight re-fit + lesson review in one daily
 *     job, each step logged as a learning_events row so the UI can show the
 *     delta. A lesson whose contradictions dominate is REVOKED (its gate
 *     turns off), and it may be re-proposed after its mistake cluster has
 *     collected fresh observations again.
 */
import type { DatabaseSync } from 'node:sqlite';
import { FUSION_WEIGHTS } from '@promptslim/tucore';
import type { Horizon, ScoreParts } from '@promptslim/tucore';
import { consolidate } from './learning.ts';

const PART_KEYS: Array<keyof ScoreParts> = ['technical', 'fundamental', 'event', 'sentiment', 'macro', 'regime'];

/** Closed outcomes required per (strategy, horizon) before any weight moves. */
export const MIN_TRADES = 10;
/** Each learned part weight stays within ±MAX_SHIFT of its shipped default. */
const MAX_SHIFT = 0.35;
/** ...and never below MIN_SHARE of it (a weak part is damped, not silenced). */
const MIN_SHARE = 0.4;
/** Contradictions required before a VALIDATED lesson is revoked. */
export const REVOKE_AFTER = 3;
/** Cluster observations needed after a revocation before re-proposing. */
export const REPROPOSE_AFTER = 3;

/**
 * A lesson's prescription, evaluated against the entry checks the engine
 * stores in the signal's audit_json at emit time. A lesson with no
 * measurable check gets NO feedback rather than a guessed one.
 */
const LESSON_CHECKS: Record<string, (checks: Record<string, number>) => boolean> = {
  // lesson text: "require price AND volume confirmation" — the scan gate's
  // own threshold is relativeVolume >= 1.15 (engine.runScan).
  TECHNICAL_SIGNAL_FAILURE: (checks) => Number(checks.relativeVolume) >= 1.15,
};

function parseJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function event(db: DatabaseSync, kind: string, payload: Record<string, unknown>, now = Date.now()): void {
  db.prepare('INSERT INTO learning_events (ts, kind, payload_json) VALUES (?, ?, ?)')
    .run(now, kind, JSON.stringify(payload));
}

/* ------------------------------------------------------------------ */
/* 1. outcome feedback                                                 */
/* ------------------------------------------------------------------ */

export interface OutcomeFeedback {
  recorded: boolean;
  won?: boolean;
  lessonsTouched?: number;
}

/** Record the outcome of ANY closed trade — winners included — and feed it
 *  back into validated lessons whose prescription the entry satisfied. */
export function learnFromOutcome(db: DatabaseSync, tradeId: number): OutcomeFeedback {
  const trade = db
    .prepare('SELECT id, net_pnl, return_pct, signal_id FROM paper_trades WHERE id = ?')
    .get(tradeId) as { id: number; net_pnl: number | null; return_pct: number | null; signal_id: number | null } | undefined;
  if (!trade) return { recorded: false };

  const won = Number(trade.net_pnl ?? 0) > 0;
  event(db, 'OUTCOME_RECORDED', { tradeId: trade.id, won, returnPct: trade.return_pct ?? null });

  let lessonsTouched = 0;
  if (trade.signal_id == null) return { recorded: true, won, lessonsTouched };
  const sig = db.prepare('SELECT audit_json FROM signals WHERE id = ?').get(trade.signal_id) as
    | { audit_json: string }
    | undefined;
  const audit = parseJson(sig?.audit_json);
  const checks = audit?.entryChecks as Record<string, number> | undefined;
  if (!checks || typeof checks !== 'object') return { recorded: true, won, lessonsTouched };

  const lessons = db
    .prepare(`SELECT id, title, scope_json FROM knowledge_lessons WHERE status = 'VALIDATED'`)
    .all() as unknown as Array<{ id: number; title: string; scope_json: string }>;
  for (const l of lessons) {
    const scope = parseJson(l.scope_json);
    const kind = scope?.mistakeKind as string | undefined;
    const check = kind ? LESSON_CHECKS[kind] : undefined;
    if (!check || !check(checks)) continue; // prescription did not apply here
    db.prepare(
      won
        ? 'UPDATE knowledge_lessons SET validations = validations + 1, updated_at = ? WHERE id = ?'
        : 'UPDATE knowledge_lessons SET contradictions = contradictions + 1, updated_at = ? WHERE id = ?',
    ).run(Date.now(), l.id);
    lessonsTouched += 1;
    event(db, won ? 'LESSON_CONFIRMED' : 'LESSON_CONTRADICTED', {
      lessonId: l.id, title: l.title, tradeId: trade.id,
    });
  }
  return { recorded: true, won, lessonsTouched };
}

/* ------------------------------------------------------------------ */
/* 2. learned fusion weights                                           */
/* ------------------------------------------------------------------ */

export interface LearnedWeights {
  /** undefined when there is no sufficient evidence — callers must fall back
   *  to the shipped FUSION_WEIGHTS, which is what fuse() does anyway. */
  weights?: Partial<ScoreParts>;
  trades: number;
  sufficient: boolean;
}

interface StoredWeights {
  weights?: Partial<ScoreParts>;
  trades?: number;
  sufficient?: boolean;
  updatedAt?: number;
}

/** Read the learned weights for one strategy. Anything missing, malformed or
 *  below the evidence floor reports `sufficient:false` so the caller keeps
 *  the shipped defaults. */
export function learnedWeights(db: DatabaseSync, strategy: string, horizon: string): LearnedWeights {
  const row = db
    .prepare('SELECT weights_json FROM strategy_weights WHERE strategy = ? AND horizon = ?')
    .get(strategy, horizon) as { weights_json: string } | undefined;
  if (!row) return { trades: 0, sufficient: false };
  const parsed = parseJson(row.weights_json) as StoredWeights | null;
  const trades = Number(parsed?.trades ?? 0);
  if (!parsed?.sufficient || !parsed.weights || trades < MIN_TRADES) return { trades, sufficient: false };
  return { weights: parsed.weights, trades, sufficient: true };
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx <= 1e-12 || vy <= 1e-12) return 0; // a flat part or a flat book carries no signal
  const c = cov / Math.sqrt(vx * vy);
  return Number.isFinite(c) ? Math.max(-1, Math.min(1, c)) : 0;
}

export interface WeightRefresh {
  strategies: number;
  changed: number;
  outcomes: number;
}

/**
 * Re-fit the fusion weights for every (strategy, horizon) that has enough
 * closed outcomes. The fit correlates each score part with realized excess
 * return, then nudges the shipped default toward the parts that actually
 * predicted it — shrunk by evidence, clamped to a band, renormalized.
 */
export function recomputeStrategyWeights(db: DatabaseSync, now = Date.now()): WeightRefresh {
  const rows = db
    .prepare(
      `SELECT s.strategy AS strategy, s.horizon AS horizon, s.scores_json AS scores_json,
              COALESCE(t.excess_return, t.return_pct, 0) AS outcome
         FROM paper_trades t
         JOIN signals s ON s.id = t.signal_id
        WHERE t.status = 'CLOSED' AND t.signal_id IS NOT NULL`,
    )
    .all() as unknown as Array<{ strategy: string; horizon: string; scores_json: string; outcome: number }>;

  const groups = new Map<string, { strategy: string; horizon: string; xs: Record<string, number[]>; ys: number[] }>();
  for (const r of rows) {
    if (!Number.isFinite(Number(r.outcome))) continue;
    const scores = parseJson(r.scores_json);
    if (!scores) continue;
    const key = `${r.strategy}|${r.horizon}`;
    const g = groups.get(key) ?? { strategy: r.strategy, horizon: r.horizon, xs: {} as Record<string, number[]>, ys: [] };
    for (const k of PART_KEYS) {
      const v = Number((scores as Record<string, number>)[k]);
      (g.xs[k] ??= []).push(Number.isFinite(v) ? v : 0);
    }
    g.ys.push(Number(r.outcome));
    groups.set(key, g);
  }

  const stmt = db.prepare(
    `INSERT INTO strategy_weights (strategy, horizon, weights_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(strategy, horizon) DO UPDATE SET weights_json = excluded.weights_json, updated_at = excluded.updated_at`,
  );

  let strategies = 0;
  let changed = 0;
  let outcomes = 0;
  for (const g of groups.values()) {
    const n = g.ys.length;
    outcomes += n;
    if (n < MIN_TRADES) continue; // not enough evidence: production logic untouched
    const def = FUSION_WEIGHTS[g.horizon as Horizon] ?? FUSION_WEIGHTS.SHORT;
    const shrink = Math.min(1, n / (2 * MIN_TRADES));
    const weights: Record<string, number> = {};
    let total = 0;
    for (const k of PART_KEYS) {
      const corr = pearson(g.xs[k] ?? [], g.ys);
      const shift = Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, corr * MAX_SHIFT * shrink));
      const floor = def[k] * MIN_SHARE;
      const w = Math.max(floor, def[k] * (1 + shift));
      weights[k] = w;
      total += w;
    }
    const normalized: Record<string, number> = {};
    for (const k of PART_KEYS) normalized[k] = total > 0 ? weights[k] / total : def[k];

    const previous = learnedWeights(db, g.strategy, g.horizon);
    const delta = PART_KEYS.reduce(
      (acc, k) => acc + Math.abs((normalized[k] ?? 0) - Number(previous.weights?.[k] ?? def[k])),
      0,
    );
    stmt.run(g.strategy, g.horizon, JSON.stringify({
      weights: normalized, trades: n, sufficient: true, updatedAt: now,
    }), now);
    strategies += 1;
    if (delta > 0.01) {
      changed += 1;
      event(db, 'WEIGHT_REFRESH', {
        strategy: g.strategy, horizon: g.horizon, trades: n, delta: Number(delta.toFixed(4)),
        from: previous.weights ?? def, to: normalized,
      }, now);
    }
  }
  return { strategies, changed, outcomes };
}

/* ------------------------------------------------------------------ */
/* 3. daily refresh: consolidate + refit + lesson review               */
/* ------------------------------------------------------------------ */

interface RevocableLesson {
  id: number; title: string; validations: number; contradictions: number; scope_json: string;
}

/** A VALIDATED lesson whose contradictions now dominate its validations is
 *  revoked — its gate turns OFF in engine.runScan. The cluster count is kept
 *  in scope_json so the same rule can be re-proposed once fresh evidence
 *  accumulates, which is what makes the loop bidirectional. */
function reviewLessons(db: DatabaseSync, now: number): { revoked: number; reproposed: number } {
  let revoked = 0;
  const rows = db
    .prepare(
      `SELECT id, title, validations, contradictions, scope_json
         FROM knowledge_lessons
        WHERE status = 'VALIDATED' AND contradictions >= ?`,
    )
    .all(REVOKE_AFTER) as unknown as RevocableLesson[];
  for (const l of rows) {
    if (l.contradictions <= l.validations) continue; // evidence still net-positive
    const scope = parseJson(l.scope_json) ?? {};
    const kind = scope.mistakeKind as string | undefined;
    const cluster = kind
      ? db.prepare('SELECT count FROM mistake_clusters WHERE kind = ?').get(kind) as { count: number } | undefined
      : undefined;
    db.prepare(`UPDATE knowledge_lessons SET status = 'EXPIRED', scope_json = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify({ ...scope, revokedAtCount: cluster?.count ?? null }), now, l.id);
    event(db, 'LESSON_REVOKED', {
      lessonId: l.id, title: l.title,
      validations: l.validations, contradictions: l.contradictions,
    }, now);
    revoked += 1;
  }

  let reproposed = 0;
  const expired = db
    .prepare(`SELECT id, title, statement, confidence, scope_json, updated_at, validations, contradictions
                FROM knowledge_lessons WHERE status = 'EXPIRED' AND contradictions >= ?`)
    .all(REVOKE_AFTER) as unknown as Array<{
      id: number; title: string; statement: string; confidence: number;
      scope_json: string; updated_at: number; validations: number; contradictions: number;
    }>;
  for (const l of expired) {
    const scope = parseJson(l.scope_json) ?? {};
    const kind = scope.mistakeKind as string | undefined;
    const at = scope.revokedAtCount;
    if (!kind || typeof at !== 'number') continue;
    const cluster = db.prepare('SELECT count FROM mistake_clusters WHERE kind = ?').get(kind) as
      | { count: number }
      | undefined;
    if (!cluster || cluster.count - at < REPROPOSE_AFTER) continue;
    db.prepare(
      `UPDATE knowledge_lessons
          SET status = 'CANDIDATE', validations = 1, contradictions = 0,
              confidence = ?, updated_at = ?
        WHERE id = ?`,
    ).run(Math.min(0.95, 0.3 + 0.1 * cluster.count), now, l.id);
    event(db, 'LESSON_REPROPOSED', { lessonId: l.id, title: l.title, clusterCount: cluster.count }, now);
    reproposed += 1;
  }
  return { revoked, reproposed };
}

export interface RefreshResult {
  merged: number;
  expired: number;
  validated: number;
  strategies: number;
  weightsChanged: number;
  revoked: number;
  reproposed: number;
}

/** One daily pass: merge/expire/validate lessons, re-fit weights from new
 *  outcomes, then review lesson gates. Logged as a single KNOWLEDGE_REFRESH
 *  event so the UI can show what the book learned overnight. */
export function refreshKnowledge(db: DatabaseSync, now = Date.now()): RefreshResult {
  const c = consolidate(db, now);
  const w = recomputeStrategyWeights(db, now);
  const review = reviewLessons(db, now);
  const result: RefreshResult = {
    merged: c.merged, expired: c.expired, validated: c.validated,
    strategies: w.strategies, weightsChanged: w.changed,
    revoked: review.revoked, reproposed: review.reproposed,
  };
  event(db, 'KNOWLEDGE_REFRESH', result as unknown as Record<string, unknown>, now);
  return result;
}
