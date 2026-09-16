/**
 * LLM connect — DOM-free provider adapters, response normalization and smart
 * model routing. Runs anywhere fetch exists: the org server (governed chat
 * gateway) and later the extension. No keys here — callers pass them in.
 */

import type { ModelEntry } from '@promptslim/shared-types';

/* ---------------- provider endpoints ---------------- */

export type ProviderStyle = 'openai' | 'anthropic' | 'google';

interface ProviderEndpoint {
  style: ProviderStyle;
  base: string;
}

/** Where each catalog provider's API actually lives. `apiBase` on a model
 *  entry (models.json) overrides base — that is how an org points a catalog
 *  id at its own Azure/Bedrock gateway without touching code. */
const PROVIDERS: Record<string, ProviderEndpoint> = {
  OpenAI: { style: 'openai', base: 'https://api.openai.com/v1' },
  Anthropic: { style: 'anthropic', base: 'https://api.anthropic.com/v1' },
  Google: { style: 'google', base: 'https://generativelanguage.googleapis.com/v1beta' },
  DeepSeek: { style: 'openai', base: 'https://api.deepseek.com/v1' },
  Qwen: { style: 'openai', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  Mistral: { style: 'openai', base: 'https://api.mistral.ai/v1' },
  Meta: { style: 'openai', base: 'https://api.llama.com/compat/v1' },
};

export function providerEndpoint(model: ModelEntry): ProviderEndpoint & { base: string } {
  const p = PROVIDERS[model.provider];
  if (!p) throw new Error(`no API adapter for provider "${model.provider}"`);
  return { ...p, base: model.apiBase?.replace(/\/$/, '') ?? p.base };
}

export interface ChatRequestPlan {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: unknown;
}

/** One turn of a chat thread (assistant turns come back from the model). */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Build the HTTP request that sends `messages` to `model` (pure; testable). */
export function planChatRequest(
  model: ModelEntry,
  apiKey: string,
  messages: ChatMessage[],
  maxTokens: number,
): ChatRequestPlan {
  const { style, base } = providerEndpoint(model);
  const apiModel = model.apiModel ?? model.id;
  if (style === 'anthropic') {
    return {
      url: `${base}/messages`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: { model: apiModel, max_tokens: maxTokens, messages },
    };
  }
  if (style === 'google') {
    return {
      url: `${base}/models/${encodeURIComponent(apiModel)}:generateContent`,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: {
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: maxTokens },
      },
    };
  }
  return {
    url: `${base}/chat/completions`,
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: { model: apiModel, max_tokens: maxTokens, messages },
  };
}

export interface ChatResult {
  text: string;
  /** Exact token counts as reported by the provider (method = 'exact' downstream). */
  inputTokens: number;
  outputTokens: number;
}

export function parseChatResponse(style: ProviderStyle, status: number, payload: unknown): ChatResult {
  const p = (payload ?? {}) as Record<string, any>;
  if (status < 200 || status >= 300) {
    const msg =
      p?.error?.message ?? p?.error?.msg ?? p?.message ??
      (typeof p?.error === 'string' ? p.error : undefined);
    throw new Error(`provider HTTP ${status}${msg ? `: ${msg}` : ''}`);
  }
  if (style === 'anthropic') {
    const text = Array.isArray(p.content)
      ? p.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
      : '';
    return {
      text,
      inputTokens: Number(p?.usage?.input_tokens ?? 0),
      outputTokens: Number(p?.usage?.output_tokens ?? 0),
    };
  }
  if (style === 'google') {
    const cand = p?.candidates?.[0];
    const text = Array.isArray(cand?.content?.parts)
      ? cand.content.parts.map((x: any) => x?.text ?? '').join('')
      : '';
    const meta = p?.usageMetadata ?? {};
    return {
      text,
      inputTokens: Number(meta.promptTokenCount ?? 0),
      outputTokens: Number(meta.candidatesTokenCount ?? 0),
    };
  }
  const text = p?.choices?.[0]?.message?.content ?? '';
  const usage = p?.usage ?? {};
  return {
    text,
    inputTokens: Number(usage.prompt_tokens ?? 0),
    outputTokens: Number(usage.completion_tokens ?? 0),
  };
}

