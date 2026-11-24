/**
 * TradingUSA HTTP surface. All GET (read-only) except POST /backtests
 * (rate-limited). Mounted in createApp at '/api/tradingusa/*' — served at
 * the edge under '/pp/api/tradingusa/*'.
 *
 * Security rules enforced here:
 *  - never emit secret material: provider statuses only, enums from
 *    tucore.ProviderStatus; response bodies are built from whitelisted
 *    fields, never from process.env;
 *  - executionMode is always PAPER_ONLY (from ExecutionGuard, not config);
 *  - signal records are immutable (DB trigger) — updates are impossible.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  atr, checkKillSwitch, etDate, maCross, position52w, relativeStrength,
  rsi, sessionKindAt, nextSession, FUSION_WEIGHTS,
} from '@promptslim/tucore';
import type { Horizon, ProviderStatus, Quote } from '@promptslim/tucore';
import type { TradingRuntime } from './runtime.ts';
import { computeRegime, latestQuote, loadBars, technicalSnapshot } from './engine.ts';
import { computePortfolioView, whatIfView } from './portfolio.ts';
import { openPositions } from './broker.ts';
import { tradableUniverse, universeEntry, UNIVERSE } from './universe.ts';
import { runBacktestJob, triggerBacktest } from './backtest.ts';
import { buildReport, reportRange } from './report.ts';
import { experimentSummary } from './experiments.ts';
import { computeCalibration, loadCalibration } from './calibration.ts';
import { calibratedReturn, calibratedWinRate } from '@promptslim/tucore';

export interface TuDeps {
  runtime: TradingRuntime;
  readBody: (req: IncomingMessage) => Promise<unknown>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
}

type Res = { status: number; body: unknown };

const SESSION_KEYS = new Set(['PREMARKET', 'MARKET_OPEN', 'POSTMARKET', 'MARKET_CLOSED', 'WEEKEND', 'HOLIDAY', 'EARLY_CLOSE']);

function sessionView(now = Date.now()): {
  session: string; date: string;
  nextSession: { date: string; openMs: number; closeMs: number; earlyClose: boolean };
} {
  const kind = sessionKindAt(now);
  const ns = nextSession(now);
  return { session: SESSION_KEYS.has(kind) ? kind : 'MARKET_CLOSED', date: etDate(now), nextSession: ns };
}

function signalRow(r: Record<string, unknown>): Record<string, unknown> {
  const status = r.status ?? 'ACTIVE';
  return {
    id: r.id, ticker: r.ticker, company: r.company, sector: r.sector, portfolio: r.portfolio,
    signal: r.signal, horizon: r.horizon, confidence: r.confidence, price: r.price,
    entryLow: r.entry_low, entryHigh: r.entry_high, target: r.target, invalidation: r.invalidation,
    expectedReturnPct: (r.expected_return as number) * 100, riskReward: r.risk_reward,
    strategy: r.strategy, createdAt: r.created_at, session: r.session, status,
    regime: r.regime, dataFreshness: r.data_freshness, signalDate: r.session_date,
  };
}

const backtestHits = new Map<string, number>();

export async function handleTradingusa(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: TuDeps,
): Promise<boolean> {
  const { runtime, json } = deps;
  const db = runtime.db;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const seg = path.split('/').filter(Boolean); // ['api','tradingusa', ...]
  if (seg.length < 2 || seg[0] !== 'api' || seg[1] !== 'tradingusa') return false;
  const rest = seg.slice(2);
  const now = Date.now();

  const done = (r: Res): true => { json(res, r.status, r.body); return true; };

  try {
    /* ---------------- status ---------------- */
    if (rest.length === 1 && rest[0] === 'status' && req.method === 'GET') {
      return done({ status: 200, body: statusBody(runtime) });
    }

    /* ---------------- overview ---------------- */
    if (rest.length === 1 && rest[0] === 'overview' && req.method === 'GET') {
      const regime = computeRegime(db);
      const indexes = indexesView(db);
      const breadthRow = db.prepare(
        `SELECT SUM(CASE WHEN price > prev_close THEN 1 ELSE 0 END) AS adv, SUM(CASE WHEN price <= prev_close THEN 1 ELSE 0 END) AS dec, MAX(ts) AS ts FROM market_quotes`,
      ).get() as { adv: number | null; dec: number | null; ts: number | null };
      const vix = db.prepare(`SELECT value FROM economic_data WHERE series = 'vix' ORDER BY date DESC LIMIT 1`).get() as { value: number } | undefined;

      const oppRows = db.prepare(
        `SELECT s.*, COALESCE(st.status, 'ACTIVE') AS status FROM signals s
           LEFT JOIN signal_status st ON st.signal_id = s.id
          WHERE s.signal IN ('BUY','SELL') ORDER BY s.confidence DESC, s.created_at DESC LIMIT 6`,
      ).all() as unknown as Array<Record<string, unknown>>;

      const events = db.prepare(
        'SELECT id, ticker, type, headline, materiality, sentiment, first_seen, sources, independent_sources FROM events ORDER BY first_seen DESC LIMIT 8',
      ).all() as unknown as Array<Record<string, unknown>>;

      const positions = openPositions(db);
      const stView = computePortfolioView(db, 'SHORT_TERM_PORTFOLIO');
      const ltView = computePortfolioView(db, 'LONG_TERM_PORTFOLIO');
      const whatIf = whatIfView(db);

      const riskAlerts: Array<{ ticker: string; alert: string; severity: string }> = [];
      for (const p of positions) {
        const price = p.current_price ?? p.entry_price;
        const distStop = ((price - p.stop) / price) * 100;
        const dd = ((price - p.entry_price) / p.entry_price) * 100;
        if (distStop < 1.5) riskAlerts.push({ ticker: p.ticker, alert: `within ${distStop.toFixed(1)}% of stop ${p.stop.toFixed(2)}`, severity: 'high' });
        if (dd < -5) riskAlerts.push({ ticker: p.ticker, alert: `open loss ${dd.toFixed(1)}%`, severity: 'medium' });
      }
      const staleQuotes = db.prepare('SELECT COUNT(*) AS n FROM market_quotes WHERE ts < ?').get(now - 45 * 60_000) as { n: number };
      if (staleQuotes.n > 0) riskAlerts.push({ ticker: 'MARKET', alert: `${staleQuotes.n} quotes stale >45m`, severity: 'medium' });

      const signalsToday = (db.prepare('SELECT COUNT(*) AS n FROM signals WHERE session_date = ?').get(etDate(now)) as { n: number }).n;
      const llmToday = (db.prepare(`SELECT COUNT(*) AS n FROM llm_usage WHERE day = ? AND invoked = 1`).get(etDate(now)) as { n: number }).n;
      const whatIfCard = whatIf.find((w) => w.portfolio === 'COMBINED_MASTER') ?? whatIf[0] ?? null;

      return done({
        status: 200,
        body: {
          banner: 'PAPER TRADING — NO REAL MONEY IS BEING USED',
          market: sessionView(now),
          regime,
          indexes,
          breadth: breadthRow.ts ? { advancers: breadthRow.adv ?? 0, decliners: breadthRow.dec ?? 0, asOf: breadthRow.ts } : null,
          volatility: { vix: vix?.value ?? null },
          opportunities: oppRows.map(signalRow),
          riskAlerts,
          events: events.map((e) => ({
            id: e.id, ticker: e.ticker, type: e.type, headline: e.headline,
            materiality: e.materiality, sentiment: e.sentiment, firstSeen: e.first_seen,
            sources: e.sources, independentSources: e.independent_sources,
          })),
          positions: {
            open: positions.length,
            exposurePct: stView && stView.equity > 0 ? ((stView.equity - stView.cash) / stView.equity) * 100 : 0,
          },
          pnl: {
            todayPct: (dailyReturnPct(db) * 100),
            totalPct: whatIfCard ? whatIfCard.tradingusaReturnPct : 0,
            equitySeries: stView ? stView.equitySeries.slice(-60) : [],
          },
          portfolios: [stView, ltView].filter(Boolean).map((v) => {
            const w = whatIf.find((x) => x.portfolio === v!.kind)!;
            return {
              kind: v!.kind, startCapital: v!.startCapital, equity: v!.equity,
              totalReturnPct: w.tradingusaReturnPct, trades: v!.metrics.trades,
              winRatePct: v!.metrics.winRate != null ? v!.metrics.winRate * 100 : null,
              maxDrawdownPct: v!.metrics.maxDrawdown * 100,
              benchmarkReturnPct: w.spyReturnPct, excessReturnPct: w.excessReturnPct,
            };
          }),
          signalsToday,
          llmCallsToday: llmToday,
          llmDependencyPct: llmDependencyPct(db, etDate(now)),
          whatIf: whatIfCard,
        },
      });
    }

    /* ---------------- daily report (date-range metrics) ---------------- */
    if (rest[0] === 'report' && req.method === 'GET') {
      const range = reportRange(url.searchParams.get('from'), url.searchParams.get('to'), now);
      if ('error' in range) return done({ status: 400, body: { errors: [range.error] } });
      return done({ status: 200, body: buildReport(db, range.from, range.to) });
    }

    /* ---------------- rule experiments (shadow mode, READ-ONLY) ---------------- */
    if (rest[0] === 'experiments' && req.method === 'GET') {
      const range = reportRange(url.searchParams.get('from'), url.searchParams.get('to'), now);
      if ('error' in range) return done({ status: 400, body: { errors: [range.error] } });
      // pure comparison over stored signals + outcomes; nothing here can
      // block or rewrite a trade (enforced by test tradingusa-experiments)
      return done({ status: 200, body: experimentSummary(db, range.from, range.to) });
    }

    /* ---------------- quotes ---------------- */
    if (rest[0] === 'quotes' && req.method === 'GET') {
      const symbols = (url.searchParams.get('symbols') ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
      const out: Quote[] = [];
      for (const s of symbols) {
        const q = latestQuote(db, s);
        if (q) out.push(q);
      }
      return done({ status: 200, body: { quotes: out, asOf: now } });
    }

    /* ---------------- market ---------------- */
    if (rest[0] === 'market' && req.method === 'GET') {
      const regime = computeRegime(db);
      const indexes = indexesView(db);
      const breadthRow = db.prepare(
        `SELECT SUM(CASE WHEN price > prev_close THEN 1 ELSE 0 END) AS adv, SUM(CASE WHEN price <= prev_close THEN 1 ELSE 0 END) AS dec, MAX(ts) AS ts FROM market_quotes`,
      ).get() as { adv: number | null; dec: number | null; ts: number | null };
      const vix = db.prepare(`SELECT value FROM economic_data WHERE series = 'vix' ORDER BY date DESC LIMIT 1`).get() as { value: number } | undefined;
      const yields = db.prepare(
        `SELECT date, MAX(CASE WHEN series='treasury_y2' THEN value END) AS y2,
                MAX(CASE WHEN series='treasury_y5' THEN value END) AS y5,
                MAX(CASE WHEN series='treasury_y10' THEN value END) AS y10,
                MAX(CASE WHEN series='treasury_y30' THEN value END) AS y30
           FROM economic_data WHERE series LIKE 'treasury%' GROUP BY date ORDER BY date DESC LIMIT 10`,
      ).all() as unknown as Array<{ date: string; y2: number | null; y5: number | null; y10: number | null; y30: number | null }>;
      const latest = yields[0] ?? null;
      const sectors = sectorPerformance(db);
      const holidays = upcomingHolidays();
      return done({
        status: 200,
        body: {
          market: sessionView(now), regime, indexes,
          breadth: breadthRow.ts ? { advancers: breadthRow.adv ?? 0, decliners: breadthRow.dec ?? 0, asOf: breadthRow.ts } : null,
          volatility: { vix: vix?.value ?? null },
          yields,
          curve: latest && latest.y2 != null && latest.y10 != null
            ? { spread10y2y: latest.y10 - latest.y2, asOf: latest.date }
            : null,
          sectorPerformance: sectors,
          sessions: {
            today: sessionView(now),
            next: nextSession(now),
            holidayUpcoming: holidays[0] ?? null,
          },
        },
      });
    }

    /* ---------------- signals ---------------- */
    if (rest[0] === 'signals' && rest.length === 1 && req.method === 'GET') {
      const where: string[] = [];
      const args: unknown[] = [];
      const portfolio = url.searchParams.get('portfolio');
      const signal = url.searchParams.get('signal');
      const strategy = url.searchParams.get('strategy');
      const horizon = url.searchParams.get('horizon');
      const confidenceMin = Number(url.searchParams.get('confidenceMin') ?? '0');
      if (portfolio) { where.push('s.portfolio = ?'); args.push(portfolio); }
      if (signal) { where.push('s.signal = ?'); args.push(signal); }
      if (strategy) { where.push('s.strategy = ?'); args.push(strategy); }
      if (horizon) { where.push('s.horizon = ?'); args.push(horizon); }
      if (Number.isFinite(confidenceMin) && confidenceMin > 0) { where.push('s.confidence >= ?'); args.push(confidenceMin); }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'));
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM signals s ${whereSql}`).get(...(args as never[])) as { n: number }).n;
      const rows = db
        .prepare(
          `SELECT s.*, COALESCE(st.status, 'ACTIVE') AS status FROM signals s
             LEFT JOIN signal_status st ON st.signal_id = s.id
             ${whereSql} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...(args as never[]), limit, offset) as unknown as Array<Record<string, unknown>>;
      return done({ status: 200, body: { total, signals: rows.map(signalRow) } });
    }

    if (rest[0] === 'signals' && rest.length === 2 && req.method === 'GET') {
      const id = Number(rest[1]);
      const row = db
        .prepare(`SELECT s.*, COALESCE(st.status, 'ACTIVE') AS status FROM signals s LEFT JOIN signal_status st ON st.signal_id = s.id WHERE s.id = ?`)
        .get(id) as Record<string, unknown> | undefined;
      if (!row) return done({ status: 404, body: { errors: ['signal not found'] } });

      const eventRefs = JSON.parse(String(row.event_refs_json ?? '[]')) as Array<{ id: number }>;
      let llm: { used: boolean; provider: string | null; task: string | null; summary: string | null } = {
        used: false, provider: null, task: null, summary: null,
      };
      for (const ref of eventRefs) {
        const ev = db.prepare('SELECT payload_json FROM events WHERE id = ?').get(ref.id) as { payload_json: string } | undefined;
        if (!ev) continue;
        const payload = JSON.parse(ev.payload_json) as { analyzed?: boolean; analysisProvider?: string; analysisAction?: string; analysisReasoning?: string };
        if (payload.analyzed) {
          llm = {
            used: true, provider: payload.analysisProvider ?? null, task: 'EVENT_INTERPRETATION',
            summary: `${payload.analysisAction ?? ''}: ${payload.analysisReasoning ?? ''}`.trim(),
          };
          break;
        }
      }

      return done({
        status: 200,
        body: {
          ...signalRow(row),
          scores: JSON.parse(String(row.scores_json ?? '{}')),
          evidence: JSON.parse(String(row.evidence_json ?? '[]')),
          contradictions: JSON.parse(String(row.contradictions_json ?? '[]')),
          strategyVersion: row.strategy_version, modelVersion: row.model_version,
          marketSession: row.session, regime: row.regime, dataFreshness: row.data_freshness,
          expectedHold: row.expected_hold, maxHold: row.max_hold,
          knowledgeRefs: JSON.parse(String(row.knowledge_refs_json ?? '[]')),
          eventRefs,
          llm,
          audit: JSON.parse(String(row.audit_json ?? '{}')),
          riskChecks: JSON.parse(String(row.risk_checks_json ?? '[]')),
          immutable: true,
        },
      });
    }

    /* ---------------- scanner ---------------- */
    if (rest[0] === 'scanner' && req.method === 'GET') {
      return done({ status: 200, body: scannerBody(db, now) });
    }

    /* ---------------- stock detail ---------------- */
    if (rest[0] === 'stocks' && rest.length === 2 && req.method === 'GET') {
      const ticker = rest[1].toUpperCase();
      const entry = universeEntry(ticker);
      if (!entry) return done({ status: 404, body: { errors: ['unknown ticker'] } });
      return done({ status: 200, body: stockBody(db, ticker, now) });
    }

    if (rest[0] === 'stocks' && rest.length === 3 && rest[2] === 'chart' && req.method === 'GET') {
      const ticker = rest[1].toUpperCase();
      const range = url.searchParams.get('range') ?? '1y';
      const days = range === '6mo' ? 126 : range === '3mo' ? 63 : range === '1mo' ? 22 : 252;
      const bars = loadBars(db, ticker, days);
      return done({ status: 200, body: { candles: bars, range } });
    }

    /* ---------------- events ---------------- */
    if (rest[0] === 'events' && req.method === 'GET') {
      const ticker = url.searchParams.get('ticker')?.toUpperCase();
      const type = url.searchParams.get('type');
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
      const where: string[] = [];
      const args: unknown[] = [];
      if (ticker) { where.push('ticker = ?'); args.push(ticker); }
      if (type) { where.push('type = ?'); args.push(type); }
      const rows = db
        .prepare(
          `SELECT id, ticker, type, headline, materiality, sentiment, confidence, first_seen, last_updated,
                  sources, independent_sources, expected_horizon, payload_json
             FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
            ORDER BY first_seen DESC LIMIT ?`,
        )
        .all(...(args as never[]), limit) as unknown as Array<Record<string, unknown>>;
      return done({
        status: 200,
        body: {
          events: rows.map((e) => {
            const payload = JSON.parse(String(e.payload_json ?? '{}')) as Record<string, unknown>;
            return {
              id: e.id, ticker: e.ticker, type: e.type, headline: e.headline,
              materiality: e.materiality, sentiment: e.sentiment, confidence: e.confidence,
              firstSeen: e.first_seen, lastUpdated: e.last_updated, sources: e.sources,
              independentSources: e.independent_sources, expectedHorizon: e.expected_horizon,
              analysis: payload.analysisReasoning ? { provider: payload.analysisProvider, action: payload.analysisAction, reasoning: payload.analysisReasoning } : null,
            };
          }),
        },
      });
    }

    /* ---------------- portfolios / positions / trades ---------------- */
    if (rest[0] === 'portfolios' && req.method === 'GET') {
      const st = computePortfolioView(db, 'SHORT_TERM_PORTFOLIO');
      const lt = computePortfolioView(db, 'LONG_TERM_PORTFOLIO');
      return done({
        status: 200,
        body: { portfolios: [st, lt].filter(Boolean), whatIf: whatIfView(db) },
      });
    }

    if (rest[0] === 'positions' && req.method === 'GET') {
      const portfolio = url.searchParams.get('portfolio');
      const positions = openPositions(db, portfolio ?? undefined);
      return done({ status: 200, body: { positions: positions.map((p) => positionView(p as unknown as Record<string, unknown>)) } });
    }

    if (rest[0] === 'trades' && req.method === 'GET') {
      const portfolio = url.searchParams.get('portfolio');
      const status = url.searchParams.get('status');
      const where: string[] = [];
      const args: unknown[] = [];
      if (portfolio) { where.push('portfolio = ?'); args.push(portfolio); }
      if (status === 'closed') where.push('exit_ts IS NOT NULL');
      const rows = db
        .prepare(
          `SELECT * FROM paper_trades ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(exit_ts, entry_ts) DESC LIMIT 200`,
        )
        .all(...(args as never[])) as unknown as Array<Record<string, unknown>>;
      const openCount = openPositions(db, portfolio ?? undefined).length;
      return done({
        status: 200,
        body: {
          trades: rows.map(tradeView),
          counts: { open: openCount, closed: rows.filter((r) => r.exit_ts != null).length },
        },
      });
    }

    /* ---------------- strategies ---------------- */
    if (rest[0] === 'strategies' && req.method === 'GET') {
      return done({ status: 200, body: strategiesBody(db) });
    }

    /* ---------------- research ---------------- */
    if (rest[0] === 'research' && req.method === 'GET') {
      const items: Array<Record<string, unknown>> = [];
      const evs = db.prepare('SELECT id, ticker, type, headline, materiality, sentiment, first_seen FROM events ORDER BY first_seen DESC LIMIT 50').all() as unknown as Array<Record<string, unknown>>;
      for (const e of evs) {
        items.push({
          id: `E${e.id}`, kind: 'EVENT', ticker: e.ticker, title: e.headline, ts: e.first_seen,
          source: 'event-pipeline', url: null, materiality: e.materiality, sentiment: e.sentiment, subkind: e.type,
        });
      }
      const docs = db.prepare(`SELECT id, url, title, doc_type, fetched_at, tickers_json FROM source_documents WHERE doc_type = 'filing' ORDER BY fetched_at DESC LIMIT 30`).all() as unknown as Array<Record<string, unknown>>;
      for (const d of docs) {
        const tickers = JSON.parse(String(d.tickers_json ?? '[]')) as string[];
        items.push({
          id: `D${d.id}`, kind: 'FILING', ticker: tickers[0] ?? null, title: d.title, ts: d.fetched_at,
          source: 'sec.gov', url: d.url, materiality: 0.5, sentiment: 0, subkind: 'filing',
        });
      }
      items.sort((a, b) => Number(b.ts) - Number(a.ts));
      const sourcesToday = (db.prepare('SELECT COUNT(*) AS n FROM source_documents WHERE fetched_at >= ?').get(now - 86400_000) as { n: number }).n;
      return done({ status: 200, body: { items: items.slice(0, 80), sourcesToday } });
    }

    /* ---------------- sources ---------------- */
    if (rest[0] === 'sources' && req.method === 'GET') {
      const rows = db
        .prepare(
          `SELECT domain, url, category, retrieval_method, reliability, freshness_score, latency_ms,
                  failure_rate, duplicate_rate, predictive_contribution, documents, last_checked,
                  policy_status, check_count, fail_count FROM sources ORDER BY documents DESC, domain`,
        )
        .all() as unknown as Array<Record<string, unknown>>;
      return done({
        status: 200,
        body: {
          sources: rows.map((r) => ({
            domain: r.domain, url: r.url, category: r.category, retrievalMethod: r.retrieval_method,
            reliability: r.reliability, freshnessScore: r.freshness_score, latencyMs: r.latency_ms,
            failureRatePct: Number(r.check_count) > 0 ? Math.round((Number(r.fail_count) / Number(r.check_count)) * 1000) / 10 : 0,
            duplicateRatePct: Math.round(Number(r.duplicate_rate) * 1000) / 10,
            predictiveContribution: r.predictive_contribution, documents: r.documents,
            lastChecked: r.last_checked, policyStatus: r.policy_status,
          })),
        },
      });
    }

    /* ---------------- learning ---------------- */
    if (rest[0] === 'learning' && req.method === 'GET') {
      const mistakes = db.prepare('SELECT * FROM mistakes ORDER BY ts DESC LIMIT 50').all() as unknown as Array<Record<string, unknown>>;
      const clusters = db.prepare('SELECT * FROM mistake_clusters ORDER BY count DESC').all() as unknown as Array<Record<string, unknown>>;
      const lessons = db.prepare('SELECT * FROM knowledge_lessons ORDER BY confidence DESC, updated_at DESC LIMIT 50').all() as unknown as Array<Record<string, unknown>>;
      const rules = db.prepare('SELECT * FROM candidate_rules ORDER BY created_at DESC LIMIT 20').all() as unknown as Array<Record<string, unknown>>;
      const weightRows = db
        .prepare('SELECT strategy, horizon, weights_json, updated_at FROM strategy_weights ORDER BY strategy')
        .all() as unknown as Array<{ strategy: string; horizon: string; weights_json: string; updated_at: number }>;
      const n = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
      return done({
        status: 200,
        body: {
          stats: {
            mistakesDetected: n('SELECT COUNT(*) AS c FROM mistakes'),
            lessonsProposed: n(`SELECT COUNT(*) AS c FROM knowledge_lessons`),
            lessonsValidated: n(`SELECT COUNT(*) AS c FROM knowledge_lessons WHERE status = 'VALIDATED'`),
            lessonsRejected: n(`SELECT COUNT(*) AS c FROM knowledge_lessons WHERE status IN ('REJECTED','EXPIRED')`),
            clusters: n('SELECT COUNT(*) AS c FROM mistake_clusters'),
            challengerRules: n('SELECT COUNT(*) AS c FROM candidate_rules'),
          },
          mistakes: mistakes.map((m) => ({
            id: m.id, tradeId: m.trade_id, ticker: m.ticker, kind: m.kind, confidence: m.confidence,
            rationale: m.rationale, ts: m.ts, lossPct: Number(m.loss_pct) * 100, status: m.status,
            context: JSON.parse(String(m.context_json ?? '{}')),
          })),
          clusters: clusters.map((c) => ({ id: c.id, kind: c.kind, count: c.count, confidence: c.confidence, lesson: c.lesson })),
          lessons: lessons.map((l) => ({
            id: l.id, title: l.title, statement: l.statement, confidence: l.confidence,
            scope: JSON.parse(String(l.scope_json ?? '{}')), status: l.status,
            validations: l.validations, contradictions: l.contradictions, createdAt: l.created_at,
          })),
          ruleExtraction: rules.map((r) => ({
            id: r.id, condition: JSON.parse(String(r.condition_json ?? '{}')), action: r.action,
            evidenceCount: r.evidence_count, status: r.status,
          })),
          // learned fusion weights: what runScan is ACTUALLY using right now
          // (adaptive.ts), next to the shipped defaults it moved away from
          fusionWeights: weightRows.map((w) => {
            const parsed = JSON.parse(String(w.weights_json ?? '{}')) as {
              weights?: Record<string, number>; trades?: number; updatedAt?: number;
            };
            return {
              strategy: w.strategy, horizon: w.horizon,
              trades: parsed.trades ?? null, updatedAt: parsed.updatedAt ?? w.updated_at,
              weights: parsed.weights ?? {},
              defaults: FUSION_WEIGHTS[w.horizon as Horizon] ?? FUSION_WEIGHTS.SHORT,
            };
          }),
        },
      });
    }

    /* ---------------- outcome calibration (SHADOW, read-only) ---------------- */
    if (rest[0] === 'calibration' && req.method === 'GET') {
      const cal = computeCalibration(db, now);
      const stored = loadCalibration(db);
      const pct = (v: number): number => Math.round(v * 1000) / 10;
      return done({
        status: 200,
        body: {
          mode: 'SHADOW',
          note: 'Calibrated from this book\'s own closed trades (60-session half-life). Recorded on every signal; it never gates, filters or sizes a trade.',
          sufficient: cal.sufficient,
          samples: cal.n,
          effectiveSamples: Math.round(cal.effectiveN * 10) / 10,
          halfLifeDays: cal.halfLifeDays,
          prior: { winRatePct: pct(cal.priorWinRate), meanReturnPct: pct(cal.priorMeanReturn) },
          buckets: cal.buckets.map((b) => ({
            from: b.lo, to: b.hi, samples: b.n,
            winRatePct: pct(b.winRate), meanReturnPct: pct(b.meanReturn), sePct: pct(b.se),
          })),
          returnModel: {
            slope: Number(cal.returnModel.slope.toFixed(4)),
            interceptPct: pct(cal.returnModel.intercept),
            r: Number(cal.returnModel.r.toFixed(4)),
            meanPredictedPct: pct(cal.returnModel.meanPredicted),
            meanActualPct: pct(cal.returnModel.meanActual),
          },
          mapping: [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9].map((c) => ({
            confidence: c,
            calibratedWinRatePct: pct(calibratedWinRate(cal, c)),
            calibratedReturnPct: pct(calibratedReturn(cal, c)),
          })),
          storedAt: stored?.updatedAt ?? null,
        },
      });
    }

    /* ---------------- backtests ---------------- */
    if (rest[0] === 'backtests' && req.method === 'GET') {
      const rows = db.prepare('SELECT * FROM backtest_runs ORDER BY created_at DESC LIMIT 20').all() as unknown as Array<Record<string, unknown>>;
      return done({
        status: 200,
        body: {
          runs: rows.map((r) => {
            const result = r.result_json ? (JSON.parse(String(r.result_json)) as Record<string, unknown>) : {};
            return {
              id: r.id, strategy: r.strategy, startDate: r.start_date, endDate: r.end_date,
              status: r.status, createdAt: r.created_at, violations: r.violations,
              totalReturnPct: result.totalReturn != null ? (result.totalReturn as number) * 100 : null,
              benchmarkReturnPct: result.benchmarkReturn != null ? (result.benchmarkReturn as number) * 100 : null,
              excessReturnPct: result.excessReturn != null ? (result.excessReturn as number) * 100 : null,
              maxDrawdownPct: result.maxDrawdown != null ? (result.maxDrawdown as number) * 100 : null,
              winRatePct: result.winRate != null ? (result.winRate as number) * 100 : null,
              trades: Array.isArray(result.trades) ? result.trades.length : 0,
              folds: result.folds ?? [],
              error: result.error ?? null,
            };
          }),
        },
      });
    }

    if (rest[0] === 'backtests' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '?';
      const windowStart = backtestHits.get(ip);
      if (windowStart && now - windowStart < 60_000) {
        return done({ status: 429, body: { errors: ['rate limited — one backtest trigger per minute'] } });
      }
      const body = (await deps.readBody(req)) as { strategy?: string; startDate?: string; endDate?: string };
      const strategy = body.strategy === 'LONG_TERM' ? 'LONG_TERM' : 'SHORT_TERM';
      const result = triggerBacktest(db, strategy, String(body.startDate ?? ''), String(body.endDate ?? ''));
      if ('error' in result) return done({ status: 400, body: { errors: [result.error] } });
      backtestHits.set(ip, now);
      void runBacktestJob(db, result.runId); // async; poll GET for status
      return done({ status: 201, body: { runId: result.runId } });
    }

    /* ---------------- AI (provider health + usage; NEVER secrets) ---------------- */
    if (rest[0] === 'ai' && req.method === 'GET') {
      return done({ status: 200, body: aiBody(db, runtime, now) });
    }

    /* ---------------- system ---------------- */
    if (rest[0] === 'system' && req.method === 'GET') {
      return done({ status: 200, body: systemBody(db, runtime, now) });
    }

    /* ---------------- settings ---------------- */
    if (rest[0] === 'settings' && req.method === 'GET') {
      const config = runtime.config;
      return done({
        status: 200,
        body: {
          config: {
            shortTermCapital: config.shortCapital, longTermCapital: config.longCapital,
            riskPerTradePct: config.riskPerTradePct, maxPositionPct: config.maxPositionPct,
            maxSectorPct: config.maxSectorPct, maxCorrelatedPct: config.maxCorrelatedPct,
            minRiskReward: config.minRiskReward, fillMode: config.fillMode,
            pilotMode: config.pilotMode, limits: config.limits,
            universe: UNIVERSE.map((u) => ({ ticker: u.ticker, company: u.company, sector: u.sector, tradable: u.tradable })),
          },
          locked: {
            executionMode: runtime.guard.mode,
            realMoneyEnabled: false,
            brokerAdapters: runtime.guard.listAdapters(),
            note: 'RobinhoodAdapter: interface prepared only — NOT implemented, NOT registered, NOT active.',
          },
        },
      });
    }

    /* ---------------- reviews ---------------- */
    if (rest[0] === 'reViews'.toLowerCase() && req.method === 'GET') {
      const daily = db.prepare('SELECT date, payload_json, created_at FROM daily_reviews ORDER BY date DESC LIMIT 14').all() as unknown as Array<Record<string, unknown>>;
      const weekly = db.prepare('SELECT label, payload_json, created_at FROM weekly_reviews ORDER BY created_at DESC LIMIT 6').all() as unknown as Array<Record<string, unknown>>;
      return done({
        status: 200,
        body: {
          daily: daily.map((d) => JSON.parse(String(d.payload_json))),
          weekly: weekly.map((w) => JSON.parse(String(w.payload_json))),
        },
      });
    }

    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'internal error';
    json(res, 500, { errors: [msg] });
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* body builders                                                       */
/* ------------------------------------------------------------------ */

