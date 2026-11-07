import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import TradingUSA from '../tradingusa';
import { BASE_PATH } from '../tradingusa/data';
import { OVERVIEW, stubFetch } from './tradingusaFixtures';

beforeEach(() => {
  window.history.replaceState({}, '', `${BASE_PATH}/overview`);
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Overview page', () => {
  it('renders the WHAT IF ledger exactly per the contract', async () => {
    render(<TradingUSA />);

    const heading = await screen.findByRole('heading', { name: /what if i followed every signal/i });
    expect(heading).toBeTruthy();

    const w = OVERVIEW.whatIf;
    const labels = [
      'Starting Capital',
      'Current Equity',
      'Paper Profit',
      'TradingUSA Return',
      'SPY Return',
      'Excess Return',
      'Trades',
      'Wins',
      'Losses',
      'Other',
      'Win Rate',
      'Max Drawdown',
    ];
    for (const label of labels) {
      expect((await screen.findAllByText(label)).length).toBeGreaterThan(0);
    }

    expect(screen.getAllByText('$10,000.00').length).toBeGreaterThan(0); // starting capital
    expect(screen.getAllByText('$11,234.50').length).toBeGreaterThan(0); // current equity
    expect(screen.getAllByText('+12.34%').length).toBeGreaterThan(0); // TradingUSA return
    expect(screen.getAllByText('+8.21%').length).toBeGreaterThan(0); // SPY return
    expect(screen.getAllByText('+4.13%').length).toBeGreaterThan(0); // excess return
    expect(screen.getAllByText('46.67%').length).toBeGreaterThan(0); // win rate (unsigned)
    expect(screen.getAllByText('-5.50%').length).toBeGreaterThan(0); // max drawdown
    expect(screen.getAllByText(String(w.trades)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(String(w.wins)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(String(w.losses)).length).toBeGreaterThan(0);
  });

  it('shows the reinforced paper banner, session, breadth/VIX and portfolio cards', async () => {
    render(<TradingUSA />);

    expect((await screen.findAllByText('PAPER TRADING — NO REAL MONEY IS BEING USED')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/MARKET_OPEN/).length).toBeGreaterThan(0);
    expect(await screen.findByText('VIX')).toBeTruthy();
    expect(await screen.findByText('14.6')).toBeTruthy();
    expect(await screen.findByText('Short-term portfolio')).toBeTruthy();
    expect(await screen.findByText('Long-term portfolio')).toBeTruthy();
    expect(await screen.findByText('Top opportunities')).toBeTruthy();
    expect(await screen.findByText('Top risk alerts')).toBeTruthy();
    expect(await screen.findByText('Daily review')).toBeTruthy();
  });
});