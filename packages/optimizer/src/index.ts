import type {
  ChangeLogEntry,
  OptimizationLevel,
  OptimizationResult,
  PreservationScores,
  TokenCount,
  PreservableItem,
  TokenizerType,
} from '@promptslim/shared-types';
import { estimateTokens } from '@promptslim/token-counter';
import {
  analyzeStructure,
  CONSTRAINT_RE,
  EXAMPLE_RE,
  findPlaceholders,
  hasSlot,
  maskText,
  OUTPUT_FORMAT_RE,
  restoreText,
  SAFETY_RE,
} from './mask';
import {
  applyPhraseRules,
  contentWords,
  dedupeSentences,
  dropMetaLines,
  jaccard,
  LEVEL_RANK,
} from './rules';
import { qualityForText } from './quality';

export * from './mask';
export * from './rules';
export * from './quality';
export * from './samples';

const count: (t: string) => number = (t) => estimateTokens(t, 'heuristic').tokens;

export const LEVEL_TARGET_HINT: Record<OptimizationLevel, string> = {
  conservative: 'Target 10-25% reduction. Preserves every nuance; only politeness, filler, and duplicates removed.',
  balanced: 'Target 25-50% reduction. Default. Removes verbose collocations, redundancy, and repeated instructions.',
  aggressive: 'Target 50%+ reduction. Restructures and compresses hard. May slightly alter model behavior — review the diff.',
};

/**
 * Stage-1 deterministic optimizer. Pure string logic — no network, no AI call.
 * Order: mask protected content -> compress phrases -> dedupe -> drop meta
 * chatter -> restore verbatim -> validate preservation.
 */
export function optimizePrompt(
  originalText: string,
  level: OptimizationLevel,
  tokenizerType: TokenizerType = 'heuristic',
): OptimizationResult {
  const changes: ChangeLogEntry[] = [];
  const originalTokens = estimateTokens(originalText, tokenizerType);

  const masked = maskText(originalText);
  let lines = masked.text.split('\n');

  // 1. collapse consecutive blank lines / trailing spaces (separators kept)
  lines = lines.map((l) => l.replace(/[ \t]+$/g, ''));
  const collapsed: string[] = [];
  let blankDropped = 0;
  for (const l of lines) {
    const prev = collapsed[collapsed.length - 1];
    if (!l.trim() && prev !== undefined && !prev.trim()) {
      blankDropped += 1;
      continue;
    }
    collapsed.push(l);
  }
  lines = collapsed;
  if (blankDropped > 0) {
    changes.push({
      kind: 'collapsed-whitespace',
      description: `Collapsed ${blankDropped} redundant blank line${blankDropped === 1 ? '' : 's'}`,
      tokensSaved: Math.max(1, blankDropped),
    });
  }

  // 2. phrase compression (level-gated; slots opaque, tags rewritten-not-removed)
  lines = applyPhraseRules(lines, level, changes, count);

  // 3. duplicate / semantic-duplicate removal
  let maskedText = dedupeSentences(lines.join('\n'), level, changes, count);

  // 4. aggressive: drop pure conversational sentences
  if (LEVEL_RANK[level] >= LEVEL_RANK.aggressive) {
    maskedText = dropMetaLines(maskedText, changes, count);
  }

  // 5. restore protected content verbatim
  let optimizedText = restoreText(masked, maskedText);
  optimizedText = optimizedText.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();

  const optimizedTokens = estimateTokens(optimizedText, tokenizerType);
  if (optimizedTokens.tokens >= originalTokens.tokens) {
    // never return something longer than the original
    return finalize(originalText, originalText, level, originalTokens, originalTokens, [], tokenizerType);
  }
  for (const c of changes) if (!Number.isFinite(c.tokensSaved)) c.tokensSaved = 0;
  return finalize(originalText, optimizedText, level, originalTokens, optimizedTokens, changes, tokenizerType);
}

