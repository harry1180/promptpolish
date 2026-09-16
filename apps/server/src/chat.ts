import type { DatabaseSync } from 'node:sqlite';
import { getModel, catalog } from '@promptslim/model-config';
import { estimateTokens, estimateOutputTokens } from '@promptslim/token-counter';
import { inputCostPerRequest, requestCost } from '@promptslim/pricing-engine';
import { governQuery, type GovernanceVerdict } from '@promptslim/governance';
import { routeModel, sendChat, type ChatMessage } from '@promptslim/llm-connect';
import type { ChatResponse, ModelEntry } from '@promptslim/shared-types';
import type { KeyVault } from './keys.ts';
import { insertEvent, parseTags, type UserRow } from './db.ts';

/**
 * Governed LLM chat gateway.
 *
 * Every interactive turn passes through the SAME Action-Firewall the local
 * optimizer uses (packages/governance), gets smart-routed when modelId is
 * "auto", is sent to the provider with the user's own stored key, and is
 * recorded as a tag-snapshotted usage event with EXACT provider token counts.
 *
 * Fail-closed verdict ladder for chat (worst of: new turn vs whole thread):
 *   allow           → send
 *   review          → send (regulated-intent caveat surfaced in meta)
 *   redact-required → refuse: PII must be removed first (run the redactor)
 *   block           → refuse: guardrail hit; nothing leaves the server
 *
 * Provider keys: decrypted for this call only, never logged, never returned.
 */

const MAX_PROMPT_CHARS = 200_000;
const MAX_COMPLETION_TOKENS = 4096;

const VERDICT_RANK: Record<GovernanceVerdict, number> = {
  allow: 0, review: 1, 'redact-required': 2, block: 3,
};
function worseVerdict(a: GovernanceVerdict, b: GovernanceVerdict): GovernanceVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

export interface ChatGatewayResult {
  status: number;
  body: unknown;
}

/* sliding-window rate limit per user (requests/min) */
const window = new Map<number, number[]>();
function rateLimited(userId: number, perMin = 20): boolean {
  const now = Date.now();
  const hits = (window.get(userId) ?? []).filter((t) => now - t < 60_000);
  hits.push(now);
  window.set(userId, hits);
  return hits.length > perMin;
}

export interface ChatGatewayOptions {
  fetchImpl?: typeof fetch;
}

