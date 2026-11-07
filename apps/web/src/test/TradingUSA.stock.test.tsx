import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import TradingUSA from '../tradingusa';
import { BASE_PATH } from '../tradingusa/data';
import { goto, stubFetch } from './tradingusaFixtures';

beforeEach(() => {
  window.history.replaceState({}, '', `${BASE_PATH}/stocks/AAPL`);
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Stock page', () => {
  it('renders header, quote freshness and the technical/fundamental blocks', async () => {
    render(<TradingUSA />);

    expect(await screen.findByRole('heading', { name: /aapl/i })).toBeTruthy();
    expect(screen.getByText('Apple Inc.')).toBeTruthy();
    expect(screen.getAllByText('DELAYED').length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { name: /technicals/i })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: /fundamentals/i })).toBeTruthy();
    expect(screen.getByText('RSI 14')).toBeTruthy();
    expect(await screen.findByRole('heading', { name: /sentiment/i })).toBeTruthy();
    expect(screen.getByText('IMPROVING')).toBeTruthy();
  });

  it('renders the WHY / WHAT COULD MAKE IT WRONG thesis blocks from the fixture', async () => {
    render(<TradingUSA />);

    const why = await screen.findByRole('heading', { name: /why tradingusa likes this/i });
    expect(why).toBeTruthy();
    expect(
      screen.getByText('Price is breaking a 20-day high on 1.8x relative volume.'),
    ).toBeTruthy();
    expect(screen.getByText('Estimate revisions are trending up into the next print.')).toBeTruthy();

    const counter = await screen.findByRole('heading', { name: /what could make it wrong/i });
    expect(counter).toBeTruthy();
    expect(screen.getByText('RSI(14) at 74 leaves little room before the entry band fails.')).toBeTruthy();
    expect(screen.getByText('A hawkish yields spike would compress the multiple.')).toBeTruthy();

    // the two blocks are visually accented, not plain cards
    const whyClass = why.closest('section')?.className ?? '';
    expect(whyClass).toContain('mint');
    const counterClass = counter.closest('section')?.className ?? '';
    expect(counterClass).toContain('amber');
  });

  it('renders the current-information vs historical-knowledge split', async () => {
    render(<TradingUSA />);

    expect(await screen.findByRole('heading', { name: /current information vs historical knowledge/i })).toBeTruthy();
    expect(screen.getByText('Quote is 4 minutes old (DELAYED).')).toBeTruthy();
    expect(screen.getByText('Breakouts held in risk-on regimes 7 of 10 times.')).toBeTruthy();
    expect(screen.getByText('Current information')).toBeTruthy();
    expect(screen.getByText('Historical knowledge')).toBeTruthy();
  });

  it('links back to the signals list', async () => {
    render(<TradingUSA />);
    const back = await screen.findByRole('link', { name: /back to signals/i });
    expect(back.getAttribute('href')).toBe(`${BASE_PATH}/signals`);
    goto(`${BASE_PATH}/signals`);
    expect(window.location.pathname).toBe(`${BASE_PATH}/signals`);
  });
});