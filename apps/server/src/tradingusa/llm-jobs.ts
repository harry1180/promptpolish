/**
 * Selective LLM reasoning jobs — the ONLY places in the server that end in
 * InferenceRouter.reason(). Each call is gated by the LLMValueRouter and
 * the daily quota/reserve budgets, and every call is recorded in the usage
 * ledger. With Groq+Gemini absent these jobs degrade to LOCAL_ONLY and the
 * trading loop continues.
 */
import type { DatabaseSync } from 'node:sqlite';
import { classifyMistake, normalizeHeadline, similarity } from '@promptslim/tucore';
import type { InferenceRouter, QualityTracker } from './inference/router.ts';

export interface LlmJobStats {
  considered: number;
  invoked: number;
  skipped: number;
  cacheHits: number;
  localOnly: number;
}

function localBaseAction(sentiment: number, materiality: number): 'BUY' | 'AVOID' | 'HOLD' {
  const s = sentiment * materiality;
  if (s >= 0.15) return 'BUY';
  if (s <= -0.15) return 'AVOID';
  return 'HOLD';
}

function parseAction(text: string | null): { action: 'BUY' | 'AVOID' | 'HOLD'; reasoning: string; confidence: number } | null {
  if (!text) return null;
  try {
    const m = /\{[\s\S]*\}/.exec(text);
    if (m) {
      const obj = JSON.parse(m[0]) as { action?: string; reasoning?: string; confidence?: number };
      const action = (obj.action ?? '').toUpperCase();
      if (action === 'BUY' || action === 'AVOID' || action === 'HOLD') {
        return {
          action,
          reasoning: String(obj.reasoning ?? '').slice(0, 600),
          confidence: typeof obj.confidence === 'number' ? Math.max(0, Math.min(1, obj.confidence)) : 0.6,
        };
      }
    }
  } catch {
    /* fall through to heuristic */
  }
  const lower = text.toLowerCase();
  if (lower.includes('material negative') || lower.includes('downside')) return { action: 'AVOID', reasoning: text.slice(0, 600), confidence: 0.55 };
  if (lower.includes('material positive') || lower.includes('upside')) return { action: 'BUY', reasoning: text.slice(0, 600), confidence: 0.55 };
  return { action: 'HOLD', reasoning: text.slice(0, 600), confidence: 0.5 };
}

/**
 * Interpret high-materiality NEW events (earnings, guidance, filings,
 * regulatory) with cloud reasoning, storing a BASE vs LLM-AUGMENTED
 * prediction pair for ablation measurement.
 */
export async function analyzeNewMaterialEvents(
  db: DatabaseSync,
  router: InferenceRouter,
  quality: QualityTracker,
  limit = 3,
): Promise<LlmJobStats> {
  const stats: LlmJobStats = { considered: 0, invoked: 0, skipped: 0, cacheHits: 0, localOnly: 0 };
  const rows = db
    .prepare(
      `SELECT id, ticker, type, headline, materiality, sentiment, confidence, payload_json, first_seen
         FROM events
        WHERE materiality >= 0.55 AND first_seen >= ?
          AND payload_json NOT LIKE '%"analyzed":true%'
        ORDER BY materiality DESC, first_seen DESC LIMIT ?`,
    )
    .all(Date.now() - 48 * 3600_000, limit) as unknown as Array<{
      id: number; ticker: string | null; type: string; headline: string;
      materiality: number; sentiment: number; confidence: number; payload_json: string; first_seen: number;
    }>;

  const isHighPriority = (type: string): boolean =>
    ['EARNINGS', 'GUIDANCE_CHANGE', 'GUIDANCE_REDUCTION', 'SEC_FILING', 'FDA', 'REGULATORY', 'MA'].includes(type);

  for (const ev of rows) {
    stats.considered += 1;
    const baseAction = localBaseAction(ev.sentiment, ev.materiality);
    const exposure = db
      .prepare(`SELECT COUNT(*) AS n FROM paper_positions WHERE ticker = ? AND exit_ts IS NULL`)
      .get(ev.ticker ?? '') as { n: number };
    const evaluated = quality.summary();
    const historicalBenefit = evaluated.evaluated > 0 ? evaluated.improved / evaluated.evaluated : 0.5;

    const task = ev.type === 'SEC_FILING' ? 'FILING_INTERPRETATION' : 'EVENT_INTERPRETATION';
    const response = await router.reason({
      task,
      priority: isHighPriority(ev.type) ? 'high' : 'routine',
      contentKey: `event:${ev.id}:${ev.headline.slice(0, 80)}`,
      system:
        'You are a cautious equity research analyst. You never give investment advice to individuals; you classify events for a paper-trading research system. Respond ONLY with JSON: {"action":"BUY"|"AVOID"|"HOLD","confidence":0.0-1.0,"reasoning":"<max 80 words>"}',
      prompt:
        `Event: ${ev.type}\nTicker: ${ev.ticker ?? 'MARKET'}\nHeadline: ${ev.headline}\n` +
        `Local sentiment: ${ev.sentiment.toFixed(2)}, materiality: ${ev.materiality.toFixed(2)}\n` +
        `Local baseline action: ${baseAction}\n` +
        `Question: is this event materially positive or negative for the ticker over the next 1-4 weeks, considering the description above only?`,
      longContext: false,
      value: {
        novelty: Math.max(0.2, 1 - (Date.now() - ev.first_seen) / (48 * 3600_000)),
        materiality: ev.materiality,
        portfolioExposure: exposure.n > 0 ? 0.8 : 0.3,
        strategyImportance: ev.materiality,
        modelDisagreement: 0.5,
        currentUncertainty: 1 - ev.confidence,
        historicalLlmBenefit: historicalBenefit,
        informationComplexity: ev.headline.length > 90 ? 0.7 : 0.4,
      },
    });

    if (response.mode === 'SKIPPED') { stats.skipped += 1; }
    else if (response.mode === 'CACHE') { stats.cacheHits += 1; stats.invoked += 1; }
    else if (response.mode === 'LOCAL_ONLY') { stats.localOnly += 1; }
    else if (response.ok && response.text) {
      stats.invoked += 1;
      const parsed = parseAction(response.text);
      quality.record({
        task, eventId: ev.id, signalId: null,
        baseAction, augmentedAction: parsed?.action ?? baseAction,
        baseConf: 0.5, augmentedConf: parsed?.confidence ?? 0.5,
        tokens: response.inputTokens + response.outputTokens, provider: response.provider,
      });
      db.prepare('UPDATE events SET payload_json = ? WHERE id = ?').run(
        JSON.stringify({
          ...(JSON.parse(ev.payload_json) as Record<string, unknown>),
          analyzed: true, analysisProvider: response.provider, analysisAction: parsed?.action ?? baseAction,
          analysisReasoning: parsed?.reasoning ?? '', analyzedAt: Date.now(),
        }),
        ev.id,
      );
    }
  }
  return stats;
}

