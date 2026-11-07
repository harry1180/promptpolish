/**
 * Session-aware scheduler. Everything runs IN-PROCESS on timers driven by
 * the ComputeBudgetController: heavy intraday work during MARKET_OPEN,
 * reduced frequency in PREMARKET/POSTMARKET, only low-frequency services
 * (SEC watcher, event watcher, health, consolidation, reviews) when the
 * market is closed / weekend / holiday. Hermes is NOT involved after
 * deployment — this loop is the system's own heartbeat.
 */
import type { DatabaseSync } from 'node:sqlite';
import { computeBudget, etDate, sessionKindAt, tradingDaysBetween } from '@promptslim/tucore';
import type { InferenceRouter, QualityTracker } from './inference/router.ts';
import type { TuConfig } from './config.ts';
import type { YahooFinanceProvider } from './providers/yahoo.ts';
import type { NewsProvider } from './providers/news.ts';
import type { SecProvider } from './providers/sec.ts';
import type { MacroProvider } from './providers/macro.ts';
import type { NasdaqEodProvider } from './providers/nasdaq.ts';
import type { CboeIndexProvider } from './providers/cboe.ts';
import { backfillBars, coreQuoteSymbols, ingestTick, runScan } from './engine.ts';
import { monitorPositions, processOrders, settleEndOfDay, ensurePortfolios } from './broker.ts';
import { snapshotPortfolios } from './portfolio.ts';
import { pollNews, pollSecFilings, pollMacro, refreshFundamentals } from './intake.ts';
import { fetchNextEarnings } from './earnings.ts';
import { analyzeClosedTrade } from './learning.ts';
import { learnFromOutcome, refreshKnowledge } from './adaptive.ts';
import { analyzeNewMaterialEvents, analyzePostmortems, resolveAblation } from './llm-jobs.ts';
import { ensureInitialBacktest, runBacktestJob } from './backtest.ts';
import { ALL_TICKERS, TRADABLE_TICKERS, tradableUniverse, universeEntry } from './universe.ts';

export interface SchedulerRuntime {
  db: DatabaseSync;
  provider: YahooFinanceProvider;
  news: NewsProvider;
  sec: SecProvider;
  macro: MacroProvider;
  nasdaq: NasdaqEodProvider;
  cboe: CboeIndexProvider;
  router: InferenceRouter;
  quality: QualityTracker;
  config: TuConfig;
}

interface JobState { lastRun: number; runs: number; error: string | null }

export class TradingScheduler {
  private rt: SchedulerRuntime;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private states = new Map<string, JobState>();
  private busy = new Set<string>();
  private cursor = 0;
  private postmarketDoneFor = '';
  private consolidationDoneFor = '';
  /** newest daily bar already passed through settleEndOfDay */
  private lastSettleDate = '';
  private startedAt = 0;

  constructor(rt: SchedulerRuntime) {
    this.rt = rt;
  }

  start(intervalMs = 20_000): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    ensurePortfolios(this.rt.db, this.rt.config);
    // Start from the PREVIOUS bar, not MAX(date): settling the newest session
    // once after boot is idempotent (same bars → same sessions_held/exits) and
    // heals positions a settle missed — e.g. one that fired while bar_backfill
    // was still writing the new date, which skipped every position whose bar
    // had not landed yet and then latched lastSettleDate over them.
    const newest =
      (this.rt.db.prepare('SELECT MAX(date) AS d FROM market_bars').get() as { d: string | null }).d ?? null;
    const prev = newest
      ? (this.rt.db.prepare('SELECT MAX(date) AS d FROM market_bars WHERE date < ?').get(newest) as { d: string | null }).d
      : null;
    this.lastSettleDate = prev ?? newest ?? etDate(Date.now());
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  started(): number { return this.startedAt; }
  ticks(): number { return this.tickCount; }

  jobRows(): Array<{ name: string; schedule: string; lastRun: number | null; lastStatus: string; durationMs: number | null; lastError: string | null }> {
    const rows = this.rt.db.prepare('SELECT name, schedule, last_run, last_status, duration_ms, last_error FROM system_jobs').all() as unknown as Array<{
      name: string; schedule: string; last_run: number | null; last_status: string; duration_ms: number | null; last_error: string | null;
    }>;
    return rows.map((r) => ({
      name: r.name, schedule: r.schedule, lastRun: r.last_run,
      lastStatus: r.last_status ?? 'never', durationMs: r.duration_ms, lastError: r.last_error,
    }));
  }

