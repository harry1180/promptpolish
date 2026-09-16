import type { ModelEntry, TokenCount, TokenizerType } from '@promptslim/shared-types';

/**
 * Token estimation abstraction.
 *
 * Every number is labeled 'estimated' vs 'exact' via TokenCount.method.
 * ExactTokenProvider is the seam for plugging real tokenizers later
 * (e.g. tiktoken WASM in the browser, or a server-side counter) — the app
 * only consumes TokenCount, so upgrading estimation to exact changes one
 * function, not the UI.
 */

export interface ExactTokenProvider {
  readonly name: string; // e.g. 'tiktoken o200k_base'
  count(text: string): number;
}

let exactProvider: ExactTokenProvider | null = null;

/** Register a real tokenizer at app start; pass null to fall back to estimates. */
export function setExactTokenProvider(p: ExactTokenProvider | null): void {
  exactProvider = p;
}

export function hasExactTokenProvider(): boolean {
  return exactProvider !== null;
}

// --- shared word-ish tokenizer ---------------------------------------------

/** Split into word/symbol units, keeping {{var}}, ${var}, {orderId} as ONE unit. */
export function tokenizeWords(text: string): string[] {
  return text.match(/\{\{[\w.\-]+\}\}|\$?\{[\w.\-]+\}|\[[\w.\-]+\]|<[\w.\-/]+>|\w+|[^\w\s]/g) ?? [];
}

/** Heuristic engine tuned against public tokenizers (~4 chars/token English). */
function heuristicCount(text: string): number {
  const words = tokenizeWords(text);
  let alpha = 0;
  let digits = 0;
  let punct = 0;
  for (const w of words) {
    if (/^\w+$/.test(w)) {
      if (/^[a-z]+$/i.test(w)) alpha += Math.max(1, Math.ceil(w.length / 4));
      else digits += Math.max(1, Math.ceil(w.length / 2.5));
    } else {
      punct += 1;
    }
  }
  // whitespace/capitalization overhead: +1 token per ~24 chars, capped
  const overhead = Math.min(Math.floor(text.length / 24), Math.ceil(words.length * 0.4));
  return alpha + digits + punct + overhead;
}

/**
 * o200k-style approximation (for OpenAI models without an exact provider):
 * greedy character-run segmentation — merges letters and following
 * letters/apostrophes/hyphens; digits and each punctuation char stand alone;
 * then ~1 token per 4 alpha chars.
 */
function o200kApprox(text: string): number {
  let tokens = 0;
  let alphaRun = 0;
  const flush = () => {
    if (alphaRun > 0) tokens += Math.max(1, Math.ceil(alphaRun / 4));
    alphaRun = 0;
  };
  for (const ch of text) {
    if (/[A-Za-z]/.test(ch)) {
      alphaRun += 1;
    } else if (ch === "'" || ch === '\u2019' || ch === '-') {
      // clings to a letters-only run (don't, 2024-style hyphenated words)
      if (alphaRun > 0) alphaRun += 1;
      else tokens += 1;
    } else if (/\s/.test(ch)) {
      flush();
    } else if (/\d/.test(ch)) {
      flush();
      tokens += 1;
    } else {
      flush();
      tokens += 1;
    }
  }
  flush();
  return Math.max(tokens, heuristicCount(text) > 0 ? 1 : 0);
}

function engineLabel(t: TokenizerType): string {
  if (t === 'o200k') return 'estimated o200k approximation';
  if (t === 'cl100k') return 'estimated cl100k heuristic';
  if (t === 'tiktoken') return 'estimated tiktoken-style heuristic';
  return 'estimated heuristic (chars/4 + words)';
}

export function estimateTokens(text: string, tokenizerType: TokenizerType = 'heuristic'): TokenCount {
  if (exactProvider) {
    return {
      tokens: exactProvider.count(text),
      method: 'exact',
      engine: `exact ${exactProvider.name}`,
    };
  }
  const tokens =
    tokenizerType === 'o200k'
      ? o200kApprox(text)
      : tokenizerType === 'cl100k'
        ? Math.round(heuristicCount(text) * 1.04)
        : heuristicCount(text);
  return { tokens, method: 'estimated', engine: engineLabel(tokenizerType) };
}

export function countTokens(text: string, model: ModelEntry): TokenCount {
  return estimateTokens(text, model.tokenizerType);
}

// --- projected output length -----------------------------------------------

export type OutputShape =
  | 'json-schema'
  | 'summary'
  | 'list'
  | 'classification'
  | 'code'
  | 'long-form'
  | 'qa';

