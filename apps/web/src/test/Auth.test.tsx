import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../App';
import type { AggregateResponse } from '@promptslim/shared-types';

/**
 * Auth + dashboard UI flow against a stubbed /api (the real server has its own
 * node:test integration suite). Covers: signup collects tag pairs, session
 * switches the app into dashboard mode, tag filters AND together, and the
 * cost-center breakdown shows the org rollup.
 */

beforeEach(() => {
  localStorage.clear();
  cleanup();
  vi.unstubAllGlobals();
});

const ACCOUNT = { id: 7, email: 'ada@corp.com', name: 'Ada', tags: { cost_center: '10', team: 'payments' }, createdAt: Date.now() };

const AGG: AggregateResponse = {
  window: { since: null, until: null },
  filters: [],
  groupBy: ['cost_center'],
  totals: {
    requests: 12, users: 5, originalTokens: 240_000, optimizedTokens: 168_000,
    savedTokens: 72_000, costOriginalUsd: 4.8, costOptimizedUsd: 3.36,
    savingsUsd: 1.44, reductionPercent: 30, chatRequests: 2, actualCostUsd: 0.42,
  },
  projectedAnnualUsd: 52.56,
  windowDays: 10,
  buckets: [
    { label: '10', values: ['10'], requests: 9, users: 5, originalTokens: 180_000, optimizedTokens: 126_000, savedTokens: 54_000, costOriginalUsd: 3.6, costOptimizedUsd: 2.52, savingsUsd: 1.08, reductionPercent: 30, chatRequests: 2, actualCostUsd: 0.42 },
    { label: '20', values: ['20'], requests: 3, users: 1, originalTokens: 60_000, optimizedTokens: 42_000, savedTokens: 18_000, costOriginalUsd: 1.2, costOptimizedUsd: 0.84, savingsUsd: 0.36, reductionPercent: 30, chatRequests: 0, actualCostUsd: 0 },
  ],
  series: [
    { date: '2026-09-10', requests: 6, savedUsd: 0.72, costUsd: 1.68 },
    { date: '2026-09-11', requests: 6, savedUsd: 0.72, costUsd: 1.68 },
  ],
};

const FACETS = {
  facets: [
    { key: 'cost_center', values: [{ value: '10', events: 9 }, { value: '20', events: 3 }] },
    { key: 'team', values: [{ value: 'payments', events: 9 }] },
  ],
};

let signedIn = false;
function stubApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const send = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (path === '/api/me') return send(200, signedIn ? { account: ACCOUNT } : { errors: ['not signed in'] });
    if (path === '/api/signup') {
      if (!body.tags || Object.keys(body.tags).length === 0) return send(400, { errors: ['tags required in this stub'] });
      signedIn = true;
      return send(201, { account: { ...ACCOUNT, tags: body.tags } });
    }
    if (path === '/api/login') { signedIn = true; return send(200, { account: ACCOUNT }); }
    if (path === '/api/logout') { signedIn = false; return send(200, { ok: true }); }
    if (path === '/api/events') return send(201, { ok: true, tagsRecorded: ACCOUNT.tags });
    if (path === '/api/keys') return send(200, { keys: [] });
    if (path === '/api/chat') {
      return send(200, {
        text: 'Paris is the capital of France.',
        meta: {
          modelId: body.modelId === 'auto' ? 'gemini-3.1-pro' : 'gpt-5.4',
          provider: body.modelId === 'auto' ? 'Google' : 'OpenAI',
          modelName: body.modelId === 'auto' ? 'Gemini 3.1 Pro' : 'GPT-5.4',
          routed: body.modelId === 'auto',
          routeReason: body.modelId === 'auto' ? 'balanced Google Gemini 3.1 Pro (cost 61 · capability 74 · context 100)' : undefined,
          inputTokens: 42, outputTokens: 9, costUsd: 0.0002, savingsUsd: 0.0001, governance: 'allow',
        },
      });
    }
    if (path === '/api/aggregate') {
      const only20 = (body.filters ?? []).some((f: { key: string; value: string }) => f.value === '20');
      return send(200, {
        ...AGG,
        filters: body.filters ?? [],
        groupBy: body.groupBy ?? [],
        totals: only20 ? { ...AGG.buckets[1]! } : AGG.totals,
        buckets: only20 ? [AGG.buckets[1]!] : AGG.buckets,
      });
    }
    if (path === '/api/tags/facets') return send(200, FACETS);
    return send(404, { errors: ['not found'] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('account signup with tags', () => {
  it('renders the account gate with tag key/value inputs when signed out', () => {
    stubApi();
    render(<App />);
    const panel = screen.getByLabelText('Account');
    expect(within(panel).getByRole('tab', { name: /create account/i })).toBeTruthy();
    expect(within(panel).getByLabelText('Tag 1 key')).toBeTruthy();
    expect(within(panel).getByLabelText('Tag 1 value')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: /add tag/i }));
    expect(within(panel).getByLabelText('Tag 2 key')).toBeTruthy();
  });

  it('signup submits tags and switches to the dashboard', async () => {
    stubApi();
    render(<App />);
    const panel = screen.getByLabelText('Account');
    fireEvent.change(within(panel).getByLabelText('Work email'), { target: { value: 'ada@corp.com' } });
    fireEvent.change(within(panel).getByLabelText('Password'), { target: { value: 'hunter2hunter2' } });
    fireEvent.change(within(panel).getByLabelText('Tag 1 value'), { target: { value: '10' } });
    fireEvent.click(within(panel).getByRole('button', { name: /create account & continue/i }));
    await waitFor(() => {
      expect(screen.getByLabelText('Executive dashboard')).toBeTruthy();
    });
  });
});

