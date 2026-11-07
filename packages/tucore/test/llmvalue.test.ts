import { describe, expect, it } from 'vitest';
import { LLM_VALUE_THRESHOLD, llmValueScore, shouldInvokeLlm } from '../src/llmvalue.ts';
import type { LlmValueInput } from '../src/types.ts';

const KEYS: (keyof LlmValueInput)[] = [
  'novelty',
  'materiality',
  'portfolioExposure',
  'strategyImportance',
  'modelDisagreement',
  'currentUncertainty',
  'historicalLlmBenefit',
  'informationComplexity',
];

function input(overrides: Partial<LlmValueInput> = {}): LlmValueInput {
  return {
    novelty: 0.5,
    materiality: 0.5,
    portfolioExposure: 0.5,
    strategyImportance: 0.5,
    modelDisagreement: 0.5,
    currentUncertainty: 0.5,
    historicalLlmBenefit: 0.5,
    informationComplexity: 0.5,
    ...overrides,
  };
}

describe('llmValueScore', () => {
  it('zero novelty stays below the threshold', () => {
    const value = llmValueScore(input({ novelty: 0 }));
    expect(value).toBe(0);
    expect(shouldInvokeLlm(value)).toBe(false);
    expect(value).toBeLessThan(LLM_VALUE_THRESHOLD);
    expect(shouldInvokeLlm(llmValueScore(input({ materiality: 0 })))).toBe(false);
    expect(shouldInvokeLlm(llmValueScore(input({ currentUncertainty: 0 })))).toBe(false);
  });

  it('all-high inputs score above the threshold', () => {
    const value = llmValueScore(input({
      novelty: 1, materiality: 1, portfolioExposure: 1, strategyImportance: 1,
      modelDisagreement: 1, currentUncertainty: 1, historicalLlmBenefit: 1, informationComplexity: 1,
    }));
    expect(value).toBeCloseTo(1, 12);
    expect(value).toBeGreaterThanOrEqual(LLM_VALUE_THRESHOLD);
    expect(shouldInvokeLlm(value)).toBe(true);
  });

  it('monotonically non-decreasing in every input', () => {
    const base = llmValueScore(input());
    for (const key of KEYS) {
      const bumped = llmValueScore(input({ [key]: 0.9 }));
      expect(bumped).toBeGreaterThanOrEqual(base - 1e-12);
      const maxed = llmValueScore(input({ [key]: 1 }));
      expect(maxed).toBeGreaterThanOrEqual(bumped - 1e-12);
      const lowered = llmValueScore(input({ [key]: 0.1 }));
      expect(lowered).toBeLessThanOrEqual(base + 1e-12);
    }
    // historicalLlmBenefit below the 0.25 floor still cannot lower the score
    const lowBenefit = llmValueScore(input({ historicalLlmBenefit: 0 }));
    expect(llmValueScore(input({ historicalLlmBenefit: 0.1 }))).toBeGreaterThanOrEqual(lowBenefit - 1e-12);
  });

  it('value is bounded to [0, 1] and matches the documented formula', () => {
    const i = input({ novelty: 0.8, materiality: 0.7, currentUncertainty: 0.6, historicalLlmBenefit: 0.5, modelDisagreement: 0.4, portfolioExposure: 0.3, strategyImportance: 0.2, informationComplexity: 0.1 });
    const core = 0.8 * 0.7 * 0.6 * Math.max(0.5, 0.25);
    const boost = 0.35 * 0.4 + 0.3 * 0.3 + 0.2 * 0.2 + 0.15 * 0.1;
    expect(llmValueScore(i)).toBeCloseTo(core * (0.6 + 0.4 * boost), 12);
    expect(llmValueScore(i)).toBeLessThanOrEqual(1);
    // out-of-range inputs are clamped, never > 1
    expect(llmValueScore(input({ novelty: 5, materiality: 5, currentUncertainty: 5, historicalLlmBenefit: 5, modelDisagreement: 5, portfolioExposure: 5, strategyImportance: 5, informationComplexity: 5 }))).toBe(1);
  });

  it('threshold helper is inclusive at the boundary', () => {
    expect(LLM_VALUE_THRESHOLD).toBe(0.35);
    expect(shouldInvokeLlm(0.349)).toBe(false);
    expect(shouldInvokeLlm(0.35)).toBe(true);
    expect(shouldInvokeLlm(0.36)).toBe(true);
    expect(shouldInvokeLlm(0.1, 0.05)).toBe(true);
    expect(shouldInvokeLlm(0.5, 0.6)).toBe(false);
  });
});