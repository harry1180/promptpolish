/**
 * Value-of-information estimate for invoking an LLM on a given situation.
 *
 * value = clamp(core * (0.6 + 0.4 * boost), 0, 1) where
 *   core  = novelty * materiality * currentUncertainty * max(historicalLlmBenefit, 0.25)
 *   boost = clamp(0.35*modelDisagreement + 0.30*portfolioExposure
 *               + 0.20*strategyImportance + 0.15*informationComplexity, 0, 1)
 * Monotonically non-decreasing in every input (inputs are clamped to 0..1).
 */
import type { LlmValueInput } from './types.ts';

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function llmValueScore(i: LlmValueInput): number {
  const novelty = clamp01(i.novelty);
  const materiality = clamp01(i.materiality);
  const uncertainty = clamp01(i.currentUncertainty);
  const benefit = clamp01(i.historicalLlmBenefit);
  const core = novelty * materiality * uncertainty * Math.max(benefit, 0.25);
  const boost = clamp01(
    0.35 * clamp01(i.modelDisagreement) +
      0.3 * clamp01(i.portfolioExposure) +
      0.2 * clamp01(i.strategyImportance) +
      0.15 * clamp01(i.informationComplexity),
  );
  return clamp01(core * (0.6 + 0.4 * boost));
}

export const LLM_VALUE_THRESHOLD = 0.35;

/** value >= threshold -> invoke (threshold is inclusive). */
export function shouldInvokeLlm(value: number, threshold: number = LLM_VALUE_THRESHOLD): boolean {
  return value >= threshold;
}