describe('executive dashboard', () => {
  it('shows KPI money cards and the cost-center breakdown table', async () => {
    signedIn = true;
    stubApi();
    render(<App />);
    const dash = await screen.findByLabelText('Executive dashboard');
    await waitFor(() => expect(within(dash).getAllByText("$1.44").length).toBeGreaterThanOrEqual(2));
    expect(within(dash).getByText('Savings · this window')).toBeTruthy();
    expect(within(dash).getByText('Projected annual')).toBeTruthy();
    // breakdown rows: cost center 10 aggregates 5 users
    await waitFor(() => {
      const row10 = within(dash).getByRole('row', { name: /10/ });
      expect(row10.textContent).toContain('5');
    });
    expect(within(dash).getByText('20')).toBeTruthy();
    expect(within(dash).getByText(/across 5 users · 12 runs/i)).toBeTruthy();
  });

  it('tag filter chips compose with AND semantics and refetch', async () => {
    signedIn = true;
    const fetchMock = stubApi();
    render(<App />);
    const dash = await screen.findByLabelText('Executive dashboard');
    await waitFor(() => expect(within(dash).getAllByText("$1.44").length).toBeGreaterThanOrEqual(2));

    fireEvent.change(within(dash).getByLabelText('Filter tag key'), { target: { value: 'cost_center' } });
    fireEvent.change(within(dash).getByLabelText('Filter tag value'), { target: { value: '20' } });

    // chip appears (and the footer restates the active filter) and the
    // aggregate call includes the filter
    await waitFor(() => {
      expect(within(dash).getAllByText(/cost_center=20/).length).toBeGreaterThanOrEqual(1);
    });
    const aggCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === '/api/aggregate');
    const last = JSON.parse(String(aggCalls[aggCalls.length - 1]![1]!.body));
    expect(last.filters).toEqual([{ key: 'cost_center', value: '20' }]);
  });

  it('optimizing while signed in reports a metrics-only event to the server', async () => {
    signedIn = true;
    const fetchMock = stubApi();
    render(<App />);
    await screen.findByLabelText('Executive dashboard');
    const { SAMPLE_PROMPTS } = await import('@promptslim/optimizer');
    fireEvent.change(screen.getByLabelText('Original Prompt'), { target: { value: SAMPLE_PROMPTS[0]!.text } });
    fireEvent.click(screen.getByRole('button', { name: /optimize prompt/i }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => String(c[0]) === '/api/events');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const payload = JSON.parse(String(calls[0]![1]!.body));
      // counts only — never prompt text
      expect(Object.keys(payload).sort()).toEqual(['fromCache', 'level', 'modelId', 'optimizedTokens', 'originalTokens']);
      expect(payload.originalTokens).toBeGreaterThan(payload.optimizedTokens);
    });
  });
});