export interface OutputEstimate extends TokenCount {
  /** The response shape the prompt appears to ask for. */
  shape: OutputShape;
  /** Human phrase, e.g. 'JSON schema output'. */
  shapeLabel: string;
  /** Where the number came from: hand-tuned prior vs the user's own measurements vs manual. */
  basis: 'prior' | 'learned';
  /** number of measured observations backing a 'learned' estimate (0 for prior) */
  sampleSize: number;
}

/**
 * Calibration source seam: given (modelId, shape), return the mean measured
 * output length and how many observations back it — or null when no
 * measurements exist. The web app wires this to the local cache package
 * (user-recorded real response lengths / API usage fields in Phase 3),
 * keeping token-counter DOM-free and dependency-free.
 */
export interface OutputCalibrationSource {
  lookup(modelId: string, shape: OutputShape): { mean: number; n: number } | null;
}

let calibrationSource: OutputCalibrationSource | null = null;

export function setOutputCalibrationSource(s: OutputCalibrationSource | null): void {
  calibrationSource = s;
}

const OUTPUT_SHAPES: Array<{
  shape: OutputShape;
  label: string;
  test: RegExp;
  ratio: number;
  min: number;
  max: number;
}> = [
  { shape: 'json-schema', label: 'JSON schema output', test: /\b(json|jsonschema|schema|field[s]? must|valid json)\b/i, ratio: 0.35, min: 60, max: 1200 },
  { shape: 'classification', label: 'classification / label', test: /\b(classif|categor|label it|sentiment|yes or no|true or false)\b/i, ratio: 0.08, min: 8, max: 80 },
  { shape: 'summary', label: 'summary', test: /\b(summar|tl;?dr|condense|brief)\b/i, ratio: 0.2, min: 40, max: 600 },
  { shape: 'list', label: 'bulleted list', test: /\b(list of|bullet|numbered|top \d+|steps to)\b/i, ratio: 0.4, min: 60, max: 1500 },
  { shape: 'code', label: 'code', test: /\b(implement|function|refactor|code\b|bug|compile|write a (program|script))\b/i, ratio: 0.6, min: 80, max: 2500 },
  { shape: 'long-form', label: 'long-form prose', test: /\b(essay|article|blog post|write a (report|story)|in detail|comprehensive)\b/i, ratio: 1.2, min: 300, max: 4000 },
];

/**
 * Estimate the OUTPUT token length a prompt is likely to produce.
 *
 * Honesty note: output length is decided by the model at generation time —
 * no offline method (this or any other) can be exact. So this is a
 * three-tier estimate, and every tier says so:
 *   1. CALIBRATION (best available): measured response lengths the user's
 *      own cache recorded for this model+shape (setOutputCalibrationSource).
 *      This is the concrete upgrade path the research pointed to: prior
 *      distributions per (model, shape) beat hand-tuned fixed ratios.
 *   2. SHAPE PRIOR: response-shape heuristics × input size (json-schema,
 *      classification, summary, ... qa).
 *   3. MANUAL OVERRIDE wins over both (handled by the caller).
 * method is always 'estimated': a projection, not a model call.
 */
export function estimateOutputTokens(promptText: string, modelId?: string): OutputEstimate {
  const inputTokens = heuristicCount(promptText);
  const match = OUTPUT_SHAPES.find((s) => s.test.test(promptText));
  const shape: OutputShape = match?.shape ?? 'qa';
  const shapeLabel = match?.label ?? 'general Q&A response';

  // tier 1: calibration from measured data
  const calib = modelId && calibrationSource ? calibrationSource.lookup(modelId, shape) : null;
  if (calib && calib.n >= 3 && Number.isFinite(calib.mean) && calib.mean > 0) {
    return {
      tokens: Math.max(1, Math.round(calib.mean)),
      method: 'estimated',
      engine: `calibrated from ${calib.n} measured response${calib.n === 1 ? '' : 's'} (${shapeLabel})`,
      shape,
      shapeLabel,
      basis: 'learned',
      sampleSize: calib.n,
    };
  }

  // tier 2: shape prior
  const tokens = match
    ? Math.min(match.max, Math.max(match.min, Math.round(inputTokens * match.ratio)))
    : Math.min(1500, Math.max(100, Math.round(inputTokens * 0.5))); // general Q&A
  return {
    tokens,
    method: 'estimated',
    engine: `output projection (${shapeLabel})`,
    shape,
    shapeLabel,
    basis: 'prior',
    sampleSize: calib?.n ?? 0,
  };
}