function finalize(
  originalText: string,
  optimizedText: string,
  level: OptimizationLevel,
  originalTokens: TokenCount,
  optimizedTokens: TokenCount,
  changes: ChangeLogEntry[],
  _tokenizerType: TokenizerType,
): OptimizationResult {
  const reductionPercent =
    originalTokens.tokens > 0
      ? ((originalTokens.tokens - optimizedTokens.tokens) / originalTokens.tokens) * 100
      : 0;
  return {
    originalText,
    optimizedText,
    level,
    originalTokens,
    optimizedTokens,
    reductionPercent: Math.max(0, reductionPercent),
    changeLog: changes,
    preservation: computePreservation(originalText, optimizedText),
    structure: analyzeStructure(originalText),
  };
}

/**
 * Heuristic Prompt Preservation Score.
 * Phase-3 seam: swap for embeddings/LLM comparison — same output shape
 * (0-100 sub-scores + warnings + notes), better engine behind it.
 */
export function computePreservation(original: string, optimized: string): PreservationScores {
  const warnings: string[] = [];
  const notes: string[] = [];
  const optLines = optimized.split('\n').map((l) => l.trim()).filter(Boolean);
  const optSets = optLines.map(contentWords);

  const survives = (line: string): boolean => {
    const set = contentWords(line);
    if (set.size === 0) return true;
    return optSets.some((o) => jaccard(set, o) >= 0.4);
  };

  // --- placeholders (hard guarantee) ----------------------------------------
  const origPh = findPlaceholders(original);
  const uniqPh = Array.from(new Set(origPh));
  let phKept = 0;
  for (const ph of uniqPh) {
    const wanted = origPh.filter((p) => p === ph).length;
    const have = (optimized.match(new RegExp(escapeRe(ph), 'g')) ?? []).length;
    if (have >= wanted) {
      phKept += 1;
      notes.push(`Variable ${ph} preserved`);
    } else {
      warnings.push(`Possible variable removed: ${ph}`);
    }
  }
  const placeholders = uniqPh.length === 0 ? 100 : Math.round((phKept / uniqPh.length) * 100);

  // --- structural blocks (JSON / XML / code) restored verbatim ---------------
  const blocks = extractBlocks(original);
  let blocksKept = 0;
  const optFlat = optimized.replace(/\s+/g, ' ');
  for (const b of blocks) {
    if (optFlat.includes(b.text.replace(/\s+/g, ' ').trim())) {
      blocksKept += 1;
      if (b.type === 'json-block') notes.push('JSON schema preserved');
      else if (b.type === 'xml-block') notes.push('XML tags preserved');
      else notes.push('Code block preserved');
    } else {
      const label = b.type === 'json-block' ? 'JSON schema' : b.type === 'xml-block' ? 'XML block' : 'Code block';
      warnings.push(`${label} may have changed — verify before shipping`);
    }
  }

  // --- constraints / safety / examples / output-format lines ------------------
  const contentLines = (t: string, pred: (l: string) => boolean) =>
    t
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !hasSlot(l) && pred(l));

  const scoreGroup = (pred: (l: string) => boolean): { total: number; kept: number } => {
    const orig = contentLines(original, pred);
    let kept = 0;
    for (const line of orig) if (survives(line)) kept += 1;
    return { total: orig.length, kept };
  };

  const constraints = scoreGroup((l) => CONSTRAINT_RE.test(l) && !SAFETY_RE.test(l));
  const safety = scoreGroup((l) => SAFETY_RE.test(l));
  const fmt = scoreGroup((l) => OUTPUT_FORMAT_RE.test(l));
  const examples = scoreGroup((l) => EXAMPLE_RE.test(l));

  const constraintScore =
    constraints.total === 0 ? 100 : Math.round((constraints.kept / constraints.total) * 100);
  if (safety.total > safety.kept) warnings.push('Possible safety requirement removed');
  const safetyScore = safety.total === 0 ? 100 : Math.round((safety.kept / safety.total) * 100);
  if (fmt.total > fmt.kept) warnings.push('Output format may have changed');
  else if (fmt.total > 0) notes.push('Output format instructions preserved');
  if (examples.total > examples.kept) {
    warnings.push(
      `Example removed during compression (${examples.total - examples.kept} of ${examples.total})`,
    );
  }

  const fmtTotal = fmt.total + blocks.length;
  const fmtKept = fmt.kept + blocksKept;
  const outputFormat = fmtTotal === 0 ? 100 : Math.round((fmtKept / fmtTotal) * 100);

  // --- intent: unique content sentences surviving (fuzzy) --------------------
  const origSents = uniqueSentences(original);
  let surviving = 0;
  for (const s of origSents) if (survives(s)) surviving += 1;
  const intent =
    origSents.length === 0 ? 100 : Math.min(100, Math.round((surviving / origSents.length) * 100 + 8));

  const overall = Math.round(
    intent * 0.3 +
      Math.min(constraintScore, safetyScore) * 0.25 +
      outputFormat * 0.25 +
      placeholders * 0.2,
  );

  if (original.trim() === optimized.trim()) notes.push('No changes needed — prompt already efficient');

  return {
    intent,
    constraints: Math.min(constraintScore, safetyScore),
    outputFormat,
    placeholders,
    overall: Math.min(100, overall),
    warnings: Array.from(new Set(warnings)),
    notes: Array.from(new Set(notes)),
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBlocks(text: string): Array<{ type: PreservableItem['type']; text: string }> {
  const out: Array<{ type: PreservableItem['type']; text: string }> = [];
  for (const f of text.match(/```[\s\S]*?```/g) ?? []) {
    out.push({ type: f.toLowerCase().includes('```json') ? 'json-block' : 'code-block', text: f });
  }
  for (const x of text.match(/<[A-Za-z][\w.\-]*(?:\s[^>]*)?>[\s\S]*?<\/[A-Za-z][\w.\-]*>/g) ?? []) {
    out.push({ type: 'xml-block', text: x });
  }
  for (const j of jsonBlocksIn(text)) {
    out.push({ type: 'json-block', text: j });
  }
  return out;
}

/** Brace-balanced JSON object scan (same logic as masking, kept local to validation). */
function jsonBlocksIn(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      let depth = 0;
      let end = -1;
      for (let j = i; j < text.length; j++) {
        if (text[j] === '{') depth += 1;
        else if (text[j] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end > i) {
        const block = text.slice(i, end + 1);
        if (/"[^"]+"\s*:/.test(block) && block.length > 12) {
          out.push(block);
          i = end + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  return out;
}

function uniqueSentences(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (hasSlot(line)) continue;
    for (const s of line.split(/(?<=[.!?])\s+/)) {
      const t = s.replace(/[\u2E1E][CESFRX][\u2E1E]/g, '').trim();
      if (t.length < 25) continue;
      const key = t.toLowerCase().replace(/[^a-z0-9 ]/g, '');
      if (seen.has(key)) continue; // intentional dedupe — no intent penalty
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

export interface AnalysisBundle {
  characters: number;
  words: number;
  lines: number;
  sentences: number;
  tokens: TokenCount;
  structure: ReturnType<typeof analyzeStructure>;
  quality: ReturnType<typeof qualityForText>;
  preserved: PreservableItem[];
}

/** Instant analysis for the live counters and structure/quality cards. */
export function analyzePromptText(text: string, tokenizerType: TokenizerType = 'heuristic'): AnalysisBundle {
  const masked = maskText(text);
  return {
    characters: text.length,
    words: (text.match(/\S+/g) ?? []).length,
    lines: text.split('\n').length,
    sentences: (text.match(/[^.!?\n]+[.!?]+/g) ?? []).length,
    tokens: estimateTokens(text, tokenizerType),
    structure: analyzeStructure(text),
    quality: qualityForText(text),
    preserved: masked.protectedItems,
  };
}
