import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import Crypto from '../crypto';
import { BASE_PATH, NAV } from '../crypto/data';
import { goto, stubFetch } from './cryptoFixtures';

/**
 * The Kalshi 15m tab: one nav entry + five sections, each on its own
 * /api/crypto/kalshi15m* endpoint. Fixtures mirror server/src/crypto/routes.ts
 * (money in CENTS, verdicts TRADE/SKIP, the SHADOW and PAPER labels verbatim).
 */

beforeEach(() => {
  goto(`${BASE_PATH}/kalshi15m`);
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const urls = (): string[] => vi.mocked(fetch).mock.calls.map((c) => String(c[0]));

describe('Crypto Kalshi 15m tab', () => {
  it('is a visible sidebar tab that deep-links to the page without a reload', async () => {
    render(<Crypto />);

    const nav = await screen.findByRole('navigation', { name: /crypto navigation/i });
    const tab = within(nav).getByRole('link', { name: 'Kalshi 15m' });
    expect(tab.getAttribute('href')).toBe(`${BASE_PATH}/kalshi15m`);
    expect(tab.getAttribute('aria-current')).toBe('page');
    expect(NAV.find((n) => n.key === 'kalshi15m')?.label).toBe('Kalshi 15m');
    expect(window.location.pathname).toBe(`${BASE_PATH}/kalshi15m`);

    // the page renders on the deep link (no redirect, no blank state)
    expect(await screen.findByText('Window & feed')).toBeTruthy();
  });

  it('shows the window, fair value, strategies, paper and signal tables', async () => {
    render(<Crypto />);

    /* 1 — window & feed */
    expect(await screen.findByText('Window & feed')).toBeTruthy();
    expect(await screen.findByText('LIVE')).toBeTruthy();
    expect(screen.getByText('OPEN')).toBeTruthy();
    // event ticker: phase tile hint + the open paper position's market
    expect(screen.getAllByText('KXBTC15M-20NOV202100').length).toBeGreaterThanOrEqual(1);

    /* 2 — fair value & calibration */
    expect(await screen.findByText('Fair value & calibration')).toBeTruthy();
    expect(await screen.findByText('APPROXIMATION')).toBeTruthy();
    expect(screen.getByText('0.5473')).toBeTruthy(); // model p(YES)
    expect(
      screen.getByText(
        'edge_pp is information ONLY while sigma is calibrated: compare impliedOverRealizedMedian with 1 before believing any edge.',
      ),
    ).toBeTruthy();
    // a 6.95e-6 sigma must never render as a bare 0 (2-decimal rounding)
    expect(screen.getByText('6.95e-6')).toBeTruthy();
    expect(screen.getByText('6.03e-7 implied')).toBeTruthy();

    /* 3 — strategies, label verbatim */
    expect(await screen.findByText('SHADOW — no order is ever placed from this engine')).toBeTruthy();
    const strat = await screen.findByRole('table', { name: 'kalshi 15m shadow strategies' });
    expect(within(strat).getAllByRole('row')).toHaveLength(7); // header + A..F
    expect(within(strat).getByText('F_MAKER')).toBeTruthy();
    expect(within(strat).getByText('C_PANICFADE')).toBeTruthy();
    expect(await screen.findByText('move_too_small · 584')).toBeTruthy();

    /* 4 — paper, label verbatim, money rendered in dollars */
    expect(await screen.findByText('PAPER — simulated fills, no order path exists in this engine')).toBeTruthy();
    expect(await screen.findByText('$994.38')).toBeTruthy(); // 99_438.36 cents
    // closed net and daily realized are both −561.64c — shown plainly, never as a claim
    expect(screen.getAllByText('$-5.62').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Halt' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    const exits = await screen.findByRole('table', { name: 'paper exit reasons' });
    expect(within(exits).getByText('STOP_LOSS')).toBeTruthy();

    /* 5 — recent signals */
    const sig = await screen.findByRole('table', { name: 'kalshi 15m recent signals' });
    expect(within(sig).getAllByRole('row')).toHaveLength(4); // header + 3 signals
    expect(within(sig).getByText('TRADE')).toBeTruthy();
    expect(within(sig).getAllByText('SKIP')).toHaveLength(2);
    expect(within(sig).getByText('move_too_small')).toBeTruthy();
  });

  it('drives the paper halt/resume controls and refetches the ledger', async () => {
    render(<Crypto />);

    const halt = await screen.findByRole('button', { name: 'Halt' });
    halt.click();
    await waitFor(() => {
      expect(urls().some((u) => u.includes('/kalshi15m/paper?action=halt'))).toBe(true);
    });
    await waitFor(() => {
      expect(urls().filter((u) => u.endsWith('/kalshi15m/paper')).length).toBeGreaterThanOrEqual(2);
    });

    const resume = await screen.findByRole('button', { name: 'Resume' });
    resume.click();
    await waitFor(() => {
      expect(urls().some((u) => u.includes('/kalshi15m/paper?action=resume'))).toBe(true);
    });
  });

  it('renders when the server sends fairValue: null (rollover / empty-book state)', async () => {
    // REAL server shape: status() emits fairValue: null whenever there is no
    // window yet or the book is empty — at engine restart and every 15-minute
    // rollover. undefined-checks alone let null through and the page died:
    // "Cannot read properties of null (reading 'reference')".
    stubFetch({
      kalshi15m: {
        enabled: true,
        series: 'KXBTC15M',
        window: { eventTicker: 'KXBTC15M-21NOV203300', phase: 'OPEN' },
        fairValue: null,
      },
    });
    render(<Crypto />);

    expect(await screen.findByText('Window & feed')).toBeTruthy();
    expect(await screen.findByText('Fair value & calibration')).toBeTruthy();
    expect(await screen.findByText(/No fair value yet/)).toBeTruthy();
    // the page survives: every other section still renders, no error boundary
    expect(await screen.findByText('Strategies')).toBeTruthy();
    expect(await screen.findByText('Paper execution')).toBeTruthy();
    expect(await screen.findByText('Recent signals')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('survives an unknown {} payload instead of crashing the shell', async () => {
    stubFetch({ kalshi15m: {}, 'kalshi15m/calibration': {}, 'kalshi15m/signals': {}, 'kalshi15m/paper': {} });
    render(<Crypto />);

    // every section still renders its empty/loading state
    expect(await screen.findByText('Window & feed')).toBeTruthy();
    expect(await screen.findByText('Fair value & calibration')).toBeTruthy();
    expect(await screen.findByText('Strategies')).toBeTruthy();
    expect(await screen.findByText('Paper execution')).toBeTruthy();
    expect(await screen.findByText('Recent signals')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});