export function statusBody(runtime: TradingRuntime): Record<string, unknown> {
  const db = runtime.db;
  const now = Date.now();
  const marketData = runtime.provider;
  const jobs = runtime.scheduler.jobRows();
  return {
    mode: runtime.guard.mode,
    pilotMode: runtime.config.pilotMode,
    executionGuard: runtime.guard.status(),
    now,
    timezone: 'America/New_York',
    market: sessionView(now),
    providers: {
      marketData: (() => {
        // Provenance from the freshest stored quote: Alpaca snapshots are
        // REALTIME, the Nasdaq/Yahoo path stays DELAYED. Name shows who is
        // actually serving data right now, not just the nominal primary.
        const latest = db
          .prepare('SELECT provider, freshness FROM market_quotes ORDER BY ts DESC LIMIT 1')
          .get() as { provider: string; freshness: string } | undefined;
        return {
          name: latest?.provider ?? marketData.name,
          status: marketData.status(),
          freshness: latest?.freshness ?? 'DELAYED',
          lastUpdate: marketData.lastUpdate(), latencyMs: marketData.lastLatencyMs(),
          lastError: marketData.lastError(),
        };
      })(),
      news: { name: runtime.news.name, status: runtime.news.status() },
      sec: { name: runtime.sec.name, status: runtime.sec.status() },
      macro: { name: runtime.macro.name, status: runtime.macro.status() },
    },
    jobs,
    workers: { enabled: runtime.config.workers, startedAt: runtime.scheduler.started(), ticks: runtime.scheduler.ticks() },
    llm: { groq: runtime.router.health().find((h) => h.name === 'groq')?.status, gemini: runtime.router.health().find((h) => h.name === 'gemini')?.status, mode: runtime.router.mode() },
    tables: db ? 'tradingusa' : 'tradingusa',
  };
}

