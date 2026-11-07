/**
 * Learning pipeline: every losing closed trade generates a mistake record;
 * clusters of repeated mistakes become candidate lessons and — after enough
 * validated evidence — locally evaluable candidate rules.
 *
 * Deliberate guardrails:
 *  - ONE losing trade NEVER modifies production logic. It only appends
 *    statistics + a candidate lesson (status CANDIDATE).
 *  - No LLM edits strategy code, ever. Learning may only move weights /
 *    confidence / source priority through validated mechanisms, and
 *    Champion promotion requires backtest + walk-forward + shadow evidence
 *    (enforced by the challenger table workflow, not by this code path).
 */
import type { DatabaseSync } from 'node:sqlite';
import { classifyMistake } from '@promptslim/tucore';
import type { MistakeKind, Regime } from '@promptslim/tucore';

interface ClosedTradeRow {
  id: number; ticker: string; portfolio: string; net_pnl: number; return_pct: number;
  exit_reason: string | null; signal_id: number | null; entry_ts: number; exit_ts: number;
  mfe: number | null; mae: number | null;
}

function regimeAt(db: DatabaseSync, ts: number): Regime {
  const d = new Date(ts).toISOString().slice(0, 10);
  const row = db.prepare('SELECT regime FROM market_regimes WHERE date <= ? ORDER BY date DESC LIMIT 1').get(d) as
    | { regime: Regime }
    | undefined;
  return row?.regime ?? 'UNCERTAIN';
}

