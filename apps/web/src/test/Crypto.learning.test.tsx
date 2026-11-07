import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import Crypto from '../crypto';
import { BASE_PATH } from '../crypto/data';
import {
  CONTEXT_OFF,
  CONTEXT_ON,
  CONTEXT_SOURCE,
  FIXTURES,
  PROVIDERS,
  PROVIDERS_DISABLED,
  PROVIDERS_STALE,
  XCHANGE_DISABLED,
  goto,
  stubFetch,
} from './cryptoFixtures';

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

  it('renders the MULTI-EXCHANGE MARKET INTELLIGENCE blocks with live source rows', async () => {
    render(<Crypto />);

    expect(await screen.findByRole('heading', { name: /multi-exchange market intelligence/i })).toBeTruthy();
    expect(screen.getByText(/existing trading & learning results/i)).toBeTruthy();
    expect(screen.getByText(/live market-data observations/i)).toBeTruthy();
    expect(screen.getByText(/experimental model predictions/i)).toBeTruthy();
    expect(screen.getByText(/validated results/i)).toBeTruthy();

    // source table: Kraken reference first, Coinbase second, then NOT WIRED venues
    const table = await screen.findByRole('table', { name: 'Market data sources' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(7); // header + kraken + coinbase + 4 pending
    expect(within(rows[1]).getByText('Kraken')).toBeTruthy();
    expect(within(rows[2]).getByText('Coinbase Exchange')).toBeTruthy();
    expect(within(rows[2]).getByText('HEALTHY')).toBeTruthy();
    expect(within(rows[2]).getByText('2/2 valid')).toBeTruthy();
    // Kraken's ticker carries no L2 book here: latency + integrity both "n/a"
    expect(within(rows[1]).getAllByText('n/a')).toHaveLength(2);
    // pending venues stay visible as NOT WIRED (case-insensitive check)
    expect(screen.getAllByText(/not wired/i).length).toBeGreaterThanOrEqual(4);

    // per-provider data freshness comes from the same payload
    expect(screen.getByText(/data freshness · per source/i)).toBeTruthy();
    expect(screen.getAllByText('4s ago').length).toBeGreaterThan(0);

    // comparative view: numbers are read from /xchange, never computed here
    expect(screen.getByText('76,661.9')).toBeTruthy();
    expect(screen.getAllByText('100.00%').length).toBeGreaterThan(0);
    expect(screen.getByText('83.00%')).toBeTruthy();
    expect(screen.getByText(/experimental, not a calibrated probability/i)).toBeTruthy();

    // validated results block
    expect(screen.getByText(/validated on actual trade outcomes/i)).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Fixed-horizon accuracy' })).toBeTruthy();
    expect(screen.getByText('62.50%')).toBeTruthy();
  });

  it('reports INSUFFICIENT_DATA with its note instead of a fabricated number', async () => {
    render(<Crypto />);

    const table = await screen.findByRole('table', { name: 'Experimental model predictions by horizon' });
    expect(screen.getByText('INSUFFICIENT_DATA')).toBeTruthy();
    expect(screen.getByText(/below the 30-row evaluation floor/)).toBeTruthy();

    const row = within(table).getByText('1d').closest('tr') as HTMLElement;
    expect(within(row).queryByText('0.00%')).toBeNull();
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(3);

    // the OK horizon still carries its real readings
    const okRow = within(table).getByText('5m').closest('tr') as HTMLElement;
    expect(within(okRow).getByText('57.78%')).toBeTruthy();
    expect(within(okRow).getByText('+3.34%')).toBeTruthy();
    expect(within(okRow).getByText('-0.0081')).toBeTruthy();
  });

  it('shows honest DISABLED / context-off states when the layer is switched off', async () => {
    stubFetch({ xchange: XCHANGE_DISABLED, providers: PROVIDERS_DISABLED, context: CONTEXT_OFF });
    render(<Crypto />);

    expect(await screen.findByRole('heading', { name: /multi-exchange market intelligence/i })).toBeTruthy();
    // wait for BOTH async blocks: the sources table carries one DISABLED note,
    // the comparative block the other — asserting on the heading alone races
    // the fetch and sees only one of them.
    await screen.findByRole('table', { name: 'Market data sources' });
    expect(screen.getAllByText('CRYPTO_XCHANGE_ENABLED=0').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('DISABLED').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/CRYPTO_XCHANGE_CONTEXT is off/)).toBeTruthy();
    expect(screen.getAllByText(/not wired/i).length).toBeGreaterThanOrEqual(4);
    // no cross-venue numbers are rendered while the layer is off
    expect(screen.queryByText('83.00%')).toBeNull();
    expect(screen.queryByText('76,661.9')).toBeNull();
  });

  it('never renders CONNECTED as healthy when the feed is stale', async () => {
    stubFetch({ providers: PROVIDERS_STALE });
    render(<Crypto />);

    const table = await screen.findByRole('table', { name: 'Market data sources' });
    const row = within(table).getByText('Coinbase Exchange').closest('tr') as HTMLElement;
    expect(within(row).getByText('CONNECTED')).toBeTruthy();
    expect(within(row).getByText('NOT HEALTHY')).toBeTruthy();
    expect(within(row).queryByText('HEALTHY')).toBeNull();
    expect(within(row).getByText(/no market data for 95s/)).toBeTruthy();
  });

  it('lists lower-frequency context sources when the context layer is enabled', async () => {
    stubFetch({ context: CONTEXT_ON, providers: { ...PROVIDERS, context: [CONTEXT_SOURCE] } });
    render(<Crypto />);

    const table = await screen.findByRole('table', { name: 'Market data sources' });
    expect(within(table).getByText('DEX Screener')).toBeTruthy();
    expect(within(table).getByText('36 cached')).toBeTruthy();
    expect(within(table).getByText('REST')).toBeTruthy();
    expect(screen.getByText(/1 enabled · 36 cached entries/)).toBeTruthy();
  });

  it('wires every new endpoint and follows the BTC/ETH symbol toggle', async () => {
    render(<Crypto />);
    await screen.findByRole('heading', { name: /multi-exchange market intelligence/i });

    const calls = (): string[] =>
      (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    for (const path of ['/providers', '/xchange', '/sources', '/context', '/accuracy']) {
      expect(calls().some((u) => u.includes(path))).toBe(true);
    }
    expect(calls().some((u) => u.includes('symbol=BTC'))).toBe(true);

    screen.getByRole('button', { name: 'ETH' }).click();
    await waitFor(() => expect(calls().some((u) => u.includes('symbol=ETH'))).toBe(true));
  });
});