/** Index quotes: live quotes when the session polls them, otherwise the most
 *  recent daily bars — a weekend dashboard must still show the market. */
function indexesView(db: DatabaseSync): Array<Record<string, unknown>> {
  const quotes = db.prepare(
    `SELECT symbol, price, prev_close, ts, provider, freshness FROM market_quotes WHERE symbol IN ('SPY','QQQ','DIA')`,
  ).all() as unknown as Array<Record<string, unknown>>;
  if (quotes.length > 0) {
    return quotes.map((q) => ({
      symbol: q.symbol, price: q.price, prevClose: q.prev_close,
      changePct: Number(q.prev_close) > 0 ? ((Number(q.price) - Number(q.prev_close)) / Number(q.prev_close)) * 100 : 0,
      ts: q.ts, freshness: q.freshness, provider: q.provider,
    }));
  }
  const out: Array<Record<string, unknown>> = [];
  for (const sym of ['SPY', 'QQQ', 'DIA']) {
    const bars = loadBars(db, sym, 2);
    if (bars.length === 0) continue;
    const last = bars[bars.length - 1];
    const prev = bars.length > 1 ? bars[bars.length - 2] : last;
    out.push({
      symbol: sym, price: last.close, prevClose: prev.close,
      changePct: prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0,
      ts: Date.parse(`${last.date}T21:00:00Z`), freshness: 'EOD', provider: 'bars',
    });
  }
  return out;
}