  private async runJob(name: string, schedule: string, fn: () => Promise<unknown> | unknown): Promise<void> {
    if (this.busy.has(name)) return;
    this.busy.add(name);
    const started = Date.now();
    let error: string | null = null;
    try {
      await fn();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      const duration = Date.now() - started;
      const state = this.states.get(name) ?? { lastRun: 0, runs: 0, error: null };
      state.lastRun = started;
      state.runs += 1;
      state.error = error;
      this.states.set(name, state);
      try {
        this.rt.db
          .prepare(
            `INSERT INTO system_jobs (name, schedule, last_run, last_status, duration_ms, last_error, runs)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET schedule=excluded.schedule, last_run=excluded.last_run,
               last_status=excluded.last_status, duration_ms=excluded.duration_ms,
               last_error=excluded.last_error, runs=system_jobs.runs + 1`,
          )
          .run(name, schedule, started, error ? 'error' : 'ok', duration, error, 1);
      } catch {
        /* job bookkeeping must not fail the loop */
      }
      this.busy.delete(name);
    }
  }

  private due(name: string, intervalMs: number): boolean {
    const state = this.states.get(name);
    if (!state) return true;
    return Date.now() - state.lastRun >= intervalMs;
  }

  private async tick(): Promise<void> {
    this.tickCount += 1;
    const now = Date.now();
    const db = this.rt.db;
    const config = this.rt.config;
    const session = sessionKindAt(now);
    const budget = computeBudget({
      session,
      portfolioExposure: 0,
      openCandidates: 0,
      dataFreshness: this.rt.provider.status() === 'CONNECTED' ? 1 : 0.5,
      providerHealthy: this.rt.provider.status() !== 'UNAVAILABLE',
      systemLoad: 0,
    });

    /* ---------- history backfill: retry every 10 min until complete, then daily ---------- */
    const barsHave = (db.prepare('SELECT COUNT(DISTINCT ticker) AS n FROM market_bars').get() as { n: number }).n;
    const backfillDue = barsHave < ALL_TICKERS.length
      ? this.due('bar_backfill', 10 * 60_000)
      : this.due('bar_backfill', 24 * 3600_000);
    if (backfillDue) {
      await this.runJob('bar_backfill', barsHave < ALL_TICKERS.length ? 'retry/10min until complete' : 'daily', async () => {
        const have = (db.prepare('SELECT COUNT(DISTINCT ticker) AS n FROM market_bars').get() as { n: number }).n;
        if (have < ALL_TICKERS.length) {
          await backfillBars(db, this.rt.provider, ALL_TICKERS, '2y', 1500, this.rt.nasdaq);
        } else {
          // Every ticker already has history: append the recent window. The
          // initial pass skips known tickers, so without this branch the
          // first backfill freezes daily bars at the boot date — features,
          // EOD settlement and the SPY benchmark then never advance.
          await backfillBars(db, this.rt.provider, ALL_TICKERS, '5d', 200, this.rt.nasdaq, { refresh: true });
        }
        const after = (db.prepare('SELECT COUNT(DISTINCT ticker) AS n FROM market_bars').get() as { n: number }).n;
        if (after >= 10) {
          const boot = ensureInitialBacktest(db);
          if (boot) void runBacktestJob(db, boot.runId);
        }
        // new history => the next tick should immediately re-scan signals and
        // re-attempt pending paper orders instead of waiting out their cadence
        this.states.delete('signal_scan');
        this.states.delete('order_processing');
      });
    }

    /* ---------- pending backtest run ---------- */
    const running = db.prepare(`SELECT id FROM backtest_runs WHERE status = 'RUNNING' LIMIT 1`).get() as { id: number } | undefined;
    if (running && this.due('backtest_runner', 15_000)) {
      await this.runJob('backtest_runner', 'on-demand', () => runBacktestJob(db, running.id));
    }

    /* ---------- quote stream (only in active sessions) ---------- */
    const quotesActive = session === 'PREMARKET' || session === 'MARKET_OPEN' || session === 'EARLY_CLOSE' || session === 'POSTMARKET';
    const quotePollMs = Math.max(budget.quotePollMs, 45_000); // provider politeness floor
    if (quotesActive && this.due('quote_poll', quotePollMs)) {
      await this.runJob('quote_poll', `every ${Math.round(quotePollMs / 1000)}s`, async () => {
        const quotes = await this.rt.provider.getQuotes([...coreQuoteSymbols(db), '^VIX']);
        ingestTick(db, quotes, now);
        const vix = quotes.find((q) => q.symbol === '^VIX');
        if (vix) {
          db.prepare(
            `INSERT INTO economic_data (series, date, value, source) VALUES ('vix', ?, ?, 'yahoo')
             ON CONFLICT(series, date) DO UPDATE SET value = excluded.value`,
          ).run(etDate(now), vix.price, 'yahoo');
        }
      });
    }

    /* ---------- decision scan (strategies -> signals) ---------- */
    const scanSessions = session === 'MARKET_OPEN' || session === 'EARLY_CLOSE' || session === 'PREMARKET' || session === 'POSTMARKET' || session === 'MARKET_CLOSED' || session === 'WEEKEND' || session === 'HOLIDAY';
    if (scanSessions && this.due('signal_scan', budget.featureIntervalMs)) {
      await this.runJob('signal_scan', `every ${Math.round(budget.featureIntervalMs / 1000)}s`, async () => {
        await runScan({ db, provider: this.rt.provider, config, now });
      });
    }

    /* ---------- paper broker ---------- */
    if (this.due('order_processing', quotesActive ? 15_000 : 120_000)) {
      await this.runJob('order_processing', quotesActive ? 'every 15s' : 'every 120s', () =>
        processOrders(db, this.rt.provider, config, Date.now()));
    }
    if (budget.intradayEnabled && this.due('position_monitor', 20_000)) {
      await this.runJob('position_monitor', 'every 20s', () => monitorPositions(db, this.rt.provider, config, Date.now()));
    }

    /* ---------- valuation ---------- */
    if (session === 'MARKET_OPEN' && this.due('portfolio_snapshot', 3600_000)) {
      await this.runJob('portfolio_snapshot', 'hourly (market open)', () => snapshotPortfolios(db, Date.now()));
    }

    /* ---------- public information crawlers ---------- */
    if (this.due('news_poll', budget.crawlIntervalMs)) {
      await this.runJob('news_poll', `every ${Math.round(budget.crawlIntervalMs / 1000)}s`, () => {
        const start = this.cursor % TRADABLE_TICKERS.length;
        const batch: Array<{ ticker: string; company: string }> = [];
        for (let i = 0; i < Math.min(10, TRADABLE_TICKERS.length); i++) {
          const t = TRADABLE_TICKERS[(start + i) % TRADABLE_TICKERS.length];
          const e = universeEntry(t);
          batch.push({ ticker: t, company: e?.company ?? t });
        }
        this.cursor += batch.length;
        return pollNews(db, this.rt.news, batch);
      });
    }
    if (this.due('sec_filings', 3600_000)) {
      await this.runJob('sec_filings', 'hourly', () => {
        const start = this.cursor % TRADABLE_TICKERS.length;
        const batch = Array.from({ length: 10 }, (_, i) => TRADABLE_TICKERS[(start + i) % TRADABLE_TICKERS.length]);
        return pollSecFilings(db, this.rt.sec, batch);
      });
    }
    if (this.due('macro_poll', 12 * 3600_000)) {
      await this.runJob('macro_poll', '12h', async () => {
        const stored = await pollMacro(db, this.rt.macro);
        // VIX: Yahoo first (one polite request/day) — it 429s from this host,
        // so the macro score's volatility term also has a direct index source.
        const putVix = (price: number, source: string) => {
          db.prepare(
            `INSERT INTO economic_data (series, date, value, source) VALUES ('vix', ?, ?, ?)
             ON CONFLICT(series, date) DO UPDATE SET value = excluded.value, source = excluded.source`,
          ).run(etDate(Date.now()), price, source);
        };
        try {
          const vix = await this.rt.provider.quoteFromChart('%5EVIX');
          if (vix && vix.price > 0) putVix(vix.price, 'yahoo');
        } catch { /* fall through to the index source */ }
        const haveVix = db
          .prepare(`SELECT 1 FROM economic_data WHERE series = 'vix' AND date = ?`)
          .get(etDate(Date.now()));
        if (!haveVix) {
          try {
            const [q] = await this.rt.cboe.getQuotes(['^VIX']);
            if (q && q.price > 0) putVix(q.price, 'cboe');
          } catch { /* vix optional */ }
        }
        return stored;
      });
    }
    /* ---------- next-earnings calendar (feeds the entry guard) ---------- */
    if (this.due('earnings_calendar', 24 * 3600_000)) {
      await this.runJob('earnings_calendar', 'daily', async () => {
        const today = etDate(Date.now());
        const cutoff = Date.now() - 7 * 86400_000; // refresh weekly, per ticker
        let fetched = 0;
        for (const u of tradableUniverse()) {
          const have = db
            .prepare('SELECT fetched_at FROM earnings_calendar WHERE ticker = ?')
            .get(u.ticker) as { fetched_at: number } | undefined;
          if (have && have.fetched_at >= cutoff) continue;
          try {
            const next = await fetchNextEarnings(u.ticker, today);
            if (next) {
              db.prepare(
                `INSERT INTO earnings_calendar (ticker, next_earnings_date, fetched_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(ticker) DO UPDATE SET next_earnings_date=excluded.next_earnings_date,
                   fetched_at=excluded.fetched_at`,
              ).run(u.ticker, next, Date.now());
              fetched += 1;
            } else if (!have) {
              // record the miss so an unknown ticker is not re-polled daily
              db.prepare(
                `INSERT INTO earnings_calendar (ticker, next_earnings_date, fetched_at)
                 VALUES (?, '9999-12-31', ?) ON CONFLICT(ticker) DO NOTHING`,
              ).run(u.ticker, Date.now());
            }
          } catch { /* per-ticker failure keeps any previous row */ }
          await new Promise((r) => setTimeout(r, 300)); // paced: public endpoint
        }
        return { universe: tradableUniverse().length, dated: fetched };
      });
    }

    if (this.due('fundamentals_refresh', 24 * 3600_000)) {
      await this.runJob('fundamentals_refresh', 'daily', () => {
        const start = this.cursor % TRADABLE_TICKERS.length;
        const batch = Array.from({ length: 15 }, (_, i) => TRADABLE_TICKERS[(start + i) % TRADABLE_TICKERS.length]);
        return refreshFundamentals(db, this.rt.sec, batch);
      });
    }

    /* ---------- selective LLM reasoning (budget/circuit gated inside) ---------- */
    if (this.due('llm_event_analysis', session === 'MARKET_OPEN' || session === 'EARLY_CLOSE' ? 600_000 : 1800_000)) {
      await this.runJob('llm_event_analysis', 'gated', () =>
        analyzeNewMaterialEvents(db, this.rt.router, this.rt.quality, 3));
    }

    /* ---------- backtest bootstrapping ---------- */
    if (this.due('backtest_boot', 6 * 3600_000)) {
      await this.runJob('backtest_boot', '6h', () => {
        const boot = ensureInitialBacktest(db);
        if (boot) return runBacktestJob(db, boot.runId);
        return null;
      });
    }

    /* ---------- POSTMARKET: settle, value, review ---------- */
    const today = etDate(now);
    if (session === 'POSTMARKET' && this.postmarketDoneFor !== today) {
      this.postmarketDoneFor = today;
      await this.runJob('postmarket_review', 'daily at close', async () => {
        // The daily bar may not be published yet at 16:00; when it is, today
        // counts as settled here so the new-bar pass below does not redo it.
        const barToday = (db.prepare('SELECT COUNT(*) AS n FROM market_bars WHERE date = ?').get(today) as { n: number }).n;
        if (barToday > 0) this.lastSettleDate = today;
        settleEndOfDay(db, config, today);
        // mistake analysis for trades closed today
        const closed = db.prepare('SELECT id FROM paper_trades WHERE exit_ts >= ?').all(now - 6 * 3600_000) as unknown as Array<{ id: number }>;
        for (const c of closed) {
          learnFromOutcome(db, c.id); // wins included — the positive half of the loop
          analyzeClosedTrade(db, c.id);
        }
        snapshotPortfolios(db, Date.now());
        buildDailyReview(db, today);
        buildWeeklyReviewIfDue(db, today);
      });
    }

    /* ---------- settle each session whose daily bar has arrived ---------- */
    // Daily bars can land hours after the close (provider-dependent), so EOD
    // settlement follows the newest stored bar instead of only today's date:
    // sessions_held, gap-aware exits and the SPY benchmark all depend on it.
    const newestBar = (db.prepare('SELECT MAX(date) AS d FROM market_bars').get() as { d: string | null }).d;
    const markingLive = session === 'MARKET_OPEN' || session === 'EARLY_CLOSE';
    // bar_backfill writes the new session's bars ticker-by-ticker and ticks
    // overlap (tick() is fired without awaiting the previous one): settling
    // mid-write sees only the first N tickers with the new date, skips every
    // position whose bar has not landed yet, then latches lastSettleDate —
    // those positions never get that session (sessions_held stays 0). Never
    // settle while the bar writer is in flight; the next free tick settles
    // against the complete universe.
    const backfillInFlight = this.busy.has('bar_backfill');
    if (
      newestBar && this.lastSettleDate && newestBar > this.lastSettleDate && newestBar <= today && !markingLive
      && !backfillInFlight
      && this.due('settle_new_session', 300_000) // failed settle retries at most every 5 min
    ) {
      const settleFor = newestBar;
      await this.runJob('settle_new_session', `on new daily bar ${settleFor}`, async () => {
        const res = settleEndOfDay(db, config, settleFor);
        const dayStart = Date.parse(`${settleFor}T00:00:00Z`);
        // losses closed on that session feed the learning pipeline (the
        // helper is idempotent per trade, so a re-run is harmless)
        const closed = db
          .prepare('SELECT id FROM paper_trades WHERE exit_ts >= ? AND exit_ts < ?')
          .all(dayStart, dayStart + 36 * 3600_000) as unknown as Array<{ id: number }>;
        for (const c of closed) {
          learnFromOutcome(db, c.id); // wins included — the positive half of the loop
          analyzeClosedTrade(db, c.id);
        }
        snapshotPortfolios(db, Date.now());
        // The day's SPY bar only exists NOW (it lands after the close), so
        // re-run the reviews: without this the daily benchmark stayed 0% and
        // the weekly SPY return stayed 0 — both read as "the market didn't
        // move" instead of "we hadn't looked yet".
        buildDailyReview(db, settleFor);
        buildWeeklyReviewIfDue(db, settleFor);
        this.lastSettleDate = settleFor;
        return res;
      });
    }

    /* ---------- MARKET CLOSED: consolidation + maintenance ---------- */
    if ((session === 'MARKET_CLOSED' || session === 'WEEKEND' || session === 'HOLIDAY') && this.consolidationDoneFor !== today) {
      const hourEt = new Date(now).getUTCHours(); // coarse; fine for a once-a-day guard
      if (session !== 'MARKET_CLOSED' || hourEt >= 4) {
        this.consolidationDoneFor = today;
        await this.runJob('knowledge_consolidation', 'daily after close', async () => {
          // the whole learning refresh in one pass: merge/expire/validate
          // lessons, re-fit fusion weights from realized outcomes, review
          // lesson gates — each step logged as a learning_events row.
          const refreshed = refreshKnowledge(db, Date.now());
          resolveAblation(db, this.rt.quality);
          await analyzePostmortems(db, this.rt.router, 2);
          return refreshed;
        });
      }
    }

    void budget;
  }
}