/** Resolve pending ablation evaluations once signals have real outcomes. */
export function resolveAblation(db: DatabaseSync, quality: QualityTracker): number {
  const signals = db
    .prepare(
      `SELECT s.id, pr.actual_return FROM signals s
         JOIN prediction_results pr ON pr.signal_id = s.id
         JOIN llm_evaluations e ON e.event_id IS NOT NULL
        WHERE e.outcome = 'PENDING'`,
    )
    .all() as unknown as Array<{ id: number; actual_return: number }>;
  void signals;
  // map event -> signal via signal event refs, then resolve each evaluation
  const pending = db
    .prepare(`SELECT id, event_id FROM llm_evaluations WHERE outcome = 'PENDING' AND event_id IS NOT NULL`)
    .all() as unknown as Array<{ id: number; event_id: number }>;
  let resolved = 0;
  for (const p of pending) {
    const sig = db
      .prepare(
        `SELECT s.id, pr.actual_return FROM signals s
           JOIN prediction_results pr ON pr.signal_id = s.id
          WHERE s.event_refs_json LIKE ? LIMIT 1`,
      )
      .get(`%"id":${p.event_id}%`) as { id: number; actual_return: number } | undefined;
    if (!sig) continue;
    const before = db.prepare(`SELECT outcome FROM llm_evaluations WHERE id = ?`).get(p.id) as { outcome: string };
    quality.resolve(sig.id, sig.actual_return);
    const after = db.prepare(`SELECT outcome FROM llm_evaluations WHERE id = ?`).get(p.id) as { outcome: string };
    if (after.outcome !== before.outcome) resolved += 1;
  }
  return resolved;
}

/** Trade postmortems through cloud reasoning (routine, value-gated). */
export async function analyzePostmortems(db: DatabaseSync, router: InferenceRouter, limit = 2): Promise<number> {
  const rows = db
    .prepare(
      `SELECT m.id, m.ticker, m.kind, m.rationale, m.loss_pct, t.exit_reason, t.predicted_return, t.actual_return
         FROM mistakes m JOIN paper_trades t ON t.id = m.trade_id
        WHERE m.context_json NOT LIKE '%postmortem%' ORDER BY m.ts DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<Record<string, string | number>>;
  let invoked = 0;
  for (const row of rows) {
    const res = await router.reason({
      task: 'TRADE_POSTMORTEM',
      priority: 'routine',
      contentKey: `postmortem:${row.id}`,
      system: 'You are a trading postmortem reviewer for a paper-trading research system. Respond ONLY with JSON: {"action":"HOLD","confidence":0.0-1.0,"reasoning":"<max 60 words: what to change next time>"}',
      prompt:
        `Closed paper trade: ${row.ticker}, exit reason ${row.exit_reason}, predicted ${(row.predicted_return as number * 100).toFixed(1)}%, ` +
        `actual ${(row.actual_return as number * 100).toFixed(1)}%, mistake class ${row.kind}.\n` +
        `Local analysis: ${row.rationale}\nWhat should the system change to avoid repeating this?`,
      value: {
        novelty: 0.5, materiality: Math.min(1, Math.abs(Number(row.loss_pct)) * 10),
        portfolioExposure: 0.5, strategyImportance: 0.6, modelDisagreement: 0.4,
        currentUncertainty: 0.5, historicalLlmBenefit: 0.5, informationComplexity: 0.5,
      },
    });
    if (res.ok && res.text) {
      invoked += 1;
      const m = db.prepare('SELECT context_json FROM mistakes WHERE id = ?').get(row.id) as { context_json: string };
      const ctx = JSON.parse(m.context_json) as Record<string, unknown>;
      ctx.postmortem = parseAction(res.text)?.reasoning ?? res.text.slice(0, 400);
      ctx.postmortemProvider = res.provider;
      db.prepare('UPDATE mistakes SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), row.id);
    }
  }
  void classifyMistake;
  void normalizeHeadline;
  void similarity;
  return invoked;
}