/** LLM dependency %: share of today's signals whose evidence chain included
 *  cloud reasoning — NOT raw call counts (calls can exceed signals). */
function llmDependencyPct(db: DatabaseSync, day: string): number {
  const sigs = db.prepare('SELECT event_refs_json FROM signals WHERE session_date = ?').all(day) as unknown as Array<{ event_refs_json: string }>;
  if (sigs.length === 0) return 0;
  let analyzed = 0;
  for (const s of sigs) {
    const refs = JSON.parse(s.event_refs_json || '[]') as Array<{ id: number }>;
    const hit = refs.some((r) => {
      const row = db.prepare(`SELECT payload_json FROM events WHERE id = ?`).get(r.id) as { payload_json: string } | undefined;
      if (!row) return false;
      const p = JSON.parse(row.payload_json) as { analyzed?: boolean };
      return p.analyzed === true;
    });
    if (hit) analyzed += 1;
  }
  return Math.round((analyzed / sigs.length) * 1000) / 10;
}

function dailyReturnPct(db: DatabaseSync): number {
  const rows = db.prepare('SELECT portfolio, ts, equity FROM portfolio_snapshots ORDER BY portfolio, ts').all() as unknown as Array<{ portfolio: string; ts: number; equity: number }>;
  const today = etDate(Date.now());
  let sum = 0;
  let n = 0;
  for (const kind of ['SHORT_TERM_PORTFOLIO', 'LONG_TERM_PORTFOLIO']) {
    const series = rows.filter((r) => r.portfolio === kind);
    const todayIdx = series.findIndex((r) => etDate(r.ts) === today);
    if (todayIdx > 0) {
      const prev = series[todayIdx - 1].equity;
      if (prev > 0) { sum += (series[todayIdx].equity - prev) / prev; n += 1; }
    }
  }
  return n > 0 ? sum / n : 0;
}