export interface SendChatOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** One governed chat round-trip against a live provider. */
export async function sendChat(
  model: ModelEntry,
  apiKey: string,
  messages: ChatMessage[],
  maxTokens: number,
  opts: SendChatOptions = {},
): Promise<ChatResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const plan = planChatRequest(model, apiKey, messages, maxTokens);
  const { style } = providerEndpoint(model);
  const res = await doFetch(plan.url, {
    method: plan.method,
    headers: plan.headers,
    body: JSON.stringify(plan.body),
    signal: opts.signal,
  });
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error body */
  }
  return parseChatResponse(style, res.status, payload);
}

/* ---------------- smart model routing (AUTO) ---------------- */

export interface RouteInput {
  /** estimated input tokens of the query (as sent, post-optimization) */
  inputTokens: number;
  /** projected output tokens (token-counter projection or user override) */
  expectedOutputTokens: number;
}

export interface RouteDecision {
  model: ModelEntry;
  /** human-readable, deterministic explanation shown in the UI */
  reason: string;
  scores: Array<{ model: ModelEntry; score: number; cost: number; capability: number; context: number }>;
}

/** Weighted 3-axis score across the catalog — cost, output capability,
 *  context headroom. Deterministic math only: no remote LLM in the routing
 *  path. Capability uses the price tier as its only honest proxy (models that
 *  charge more per output token are the provider's stronger tier), on a LOG
 *  scale because tier cliffs are perceived geometrically ($1 → $15 is a
 *  bigger jump than $15 → $50); the UI labels it exactly that way. Cost is
 *  the dominant axis (0.5) so AUTO lands mid-tier — not the flagship —
 *  unless capability is genuinely bought. */
export function routeModel(catalog: ModelEntry[], input: RouteInput): RouteDecision {
  const need = input.inputTokens + input.expectedOutputTokens;
  const eligible = catalog.filter((m) => m.contextWindow >= need * 1.1);
  const pool = eligible.length > 0 ? eligible : catalog;

  const costs = pool.map((m) =>
    (input.inputTokens / 1e6) * m.inputPricePerMillionTokens +
    (input.expectedOutputTokens / 1e6) * m.outputPricePerMillionTokens,
  );
  // log-scaled capability proxy: price per output token, magnitude matters
  const caps = pool.map((m) => Math.log10(Math.max(m.outputPricePerMillionTokens, 0.01)));
  const ctxs = pool.map((m) => m.contextWindow);
  const minC = Math.min(...costs), maxC = Math.max(...costs);
  const minK = Math.min(...caps), maxK = Math.max(...caps);
  const minX = Math.min(...ctxs), maxX = Math.max(...ctxs);

  const scored = pool.map((m, i) => {
    const norm = (v: number, lo: number, hi: number) => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
    const cost = 1 - norm(costs[i], minC, maxC); // cheaper scores higher
    const capability = norm(caps[i], minK, maxK); // stronger tier scores higher
    const context = norm(ctxs[i], minX, maxX); // bigger window scores higher
    return { model: m, score: 0.5 * cost + 0.35 * capability + 0.15 * context, cost, capability, context };
  });
  scored.sort((a, b) => b.score - a.score || a.model.inputPricePerMillionTokens - b.model.inputPricePerMillionTokens);
  const top = scored[0];
  const ctxNote =
    eligible.length > 0 && eligible.length < catalog.length
      ? ` · ${catalog.length - eligible.length} models excluded: context too small for this query`
      : '';
  return {
    model: top.model,
    reason:
      `balanced ${top.model.provider} ${top.model.modelName} (cost ${Math.round(top.cost * 100)} · capability ${Math.round(top.capability * 100)} · context ${Math.round(top.context * 100)})${ctxNote}`,
    scores: scored,
  };
}
