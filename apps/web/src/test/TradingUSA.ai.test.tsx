import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import TradingUSA from '../tradingusa';
import { BASE_PATH } from '../tradingusa/data';
import { stubFetch } from './tradingusaFixtures';

beforeEach(() => {
  window.history.replaceState({}, '', `${BASE_PATH}/ai`);
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AI page', () => {
  it('renders both providers with their status pills, models and role', async () => {
    render(<TradingUSA />);

    expect((await screen.findAllByText('Groq')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Gemini')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('CONNECTED').length).toBeGreaterThan(0);
    expect(screen.getAllByText('RATE_LIMITED').length).toBeGreaterThan(0);
    expect(screen.getByText('llama-3.3-70b-versatile')).toBeTruthy();
    expect(screen.getByText('gemini-2.0-flash')).toBeTruthy();
    expect(screen.getAllByText('primary').length).toBeGreaterThan(0);
    expect(screen.getAllByText('secondary').length).toBeGreaterThan(0);
    expect(screen.getByText('NORMAL')).toBeTruthy();
  });

  it('renders totals, budgets, ablation and router rows', async () => {
    render(<TradingUSA />);

    expect(await screen.findByText('Totals')).toBeTruthy();
    expect(screen.getByText('LLM dependency')).toBeTruthy();
    expect(await screen.findByText('Budgets')).toBeTruthy();
    expect(await screen.findByText(/routine calls remaining/i)).toBeTruthy();
    expect(await screen.findByText(/high-priority calls remaining/i)).toBeTruthy();
    expect(await screen.findByText(/does the llm actually help/i)).toBeTruthy();
    expect((await screen.findAllByText('evidence synthesis')).length).toBeGreaterThan(0);
    expect(await screen.findByText(/value router/i)).toBeTruthy();
    expect(await screen.findByText('local model handles it')).toBeTruthy();
  });

  it('never renders credential-like fields from the payload', async () => {
    render(<TradingUSA />);
    await screen.findAllByText('Groq');

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('sk-'); // no secret material
    expect(text).not.toContain('API_KEY');
    expect(text).not.toContain('GROQ_API_KEY');
    expect(text).not.toContain('do-not-render');
  });
});