function sectorPerformance(db: DatabaseSync): Array<{ sector: string; ret20dPct: number | null }> {
  const rows = tradableUniverse();
  return rows
    .map((u) => {
      const bars = loadBars(db, u.ticker);
      if (bars.length < 21) return { sector: u.sector, ret20dPct: null };
      const ret = (bars[bars.length - 1].close - bars[bars.length - 21].close) / bars[bars.length - 21].close;
      return { sector: u.sector, ret20dPct: ret * 100 };
    })
    .reduce<Array<{ sector: string; ret20dPct: number | null }>>((acc, row) => {
      const found = acc.find((a) => a.sector === row.sector);
      if (found && row.ret20dPct != null && found.ret20dPct != null) {
        found.ret20dPct = (found.ret20dPct + row.ret20dPct) / 2;
      } else if (!found) {
        acc.push({ ...row });
      }
      return acc;
    }, []);
}

function upcomingHolidays(): Array<{ date: string; name: string }> {
  const known: Array<[string, string]> = [
    ['2026-11-26', 'Thanksgiving Day'], ['2026-11-27', 'Early close 13:00'], ['2026-12-24', 'Christmas Eve early close'],
    ['2026-12-25', 'Christmas Day'], ['2027-01-01', "New Year's Day"], ['2027-01-18', 'MLK Day'],
    ['2027-02-15', 'Presidents Day'], ['2027-03-26', 'Good Friday'], ['2027-05-31', 'Memorial Day'],
  ];
  const today = etDate(Date.now());
  return known
    .filter(([d]) => d >= today)
    .slice(0, 3)
    .map(([date, name]) => ({ date, name }));
}

function positionView(p: Record<string, unknown>): Record<string, unknown> {
  const entry = Number(p.entry_price);
  const price = Number(p.current_price ?? entry);
  const target = Number(p.target);
  const stop = Number(p.stop);
  const qty = Number(p.qty);
  return {
    id: p.id, portfolio: p.portfolio, ticker: p.ticker, company: p.company, qty,
    entryPrice: entry, entryTs: p.entry_ts, currentPrice: price,
    unrealizedPnl: qty * (price - entry),
    returnPct: entry > 0 ? ((price - entry) / entry) * 100 : 0,
    target, stop,
    distanceToTargetPct: price > 0 ? ((target - price) / price) * 100 : 0,
    distanceToStopPct: price > 0 ? ((price - stop) / price) * 100 : 0,
    daysHeld: Math.floor((Date.now() - Number(p.entry_ts)) / 86400_000),
    sessionsHeld: p.sessions_held,
    maxFavorableExcursion: Number(p.mfe) * 100,
    maxAdverseExcursion: Number(p.mae) * 100,
    thesisStatus: p.thesis_status,
    predictedReturnPct: Number(p.predicted_return) * 100,
    signalId: p.signal_id,
  };
}

function tradeView(t: Record<string, unknown>): Record<string, unknown> {
  const num = (v: unknown): number => (v == null ? 0 : Number(v));
  return {
    id: t.id, portfolio: t.portfolio, ticker: t.ticker, company: t.company, sector: t.sector,
    qty: t.qty, entryPrice: t.entry_price, entryTs: t.entry_ts,
    exitPrice: t.exit_price, exitTs: t.exit_ts, exitReason: t.exit_reason,
    grossPnl: t.gross_pnl, netPnl: t.net_pnl,
    returnPct: num(t.return_pct) * 100,
    predictedReturnPct: num(t.predicted_return) * 100,
    actualReturnPct: num(t.actual_return) * 100,
    predictionErrorPct: num(t.prediction_error) * 100,
    benchmarkReturnPct: num(t.benchmark_return) * 100,
    excessReturnPct: num(t.excess_return) * 100,
    holdingSessions: t.holding_sessions,
    mfe: num(t.mfe) * 100, mae: num(t.mae) * 100,
    strategy: t.strategy, strategyVersion: t.strategy_version, status: t.status,
    capital: t.capital,
  };
}

