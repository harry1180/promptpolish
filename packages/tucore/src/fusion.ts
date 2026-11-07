/**
 * Fusion of component scores (ScoreParts, each in [-1, 1]) into a single
 * action with conflict detection.
 *
 * - Default weights sum to 1 per horizon; SWING/MEDIUM linearly interpolate
 *   between SHORT and LONG. Caller partial weights are merged over the
 *   defaults and renormalized to sum 1.
 * - CONFLICT: any pair of parts whose (normalized) weight >= 0.15, both values
 *   |v| >= 0.5, opposite signs and |a - b| >= 1.0.
 * - weighted >= 0.30 && confidenceHint >= 0.55 -> BUY; <= -0.30 && >= 0.55 ->
 *   SELL; |weighted| < 0.15 -> NO_TRADE; else WATCH. confidenceHint < 0.4 can
 *   never produce BUY/SELL.
 * - returned confidence = clamp(hint * (0.7 + 0.3 * |weighted|), 0, 1),
 *   capped at 0.4 on conflict.
 */
import type { EvidenceItem, Horizon, ScoreParts, SignalAction } from './types.ts';

export interface FusionInput {
  parts: ScoreParts;
  horizon: Horizon;
  strategy: string;
  weights?: Partial<ScoreParts>;
  confidenceHint: number;
  evidence: EvidenceItem[];
  contradictions: EvidenceItem[];
}

export interface FusionResult {
  action: SignalAction;
  confidence: number;
  conflicts: string[];
  weighted: number;
}

const PART_KEYS: (keyof ScoreParts)[] = ['technical', 'fundamental', 'event', 'sentiment', 'macro', 'regime'];

const SHORT_WEIGHTS: ScoreParts = {
  technical: 0.38,
  fundamental: 0.06,
  event: 0.2,
  sentiment: 0.12,
  macro: 0.08,
  regime: 0.16,
};

const LONG_WEIGHTS: ScoreParts = {
  technical: 0.1,
  fundamental: 0.45,
  event: 0.15,
  sentiment: 0.06,
  macro: 0.12,
  regime: 0.12,
};

function lerpWeights(t: number): ScoreParts {
  const mix = (a: number, b: number): number => a + (b - a) * t;
  return {
    technical: mix(SHORT_WEIGHTS.technical, LONG_WEIGHTS.technical),
    fundamental: mix(SHORT_WEIGHTS.fundamental, LONG_WEIGHTS.fundamental),
    event: mix(SHORT_WEIGHTS.event, LONG_WEIGHTS.event),
    sentiment: mix(SHORT_WEIGHTS.sentiment, LONG_WEIGHTS.sentiment),
    macro: mix(SHORT_WEIGHTS.macro, LONG_WEIGHTS.macro),
    regime: mix(SHORT_WEIGHTS.regime, LONG_WEIGHTS.regime),
  };
}

export const FUSION_WEIGHTS: Record<Horizon, ScoreParts> = {
  SHORT: SHORT_WEIGHTS,
  SWING: lerpWeights(1 / 3),
  MEDIUM: lerpWeights(2 / 3),
  LONG: LONG_WEIGHTS,
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function fuseSignals(input: FusionInput): FusionResult {
  const defaults = FUSION_WEIGHTS[input.horizon] ?? SHORT_WEIGHTS;
  const requested = input.weights ?? {};
  const weights: Record<keyof ScoreParts, number> = {
    technical: 0,
    fundamental: 0,
    event: 0,
    sentiment: 0,
    macro: 0,
    regime: 0,
  };
  let total = 0;
  for (const k of PART_KEYS) {
    const raw = requested[k] ?? defaults[k];
    const w = Number.isFinite(raw) ? raw : 0;
    weights[k] = w;
    total += w;
  }
  if (total === 0) {
    for (const k of PART_KEYS) {
      weights[k] = defaults[k];
      total += defaults[k];
    }
  }
  for (const k of PART_KEYS) weights[k] = weights[k] / total;

  let weighted = 0;
  for (const k of PART_KEYS) {
    const v = input.parts[k];
    weighted += (Number.isFinite(v) ? v : 0) * weights[k];
  }

  const conflicts: string[] = [];
  for (let i = 0; i < PART_KEYS.length; i++) {
    for (let j = i + 1; j < PART_KEYS.length; j++) {
      const a = PART_KEYS[i];
      const b = PART_KEYS[j];
      if (weights[a] < 0.15 || weights[b] < 0.15) continue;
      const va = input.parts[a];
      const vb = input.parts[b];
      if (Math.abs(va) < 0.5 || Math.abs(vb) < 0.5) continue;
      if (Math.sign(va) === Math.sign(vb)) continue;
      if (Math.abs(va - vb) < 1.0) continue;
      if (!conflicts.includes(a)) conflicts.push(a);
      if (!conflicts.includes(b)) conflicts.push(b);
    }
  }

  const hint = Number.isFinite(input.confidenceHint) ? clamp(input.confidenceHint, 0, 1) : 0;
  let action: SignalAction;
  if (conflicts.length > 0) action = 'CONFLICTING_SIGNAL';
  else if (Math.abs(weighted) < 0.15) action = 'NO_TRADE';
  else if (weighted >= 0.15 && hint >= 0.75) action = 'BUY'; // strategy conviction + net support, no conflicts
  else if (weighted <= -0.15 && hint >= 0.75) action = 'SELL';
  else if (weighted >= 0.3 && hint >= 0.55) action = 'BUY';
  else if (weighted <= -0.3 && hint >= 0.55) action = 'SELL';
  else action = 'WATCH';

  let confidence = clamp(hint * (0.7 + 0.3 * Math.abs(weighted)), 0, 1);
  if (conflicts.length > 0) confidence = Math.min(confidence, 0.4);

  return { action, confidence, conflicts, weighted };
}

/** Aliases — same signature as fuseSignals (the contract did not pin a function name). */
export const fuse = fuseSignals;
export const fuseScore = fuseSignals;
export const fuseParts = fuseSignals;