describe('governed Ask panel', () => {
  it('offers AUTO by default and the same catalog models the comparison table prices', async () => {
    signedIn = true;
    stubApi();
    render(<App />);
    const ask = await screen.findByLabelText('Ask the LLM');
    const sel = within(ask).getByLabelText('Chat model') as HTMLSelectElement;
    expect(sel.value).toBe('auto');
    expect(sel.querySelector('option[value="auto"]')!.textContent).toMatch(/balanced/i);
    expect(sel.querySelector('option[value="gpt-5.4"]')).toBeTruthy();
    expect(sel.querySelector('option[value="claude-sonnet-5"]')).toBeTruthy();
    expect(within(ask).getByRole('button', { name: /bring your own keys/i })).toBeTruthy();
  });

  it('sends the pane prompt through /api/chat and renders the answer with exact-usage meta', async () => {
    signedIn = true;
    const fetchMock = stubApi();
    render(<App />);
    const { SAMPLE_PROMPTS } = await import('@promptslim/optimizer');
    fireEvent.change(screen.getByLabelText('Original Prompt'), { target: { value: SAMPLE_PROMPTS[0]!.text } });

    const ask = await screen.findByLabelText('Ask the LLM');
    fireEvent.click(within(ask).getByRole('button', { name: /send to the model/i }));

    await waitFor(() => {
      expect(screen.getByText(/Paris is the capital/i)).toBeTruthy();
    });
    const chatCall = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/chat')!;
    const payload = JSON.parse(String(chatCall[1]!.body));
    expect(payload.modelId).toBe('auto');
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].role).toBe('user');
    // the user's raw prompt text was sent as the message (governance runs server-side)
    expect(payload.messages[0].content).toContain('customer');
    // meta line shows exact provider usage + cost + governance chip
    expect(within(ask).getByText(/in 42 · out 9 tok/i)).toBeTruthy();
    expect(ask.textContent).toContain('governed: allow');
    expect(ask.textContent).toMatch(/AUTO/);
  });

  it('supports follow-up turns on the same thread', async () => {
    signedIn = true;
    const fetchMock = stubApi();
    render(<App />);
    const { SAMPLE_PROMPTS } = await import('@promptslim/optimizer');
    fireEvent.change(screen.getByLabelText('Original Prompt'), { target: { value: SAMPLE_PROMPTS[0]!.text } });
    const ask = await screen.findByLabelText('Ask the LLM');
    fireEvent.click(within(ask).getByRole('button', { name: /send to the model/i }));
    await screen.findByText(/Paris is the capital/i);

    fireEvent.change(within(ask).getByLabelText('Follow-up message'), { target: { value: 'And its population?' } });
    fireEvent.click(within(ask).getByRole('button', { name: /^send$/i }));
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => String(c[0]) === '/api/chat');
      expect(calls.length).toBe(2);
      const second = JSON.parse(String(calls[1]![1]!.body));
      // thread forwarded: user, assistant, user
      expect(second.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(second.messages[2].content).toBe('And its population?');
    });
  });

  it('renders the server refusal for blocked queries and rolls back the turn', async () => {
    signedIn = true;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const send = (status: number, data: unknown) =>
        new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      if (path === '/api/me') return send(200, { account: ACCOUNT });
      if (path === '/api/aggregate') return send(200, AGG);
      if (path === '/api/tags/facets') return send(200, FACETS);
      if (path === '/api/keys') return send(200, { keys: [] });
      if (path === '/api/chat') return send(403, { errors: ['Blocked by governance: instruction-override attempt detected. The query was not sent anywhere.'], verdict: 'block' });
      return send(404, { errors: ['nf'] });
    }));
    render(<App />);
    const { SAMPLE_PROMPTS } = await import('@promptslim/optimizer');
    fireEvent.change(screen.getByLabelText('Original Prompt'), { target: { value: SAMPLE_PROMPTS[0]!.text } });
    const ask = await screen.findByLabelText('Ask the LLM');
    fireEvent.click(within(ask).getByRole('button', { name: /send to the model/i }));
    await waitFor(() => {
      expect(ask.textContent).toContain('Blocked by governance');
    });
    // the user bubble rolled back — the pane still shows the empty-state CTA
    expect(within(ask).getByRole('button', { name: /send to the model/i })).toBeTruthy();
  });

  it('dashboard shows the Live LLM spend KPI', async () => {
    signedIn = true;
    stubApi();
    render(<App />);
    const dash = await screen.findByLabelText('Executive dashboard');
    await waitFor(() => expect(within(dash).getAllByText('$1.44').length).toBeGreaterThanOrEqual(2));
    expect(within(dash).getByText('Live LLM spend')).toBeTruthy();
    expect(within(dash).getByText('$0.42')).toBeTruthy();
    expect(within(dash).getByText(/2 governed calls/)).toBeTruthy();
  });
});
