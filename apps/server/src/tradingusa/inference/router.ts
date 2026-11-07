/**
 * InferenceRouter — the ONLY component in TradingUSA allowed to call cloud
 * LLMs (Groq, Gemini). Everything else requests reasoning through
 * `reason()`; nobody reads provider keys, nobody imports provider SDKs.
 *
 * Sub-components: ProviderRegistry, ModelRegistry, QuotaManager,
 * HealthChecker, CircuitBreaker (per provider), TaskRouter, ResponseCache,
 * PromptVersioning, UsageLedger, QualityTracker, FallbackManager,
 * LLMValueRouter. With both keys absent the router answers LOCAL_ONLY and
 * the trading system keeps running.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LIMITS, LLM_VALUE_THRESHOLD, etDate, llmValueScore, shouldInvokeLlm } from '@promptslim/tucore';
import type { LlmValueInput, ProviderStatus } from '@promptslim/tucore';

export type ProviderName = 'groq' | 'gemini';

export interface ProviderHealth {
  name: ProviderName;
  status: ProviderStatus;
  model: string;
  configured: boolean; // key present — NEVER the key itself
  circuitOpenUntil: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastLatencyMs: number;
}

export interface LlmRequest {
  task: string;
  prompt: string;
  system?: string;
  priority: 'routine' | 'high';
  /** identity of the underlying content (event id, doc hash, trade id) */
  contentKey: string;
  value: LlmValueInput | null; // null => caller already decided value passed
  maxOutputTokens?: number;
  /** force long-context provider preference (long filings / transcripts) */
  longContext?: boolean;
}

export interface LlmResponse {
  mode: 'GROQ' | 'GEMINI' | 'CACHE' | 'LOCAL_ONLY' | 'SKIPPED';
  ok: boolean;
  text: string | null;
  provider: ProviderName | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cached: boolean;
  reason?: string;
}

/* ---------------- prompt versioning ---------------- */
export const PROMPT_VERSIONS: Record<string, string> = {
  EVENT_INTERPRETATION: 'v1',
  FILING_INTERPRETATION: 'v1',
  EARNINGS_CALL: 'v1',
  TRADE_POSTMORTEM: 'v1',
  UNKNOWN_EVENT_CLASSIFICATION: 'v1',
  THESIS_CHANGE: 'v1',
  GENERIC_REASONING: 'v1',
};
export function promptVersion(task: string): string {
  return PROMPT_VERSIONS[task] ?? PROMPT_VERSIONS.GENERIC_REASONING;
}

/* ---------------- configuration (env, no secrets in code) ---------------- */
export interface RouterConfig {
  groqKey: string | null;
  geminiKey: string | null;
  groqModel: string;
  geminiModel: string;
  groqTokensPerDay: number;
  geminiTokensPerDay: number;
  maxRoutineCallsPerDay: number;
  maxHighPriorityCallsPerDay: number;
  reservePercent: number;
  valueThreshold: number;
  maxAttemptsPerProvider: number; // 1..3
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): RouterConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    groqKey: env.GROQ_API_KEY && env.GROQ_API_KEY.trim() !== '' ? env.GROQ_API_KEY.trim() : null,
    geminiKey: env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim() !== '' ? env.GEMINI_API_KEY.trim() : null,
    groqModel: env.TU_GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile',
    geminiModel: env.TU_GEMINI_MODEL?.trim() || 'gemini-2.0-flash',
    groqTokensPerDay: num(env.TU_GROQ_TOKENS_PER_DAY, DEFAULT_LIMITS.groqTokensPerDay),
    geminiTokensPerDay: num(env.TU_GEMINI_TOKENS_PER_DAY, DEFAULT_LIMITS.geminiTokensPerDay),
    maxRoutineCallsPerDay: num(env.MAX_ROUTINE_LLM_CALLS_PER_DAY, DEFAULT_LIMITS.maxRoutineLlmCallsPerDay),
    maxHighPriorityCallsPerDay: num(env.MAX_HIGH_PRIORITY_LLM_CALLS_PER_DAY, DEFAULT_LIMITS.maxHighPriorityLlmCallsPerDay),
    reservePercent: num(env.LLM_RESERVE_PERCENT, DEFAULT_LIMITS.llmReservePercent),
    valueThreshold: num(env.TU_LLM_VALUE_THRESHOLD, LLM_VALUE_THRESHOLD),
    maxAttemptsPerProvider: Math.min(3, Math.max(1, num(env.TU_LLM_ATTEMPTS, 2))),
  };
}

