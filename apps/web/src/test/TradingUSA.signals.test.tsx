import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Mock } from 'vitest';
import TradingUSA from '../tradingusa';
import { BASE_PATH } from '../tradingusa/data';
import { stubFetch } from './tradingusaFixtures';

const COLUMNS = [
  'Ticker',
  'Company',
  'Signal',
  'Horizon',
  'Confidence',
  'Price',
  'Entry',
  'Target',
  'Invalidations',
  'Expected Return',
  'Risk',
  'Strategy',
  'Created',
  'Status',
];

beforeEach(() => {
  window.history.replaceState({}, '', `${BASE_PATH}/signals`);
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function requestedUrls(): string[] {
  const fetchMock = globalThis.fetch as unknown as Mock;
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

describe('Signals page', () => {
  it('renders every required column and the signal row', async () => {
    render(<TradingUSA />);

    const table = await screen.findByRole('table', { name: 'Signals' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.replace(/[▲▼↕]/g, '').trim() ?? '');
    expect(headers).toEqual(COLUMNS);

    const cells = within(table).getAllByRole('cell').map((td) => td.textContent ?? '');
    expect(cells).toContain('AAPL');
    expect(cells).toContain('Apple Inc.');
    expect(cells).toContain('BUY');
    expect(cells).toContain('$236.48');
    expect(cells).toContain('$234.00–$238.50'); // entry band
    expect(cells).toContain('$258.00'); // target
    expect(cells).toContain('$226.50'); // invalidation
    expect(cells).toContain('+8.70%'); // expected return
  });

  it('keeps the filters working (portfolio, type, strategy, horizon, confidence) without crashing', async () => {
    render(<TradingUSA />);
    await screen.findByRole('table', { name: 'Signals' });

    const portfolio = screen.getByLabelText(/portfolio/i);
    fireEvent.change(portfolio, { target: { value: 'SHORT_TERM_PORTFOLIO' } });
    await waitFor(() => expect(requestedUrls().some((u) => u.includes('portfolio=SHORT_TERM_PORTFOLIO'))).toBe(true));

    const signalType = screen.getByLabelText(/signal type/i);
    fireEvent.change(signalType, { target: { value: 'SELL' } });
    await waitFor(() => expect(requestedUrls().some((u) => u.includes('signal=SELL'))).toBe(true));

    const strategy = screen.getByPlaceholderText('any strategy');
    fireEvent.change(strategy, { target: { value: 'MOMENTUM_BREAKOUT' } });
    await waitFor(() =>
      expect(requestedUrls().some((u) => u.includes('strategy=MOMENTUM_BREAKOUT'))).toBe(true),
    );

    const horizon = screen.getByLabelText(/horizon/i);
    fireEvent.change(horizon, { target: { value: 'LONG_TERM' } });
    await waitFor(() => expect(requestedUrls().some((u) => u.includes('horizon=LONG_TERM'))).toBe(true));

    const slider = screen.getByLabelText(/minimum confidence/i);
    fireEvent.change(slider, { target: { value: '0.5' } });
    await waitFor(() => expect(requestedUrls().some((u) => u.includes('confidenceMin=0.5'))).toBe(true));

    // still rendering the table afterwards — no crash
    expect(screen.getByRole('table', { name: 'Signals' })).toBeTruthy();
    expect(screen.queryByText(/request failed/i)).toBeNull();
  });

  it('opens the immutable signal detail with evidence and contradictions', async () => {
    render(<TradingUSA />);
    await screen.findByRole('table', { name: 'Signals' });

    fireEvent.click(screen.getByText('AAPL'));

    expect((await screen.findAllByText(/evidence/i)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('20-day breakout confirmed on 1.8x relative volume').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RSI(14) at 74 — overbought near the entry band').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/immutable record/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Groq/).length).toBeGreaterThan(0); // llm usage line
    expect(window.location.pathname).toBe(`${BASE_PATH}/signals/sig_1`);
    expect(await screen.findByRole('heading', { name: /score breakdown/i })).toBeTruthy();
    expect(screen.getAllByText(/position size within limit/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Breakouts hold in risk-on regimes/).length).toBeGreaterThan(0);
  });
});