export * from './diff';

import type { OptimizationLevel } from '@promptslim/shared-types';

/** History record stored in LocalStorage — prompt text only if user opted in. */
export interface HistoryEntry {
  id: string;
  date: string; // ISO
  modelId: string;
  level: OptimizationLevel;
  originalTokens: number;
  optimizedTokens: number;
  reductionPercent: number;
  originalText?: string; // present only when "Save prompt text" is ON
  optimizedText?: string;
}

export const HISTORY_KEY = 'promptslim.history.v1';
export const HISTORY_MAX = 50;

export interface HistoryStore {
  load(): HistoryEntry[];
  save(entries: HistoryEntry[]): void;
  clear(): void;
}

/** Store implementation over any WebStorage-like backend (localStorage / chrome.storage.local in Phase 2). */
export function makeHistoryStore(storage: {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}): HistoryStore {
  return {
    load() {
      try {
        const raw = storage.getItem(HISTORY_KEY);
        return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
      } catch {
        return [];
      }
    },
    save(entries) {
      try {
        storage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, HISTORY_MAX)));
      } catch {
        /* storage full or unavailable — history is best-effort */
      }
    },
    clear() {
      storage.removeItem(HISTORY_KEY);
    },
  };
}

/** Export helpers for TXT / Markdown / JSON downloads. */
export function buildExportJSON(input: {
  originalTokens: number;
  optimizedTokens: number;
  reductionPercent: number;
  model: string;
  modelProvider: string;
  level: OptimizationLevel;
  optimizedPrompt: string;
  estimatedSavings: Record<string, number | string>;
  /** Optional input+output cost split for one request (currency USD by convention). */
  estimatedCostPerRequest?: Record<string, number | string>;
  preservation: unknown;
}): string {
  return JSON.stringify(
    {
      app: 'PromptPolice',
      exportedAt: new Date().toISOString(),
      originalTokens: input.originalTokens,
      optimizedTokens: input.optimizedTokens,
      reductionPercent: Number(input.reductionPercent.toFixed(1)),
      model: `${input.modelProvider} ${input.model}`,
      optimizationLevel: input.level,
      optimizedPrompt: input.optimizedPrompt,
      estimatedSavings: input.estimatedSavings,
      ...(input.estimatedCostPerRequest
        ? { estimatedCostPerRequest: input.estimatedCostPerRequest }
        : {}),
      preservation: input.preservation,
    },
    null,
    2,
  );
}

export function buildExportMarkdown(input: {
  original: string;
  optimized: string;
  stats: string[];
  model: string;
  level: string;
}): string {
  return [
    `# PromptPolice Optimization Report`,
    ``,
    `- **Model:** ${input.model}`,
    `- **Level:** ${input.level}`,
    `- **Exported:** ${new Date().toISOString()}`,
    '',
    '## Results',
    ...input.stats.map((s) => `- ${s}`),
    '',
    '## Original Prompt',
    '```',
    input.original,
    '```',
    '',
    '## Optimized Prompt',
    '```',
    input.optimized,
    '```',
    '',
  ].join('\n');
}

export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