/* ------------------------------------------------------------------ */
/* reviews                                                             */
/* ------------------------------------------------------------------ */

export function buildDailyReview(db: DatabaseSync, date: string): void {
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const dayEnd = dayStart + 86400_000;
  const count = (sql: string, ...args: unknown[]): number => {
    const row = db.prepare(sql).get(...(args as never[])) as { n: number } | undefined;
    return row?.n ?? 0;
  };
  const signals = count('SELECT COUNT(*) AS n FROM signals WHERE session_date = ?', date);
  const opened = count('SELECT COUNT(*) AS n FROM paper_orders WHERE status = ? AND filled_at BETWEEN ? AND ?', 'FILLED', dayStart, dayEnd);
  const closedRows = db
    .prepare('SELECT net_pnl, return_pct FROM paper_trades WHERE exit_ts BETWEEN ? AND ?')
    .all(dayStart, dayEnd) as unknown as Array<{ net_pnl: number; return_pct: number }>;
  const wins = closedRows.filter((r) => r.net_pnl > 0).length;
  const losses = closedRows.filter((r) => r.net_pnl < 0).length;
  const mistakes = count('SELECT COUNT(*) AS n FROM mistakes WHERE ts BETWEEN ? AND ?', dayStart, dayEnd);
  const lessons = count(`SELECT COUNT(*) AS n FROM knowledge_lessons WHERE created_at BETWEEN ? AND ?`, dayStart, dayEnd);
  const errors = count(`SELECT COUNT(*) AS n FROM system_jobs WHERE last_status = 'error'`);
  const llmCalls = count('SELECT COUNT(*) AS n FROM llm_usage WHERE day = ? AND invoked = 1', date);

  const spyBars = db.prepare('SELECT date, close FROM market_bars WHERE ticker = ? AND date >= ? ORDER BY date').all('SPY', date) as unknown as Array<{ date: string; close: number }>;
  const prev = db.prepare('SELECT close FROM market_bars WHERE ticker = ? AND date < ? ORDER BY date DESC LIMIT 1').get('SPY', date) as { close: number } | undefined;
  const last = spyBars.find((b) => b.date === date);
  // The review is written right after the close, usually BEFORE the day's SPY
  // bar exists. Falling back to 0 there made every day read "benchmark 0%"
  // and flipped the sign of excess return (2026-11-02 showed -0.04% excess
  // against a real -0.48% SPY move). Report null — the web renders "—" — and
  // the settle pass rewrites the row once the bar has landed.
  const benchReturn = prev && last ? (last.close - prev.close) / prev.close : null;

  // THAT day's portfolio return: the last snapshot inside the day versus the
  // last one before it. The old code always compared the two most recent
  // snapshots, which is only right when the review is written for today —
  // re-running it for an older date (what the settle pass now does) would
  // stamp today's return onto that date.
  const retOf = (kind: string): number => {
    const inDay = db
      .prepare('SELECT equity FROM portfolio_snapshots WHERE portfolio = ? AND ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 1')
      .get(kind, dayStart, dayEnd) as { equity: number } | undefined;
    const before = db
      .prepare('SELECT equity FROM portfolio_snapshots WHERE portfolio = ? AND ts < ? ORDER BY ts DESC LIMIT 1')
      .get(kind, dayStart) as { equity: number } | undefined;
    if (!inDay || !before || before.equity <= 0) return 0;
    return (inDay.equity - before.equity) / before.equity;
  };
  const stRet = retOf('SHORT_TERM_PORTFOLIO');
  const ltRet = retOf('LONG_TERM_PORTFOLIO');
  const daily = (stRet + ltRet) / 2;

  const payload = {
    date, signals, opened, closed: closedRows.length, wins, losses,
    dailyReturnPct: daily * 100,
    benchmarkReturnPct: benchReturn == null ? null : benchReturn * 100,
    excessReturnPct: benchReturn == null ? null : (daily - benchReturn) * 100,
    benchmarkPending: benchReturn == null,
    mistakes, lessons, errors, llmCalls,
  };
  db.prepare(
    `INSERT INTO daily_reviews (date, payload_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET payload_json = excluded.payload_json`,
  ).run(date, JSON.stringify(payload), Date.now());
}

