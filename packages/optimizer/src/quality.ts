import type { QualityMetrics } from '@promptslim/shared-types';
import { CONSTRAINT_RE, EXAMPLE_RE, OUTPUT_FORMAT_RE, ROLE_RE, SAFETY_RE } from './mask';

/**
 * Informational quality metrics for a prompt (0-100 each).
 * Explicitly NOT a factual-accuracy or capability prediction.
 */

const FILLER_WORDS = new Set([
  'very', 'really', 'just', 'basically', 'actually', 'literally', 'simply',
  'definitely', 'kindly', 'please', 'perhaps', 'somewhat', 'quite',
]);

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

function redundancyScore(text: string): number {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' '))
    .filter((s) => s.split(' ').length >= 6);
  if (sentences.length === 0) return 100;
  const seen = new Set<string>();
  let dup = 0;
  for (const s of sentences) {
    const key = s.split(' ').slice(0, 8).join(' ');
    if (seen.has(key)) dup += 1;
    seen.add(key);
  }
  const words = tokens(text);
  const filler = words.filter((w) => FILLER_WORDS.has(w)).length;
  const fillerRatio = words.length ? filler / words.length : 0;
  return clamp(100 - (dup / sentences.length) * 70 - fillerRatio * 260);
}

function instructionDensity(text: string): number {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return 0;
  const imperative = lines.filter((l) =>
    /^(analyze|write|create|list|extract|summarize|generate|provide|respond|return|output|use|include|keep|ensure|follow|format|draft|answer|compare|explain|identify|translate|review|classify|convert|produce|do |don'?t|must|never|always|required:|constraint|role|task|objective|context|example|output)/i.test(l) ||
    /[\uE000]/.test(l),
  ).length;
  return clamp((imperative / lines.length) * 160);
}

function constraintClarity(text: string): number {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const constraints = lines.filter((l) => CONSTRAINT_RE.test(l) && l.length <= 220).length;
  const safety = lines.filter((l) => SAFETY_RE.test(l)).length;
  const fmt = lines.filter((l) => OUTPUT_FORMAT_RE.test(l)).length;
  const signals = constraints + safety + fmt;
  if (signals === 0) return clamp((lines.length ? 20 : 0));
  return clamp(Math.min(100, signals / Math.max(1, lines.length * 0.25) * 50));
}

function structureScore(text: string): number {
  const lines = text.split('\n');
  let s = 0;
  if (lines.some((l) => ROLE_RE.test(l.trim()))) s += 18;
  if (lines.some((l) => /^(objective|task|goal|your task is)/i.test(l.trim()))) s += 16;
  if (lines.some((l) => /^(context|background)/i.test(l.trim()))) s += 14;
  if (lines.some((l) => /^(constraints?|rules?|requirements?|guidelines?)/i.test(l.trim()))) s += 16;
  if (lines.some((l) => /^(examples?|e\.g\.|for example)/i.test(l.trim())) || EXAMPLE_RE.test(lines.join('\n'))) s += 14;
  if (lines.some((l) => OUTPUT_FORMAT_RE.test(l.trim()))) s += 16;
  if (/^#{1,6}\s/m.test(text)) s += 6;
  return clamp(s);
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function qualityForText(text: string): QualityMetrics {
  const redundancy = redundancyScore(text);
  const density = instructionDensity(text);
  const clarity = constraintClarity(text);
  const structure = structureScore(text);
  const score = clamp(
    redundancy * 0.3 + density * 0.25 + clarity * 0.25 + structure * 0.2,
  );
  return { score, redundancy, instructionDensity: density, constraintClarity: clarity, structure };
}
