import { describe, expect, it, vi } from 'vitest';
import type { ModelEntry } from '@promptslim/shared-types';
import { parseChatResponse, planChatRequest, providerEndpoint, routeModel, sendChat } from '../src/index';

const m = (over: Partial<ModelEntry>): ModelEntry => ({
  id: 'x', provider: 'OpenAI', modelName: 'X',
  inputPricePerMillionTokens: 1, outputPricePerMillionTokens: 10,
  contextWindow: 100_000, tokenizerType: 'heuristic', lastUpdated: '2026-09-15',
  ...over,
});
const msg = (text: string) => [{ role: 'user' as const, content: text }];

describe('planChatRequest — wire formats', () => {
  it('openai style: /chat/completions, bearer auth, messages array', () => {
    const p = planChatRequest(m({ provider: 'OpenAI' }), 'key-test', msg('hello'), 512);
    expect(p.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(p.headers.authorization).toBe('Bearer key-test');
    expect((p.body as any).messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect((p.body as any).max_tokens).toBe(512);
  });

  it('deepseek/qwen/mistral/meta reuse the openai style with their own bases', () => {
    expect(planChatRequest(m({ provider: 'DeepSeek' }), 'k', msg('q'), 8).url)
      .toBe('https://api.deepseek.com/v1/chat/completions');
    expect(providerEndpoint(m({ provider: 'Qwen' })).base).toContain('dashscope');
    expect(providerEndpoint(m({ provider: 'Mistral' })).style).toBe('openai');
    expect(providerEndpoint(m({ provider: 'Meta' })).style).toBe('openai');
  });

  it('anthropic style: /messages, x-api-key + version header', () => {
    const p = planChatRequest(m({ provider: 'Anthropic' }), 'key-a', msg('hi'), 256);
    expect(p.url).toBe('https://api.anthropic.com/v1/messages');
    expect(p.headers['x-api-key']).toBe('key-a');
    expect(p.headers['anthropic-version']).toBeTruthy();
  });

  it('google style: :generateContent with x-goog-api-key; roles mapped', () => {
    const p = planChatRequest(
      m({ provider: 'Google' }), 'key-g',
      [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }], 64,
    );
    expect(p.url).toContain(':generateContent');
    expect(p.headers['x-goog-api-key']).toBe('key-g');
    const contents = (p.body as any).contents;
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] });
    expect(contents[1].role).toBe('model');
  });

  it('apiBase override wins (org gateway), trailing slash trimmed', () => {
    const p = planChatRequest(m({ provider: 'OpenAI', apiBase: 'https://gw.corp/v1/' }), 'k', msg('q'), 8);
    expect(p.url).toBe('https://gw.corp/v1/chat/completions');
  });

  it('unknown provider throws (fail closed, no silent default)', () => {
    expect(() => planChatRequest(m({ provider: 'SomethingElse' }), 'k', msg('q'), 8)).toThrow(/no API adapter/);
  });
});

describe('parseChatResponse — normalization', () => {
  it('openai usage fields become exact counts', () => {
    const r = parseChatResponse('openai', 200, {
      choices: [{ message: { content: 'the answer' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    });
    expect(r).toEqual({ text: 'the answer', inputTokens: 12, outputTokens: 34 });
  });

  it('anthropic content blocks joined; usage mapped', () => {
    const r = parseChatResponse('anthropic', 200, {
      content: [{ type: 'text', text: 'A' }, { type: 'thinking', note: 'skip' }, { type: 'text', text: 'B' }],
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    expect(r.text).toBe('AB');
    expect(r.inputTokens).toBe(5);
    expect(r.outputTokens).toBe(7);
  });

  it('google candidates + usageMetadata mapped', () => {
    const r = parseChatResponse('google', 200, {
      candidates: [{ content: { parts: [{ text: 'hi ' }, { text: 'there' }] } }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
    });
    expect(r).toEqual({ text: 'hi there', inputTokens: 3, outputTokens: 4 });
  });

  it('HTTP errors surface provider message', () => {
    expect(() => parseChatResponse('openai', 429, { error: { message: 'rate limited' } }))
      .toThrow(/HTTP 429: rate limited/);
    expect(() => parseChatResponse('anthropic', 401, {})).toThrow(/HTTP 401/);
  });

  it('missing fields degrade to empty text / zero tokens, not crash', () => {
    expect(parseChatResponse('openai', 200, {})).toEqual({ text: '', inputTokens: 0, outputTokens: 0 });
  });
});

describe('sendChat — end to end with mocked fetch', () => {
  it('posts the plan and returns the normalized result', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: 'pong' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const r = await sendChat(m({ provider: 'OpenAI' }), 'key', msg('ping'), 100, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(r.text).toBe('pong');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body)).model).toBe('x');
  });

  it('provider failure rejects with the HTTP status', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 }),
    );
    await expect(
      sendChat(m({ provider: 'OpenAI' }), 'bad', msg('q'), 10, { fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 401: invalid api key/);
  });
});

describe('routeModel — AUTO routing math', () => {
  const catalog = [
    m({ id: 'cheap', modelName: 'Cheap', inputPricePerMillionTokens: 0.05, outputPricePerMillionTokens: 0.5, contextWindow: 131_072 }),
    m({ id: 'mid', modelName: 'Mid', inputPricePerMillionTokens: 0.5, outputPricePerMillionTokens: 3, contextWindow: 1_000_000 }),
    m({ id: 'flag', modelName: 'Flagship', inputPricePerMillionTokens: 10, outputPricePerMillionTokens: 50, contextWindow: 1_000_000 }),
    m({ id: 'small', modelName: 'SmallCtx', inputPricePerMillionTokens: 0.2, outputPricePerMillionTokens: 1, contextWindow: 8_000 }),
  ];

  it('picks a balanced model, not the cheapest or the flagship', () => {
    const d = routeModel(catalog, { inputTokens: 5_000, expectedOutputTokens: 600 });
    expect(d.model.id).toBe('mid');
    expect(d.reason).toContain('balanced');
  });

  it('deterministic: same input, same choice', () => {
    const a = routeModel(catalog, { inputTokens: 9_000, expectedOutputTokens: 500 });
    const b = routeModel(catalog, { inputTokens: 9_000, expectedOutputTokens: 500 });
    expect(a.model.id).toBe(b.model.id);
  });

  it('excludes models whose context cannot fit the query + 10% headroom', () => {
    const d = routeModel(catalog, { inputTokens: 200_000, expectedOutputTokens: 4_000 });
    expect(d.model.id).not.toBe('small');
    expect(d.reason).toContain('excluded');
  });

  it('cost weight dominates for output-heavy prompts', () => {
    const d = routeModel(catalog, { inputTokens: 1_000, expectedOutputTokens: 8_000 });
    expect(['cheap', 'mid']).toContain(d.model.id);
    expect(d.model.id).not.toBe('flag');
  });

  it('a single-provider pool still ranks sensibly (mid over extremes)', () => {
    const d = routeModel([catalog[1]!, catalog[2]!, catalog[0]!], { inputTokens: 200, expectedOutputTokens: 400 });
    expect(d.model.id).not.toBe('flag');
  });

  it('scores are attached for the transparency panel', () => {
    const d = routeModel(catalog, { inputTokens: 100, expectedOutputTokens: 100 });
    expect(d.scores.length).toBeGreaterThan(0);
    expect(d.scores[0]!.score).toBeGreaterThanOrEqual(d.scores[d.scores.length - 1]!.score);
  });
});
