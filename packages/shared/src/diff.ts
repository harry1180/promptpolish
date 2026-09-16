/**
 * Word-level diff used by the Diff view (web + extension share it).
 * Deliberately calm: equal runs are collapsed, single-token changes grouped.
 */

export interface DiffPart {
  type: 'equal' | 'removed' | 'added';
  text: string;
}

function words(text: string): string[] {
  // keep whitespace chunks attached so rendering needs no re-joining logic
  return text.match(/\S+\s*|\s+/g) ?? [];
}

export function diffWords(original: string, optimized: string): DiffPart[] {
  const a = words(original);
  const b = words(optimized);
  const lcs = lcsTable(a, b);
  const parts: DiffPart[] = [];
  let i = a.length;
  let j = b.length;
  const push = (type: DiffPart['type'], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text = text + last.text;
    else parts.push({ type, text });
  };
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      push('equal', a[i - 1]!);
      i -= 1;
      j -= 1;
    } else if (lcs[i - 1][j]! >= lcs[i][j - 1]!) {
      push('removed', a[i - 1]!);
      i -= 1;
    } else {
      push('added', b[j - 1]!);
      j -= 1;
    }
  }
  while (i > 0) {
    push('removed', a[i - 1]!);
    i -= 1;
  }
  while (j > 0) {
    push('added', b[j - 1]!);
    j -= 1;
  }
  return parts.reverse();
}

function lcsTable(a: string[], b: string[]): number[][] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  return dp;
}

/** Collapse equal runs that are only punctuation/whitespace noise into neighbors? No — keep simple. */
export function diffStats(parts: DiffPart[]): { removedWords: number; addedWords: number } {
  let removedWords = 0;
  let addedWords = 0;
  for (const p of parts) {
    const n = (p.text.match(/\S+/g) ?? []).length;
    if (p.type === 'removed') removedWords += n;
    if (p.type === 'added') addedWords += n;
  }
  return { removedWords, addedWords };
}
