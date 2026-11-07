import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import Crypto from '../crypto';
import { BASE_PATH } from '../crypto/data';
import { goto, stubFetch, FIXTURES } from './cryptoFixtures';

beforeEach(() => {
  goto(`${BASE_PATH}/learning`);
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Crypto learning page', () => {
  it('shows the empty learned state with shipped defaults until the evidence floor', async () => {
    render(<Crypto />);

    expect(await screen.findByText('No learned weights yet')).toBeTruthy();
    expect(screen.getByText(/10 closed outcomes back a change/i)).toBeTruthy();
    // the strategy + horizon are named so you know WHICH book is learning
    expect(screen.getByText('crypto_momentum_v1')).toBeTruthy();

    const evidence = screen.getByText('Evidence');
    expect(evidence.parentElement?.textContent).toContain('below MIN_TRADES floor');
  });

  it('renders shadow experiments with dates, verdicts and only a positive headline', async () => {
    render(<Crypto />);

    expect(await screen.findByText('Rule experiments · shadow mode')).toBeTruthy();
    expect(screen.getByText(/observe outcomes only\. Nothing is blocked/)).toBeTruthy();

    // date range is visible and driven by the two inputs
    expect(screen.getByLabelText('experiments from date')).toBeTruthy();
    expect(screen.getByLabelText('experiments to date')).toBeTruthy();
    const span = screen.getByText(/2026-08-06 → 2026-11-03/);
    expect(span).toBeTruthy();

    // window stats from the fixture
    expect(screen.getByText('Signals in window')).toBeTruthy();
    expect(screen.getByText('Closed trades')).toBeTruthy();

    // only the POSITIVE delta gets the "strongest setup" headline
    expect(screen.getByText(/Strongest setup in this window/)).toBeTruthy();
    expect(screen.getAllByText('Relative strength').length).toBeGreaterThan(0);
    expect(screen.getByText('PROMOTE CANDIDATE')).toBeTruthy();
    // the negative-delta condition is still shown, but never headlined
    expect(screen.getByText('OBSERVING')).toBeTruthy();

    const table = screen.getByRole('table', { name: 'Rule experiments' });
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2 conditions
  });

  it('re-queries when a preset changes the window', async () => {
    render(<Crypto />);
    await screen.findByText('Rule experiments · shadow mode');

    const calls = (): number => (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const before = calls();
    screen.getByRole('button', { name: '30d' }).click();

    await waitFor(() => expect(calls()).toBeGreaterThan(before));
    const last = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)?.[0] ?? '';
    const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    expect(String(last)).toContain(`from=${from}`);
  });

  it('still renders when the server answers an unknown payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (await import('./cryptoFixtures')).jsonResponse({})));
    render(<Crypto />);
    // note/conditions default safely: no crash, no "strongest" headline
    expect(await screen.findByText('Rule experiments · shadow mode')).toBeTruthy();
    expect(screen.queryByText(/Strongest setup/)).toBeNull();
    expect(FIXTURES.learning).toBeTruthy();
  });
});
