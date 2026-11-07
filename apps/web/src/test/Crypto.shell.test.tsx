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
  it('always shows the paper + 24/7 badges and all 6 nav labels, in order', async () => {
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
    expect(links).toEqual(['Overview', 'Market', 'Signals', 'Paper Trading', 'Learning', 'System']);
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

  it('falls back to Overview for an unknown crypto path', async () => {
    goto(`${BASE_PATH}/does-not-exist`);
    render(<Crypto />);
    expect(await screen.findByText('Page not found')).toBeTruthy();
    expect(screen.getByText(/No crypto page matches this path/)).toBeTruthy();
  });
});