function scannerBody(db: DatabaseSync, now: number): Record<string, unknown> {
  const rows = db.prepare(
    `SELECT s.*, COALESCE(st.status, 'ACTIVE') AS status FROM signals s
       LEFT JOIN signal_status st ON st.signal_id = s.id
      ORDER BY s.confidence DESC`,
  ).all() as unknown as Array<Record<string, unknown>>;
  const byTicker = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const list = byTicker.get(String(r.ticker)) ?? [];
    list.push(r);
    byTicker.set(String(r.ticker), list);
  }
  const quoteOf = (t: string): { price: number; change: number } => {
    const q = latestQuote(db, t);
    if (q) return { price: q.price, change: q.prevClose > 0 ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0 };
    const bars = loadBars(db, t, 2);
    const price = bars[bars.length - 1]?.close ?? 0;
    const prev = bars[bars.length - 2]?.close ?? price;
    return { price, change: prev > 0 ? ((price - prev) / prev) * 100 : 0 };
  };
  const item = (ticker: string, score: number, reason: string): Record<string, unknown> => {
    const e = universeEntry(ticker);
    const q = quoteOf(ticker);
    return { ticker, company: e?.company ?? ticker, price: q.price, changePct: q.change, score, reason };
  };

  const buys = rows.filter((r) => r.signal === 'BUY' && r.horizon === 'SHORT');
  const ltBuys = rows.filter((r) => r.signal === 'BUY' && r.horizon === 'LONG');
  const sells = rows.filter((r) => r.signal === 'SELL');
  const breakoutSignals = rows.filter((r) => String(r.evidence_json).toLowerCase().includes('breakout'));
  const postEarnings = rows.filter((r) => String(r.evidence_json).toLowerCase().includes('earnings'));

  const categories = [
    {
      key: 'highest_conviction', label: 'Highest Conviction',
      note: 'Highest fused confidence — scanner inclusion is NOT a trade.',
      items: [...buys].sort((a, b) => Number(b.confidence) - Number(a.confidence)).slice(0, 8)
        .map((r) => item(String(r.ticker), Number(r.confidence), `${r.signal} ${r.horizon} @ ${r.strategy}`)),
    },
    {
      key: 'new_momentum', label: 'New Momentum',
      note: 'Fresh SHORT-horizon momentum signals (last 3 sessions).',
      items: buys.filter((r) => now - Number(r.created_at) < 3 * 86400_000).slice(0, 8)
        .map((r) => item(String(r.ticker), Number(r.confidence), 'new momentum signal')),
    },
    {
      key: 'breakouts', label: 'Breakout Candidates',
      note: 'Signals citing breakout evidence; requires volume confirmation.',
      items: breakoutSignals.slice(0, 8).map((r) => item(String(r.ticker), Number(r.confidence), 'breakout evidence in signal')),
    },
    {
      key: 'post_earnings', label: 'Post-Earnings Opportunities',
      note: 'Signals with earnings-related evidence.',
      items: postEarnings.slice(0, 8).map((r) => item(String(r.ticker), Number(r.confidence), 'earnings-related evidence')),
    },
    {
      key: 'fundamental_improvement', label: 'Fundamental Improvement',
      note: 'LONG-horizon signals from the quality/growth strategy.',
      items: ltBuys.slice(0, 8).map((r) => item(String(r.ticker), Number(r.confidence), `fundamental ${r.strategy}`)),
    },
    {
      key: 'quality_value', label: 'Quality at Attractive Valuation',
      note: 'Long-horizon value-leaning candidates.',
      items: ltBuys.filter((r) => String(r.evidence_json).toLowerCase().includes('valuation')).slice(0, 8)
        .map((r) => item(String(r.ticker), Number(r.confidence), 'valuation evidence')),
    },
    {
      key: 'oversold_quality', label: 'Oversold Quality',
      note: 'Mean-reversion candidates — capped at WATCH unless multi-factor confirms.',
      items: rows.filter((r) => String(r.evidence_json).toLowerCase().includes('oversold')).slice(0, 8)
        .map((r) => item(String(r.ticker), Number(r.confidence), 'oversold evidence')),
    },
    {
      key: 'deterioration', label: 'Negative Deterioration',
      note: 'SELL / EXIT signals — risk-reduction candidates.',
      items: sells.slice(0, 8).map((r) => item(String(r.ticker), Number(r.confidence), `${r.signal} signal`)),
    },
    {
      key: 'risk_alerts', label: 'Risk Alerts',
      note: 'Positions near stops or with open losses.',
      items: openPositions(db).flatMap((p) => {
        const price = p.current_price ?? p.entry_price;
        const distStop = ((price - p.stop) / price) * 100;
        const dd = ((price - p.entry_price) / p.entry_price) * 100;
        if (distStop < 2 || dd < -0.05) return [item(p.ticker, Math.max(0, 1 - distStop / 10), `stop ${distStop.toFixed(1)}% away, P&L ${dd.toFixed(1)}%`)];
        return [];
      }).slice(0, 8),
    },
    {
      key: 'compounders', label: 'Long-Term Compounder Candidates',
      note: 'Highest-quality LONG signals with multi-year horizons.',
      items: ltBuys.filter((r) => Number(r.max_hold) >= 120).slice(0, 8)
        .map((r) => item(String(r.ticker), Number(r.confidence), `max hold ${r.max_hold} sessions`)),
    },
  ];
  return { categories };
}