export async function handleChat(
  db: DatabaseSync,
  vault: KeyVault,
  user: UserRow,
  body: Record<string, unknown>,
  opts: ChatGatewayOptions = {},
): Promise<ChatGatewayResult> {
  /* ---- thread + bounds ---- */
  const rawMsgs = Array.isArray(body.messages) ? body.messages : [];
  const messages: ChatMessage[] = [];
  for (const m of rawMsgs.slice(-21)) {
    const role = (m as ChatMessage)?.role === 'assistant' ? 'assistant' : 'user';
    const content = String((m as ChatMessage)?.content ?? '');
    if (content.trim()) messages.push({ role, content });
  }
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (!lastUser.trim()) return { status: 400, body: { errors: ['a user message is required'] } };
  const transcriptChars = messages.reduce((s, m) => s + m.content.length, 0);
  if (transcriptChars > MAX_PROMPT_CHARS) {
    return { status: 400, body: { errors: [`thread exceeds ${MAX_PROMPT_CHARS.toLocaleString()} chars — start a new chat`] } };
  }
  if (rateLimited(user.id)) {
    return { status: 429, body: { errors: ['rate limit: 20 chat requests/minute per account'] } };
  }

  /* ---- governance gate: new turn AND accumulated user thread are screened
   *      before anything leaves this server (fail-closed) ---- */
  const gov = governQuery(lastUser);
  const govThread = governQuery(
    messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n'),
  );
  const verdict = worseVerdict(gov.verdict, govThread.verdict);
  if (verdict === 'block' || verdict === 'redact-required') {
    // audit line (stdout; ship-proof to a real audit sink in Phase 4)
    console.log(`chat-blocked user=${user.id} verdict=${verdict} reasons=${[...gov.reasons, ...govThread.reasons].join(';')}`);
    return {
      status: 403,
      body: {
        errors: [
          verdict === 'block'
            ? `Blocked by governance: ${gov.reasons[0] ?? govThread.reasons[0] ?? 'guardrail hit'}. The query was not sent anywhere.`
            : `PII detected (${gov.reasons[0] ?? govThread.reasons[0] ?? 'sensitive data'}) — use the one-click redact in the optimizer, or remove it, before asking the LLM.`,
        ],
        verdict,
      },
    };
  }

  /* ---- model choice: explicit catalog id, or AUTO routing ---- */
  const requested = String(body.modelId ?? 'auto');
  let model: ModelEntry | undefined;
  let routed = false;
  let routeReason: string | undefined;
  if (requested === 'auto') {
    const estIn = estimateTokens(transcriptText(messages), 'heuristic').tokens;
    const estOut = estimateOutputTokens(lastUser, catalog.models[0]!.id).tokens;
    // route only among providers the user actually has a key for (a model
    // you cannot call is not a route); with no keys, keep the full catalog
    // so the follow-up error message stays actionable.
    const owned = new Set(vault.list(user.id).map((k) => k.provider));
    const pool = catalog.models.filter((m) => owned.has(m.provider));
    const decision = routeModel(pool.length > 0 ? pool : catalog.models, {
      inputTokens: estIn,
      expectedOutputTokens: estOut,
    });
    model = decision.model;
    routed = true;
    routeReason =
      pool.length > 0 ? decision.reason : `no provider keys saved — ${decision.reason}`;
  } else {
    model = getModel(requested);
    if (!model) return { status: 400, body: { errors: [`unknown modelId "${requested}" — pick from the catalog or use auto`] } };
  }

  const apiKey = vault.get(user.id, model.provider);
  if (!apiKey) {
    return {
      status: 400,
      body: { errors: [`No API key saved for ${model.provider}. Add one under “Bring your own keys”.`] },
    };
  }

  /* ---- send to provider (exact usage comes back in the response) ---- */
  const estInput = estimateTokens(transcriptText(messages), model.tokenizerType).tokens;
  const maxTokens = Math.min(MAX_COMPLETION_TOKENS, Math.max(256, model.contextWindow - estInput));
  let result;
  try {
    result = await sendChat(model, apiKey, messages, maxTokens, { fetchImpl: opts.fetchImpl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'provider call failed';
    return { status: 502, body: { errors: [`${model.provider} error: ${msg}`] } };
  }

  const inputTokens = result.inputTokens > 0 ? result.inputTokens : estInput;
  const outputTokens = result.outputTokens;
  const actualCost = requestCost(model, inputTokens, outputTokens);

  /* ---- attribution: what the optimizer saved on this real call ---- */
  const rawTokens = Number(body.originalTokens);
  const originalTokens =
    Number.isInteger(rawTokens) && rawTokens >= estInput ? Math.min(rawTokens, 100_000_000) : estInput;
  const savingsUsd = body.sentWasOptimized === true
    ? Math.max(0, inputCostPerRequest(model, originalTokens) - inputCostPerRequest(model, estInput))
    : null;

  /* ---- usage event: tag snapshot, exact counts, real spend ---- */
  insertEvent(db, {
    user_id: user.id, ts: Date.now(), model_id: model.id,
    level: 'balanced', original_tokens: originalTokens, optimized_tokens: estInput,
    from_cache: 0,
    cost_original_usd: inputCostPerRequest(model, originalTokens),
    cost_optimized_usd: inputCostPerRequest(model, estInput),
    tags_json: JSON.stringify(parseTags(user.tags_json)),
    source: 'chat', output_tokens: outputTokens, actual_cost_usd: actualCost,
  });

  const meta: ChatResponse['meta'] = {
    modelId: model.id, provider: model.provider, modelName: model.modelName,
    routed, routeReason,
    inputTokens, outputTokens,
    costUsd: actualCost, savingsUsd,
    governance: verdict,
  };
  return { status: 200, body: { text: result.text, meta } satisfies ChatResponse };
}

/** Flatten the thread for token estimation (roles cost a handful of tokens
 *  each; the heuristic doesn't model chat framing, so add a small per-turn
 *  overhead — honest enough for routing/attribution math). */
function transcriptText(messages: ChatMessage[]): string {
  return messages.map((m) => m.content).join('\n\n');
}