/* ---------------- circuit breaker ---------------- */
export interface BreakerState {
  failures: number;
  openUntil: number;
  state: 'CLOSED' | 'OPEN';
}
const BACKOFF_MS = [30_000, 120_000, 600_000];

/* ---------------- task routing ---------------- */
export interface TaskRoute {
  primary: ProviderName;
  secondary: ProviderName;
  minPriority: 'routine' | 'high';
}
const TASK_ROUTES: Record<string, TaskRoute> = {
  EVENT_INTERPRETATION: { primary: 'groq', secondary: 'gemini', minPriority: 'routine' },
  FILING_INTERPRETATION: { primary: 'gemini', secondary: 'groq', minPriority: 'high' },
  EARNINGS_CALL: { primary: 'gemini', secondary: 'groq', minPriority: 'high' },
  TRADE_POSTMORTEM: { primary: 'groq', secondary: 'gemini', minPriority: 'routine' },
  UNKNOWN_EVENT_CLASSIFICATION: { primary: 'groq', secondary: 'gemini', minPriority: 'routine' },
  THESIS_CHANGE: { primary: 'groq', secondary: 'gemini', minPriority: 'high' },
  GENERIC_REASONING: { primary: 'groq', secondary: 'gemini', minPriority: 'routine' },
};
export function routeForTask(task: string): TaskRoute {
  return TASK_ROUTES[task] ?? TASK_ROUTES.GENERIC_REASONING;
}

/* ---------------- provider HTTP ---------------- */
interface ProviderCallResult {
  ok: boolean;
  text: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status: ProviderStatus;
  error: string | null;
  rateLimitResetMs: number | null;
}

