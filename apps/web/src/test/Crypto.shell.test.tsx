import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import Crypto from '../crypto';
import { ALWAYS_OPEN, BASE_PATH, NAV, PAPER_BANNER } from '../crypto/data';
import { goto, stubFetch } from './cryptoFixtures';

beforeEach(() => {
  window.history.replaceState({}, '', `${BASE_PATH}/overview`);
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Crypto shell', () => {
  it('always shows the paper + 24/7 badges and all 7 nav labels, in order', async () => {
    render(<Crypto />);

    // both badges live in the shell header — always visible on every page
    const paper = await screen.findByText(PAPER_BANNER);
    expect(paper.textContent).toContain('NO REAL MONEY IS BEING USED');
    expect(paper.className).toContain('amber');

    const alwaysOpen = screen.getByText(ALWAYS_OPEN);
    expect(alwaysOpen.textContent).toContain('NEVER CLOSES');
    expect(alwaysOpen.className).toContain('mint');

    const nav = await screen.findByRole('navigation', { name: /crypto navigation/i });
    const links = within(nav).getAllByRole('link').map((a) => a.textContent ?? '');
    expect(links).toEqual(NAV.map((n) => n.label));
    expect(links).toEqual(['Overview', 'Market', 'Kalshi 15m', 'Signals', 'Paper Trading', 'Learning', 'System']);
  });

  it('renders the Overview page with provider, transport and universe in the header', async () => {
    render(<Crypto />);

    await waitFor(() => expect(screen.getByText(/kraken/)).toBeTruthy());
    expect(screen.getByText('websocket')).toBeTruthy();
    expect(screen.getByText('25 coins')).toBeTruthy();
    expect(screen.getByText('3 open')).toBeTruthy();
    expect(screen.getByText('paper only')).toBeTruthy();

    // page body: equity + benchmark tiles from the overview fixture
    expect(await screen.findByText('Equity')).toBeTruthy();
    expect(screen.getAllByText(/101,842\.11/).length).toBeGreaterThan(0);
    expect(screen.getByText('Paper ledger')).toBeTruthy();
    expect(screen.getByText('Recent trades')).toBeTruthy();
  });

  it('navigates to Learning and Market without a full reload', async () => {
    render(<Crypto />);
    const nav = await screen.findByRole('navigation', { name: /crypto navigation/i });

    within(nav).getByRole('link', { name: 'Learning' }).click();
    await waitFor(() => expect(screen.getByText('Learned fusion weights')).toBeTruthy());
    expect(window.location.pathname).toBe(`${BASE_PATH}/learning`);

    within(nav).getByRole('link', { name: 'Market' }).click();
    await waitFor(() => expect(screen.getByText('Universe quotes')).toBeTruthy());
    expect(window.location.pathname).toBe(`${BASE_PATH}/market`);
  });

  it('shows the win rate with its sample size and 95% interval', async () => {
    render(<Crypto />);
    expect(await screen.findByText('Win rate')).toBeTruthy();
    // 2 wins in 5 closes -> Wilson [11.8%, 76.9%]: the interval travels with
    // the rate so a small sample can never read as a settled number
    expect(await screen.findByText('2 of 5 · CI 11.8–76.9%')).toBeTruthy();
  });

  it('renders the top-K recorder as a read-only shadow card on System', async () => {
    render(<Crypto />);
    const nav = await screen.findByRole('navigation', { name: /crypto navigation/i });
    within(nav).getByRole('link', { name: 'System' }).click();

    expect(await screen.findByText('Top-K ranking (shadow)')).toBeTruthy();
    expect(await screen.findByText(/every BUY still trades/)).toBeTruthy();
    expect(await screen.findByText('Would keep')).toBeTruthy();
    // the sentence is built from two spans — query the parts, not the line
    expect(await screen.findByText('2/3 wins (67%)')).toBeTruthy();
    expect(await screen.findByText('0/2 wins (0%)')).toBeTruthy();
  });

  it('falls back to Overview for an unknown crypto path', async () => {
    goto(`${BASE_PATH}/does-not-exist`);
    render(<Crypto />);
    expect(await screen.findByText('Page not found')).toBeTruthy();
    expect(screen.getByText(/No crypto page matches this path/)).toBeTruthy();
  });
});