export function analyzeClosedTrade(db: DatabaseSync, tradeId: number): { recorded: boolean; kind?: MistakeKind } {
  const trade = db
    .prepare('SELECT id, ticker, portfolio, net_pnl, return_pct, exit_reason, signal_id, entry_ts, exit_ts, mfe, mae FROM paper_trades WHERE id = ?')
    .get(tradeId) as ClosedTradeRow | undefined;
  if (!trade) return { recorded: false };
  if (trade.net_pnl >= 0) return { recorded: false };

  const already = db.prepare('SELECT id FROM mistakes WHERE trade_id = ?').get(tradeId);
  if (already) return { recorded: false };

  const sig = trade.signal_id
    ? (db.prepare('SELECT confidence, evidence_json FROM signals WHERE id = ?').get(trade.signal_id) as
        | { confidence: number; evidence_json: string } | undefined)
    : undefined;

  const bars = db.prepare('SELECT date, close FROM market_bars WHERE ticker = ? AND date >= ? AND date <= ? ORDER BY date')
    .all(trade.ticker, new Date(trade.entry_ts).toISOString().slice(0, 10), new Date(trade.exit_ts).toISOString().slice(0, 10)) as unknown as Array<{ date: string; close: number }>;
  const volatilitySpike = bars.length > 3
    ? bars.some((b, i) => i > 0 && Math.abs(b.close / bars[i - 1].close - 1) > 0.06)
    : false;

  const classified = classifyMistake({
    lossPct: trade.return_pct,
    exitReason: (trade.exit_reason ?? null) as never,
    regimeAtEntry: regimeAt(db, trade.entry_ts),
    regimeAtExit: regimeAt(db, trade.exit_ts),
    volatilitySpike,
    newsMisinterpreted: false,
    sourceFailure: false,
    staleInfo: false,
    positionSizedOverLimit: false,
    confidenceAtEntry: sig?.confidence ?? 0.5,
    trendBrokeAtEntry: trade.exit_reason === 'STOP_REACHED',
    eventRiskWithinHold: false,
    macroDriven: false,
    correlatedClusterLoss: false,
  });

  db.prepare(
    `INSERT INTO mistakes (trade_id, ticker, kind, confidence, rationale, ts, loss_pct, status, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
  ).run(
    trade.id, trade.ticker, classified.kind, classified.confidence, classified.rationale,
    Date.now(), trade.return_pct,
    // The trade's own excursion tracking (FRACTIONS, as stored by the broker).
    // The old value put raw bar PRICES here (mfe: 418.51 on a $97 stock),
    // which fed garbage to the postmortem LLM and the classification context.
    JSON.stringify({ mfe: trade.mfe, mae: trade.mae, exitReason: trade.exit_reason }),
  );

  // cluster statistics (still no production-logic change)
  const existing = db.prepare('SELECT id, count FROM mistake_clusters WHERE kind = ?').get(classified.kind) as
    | { id: number; count: number }
    | undefined;
  const count = (existing?.count ?? 0) + 1;
  const confidence = Math.min(0.95, 0.3 + 0.1 * count);
  if (existing) {
    db.prepare('UPDATE mistake_clusters SET count = ?, confidence = ?, updated_at = ?, lesson = ? WHERE id = ?')
      .run(count, confidence, Date.now(), lessonFor(classified.kind, count), existing.id);
  } else {
    db.prepare('INSERT INTO mistake_clusters (kind, count, confidence, lesson, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(classified.kind, count, confidence, lessonFor(classified.kind, count), Date.now());
  }

  db.prepare('INSERT INTO learning_events (ts, kind, payload_json) VALUES (?, ?, ?)')
    .run(Date.now(), 'MISTAKE_DETECTED', JSON.stringify({ tradeId: trade.id, kind: classified.kind }));

  // a CLUSTER (not a single mistake) proposes a candidate lesson
  if (count === 3) {
    db.prepare(
      `INSERT INTO knowledge_lessons (title, statement, confidence, scope_json, status, validations, contradictions, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'CANDIDATE', 1, 0, ?, ?)`,
    ).run(
      `Recurring: ${classified.kind}`,
      lessonFor(classified.kind, count),
      confidence,
      JSON.stringify({ mistakeKind: classified.kind }),
      Date.now(), Date.now(),
    );
  }
  // repeated evidence -> locally evaluable candidate rule (never auto-champion)
  if (count === 5) {
    db.prepare(
      `INSERT INTO candidate_rules (condition_json, action, evidence_count, status, created_at)
       VALUES (?, ?, 5, 'CANDIDATE', ?)`,
    ).run(
      JSON.stringify({ mistakeKind: classified.kind, window: 'rolling-90d' }),
      'reduce signal confidence for matching contexts (requires validation before Champion)',
      Date.now(),
    );
  }
  return { recorded: true, kind: classified.kind };
}

function lessonFor(kind: MistakeKind, count: number): string {
  const base: Record<string, string> = {
    BAD_ENTRY: 'Entries taken without multi-factor confirmation lost money repeatedly — require a second confirmation (volume or event alignment) before entry.',
    BAD_EXIT: 'Exits fired too early relative to the original thesis horizon — honor the invalidation level instead of the first adverse wiggle.',
    FALSE_BREAKOUT: 'Breakouts without relative-volume confirmation failed repeatedly — demand relVol >= 1.2 on breakout entries.',
    NEWS_MISINTERPRETATION: 'Headline-driven entries misread the actual guidance implication — require event materiality >= 0.7 and independent corroboration.',
    FUNDAMENTAL_ERROR: 'Fundamental thesis used stale/incorrect data — verify latest filing before long-horizon entries.',
    REGIME_CHANGE: 'Signals taken against the prevailing regime failed — down-weight strategy weights when regime confidence is low.',
    VOLATILITY_SPIKE: 'Positions entered into volatility spikes suffered oversized adverse moves — halve size when 20d realized vol > 2x median.',
    EVENT_RISK: 'Holding through high-materiality events produced outsized losses — cap exposure within N days of scheduled binary events.',
    SOURCE_FAILURE: 'Decisions relied on a source that failed/duplicated — reweight source scores before reuse.',
    STALE_INFORMATION: 'Decisions used stale data — enforce freshness gates before entry.',
    BAD_POSITION_SIZING: 'Sizing exceeded risk limits — clamp notional to maxPositionPct and risk to riskPerTradePct.',
    OVERCONFIDENCE: 'High-confidence calls lost repeatedly — cap confidence at 0.75 until calibration catches up.',
    CORRELATION_ERROR: 'Clustered sector losses show hidden correlation — enforce maxCorrelatedPct across same-sector names.',
    MACRO_ERROR: 'Macro-driven losses: incorporate yield-curve/vix signals into regime part before entry.',
    TECHNICAL_SIGNAL_FAILURE: 'Technical entries failed at the trigger — require price AND volume confirmation.',
    UNKNOWN: 'Unclassified losing trade — review evidence manually before drawing conclusions.',
  };
  return `${base[kind] ?? base.UNKNOWN} (observed ${count}x)`;
}

/** Post-close consolidation: merge duplicates, calibrate confidence, expire stale lessons. */
export function consolidate(db: DatabaseSync, now = Date.now()): { merged: number; expired: number; validated: number } {
  let expired = 0;
  let validated = 0;

  // expire stale low-confidence candidates (>180 days, unvalidated)
  const stale = db
    .prepare(`SELECT id FROM knowledge_lessons WHERE status = 'CANDIDATE' AND validations <= 1 AND created_at < ?`)
    .all(now - 180 * 86400_000) as unknown as Array<{ id: number }>;
  for (const s of stale) {
    db.prepare(`UPDATE knowledge_lessons SET status = 'EXPIRED', updated_at = ? WHERE id = ?`).run(now, s.id);
    expired += 1;
  }

  // validated lessons gain confidence when their cluster keeps recurring
  const lessons = db.prepare(`SELECT id, confidence, scope_json FROM knowledge_lessons WHERE status IN ('CANDIDATE','VALIDATED')`).all() as unknown as Array<{
    id: number; confidence: number; scope_json: string;
  }>;
  for (const l of lessons) {
    const scope = JSON.parse(l.scope_json) as { mistakeKind?: string };
    if (!scope.mistakeKind) continue;
    const cluster = db.prepare('SELECT count FROM mistake_clusters WHERE kind = ?').get(scope.mistakeKind) as { count: number } | undefined;
    if (!cluster) continue;
    const target = Math.min(0.95, 0.3 + 0.1 * cluster.count);
    if (target > l.confidence + 0.05) {
      db.prepare(`UPDATE knowledge_lessons SET confidence = ?, status = 'VALIDATED', validations = validations + 1, updated_at = ? WHERE id = ?`)
        .run(target, now, l.id);
      validated += 1;
    }
  }

  // duplicate lesson merge (same statement text, keep the newer linked to the older)
  const dupes = db
    .prepare(
      `SELECT a.id AS aId, b.id AS bId FROM knowledge_lessons a
         JOIN knowledge_lessons b ON a.statement = b.statement AND a.id < b.id
        WHERE a.status != 'EXPIRED' AND b.status != 'EXPIRED'`,
    )
    .all() as unknown as Array<{ aId: number; bId: number }>;
  let merged = 0;
  for (const d of dupes) {
    db.prepare(`UPDATE knowledge_lessons SET status = 'EXPIRED', updated_at = ? WHERE id = ?`).run(now, d.bId);
    db.prepare('UPDATE knowledge_lessons SET validations = validations + 1, updated_at = ? WHERE id = ?').run(now, d.aId);
    merged += 1;
  }

  db.prepare('INSERT INTO learning_events (ts, kind, payload_json) VALUES (?, ?, ?)')
    .run(now, 'CONSOLIDATION', JSON.stringify({ merged, expired, validated }));
  return { merged, expired, validated };
}

export function lessonsForTicker(db: DatabaseSync, ticker: string, sector?: string): Array<Record<string, unknown>> {
  const rows = db
    .prepare(`SELECT * FROM knowledge_lessons WHERE status IN ('VALIDATED','CANDIDATE') ORDER BY confidence DESC, updated_at DESC LIMIT 50`)
    .all() as unknown as Array<Record<string, unknown>>;
  return rows.filter((r) => {
    const scope = JSON.parse(String(r.scope_json)) as { ticker?: string; sector?: string };
    return !scope.ticker || scope.ticker === ticker || (sector != null && scope.sector === sector);
  });
}