export function buildWeeklyReviewIfDue(db: DatabaseSync, date: string): void {
  const last = db.prepare('SELECT label FROM weekly_reviews ORDER BY created_at DESC LIMIT 1').get() as { label: string } | undefined;
  const since = last ? last.label.split('_')[1] ?? '1970-01-01' : '1970-01-01';
  let sessions: string[] = [];
  try {
    sessions = tradingDaysBetween(since, date);
  } catch {
    sessions = [];
  }
  const completed = sessions.filter((d) => d < date).length;
  if (completed < 5) return;

  const windowStart = sessions[0] ?? date;
  const windowEnd = sessions[Math.min(completed, sessions.length) - 1] ?? date;
  const startTs = Date.parse(`${windowStart}T00:00:00Z`);
  const endTs = Date.parse(`${windowEnd}T23:59:59Z`);

  const portfolioBlock = (kind: string): Record<string, number | null> => {
    const trades = db.prepare('SELECT net_pnl FROM paper_trades WHERE portfolio = ? AND exit_ts BETWEEN ? AND ?').all(kind, startTs, endTs) as unknown as Array<{ net_pnl: number }>;
    const snaps = db.prepare('SELECT ts, equity FROM portfolio_snapshots WHERE portfolio = ? AND ts BETWEEN ? AND ? ORDER BY ts').all(kind, startTs, endTs) as unknown as Array<{ ts: number; equity: number }>;
    const startCapital = (db.prepare('SELECT start_capital FROM paper_portfolios WHERE kind = ?').get(kind) as { start_capital: number } | undefined)?.start_capital ?? 100_000;
    const equity = snaps.length > 0 ? snaps[snaps.length - 1].equity : startCapital;
    const wins = trades.filter((t) => t.net_pnl > 0).length;
    const spy = db.prepare('SELECT close FROM market_bars WHERE ticker = ? AND date = ?').get('SPY', windowStart) as { close: number } | undefined;
    const spyEnd = db.prepare('SELECT close FROM market_bars WHERE ticker = ? AND date = ?').get('SPY', windowEnd) as { close: number } | undefined;
    // null when either end of the window has no SPY bar yet: a 0 here reads
    // as "SPY was flat" and makes excess return identical to our own return
    const spyRet = spy && spyEnd ? ((spyEnd.close - spy.close) / spy.close) * 100 : null;
    const ret = ((equity - startCapital) / startCapital) * 100;
    return {
      startCapital, endingEquity: equity, returnPct: ret, spyReturnPct: spyRet,
      excessReturnPct: spyRet == null ? null : ret - spyRet, trades: trades.length, wins,
      losses: trades.length - wins,
    };
  };

  const aiRow = db.prepare('SELECT COUNT(*) AS n, SUM(input_tokens + output_tokens) AS t, SUM(cached) AS c FROM llm_usage WHERE day >= ? AND day <= ? AND invoked = 1')
    .get(windowStart, windowEnd) as { n: number | null; t: number | null; c: number | null };
  const totalSignals = (db.prepare('SELECT COUNT(*) AS n FROM signals WHERE session_date >= ? AND session_date <= ?').get(windowStart, windowEnd) as { n: number }).n;
  const llmCalls = aiRow.n ?? 0;

  const payload = {
    label: `week_${windowEnd}`,
    start: windowStart, end: windowEnd,
    shortTerm: portfolioBlock('SHORT_TERM_PORTFOLIO'),
    longTerm: portfolioBlock('LONG_TERM_PORTFOLIO'),
    system: {
      observations: (db.prepare('SELECT COUNT(*) AS n FROM market_quotes').get() as { n: number }).n,
      events: (db.prepare('SELECT COUNT(*) AS n FROM events WHERE first_seen BETWEEN ? AND ?').get(startTs, endTs) as { n: number }).n,
      signals: totalSignals,
      trades: (db.prepare('SELECT COUNT(*) AS n FROM paper_trades WHERE exit_ts BETWEEN ? AND ?').get(startTs, endTs) as { n: number }).n,
      documents: (db.prepare('SELECT COUNT(*) AS n FROM source_documents WHERE fetched_at BETWEEN ? AND ?').get(startTs, endTs) as { n: number }).n,
    },
    ai: {
      groqCalls: (db.prepare(`SELECT COUNT(*) AS n FROM llm_usage WHERE provider = 'groq' AND day >= ? AND day <= ? AND invoked = 1`).get(windowStart, windowEnd) as { n: number }).n,
      geminiCalls: (db.prepare(`SELECT COUNT(*) AS n FROM llm_usage WHERE provider = 'gemini' AND day >= ? AND day <= ? AND invoked = 1`).get(windowStart, windowEnd) as { n: number }).n,
      tokens: aiRow.t ?? 0,
      cacheHits: aiRow.c ?? 0,
      dependencyPct: totalSignals > 0 ? Math.round((llmCalls / totalSignals) * 1000) / 10 : 0,
    },
  };
  db.prepare(
    `INSERT INTO weekly_reviews (label, payload_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT(label) DO UPDATE SET payload_json = excluded.payload_json`,
  ).run(payload.label, JSON.stringify(payload), Date.now());
}