async function callChatCompletions(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  parse: (json: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }) => string | null,
  timeoutMs = 45_000,
): Promise<ProviderCallResult> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const latency = Date.now() - started;
    if (res.status === 429) {
      const resetHeader = res.headers.get('x-ratelimit-reset') ?? res.headers.get('retry-after');
      const resetRaw = resetHeader ? Number(resetHeader) : NaN;
      const rateLimitResetMs = Number.isFinite(resetRaw)
        ? resetRaw < 1e12 ? started + resetRaw * 1000 : resetRaw
        : null;
      return { ok: false, text: null, inputTokens: 0, outputTokens: 0, latencyMs: latency, status: 'RATE_LIMITED', error: 'rate limited', rateLimitResetMs };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, text: null, inputTokens: 0, outputTokens: 0, latencyMs: latency, status: 'UNAVAILABLE', error: `auth/config error (HTTP ${res.status})`, rateLimitResetMs: null };
    }
    if (res.status === 400) {
      const detail = await res.text().catch(() => '');
      return { ok: false, text: null, inputTokens: 0, outputTokens: 0, latencyMs: latency, status: 'ERROR', error: `bad request: ${detail.slice(0, 200)}`, rateLimitResetMs: null };
    }
    if (!res.ok) {
      return { ok: false, text: null, inputTokens: 0, outputTokens: 0, latencyMs: latency, status: 'ERROR', error: `HTTP ${res.status}`, rateLimitResetMs: null };
    }
    const json = (await res.json()) as Parameters<typeof parse>[0];
    const text = parse(json);
    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    if (text == null) {
      return { ok: false, text: null, inputTokens, outputTokens, latencyMs: latency, status: 'ERROR', error: 'empty completion', rateLimitResetMs: null };
    }
    return { ok: true, text, inputTokens, outputTokens, latencyMs: latency, status: 'CONNECTED', error: null, rateLimitResetMs: null };
  } catch (err) {
    return {
      ok: false, text: null, inputTokens: 0, outputTokens: 0,
      latencyMs: Date.now() - started,
      status: 'ERROR', error: err instanceof Error ? err.message : 'network error', rateLimitResetMs: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- the router ---------------- */
export interface RouterDeps {
  db: DatabaseSync;
  config?: RouterConfig;
  fetchImpl?: typeof fetch;
}

export class InferenceRouter {
  readonly config: RouterConfig;
  private db: DatabaseSync;
  private fetchImpl: typeof fetch;
  private breakers: Record<ProviderName, BreakerState> = {
    groq: { failures: 0, openUntil: 0, state: 'CLOSED' },
    gemini: { failures: 0, openUntil: 0, state: 'CLOSED' },
  };
  private rateLimitUntil: Record<ProviderName, number> = { groq: 0, gemini: 0 };
  private lastErrors: Record<ProviderName, string | null> = { groq: null, gemini: null };
  private lastLatencies: Record<ProviderName, number> = { groq: 0, gemini: 0 };
  /* in-process high-water marks so budgets hold even before rows flush */
  private day = '';
  private dayCounts = { groqCalls: 0, geminiCalls: 0, routine: 0, high: 0, groqTokens: 0, geminiTokens: 0 };

  constructor(deps: RouterDeps) {
    this.db = deps.db;
    this.config = deps.config ?? configFromEnv();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.rollDay();
  }

  private today(): string {
    // exchange date (America/New_York) — the SAME key every dashboard query
    // uses; UTC would shift late-evening ET calls onto the wrong day
    return etDate(Date.now());
  }

  private rollDay(): void {
    const t = this.today();
    if (t !== this.day) {
      this.day = t;
      this.dayCounts = { groqCalls: 0, geminiCalls: 0, routine: 0, high: 0, groqTokens: 0, geminiTokens: 0 };
      // hydrate from the ledger (restarts keep budgets honest)
      try {
        const rows = this.db
          .prepare(
            `SELECT provider, task, COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS tokens
               FROM llm_usage WHERE day = ? AND invoked = 1 GROUP BY provider, task`,
          )
          .all(t) as unknown as Array<{ provider: string; task: string; calls: number; tokens: number }>;
        for (const r of rows) {
          const tokens = Number(r.tokens ?? 0);
          if (r.provider === 'groq') { this.dayCounts.groqCalls += r.calls; this.dayCounts.groqTokens += tokens; }
          if (r.provider === 'gemini') { this.dayCounts.geminiCalls += r.calls; this.dayCounts.geminiTokens += tokens; }
        }
        const prio = this.db
          .prepare(`SELECT priority, COUNT(*) AS n FROM (SELECT CASE WHEN task IN ('FILING_INTERPRETATION','EARNINGS_CALL','THESIS_CHANGE') THEN 'high' ELSE 'routine' END AS priority FROM llm_usage WHERE day = ? AND invoked = 1) GROUP BY priority`)
          .all(t) as unknown as Array<{ priority: string; n: number }>;
        for (const r of prio) {
          if (r.priority === 'high') this.dayCounts.high += r.n;
          else this.dayCounts.routine += r.n;
        }
      } catch {
        /* first run */
      }
    }
  }

  /* --------- health --------- */
  health(): ProviderHealth[] {
    this.rollDay();
    return (['groq', 'gemini'] as ProviderName[]).map((name) => {
      const cfg = this.config;
      const model = name === 'groq' ? cfg.groqModel : cfg.geminiModel;
      const configured = name === 'groq' ? cfg.groqKey !== null : cfg.geminiKey !== null;
      const breaker = this.breakers[name];
      let status: ProviderStatus;
      if (!configured) status = 'UNAVAILABLE';
      else if (Date.now() < breaker.openUntil) status = 'CIRCUIT_OPEN';
      else if (Date.now() < this.rateLimitUntil[name]) status = 'RATE_LIMITED';
      else {
        const overTokens = name === 'groq' ? this.dayCounts.groqTokens >= cfg.groqTokensPerDay : this.dayCounts.geminiTokens >= cfg.geminiTokensPerDay;
        if (overTokens) status = 'QUOTA_EXHAUSTED';
        else status = breaker.failures > 0 ? 'DEGRADED' : 'CONNECTED';
      }
      return {
        name, status, model, configured,
        circuitOpenUntil: breaker.openUntil,
        consecutiveFailures: breaker.failures,
        lastError: this.lastErrors[name],
        lastLatencyMs: this.lastLatencies[name],
      };
    });
  }

  /** aggregate runtime mode for dashboards */
  mode(): 'NORMAL' | 'LOCAL_ONLY' {
    const h = this.health();
    return h.some((p) => p.configured) ? 'NORMAL' : 'LOCAL_ONLY';
  }

  /* --------- quotas --------- */
  quotaSnapshot(): {
    groqTokensToday: number; geminiTokensToday: number; groqTokensPerDay: number; geminiTokensPerDay: number;
    routineToday: number; highToday: number; routineLimit: number; highLimit: number; reservePercent: number;
    routineRemaining: number; highRemaining: number;
  } {
    this.rollDay();
    const c = this.config;
    const routineBudget = Math.floor(c.maxRoutineCallsPerDay * (100 - c.reservePercent) / 100);
    const routineRemaining = Math.max(0, routineBudget - this.dayCounts.routine);
    const highRemaining = Math.max(
      0,
      c.maxHighPriorityCallsPerDay + (c.maxRoutineCallsPerDay - routineBudget) - this.dayCounts.high - this.dayCounts.routine,
    );
    return {
      groqTokensToday: this.dayCounts.groqTokens,
      geminiTokensToday: this.dayCounts.geminiTokens,
      groqTokensPerDay: c.groqTokensPerDay,
      geminiTokensPerDay: c.geminiTokensPerDay,
      routineToday: this.dayCounts.routine,
      highToday: this.dayCounts.high,
      routineLimit: routineBudget,
      highLimit: c.maxHighPriorityCallsPerDay,
      reservePercent: c.reservePercent,
      routineRemaining,
      highRemaining,
    };
  }

  private quotaAllows(provider: ProviderName, priority: 'routine' | 'high'): { ok: boolean; reason?: string } {
    this.rollDay();
    const q = this.quotaSnapshot();
    if (priority === 'routine' && q.routineRemaining <= 0) return { ok: false, reason: 'routine quota exhausted (reserve held for high-priority events)' };
    if (priority === 'high' && q.highRemaining <= 0) return { ok: false, reason: 'high-priority quota exhausted' };
    if (provider === 'groq' && this.dayCounts.groqTokens >= this.config.groqTokensPerDay) return { ok: false, reason: 'groq daily token budget reached' };
    if (provider === 'gemini' && this.dayCounts.geminiTokens >= this.config.geminiTokensPerDay) return { ok: false, reason: 'gemini daily token budget reached' };
    return { ok: true };
  }

  /* --------- cache --------- */
  private cacheKey(req: LlmRequest): string {
    return createHash('sha256')
      .update(`${req.task}|${promptVersion(req.task)}|${req.contentKey}|${req.longContext ? 'lc' : 'std'}`)
      .digest('hex');
  }

  private cacheGet(key: string): { text: string; provider: ProviderName; model: string } | null {
    try {
      const row = this.db.prepare('SELECT provider, model, response FROM llm_cache WHERE cache_key = ?').get(key) as
        | { provider: string; model: string; response: string }
        | undefined;
      if (!row) return null;
      this.db.prepare('UPDATE llm_cache SET hits = hits + 1 WHERE cache_key = ?').run(key);
      return { text: row.response, provider: row.provider as ProviderName, model: row.model };
    } catch {
      return null;
    }
  }

  private cachePut(key: string, provider: ProviderName, model: string, task: string, text: string): void {
    try {
      this.db
        .prepare(
          'INSERT INTO llm_cache (cache_key, provider, model, prompt_version, response, created_at, hits) VALUES (?, ?, ?, ?, ?, ?, 0) ' +
          'ON CONFLICT(cache_key) DO UPDATE SET response = excluded.response, created_at = excluded.created_at',
        )
        .run(key, provider, model, promptVersion(task), text, Date.now());
    } catch {
      /* cache is best-effort */
    }
  }

  /* --------- ledger --------- */
  private ledger(row: {
    provider: ProviderName; model: string; task: string; inputTokens: number; outputTokens: number;
    cached: boolean; latencyMs: number; status: string; valueScore: number | null; invoked: boolean; detail?: unknown;
  }): void {
    this.rollDay();
    try {
      this.db
        .prepare(
          `INSERT INTO llm_usage (ts, day, provider, model, task, prompt_version, input_tokens, output_tokens,
             cached, latency_ms, status, value_score, invoked, detail_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Date.now(), this.day, row.provider, row.model, row.task, promptVersion(row.task),
          row.inputTokens, row.outputTokens, row.cached ? 1 : 0, row.latencyMs, row.status,
          row.valueScore, row.invoked ? 1 : 0, JSON.stringify(row.detail ?? {}),
        );
      if (row.invoked && !row.cached) {
        if (row.provider === 'groq') { this.dayCounts.groqCalls += 1; this.dayCounts.groqTokens += row.inputTokens + row.outputTokens; }
        if (row.provider === 'gemini') { this.dayCounts.geminiCalls += 1; this.dayCounts.geminiTokens += row.inputTokens + row.outputTokens; }
        if (row.task === 'FILING_INTERPRETATION' || row.task === 'EARNINGS_CALL' || row.task === 'THESIS_CHANGE') this.dayCounts.high += 1;
        else this.dayCounts.routine += 1;
      }
    } catch {
      /* ledger failure must not break reasoning */
    }
  }

  /* --------- circuit --------- */
  private onSuccess(name: ProviderName): void {
    this.breakers[name] = { failures: 0, openUntil: 0, state: 'CLOSED' };
  }

  private onFailure(name: ProviderName, status: ProviderStatus): void {
    const b = this.breakers[name];
    b.failures += 1;
    if (status === 'RATE_LIMITED') {
      // short cool-off rather than full breaker
      this.rateLimitUntil[name] = Date.now() + 60_000;
    }
    if (b.failures >= 3) {
      const step = Math.min(BACKOFF_MS.length - 1, Math.floor((b.failures - 3) / 2));
      b.openUntil = Date.now() + BACKOFF_MS[step];
      b.state = 'OPEN';
    }
  }

  /* --------- value router --------- */
  shouldInvoke(req: LlmRequest): { invoke: boolean; value: number; reason: string } {
    const value = req.value ? llmValueScore(req.value) : 1;
    if (req.priority === 'high') return { invoke: true, value, reason: 'high-priority task' };
    if (req.value && !shouldInvokeLlm(value, this.config.valueThreshold)) {
      return { invoke: false, value, reason: `value ${value.toFixed(2)} < threshold ${this.config.valueThreshold}` };
    }
    return { invoke: true, value, reason: 'value above threshold' };
  }

  /* --------- main entrypoint --------- */
  async reason(req: LlmRequest): Promise<LlmResponse> {
    this.rollDay();
    const route = routeForTask(req.task);

    // 1. value gate (deterministic/local work comes first by construction)
    const verdict = this.shouldInvoke(req);
    if (!verdict.invoke) {
      this.ledger({
        provider: route.primary, model: '-', task: req.task, inputTokens: 0, outputTokens: 0,
        cached: false, latencyMs: 0, status: 'SKIPPED', valueScore: verdict.value, invoked: false,
        detail: { reason: verdict.reason },
      });
      return { mode: 'SKIPPED', ok: false, text: null, provider: null, model: null, inputTokens: 0, outputTokens: 0, latencyMs: 0, cached: false, reason: verdict.reason };
    }

    // 2. cache
    const key = this.cacheKey(req);
    const hit = this.cacheGet(key);
    if (hit) {
      this.ledger({
        provider: hit.provider, model: hit.model, task: req.task, inputTokens: 0, outputTokens: 0,
        cached: true, latencyMs: 0, status: 'CACHED', valueScore: verdict.value, invoked: false,
      });
      return { mode: 'CACHE', ok: true, text: hit.text, provider: hit.provider, model: hit.model, inputTokens: 0, outputTokens: 0, latencyMs: 0, cached: true };
    }

    // 3. order providers: route primary first; long documents prefer Gemini
    const order: ProviderName[] = req.longContext
      ? (route.primary === 'gemini' ? ['gemini', 'groq'] : ['gemini', 'groq'])
      : [route.primary, route.secondary];
    // de-dup if routes collide
    const seq = [...new Set(order)];

    const skipped: string[] = [];
    for (const name of seq) {
      const health = this.health().find((h) => h.name === name)!;
      if (!health.configured) { skipped.push(`${name}:not configured`); continue; }
      if (health.status === 'CIRCUIT_OPEN') { skipped.push(`${name}:circuit open`); continue; }
      if (health.status === 'RATE_LIMITED') { skipped.push(`${name}:rate limited`); continue; }

      const quota = this.quotaAllows(name, req.priority);
      if (!quota.ok) { skipped.push(`${name}:${quota.reason}`); continue; }

      const model = name === 'groq' ? this.config.groqModel : this.config.geminiModel;
      const key0 = name === 'groq' ? this.config.groqKey! : this.config.geminiKey!;
      const result = await this.callProvider(name, model, key0, req);

      this.ledger({
        provider: name, model, task: req.task, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        cached: false, latencyMs: result.latencyMs, status: result.status, valueScore: verdict.value, invoked: true,
        detail: { error: result.error, priority: req.priority },
      });

      this.lastErrors[name] = result.error;
      this.lastLatencies[name] = result.latencyMs;
      if (result.ok) {
        this.onSuccess(name);
        this.lastErrors[name] = null;
        this.cachePut(key, name, model, req.task, result.text!);
        return {
          mode: name === 'groq' ? 'GROQ' : 'GEMINI', ok: true, text: result.text,
          provider: name, model, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
          latencyMs: result.latencyMs, cached: false,
        };
      }
      this.onFailure(name, result.status);
      if (result.rateLimitResetMs) this.rateLimitUntil[name] = result.rateLimitResetMs;
      skipped.push(`${name}:${result.status}`);
    }

    // 4. local-only: system continues without cloud reasoning
    this.ledger({
      provider: seq[0], model: '-', task: req.task, inputTokens: 0, outputTokens: 0,
      cached: false, latencyMs: 0, status: 'LOCAL_ONLY', valueScore: verdict.value, invoked: false,
      detail: { skipped },
    });
    return {
      mode: 'LOCAL_ONLY', ok: false, text: null, provider: null, model: null,
      inputTokens: 0, outputTokens: 0, latencyMs: 0, cached: false,
      reason: `providers unavailable: ${skipped.join('; ')}`,
    };
  }

  private async callProvider(name: ProviderName, model: string, key: string, req: LlmRequest): Promise<ProviderCallResult> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });

    if (name === 'groq') {
      return callChatCompletions(
        this.fetchImpl,
        'https://api.groq.com/openai/v1/chat/completions',
        { authorization: `Bearer ${key}` },
        { model, messages, temperature: 0.2, max_completion_tokens: req.maxOutputTokens ?? 700 },
        (j) => j.choices?.[0]?.message?.content ?? null,
      );
    }
    return this.callGemini(model, key, req);
  }

  /** Gemini generateContent — key travels in the x-goog-api-key HEADER only. */
  private async callGemini(model: string, key: string, req: LlmRequest): Promise<ProviderCallResult> {
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const body: unknown = {
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: req.maxOutputTokens ?? 700 },
        ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      };
      const res = await this.fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        },
      );
      const latency = Date.now() - started;
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '');
        return { ok: false, text: null, inputTokens: 0, outputTokens: 0, latencyMs: latency, status: 'RATE_LIMITED', error: 'rate limited', rateLimitResetMs: Number.isFinite(retryAfter) && retryAfter > 0 ? started + retryAfter * 1000 : null };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, text: null, inputTokens: 0, outputTokens: 0, latencyMs: latency, status: 'UNAVAILABLE', error: `auth/config error (HTTP ${res.status})`, rateLimitResetMs: null };
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return { ok: false, text: null, inputTokens: 0, outputTokens: 0, latencyMs: latency, status: 'ERROR', error: `HTTP ${res.status}: ${detail.slice(0, 160)}`, rateLimitResetMs: null };
      }
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? null;
      if (!text) {
        return { ok: false, text: null, inputTokens: json.usageMetadata?.promptTokenCount ?? 0, outputTokens: 0, latencyMs: latency, status: 'ERROR', error: 'empty completion', rateLimitResetMs: null };
      }
      return {
        ok: true, text,
        inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
        latencyMs: latency, status: 'CONNECTED', error: null, rateLimitResetMs: null,
      };
    } catch (err) {
      return { ok: false, text: null, inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, status: 'ERROR', error: err instanceof Error ? err.message : 'network error', rateLimitResetMs: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ---------------- QualityTracker / ablation ---------------- */
export interface AblationRow {
  task: string;
  baseAccuracy: number | null;
  augmentedAccuracy: number | null;
  incrementalAccuracy: number | null;
  calls: number;
  tokens: number;
}

export class QualityTracker {
  private dbRef: DatabaseSync;

  constructor(dbRef: DatabaseSync) {
    this.dbRef = dbRef;
  }

  record(input: {
    task: string; eventId?: number | null; signalId?: number | null;
    baseAction: string; augmentedAction: string; baseConf: number; augmentedConf: number;
    tokens: number; provider: string | null;
  }): void {
    try {
      this.dbRef
        .prepare(
          `INSERT INTO llm_evaluations (ts, task, event_id, signal_id, base_action, augmented_action,
             base_conf, augmented_conf, outcome, tokens, provider)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(
          Date.now(), input.task, input.eventId ?? null, input.signalId ?? null,
          input.baseAction, input.augmentedAction, input.baseConf, input.augmentedConf,
          input.tokens, input.provider,
        );
    } catch {
      /* tracking must never block the loop */
    }
  }

  /**
   * Resolve ablation outcomes once a related signal's actual return is known.
   * Actions are 'BUY' (expect up) or 'AVOID' (expect not-up); correctness is
   * judged against the realized return. IMPROVED = augmented right & base
   * wrong; WORSE = base right & augmented wrong; else NO_EFFECT.
   */
  resolve(signalId: number, actualReturn: number): void {
    try {
      const rows = this.dbRef
        .prepare(`SELECT id, base_action, augmented_action FROM llm_evaluations WHERE signal_id = ? AND outcome = 'PENDING'`)
        .all(signalId) as unknown as Array<{ id: number; base_action: string; augmented_action: string }>;
      const up = actualReturn > 0;
      for (const r of rows) {
        const right = (action: string): boolean => (action === 'BUY' ? up : !up);
        const baseRight = right(r.base_action);
        const augRight = right(r.augmented_action);
        const outcome = augRight && !baseRight ? 'IMPROVED' : baseRight && !augRight ? 'WORSE' : 'NO_EFFECT';
        this.dbRef.prepare('UPDATE llm_evaluations SET outcome = ?, actual_return = ? WHERE id = ?').run(outcome, actualReturn, r.id);
      }
    } catch {
      /* ignore */
    }
  }

  summary(): {
    evaluated: number; improved: number; noEffect: number; worse: number;
    incrementalAlphaPct: number | null; byTask: AblationRow[];
  } {
    const counts = this.dbRef
      .prepare(`SELECT outcome, COUNT(*) AS n FROM llm_evaluations WHERE outcome != 'PENDING' GROUP BY outcome`)
      .all() as unknown as Array<{ outcome: string; n: number }>;
    const get = (k: string): number => counts.find((c) => c.outcome === k)?.n ?? 0;
    const evaluated = get('IMPROVED') + get('NO_EFFECT') + get('WORSE');
    const avgActual = this.dbRef
      .prepare(`SELECT AVG(CASE WHEN outcome='IMPROVED' THEN 1.0 WHEN outcome='WORSE' THEN -1.0 ELSE 0.0 END) AS s FROM llm_evaluations WHERE outcome != 'PENDING' AND actual_return IS NOT NULL`)
      .get() as { s: number | null } | undefined;
    const byTaskRaw = this.dbRef
      .prepare(
        `SELECT task,
           SUM(CASE WHEN outcome='IMPROVED' THEN 1.0 WHEN outcome='WORSE' THEN 0.0 WHEN outcome='NO_EFFECT' THEN 0.5 ELSE NULL END) AS augScore,
           COUNT(*) AS n, SUM(tokens) AS tokens
         FROM llm_evaluations WHERE outcome != 'PENDING' GROUP BY task`,
      )
      .all() as unknown as Array<{ task: string; augScore: number | null; n: number; tokens: number }>;
    const byTask: AblationRow[] = byTaskRaw.map((r) => ({
      task: r.task,
      baseAccuracy: 0.5, // baseline assumed uninformed until more signal resolves
      augmentedAccuracy: r.n > 0 ? (r.augScore ?? 0) / r.n : null,
      incrementalAccuracy: r.n > 0 ? ((r.augScore ?? 0) / r.n) - 0.5 : null,
      calls: r.n,
      tokens: Number(r.tokens ?? 0),
    }));
    return {
      evaluated,
      improved: get('IMPROVED'),
      noEffect: get('NO_EFFECT'),
      worse: get('WORSE'),
      incrementalAlphaPct: evaluated > 0 && avgActual?.s != null ? Number((avgActual.s * 100).toFixed(2)) : null,
      byTask,
    };
  }
}