function stockBody(db: DatabaseSync, ticker: string, now: number): Record<string, unknown> {
  const entry = universeEntry(ticker)!;
  const bars = loadBars(db, ticker);
  const closes = bars.map((b) => b.close);
  const quote = latestQuote(db, ticker);
  const technicals = technicalSnapshot(db, ticker);
  const fundRow = db.prepare('SELECT data_json, as_of, source FROM fundamentals WHERE ticker = ?').get(ticker) as
    | { data_json: string; as_of: string; source: string }
    | undefined;
  const fundamentals = fundRow ? JSON.parse(fundRow.data_json) : null;

  // long-term sub-scores (recomputed locally — no LLM)
  let scores = { quality: 0.5, growth: 0.5, valuation: 0.5, financialRisk: 0.5 };
  if (fundamentals) {
    const f = fundamentals as Record<string, number | null>;
    scores = {
      quality: clamp01(0.5 + 0.2 * sign(f.operatingMargin) + 0.15 * (f.roe != null ? Math.min(1, f.roe / 0.3) : 0.5)),
      growth: clamp01(0.4 + 0.6 * clamp01((f.revenueGrowth ?? 0) / 0.3)),
      valuation: clamp01(f.pe != null && f.pe > 0 ? Math.min(1, 1 - (f.pe - 8) / 40) : 0.5),
      financialRisk: clamp01(0.7 - 0.4 * clamp01((f.debtToEquity ?? 0.5) / 3)),
    };
  }

  const events = db.prepare(
    'SELECT id, ticker, type, headline, materiality, sentiment, first_seen, sources, independent_sources FROM events WHERE ticker = ? ORDER BY first_seen DESC LIMIT 20',
  ).all(ticker) as unknown as Array<Record<string, unknown>>;
  const news = db.prepare(
    `SELECT id, url, title, fetched_at FROM source_documents WHERE doc_type = 'news' AND tickers_json LIKE ? ORDER BY fetched_at DESC LIMIT 15`,
  ).all(`%${ticker}%`) as unknown as Array<Record<string, unknown>>;
  const filings = db.prepare(
    `SELECT id, url, title, fetched_at FROM source_documents WHERE doc_type = 'filing' AND tickers_json LIKE ? ORDER BY fetched_at DESC LIMIT 10`,
  ).all(`%${ticker}%`) as unknown as Array<Record<string, unknown>>;

  const sigRows = db.prepare(
    `SELECT s.*, COALESCE(st.status, 'ACTIVE') AS status FROM signals s LEFT JOIN signal_status st ON st.signal_id = s.id
      WHERE s.ticker = ? ORDER BY s.created_at DESC LIMIT 20`,
  ).all(ticker) as unknown as Array<Record<string, unknown>>;
  const trades = db.prepare('SELECT * FROM paper_trades WHERE ticker = ? ORDER BY COALESCE(exit_ts, entry_ts) DESC LIMIT 20')
    .all(ticker) as unknown as Array<Record<string, unknown>>;
  const lessons = db.prepare(`SELECT id, title, statement, confidence, status FROM knowledge_lessons WHERE status IN ('VALIDATED','CANDIDATE') ORDER BY confidence DESC LIMIT 5`)
    .all() as unknown as Array<Record<string, unknown>>;

  const latestSignal = sigRows[0] ?? null;
  const evidence = latestSignal ? (JSON.parse(String(latestSignal.evidence_json ?? '[]')) as Array<{ detail: string }>) : [];
  const contradictions = latestSignal ? (JSON.parse(String(latestSignal.contradictions_json ?? '[]')) as Array<{ detail: string }>) : [];

  const sentimentEvents = events.filter((e) => Number(e.first_seen) > now - 7 * 86400_000);
  const sentimentOverall = sentimentEvents.length > 0
    ? sentimentEvents.reduce((s, e) => s + Number(e.sentiment), 0) / sentimentEvents.length
    : 0;
  const trend = sentimentEvents.length >= 2 && sentimentEvents[0] && sentimentEvents[sentimentEvents.length - 1]
    ? Number(sentimentEvents[0].sentiment) > Number(sentimentEvents[sentimentEvents.length - 1].sentiment) + 0.1
      ? 'IMPROVING'
      : Number(sentimentEvents[0].sentiment) < Number(sentimentEvents[sentimentEvents.length - 1].sentiment) - 0.1
        ? 'DETERIORATING'
        : 'STABLE'
    : 'STABLE';

  const spy = loadBars(db, 'SPY').map((b) => b.close);
  const betaProxy = relativeStrength(closes, spy, 60).at(-1) ?? null;

  const whyBullets = evidence.length > 0
    ? evidence.map((e) => e.detail)
    : bars.length >= 60
      ? [`Technical composite from ${bars.length} sessions: trend ${maCross(closes)}, RSI(14) ${rsi(closes, 14)?.at(-1)?.toFixed(1) ?? '—'}.`]
      : ['Insufficient history to form a view yet.'];
  const counterBullets = contradictions.length > 0
    ? contradictions.map((c) => c.detail)
    : [
        bars.length >= 60 ? `ATR(14) ${(atr(bars, 14)?.at(-1) ?? 0).toFixed(2)} — position risk must respect stops.` : 'Limited history.',
        'Regime or macro conditions can invalidate any single-name thesis.',
      ];

  const currentItems = [
    ...events.slice(0, 6).map((e) => `${etDate(Number(e.first_seen))}: ${e.type} — ${e.headline} (${e.independent_sources} independent sources)`),
    ...filings.slice(0, 3).map((f) => `Filing: ${f.title}`),
  ];
  const knowledgeItems = lessons.slice(0, 5).map((l) => `${l.status}: ${l.statement}`);

  return {
    ticker, company: entry.company, sector: entry.sector,
    quote: quote ?? (bars.length ? { symbol: ticker, price: bars[bars.length - 1].close, prevClose: bars[bars.length - 2]?.close ?? bars[bars.length - 1].close, ts: now, freshness: 'DELAYED', provider: 'bars' } : null),
    freshness: quote?.freshness ?? 'DELAYED',
    technicals: {
      ...technicals,
      rsi14: technicals.rsi14,
      macdHist: null, stochasticK: null, vwapPos: null, obvTrend: null,
      position52w: position52w(bars),
      realizedVol: null, relVol: technicals.relVol,
    },
    fundamentals,
    scores,
    regime: computeRegime(db).regime,
    sentiment: {
      overall: sentimentOverall,
      dimensions: {
        news: sentimentOverall,
        earnings: sentimentEvents.filter((e) => e.type === 'EARNINGS').reduce((s, e) => s + Number(e.sentiment), 0) / Math.max(1, sentimentEvents.filter((e) => e.type === 'EARNINGS').length),
        guidance: sentimentEvents.filter((e) => String(e.type).includes('GUIDANCE')).reduce((s, e) => s + Number(e.sentiment), 0) / Math.max(1, sentimentEvents.filter((e) => String(e.type).includes('GUIDANCE')).length),
        analyst: sentimentEvents.filter((e) => e.type === 'ANALYST_CHANGE').reduce((s, e) => s + Number(e.sentiment), 0) / Math.max(1, sentimentEvents.filter((e) => e.type === 'ANALYST_CHANGE').length),
      },
      trend,
    },
    events: events.map((e) => ({
      id: e.id, ticker: e.ticker, type: e.type, headline: e.headline, materiality: e.materiality,
      sentiment: e.sentiment, firstSeen: e.first_seen, sources: e.sources, independentSources: e.independent_sources,
    })),
    news: news.map((n) => ({ id: n.id, headline: n.title, ts: n.fetched_at, source: 'yahoo-rss', url: n.url, sentiment: 0 })),
    filings: filings.map((f) => ({ id: f.id, form: String(f.title).split(' ')[0] ?? 'filing', filedAt: etDate(Number(f.fetched_at)), description: f.title, url: f.url })),
    macroExposure: betaProxy != null ? { betaToSpy: betaProxy, yields: 'see Market page' } : null,
    peers: tradableUniverse().filter((u) => u.sector === entry.sector && u.ticker !== ticker).slice(0, 6).map((u) => {
      const b = loadBars(db, u.ticker);
      const ret = b.length > 21 ? ((b[b.length - 1].close - b[b.length - 21].close) / b[b.length - 21].close) * 100 : null;
      return { ticker: u.ticker, ret20dPct: ret };
    }),
    signals: sigRows.map(signalRow),
    trades: trades.map(tradeView),
    lessons,
    why: { title: 'WHY TRADINGUSA LIKES THIS', bullets: whyBullets },
    counter: { title: 'WHAT COULD MAKE IT WRONG', bullets: counterBullets },
    currentVsKnowledge: { current: currentItems, historicalKnowledge: knowledgeItems },
  };
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function sign(n: number | null): number { return n == null ? 0 : n > 0 ? 1 : n < 0 ? -1 : 0; }

function strategiesBody(db: DatabaseSync): Record<string, unknown> {
  const seeded = db.prepare('SELECT * FROM strategy_versions').all() as unknown as Array<Record<string, unknown>>;
  const perf = (strategy: string): Record<string, number | null> => {
    const row = db.prepare('SELECT * FROM strategy_performance WHERE strategy = ? AND period = ?').get(strategy, 'all_time') as
      | { trades: number; wins: number; return_pct: number | null; benchmark_pct: number | null; excess_pct: number | null }
      | undefined;
    // strategy_performance stores rates as fractions (tucore convention);
    // this endpoint's `*Pct` fields are always percent for the web layer.
    return {
      trades: row?.trades ?? 0,
      winRatePct: row && row.trades > 0 ? (row.wins / row.trades) * 100 : null,
      returnPct: row?.return_pct != null ? row.return_pct * 100 : null,
      excessReturnPct: row?.excess_pct != null ? row.excess_pct * 100 : null,
    };
  };
  const live = [
    {
      id: 'st_multi_factor_v1', name: 'Short-Term Multi-Factor', horizon: 'SHORT_TERM',
      active: true, champion: true, version: '1.0.0',
      weights: { technical: 0.38, event: 0.2, regime: 0.16, sentiment: 0.12, macro: 0.08, fundamental: 0.06 },
      factors: ['relative_strength', 'breakout', 'trend_alignment', 'vwap', 'relative_volume', 'sector_momentum', 'event_alignment', 'liquidity'],
      performance: perf('st_multi_factor_v1'),
      notes: 'Requires >=3 confirmations; mean-reversion alone caps at WATCH.',
      challengers: db.prepare(`SELECT id, name, status, observations FROM challengers WHERE parent_strategy = ?`).all('st_multi_factor_v1') as never,
    },
    {
      id: 'lt_quality_growth_v1', name: 'Long-Term Quality Growth', horizon: 'LONG_TERM',
      active: true, champion: true, version: '1.0.0',
      weights: { fundamental: 0.45, event: 0.15, regime: 0.12, macro: 0.12, technical: 0.1, sentiment: 0.06 },
      factors: ['quality', 'growth', 'valuation', 'financial_risk', 'estimate_revisions', 'entry_timing'],
      performance: perf('lt_quality_growth_v1'),
      notes: 'Technical analysis assists timing only; BUY blocked when financialRisk < 0.3.',
      challengers: db.prepare(`SELECT id, name, status, observations FROM challengers WHERE parent_strategy = ?`).all('lt_quality_growth_v1') as never,
    },
  ];
  return {
    strategies: live,
    seededVersions: seeded.length,
    promotionPolicy: 'Challengers require backtesting + walk-forward + out-of-sample + shadow paper observations before promotion. Learning never rewrites source code.',
  };
}

function aiBody(db: DatabaseSync, runtime: TradingRuntime, now: number): Record<string, unknown> {
  const health = runtime.router.health();
  const day = etDate(now);
  const weekAgo = new Date(now - 7 * 86400_000).toISOString().slice(0, 10);
  const usageFor = (provider: string, since: string): { calls: number; input: number; output: number; cached: number } => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output,
                COALESCE(SUM(cached),0) AS cached
           FROM llm_usage WHERE provider = ? AND day >= ? AND invoked = 1`,
      )
      .get(provider, since) as { calls: number; input: number; output: number; cached: number };
    return row;
  };
  const providers = health.map((h) => {
    const today = usageFor(h.name, day);
    const week = usageFor(h.name, weekAgo);
    return {
      name: h.name === 'groq' ? 'Groq' : 'Gemini',
      status: h.status as ProviderStatus,
      model: h.model,
      role: h.name === 'groq' ? 'primary' : 'secondary',
      configured: h.configured,
      callsToday: today.calls,
      callsWeek: week.calls,
      inputTokensToday: today.input,
      outputTokensToday: today.output,
      inputTokensWeek: week.input,
      outputTokensWeek: week.output,
      cacheHitRatePct: week.calls + week.cached > 0 ? Math.round((week.cached / (week.calls + week.cached)) * 1000) / 10 : 0,
      circuitOpenUntil: h.circuitOpenUntil,
      consecutiveFailures: h.consecutiveFailures,
      lastError: h.lastError,
    };
  });
  const quota = runtime.router.quotaSnapshot();
  const totalsRow = db
    .prepare(
      `SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
              COALESCE(SUM(cached),0) AS cached,
              COALESCE(SUM(CASE WHEN invoked = 0 THEN 1 ELSE 0 END),0) AS avoided
         FROM llm_usage WHERE day = ?`,
    )
    .get(day) as { calls: number; tokens: number; cached: number; avoided: number };
  const localAvoided = db
    .prepare(`SELECT COUNT(*) AS n FROM llm_usage WHERE day = ? AND status = 'SKIPPED'`)
    .get(day) as { n: number };
  const cacheRows = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(hits),0) AS h FROM llm_cache').get() as { n: number; h: number };
  const recent = db
    .prepare('SELECT ts, provider, task, status, latency_ms, input_tokens, output_tokens, cached, invoked FROM llm_usage ORDER BY id DESC LIMIT 25')
    .all() as unknown as Array<Record<string, unknown>>;
  const valueRecent = db
    .prepare(`SELECT ts, task, value_score, invoked, detail_json FROM llm_usage WHERE value_score IS NOT NULL ORDER BY id DESC LIMIT 20`)
    .all() as unknown as Array<Record<string, unknown>>;
  const ablation = runtime.quality.summary();

  // estimated cost: free-tier providers — usage tracked, cost shown as $0.00 with token counts
  return {
    providers,
    totals: {
      callsToday: totalsRow.calls,
      tokensToday: totalsRow.tokens,
      estCostUsd: 0,
      cacheHitRatePct: cacheRows.n + cacheRows.h > 0 ? Math.round((cacheRows.h / (cacheRows.n + cacheRows.h)) * 1000) / 10 : 0,
      avoidedByCache: totalsRow.cached,
      avoidedByLocalProcessing: localAvoided.n,
      llmDependencyPct: llmDependencyPct(db, day),
    },
    budgets: {
      groqTokensPerDay: quota.groqTokensPerDay,
      geminiTokensPerDay: quota.geminiTokensPerDay,
      routineCallsPerDay: quota.routineLimit,
      highPriorityCallsPerDay: quota.highLimit,
      reservePercent: quota.reservePercent,
      routineRemaining: quota.routineRemaining,
      highRemaining: quota.highRemaining,
      groqTokensToday: quota.groqTokensToday,
      geminiTokensToday: quota.geminiTokensToday,
    },
    ablation: {
      evaluated: ablation.evaluated, improved: ablation.improved, noEffect: ablation.noEffect,
      worse: ablation.worse, incrementalAlphaPct: ablation.incrementalAlphaPct, byTask: ablation.byTask,
    },
    valueRouter: {
      threshold: runtime.router.config.valueThreshold,
      recent: valueRecent.map((v) => ({
        ts: v.ts, task: v.task, value: v.value_score, invoked: v.invoked === 1,
        reason: (JSON.parse(String(v.detail_json ?? '{}')) as { reason?: string }).reason ?? null,
      })),
    },
    mode: runtime.router.mode(),
    recent: recent.map((r) => ({
      ts: r.ts, provider: r.provider, task: r.task, status: r.status,
      latencyMs: r.latency_ms, tokens: Number(r.input_tokens) + Number(r.output_tokens), cached: r.cached === 1,
    })),
  };
}

function systemBody(db: DatabaseSync, runtime: TradingRuntime, now: number): Record<string, unknown> {
  const regime = computeRegime(db);
  const quoteAge = (db.prepare('SELECT MAX(ts) AS t FROM market_quotes').get() as { t: number | null }).t;
  const staleQuotes = (db.prepare('SELECT COUNT(*) AS n FROM market_quotes WHERE ts < ?').get(now - 60 * 60_000) as { n: number }).n;
  const positions = openPositions(db);
  const pendingOrders = (db.prepare(`SELECT COUNT(*) AS n FROM paper_orders WHERE status = 'PENDING'`).get() as { n: number }).n;
  const errors = (db.prepare(`SELECT COUNT(*) AS n FROM system_jobs WHERE last_status = 'error'`).get() as { n: number }).n;

  const stView = computePortfolioView(db, 'SHORT_TERM_PORTFOLIO');
  const ltView = computePortfolioView(db, 'LONG_TERM_PORTFOLIO');
  const dd = Math.min(stView?.metrics.maxDrawdown ?? 0, ltView?.metrics.maxDrawdown ?? 0);
  const kill = checkKillSwitch({
    dataStale: staleQuotes > 0 && (sessionKindAt(now) === 'MARKET_OPEN'),
    providerFailed: runtime.provider.status() === 'UNAVAILABLE',
    priceDisagreement: false,
    dbUnhealthy: false,
    strategyAbnormal: errors > 3,
    drawdownPct: Math.abs(dd) * 100, // tucore kill-switch compares percent
    drawdownLimitPct: runtime.config.killSwitchDrawdownPct,
    calcFailed: false,
    regimeUncertain: regime.regime === 'UNCERTAIN',
  });

  const tableCount = (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`).get() as { n: number }).n;

  return {
    market: sessionView(now),
    mode: runtime.guard.mode,
    pilotMode: runtime.config.pilotMode,
    jobs: runtime.scheduler.jobRows(),
    workers: { enabled: runtime.config.workers, startedAt: runtime.scheduler.started(), ticks: runtime.scheduler.ticks() },
    db: { healthy: true, tables: tableCount, sizeBytes: null },
    dataQuality: {
      staleQuotes,
      lastQuoteAgeMs: quoteAge ? now - quoteAge : null,
      providerDisagreements: 0,
      missingBars: (db.prepare(`SELECT COUNT(DISTINCT ticker) AS n FROM market_bars`).get() as { n: number }).n,
      regime: regime.regime,
    },
    broker: { status: 'OK', pendingOrders, openPositions: positions.length, mode: runtime.guard.mode },
    killSwitch: kill,
    llm: {
      groq: runtime.router.health().find((h) => h.name === 'groq')?.status,
      gemini: runtime.router.health().find((h) => h.name === 'gemini')?.status,
      mode: runtime.router.mode(),
    },
    dataSources: [
      { name: runtime.provider.name, status: runtime.provider.status(), lastSuccess: runtime.provider.lastUpdate(), lastError: runtime.provider.lastError() },
      { name: runtime.news.name, status: runtime.news.status(), lastSuccess: null, lastError: runtime.news.lastError() },
      { name: runtime.sec.name, status: runtime.sec.status(), lastSuccess: null, lastError: runtime.sec.lastError() },
      { name: runtime.macro.name, status: runtime.macro.status(), lastSuccess: null, lastError: runtime.macro.lastError() },
    ],
  };
}
