import type { ModelEntry } from '@promptslim/shared-types';
import { catalog } from '@promptslim/model-config';

/**
 * All cost math in one place. Prices come exclusively from model-config
 * (models.json) — never from UI components.
 */

export const REQUEST_TIERS = [1_000, 10_000, 100_000, 1_000_000] as const;

/** Input-side cost of a single request (the prompt itself). */
export function inputCostPerRequest(model: ModelEntry, inputTokens: number): number {
  return (inputTokens / 1_000_000) * model.inputPricePerMillionTokens;
}

/** Output-side cost of a single request, given expected output tokens. */
export function outputCostPerRequest(model: ModelEntry, outputTokens: number): number {
  return (outputTokens / 1_000_000) * model.outputPricePerMillionTokens;
}

export function requestCost(model: ModelEntry, inputTokens: number, outputTokens: number): number {
  return inputCostPerRequest(model, inputTokens) + outputCostPerRequest(model, outputTokens);
}

export interface SavingsSummary {
  perRequest: number; // $ saved per request (input side only — prompt optimization reduces input tokens)
  reductionPercent: number; // token reduction %
  monthlyByTier: Record<number, number>; // tier requests -> $ saved/month
  annual: number; // $ saved/year at the chosen requests/month
}

/** Full per-request money view for one model: input + projected output. */
export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

/** Cost math for a model given input tokens and a projected output length. */
export function costBreakdown(
  model: ModelEntry,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown {
  const inputCost = inputCostPerRequest(model, inputTokens);
  const outputCost = outputCostPerRequest(model, outputTokens);
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

export function computeSavings(
  model: ModelEntry,
  originalTokens: number,
  optimizedTokens: number,
  requestsPerMonth: number,
): SavingsSummary {
  const savedTokens = Math.max(0, originalTokens - optimizedTokens);
  const perRequest = inputCostPerRequest(model, savedTokens);
  const reductionPercent =
    originalTokens > 0 ? (savedTokens / originalTokens) * 100 : 0;
  const monthlyByTier: Record<number, number> = {};
  for (const tier of REQUEST_TIERS) monthlyByTier[tier] = perRequest * tier;
  return {
    perRequest,
    reductionPercent,
    monthlyByTier,
    annual: perRequest * requestsPerMonth * 12,
  };
}

/** Cross-model comparison row for the SAME prompt. */
export interface ModelComparisonRow {
  model: ModelEntry;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  costPerRequest: number; // input + output
  monthly100k: number; // $/month at 100k requests
}

export function compareModels(inputTokens: number, outputTokens = 0): ModelComparisonRow[] {
  return catalog.models.map((model) => {
    const { inputCost, outputCost, totalCost } = costBreakdown(model, inputTokens, outputTokens);
    return {
      model,
      inputTokens,
      outputTokens,
      inputCost,
      outputCost,
      costPerRequest: totalCost,
      monthly100k: totalCost * 100_000,
    };
  });
}

// --- display helpers --------------------------------------------------------

export function formatUSD(value: number): string {
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.01) return `$${value.toFixed(4)}`;
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: abs >= 1000 ? 0 : abs >= 1 ? 2 : 3,
  });
}

export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function formatPercent(p: number, digits = 1): string {
  return `${p.toFixed(digits)}%`;
}
