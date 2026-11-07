/**
 * Report page — range filter drives the /report endpoint (query strings are
 * stripped by stubFetch, so the ROUTES entry answers every range) and the
 * per-day table + range totals must render from the contract fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import TradingUSA from '../tradingusa';
import { BASE_PATH } from '../tradingusa/data';
import { stubFetch } from './tradingusaFixtures';

const HEADERS = [
  'Date', 'Regime', 'Scans', 'Signals', 'Blocked', 'Orders', 'Opened',
  'Closed', 'W-L', 'Win %', 'Expect %', 'Stops', 'Targets', 'Net PnL', 'Equity',
];

beforeEach(() => {
  window.history.replaceState({}, '', `${BASE_PATH}/report`);
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Report page', () => {
  it('renders every daily-report column and the day rows', async () => {
    render(<TradingUSA />);

    const table = await screen.findByRole('table', { name: 'Daily report' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.replace(/[▲▼↕]/g, '').trim() ?? '');
    expect(headers).toEqual(HEADERS);

    const cells = within(table).getAllByRole('cell').map((td) => td.textContent ?? '');
    expect(cells).toContain('2026-10-13');
    expect(cells).toContain('BULL_TREND');
    expect(cells).toContain('2026-10-14');
    expect(cells).toContain('LOW_VOLATILITY');
  });

  it('shows range totals and the date-range filter controls', async () => {
    render(<TradingUSA />);

    expect(await screen.findByText('Date range')).toBeTruthy();
    expect(await screen.findByText('Trades closed')).toBeTruthy();
    // totals.netPnl = 210 + (-120) = $90.00
    expect(await screen.findByText('$90.00')).toBeTruthy();
    // totals.blocked = 2+5 + 0+3+1 = 11
    expect(screen.getByText('Blocked by gates')).toBeTruthy();
    const dateInputs = document.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBe(2);
  });
});