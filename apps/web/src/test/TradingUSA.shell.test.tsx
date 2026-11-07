import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import TradingUSA from '../tradingusa';
import { NAV, PAPER_BANNER, BASE_PATH } from '../tradingusa/data';
import { goto, stubFetch } from './tradingusaFixtures';

beforeEach(() => {
  window.history.replaceState({}, '', `${BASE_PATH}/overview`);
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TradingUSA shell', () => {
  it('always shows the paper-trading banner and all 16 nav labels, in order', async () => {
    render(<TradingUSA />);

    // the badge is in the shell header, not the page body — always visible
    const banner = await screen.findByText(PAPER_BANNER);
    expect(banner.textContent).toContain('NO REAL MONEY IS BEING USED');
    expect(banner.className).toContain('amber');

    const nav = await screen.findByRole('navigation', { name: /tradingusa navigation/i });
    const links = within(nav).getAllByRole('link').map((a) => a.textContent ?? '');
    expect(links).toEqual(NAV.map((n) => n.label));
    expect(links).toEqual([
      'Overview',
      'Signals',
      'Scanner',
      'Market',
      'Stocks',
      'Portfolio',
      'Paper Trading',
      'Strategies',
      'Research',
      'Sources',
      'Learning',
      'Backtests',
      'Report',
      'AI',
      'System',
      'Settings',
    ]);
  });

  it('shows the market session badge and provider status chips from /status and /ai', async () => {
    render(<TradingUSA />);

    expect((await screen.findAllByText(/MARKET_OPEN/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/2026-10-16/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Groq')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('CONNECTED')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('RATE_LIMITED')).length).toBeGreaterThan(0);
  });

  it('renders every page and detail route without crashing', async () => {
    render(<TradingUSA />);
    await screen.findByRole('navigation', { name: /tradingusa navigation/i });

    const routes: Array<[string, string]> = [
      [`${BASE_PATH}/overview`, 'Overview'],
      [`${BASE_PATH}/signals`, 'Signals'],
      [`${BASE_PATH}/signals/sig_1`, 'Signals'],
      [`${BASE_PATH}/scanner`, 'Scanner'],
      [`${BASE_PATH}/market`, 'Market'],
      [`${BASE_PATH}/stocks`, 'Stocks'],
      [`${BASE_PATH}/stocks/AAPL`, 'Stocks'],
      [`${BASE_PATH}/portfolio`, 'Portfolio'],
      [`${BASE_PATH}/paper-trading`, 'Paper Trading'],
      [`${BASE_PATH}/strategies`, 'Strategies'],
      [`${BASE_PATH}/research`, 'Research'],
      [`${BASE_PATH}/sources`, 'Sources'],
      [`${BASE_PATH}/learning`, 'Learning'],
      [`${BASE_PATH}/backtests`, 'Backtests'],
      [`${BASE_PATH}/report`, 'Report'],
      [`${BASE_PATH}/ai`, 'AI'],
      [`${BASE_PATH}/system`, 'System'],
      [`${BASE_PATH}/settings`, 'Settings'],
    ];

    for (const [to, label] of routes) {
      goto(to);
      const heading = await screen.findByRole('heading', { level: 1, name: label });
      expect(heading).toBeTruthy();
      // let the endpoint settle: no stuck loading state and no failed request
      await waitFor(() => expect(document.querySelector('[role="status"]')).toBeNull(), { timeout: 4000 });
      expect(screen.queryByText(/request failed/i)).toBeNull();
    }
  });

  it('navigates back to PromptPolice from the footer link', async () => {
    render(<TradingUSA />);
    await screen.findByRole('navigation', { name: /tradingusa navigation/i });
    const footerLinks = screen.getAllByRole('link', { name: /promptpolice/i });
    expect(footerLinks.length).toBeGreaterThan(0);
    expect(footerLinks[0].getAttribute('href')).toBe('/');
  });
});