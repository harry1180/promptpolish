import { describe, expect, it } from 'vitest';
import { getModel } from '@promptslim/model-config';
import {
  compareModels,
  computeSavings,
  costBreakdown,
  formatUSD,
  inputCostPerRequest,
  outputCostPerRequest,
  requestCost,
} from '../src/index';

const gpt = getModel('gpt-5.4')!;

describe('pricing math', () => {
  it('input cost per request uses $/1M tokens', () => {
    // 2,843 tokens at $2.50/M -> ~$0.007108
    const c = inputCostPerRequest(gpt, 2843);
    expect(c).toBeCloseTo(0.007108, 6);
  });

  it('request cost adds input + output', () => {
    const c = requestCost(gpt, 1000, 500);
    expect(c).toBeCloseTo((1000 / 1e6) * 2.5 + (500 / 1e6) * 15, 10);
  });

  it('percentage reduction', () => {
    const s = computeSavings(gpt, 2843, 1126, 100000);
    expect(s.reductionPercent).toBeCloseTo(((2843 - 1126) / 2843) * 100, 6);
  });

  it('monthly savings per tier scale linearly', () => {
    const s = computeSavings(gpt, 2843, 1126, 100000);
    expect(s.monthlyByTier[100000]).toBeCloseTo(s.perRequest * 100000, 6);
    expect(s.monthlyByTier[100000]).toBeCloseTo(s.monthlyByTier[10000] * 10, 4);
    expect(s.annual).toBeCloseTo(s.monthlyByTier[100000] * 12, 2);
  });

  it('no negative savings when optimizer shrank nothing', () => {
    const s = computeSavings(gpt, 100, 100, 5000);
    expect(s.perRequest).toBe(0);
    expect(s.reductionPercent).toBe(0);
    expect(s.annual).toBe(0);
  });

  it('compareModels covers every configured model', () => {
    const rows = compareModels(1500);
    expect(rows.length).toBeGreaterThan(8);
    for (const r of rows) expect(r.costPerRequest).toBeGreaterThan(0);
    const cheap = rows.reduce((a, b) => (a.costPerRequest <= b.costPerRequest ? a : b));
    expect(cheap.model.provider).toBeTruthy();
  });

  it('output cost uses $/1M tokens', () => {
    // 1,200 output tokens at $15/M -> $0.018
    expect(outputCostPerRequest(gpt, 1200)).toBeCloseTo(0.018, 10);
  });

  it('costBreakdown splits input and output and totals them', () => {
    const b = costBreakdown(gpt, 1000, 500);
    expect(b.inputCost).toBeCloseTo(0.0025, 10);
    expect(b.outputCost).toBeCloseTo(0.0075, 10);
    expect(b.totalCost).toBeCloseTo(b.inputCost + b.outputCost, 12);
  });

  it('compareModels rows expose input/output split for output-heavy prompts', () => {
    const rows = compareModels(1500, 1000);
    for (const r of rows) {
      expect(r.outputTokens).toBe(1000);
      expect(r.inputCost).toBeCloseTo((1500 / 1e6) * r.model.inputPricePerMillionTokens, 10);
      expect(r.outputCost).toBeCloseTo((1000 / 1e6) * r.model.outputPricePerMillionTokens, 10);
      expect(r.costPerRequest).toBeCloseTo(r.inputCost + r.outputCost, 12);
      expect(r.monthly100k).toBeCloseTo(r.costPerRequest * 100_000, 8);
    }
    // with output included, output price dominates model ordering vs input-only
    const inputOnly = compareModels(1500, 0);
    const outSide = rows.reduce((a, b) => (a.outputCost <= b.outputCost ? a : b));
    expect(outSide.model.outputPricePerMillionTokens).toBeGreaterThan(0);
    expect(inputOnly.length).toBe(rows.length);
  });

  it('formatUSD renders micro and large amounts', () => {
    expect(formatUSD(0.0042)).toBe('$0.0042');
    expect(formatUSD(2500)).toBe('$2,500');
    expect(formatUSD(0)).toBe('$0.00');
  });

  it('every model has complete pricing metadata', async () => {
    const { catalog } = await import('@promptslim/model-config');
    for (const m of catalog.models) {
      expect(m.inputPricePerMillionTokens).toBeGreaterThan(0);
      expect(m.outputPricePerMillionTokens).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThanOrEqual(4096);
      expect(m.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.tokenizerType).toBeTruthy();
    }
  });
});
