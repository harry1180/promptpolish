import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultModelId, getModel } from '@promptslim/model-config';
import { analyzePromptText, getSample, optimizePrompt, type AnalysisBundle } from '@promptslim/optimizer';
import {
  estimateOutputTokens,
  setOutputCalibrationSource,
  type OutputEstimate,
  type OutputShape,
} from '@promptslim/token-counter';
import { computeSavings, type SavingsSummary } from '@promptslim/pricing-engine';
import { governQuery, type GovernanceReport } from '@promptslim/governance';
import type { OptimizationLevel, OptimizationResult } from '@promptslim/shared-types';
import { getPromptCache, type CacheOutcome } from './useCache';

export interface SlimResult extends OptimizationResult {
  modelId: string;
  /** governance state of the query that produced this result */
  fromCache: boolean;
}

interface Prefs {
  modelId?: string;
  level?: OptimizationLevel;
  requests?: number;
}

const PREFS_KEY = 'promp…s.v1';

function loadPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Prefs;
  } catch {
    return {};
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — prefs are best-effort */
  }
}

/** Wire the output-length calibration seam to the cache's measured data. */
function installCalibration(): void {
  const cache = getPromptCache();
  setOutputCalibrationSource({
    lookup(modelId: string, shape: OutputShape) {
      const m = cache.measuredOutputs().get(`${modelId}::${shape}`);
      return m ? { mean: m.total / m.n, n: m.n } : null;
    },
  });
}

/** Single source of UI state for the optimizer; shared by web app (and later the extension popup). */
export function usePromptSlim() {
  const prefs = useMemo(loadPrefs, []);
  const [text, setText] = useState('');
  const [modelId, setModelId] = useState<string>(() =>
    getModel(prefs.modelId ?? '') ? prefs.modelId! : defaultModelId,
  );
  const [level, setLevel] = useState<OptimizationLevel>(prefs.level ?? 'balanced');
  const [requests, setRequests] = useState<number>(
    Number.isFinite(prefs.requests) && prefs.requests ? prefs.requests : 100_000,
  );
  const [result, setResult] = useState<SlimResult | null>(null);
  const [sampleId, setSampleId] = useState('');
  const [runId, setRunId] = useState(0);
  /** null = use the automatic projection; a number = user override. */
  const [outputOverride, setOutputOverride] = useState<number | null>(null);
  const [governance, setGovernance] = useState<GovernanceReport | null>(null);
  const [cacheOutcome, setCacheOutcome] = useState<CacheOutcome | null>(null);
  const [cacheTick, setCacheTick] = useState(0);
  const lastEntryId = useRef<string | null>(null);

  useEffect(() => { installCalibration(); }, []);

  const model = getModel(modelId) ?? getModel(defaultModelId)!;

  const analysis: AnalysisBundle | null = useMemo(
    () => (text.trim() ? analyzePromptText(text, model.tokenizerType) : null),
    [text, model],
  );

  const optimize = useCallback(() => {
    if (!text.trim()) return;
    const cache = getPromptCache();

    // ---- governance gate (runs before any "provider" work) ----
    const gov = governQuery(text);
    setGovernance(gov);
    if (gov.verdict === 'block') {
      // fail-closed: no optimization run, no cache interaction
      setResult(null);
      setCacheOutcome({
        status: 'blocked-governance', similarity: 0, served: false, entryId: null,
        at: Date.now(), note: gov.reasons[0] ?? 'Blocked by governance guardrails.',
      });
      return;
    }

    // ---- cache lookup: reuse is gated to reuseSafe queries; exact hits
    //      (the user's own identical prompt) are always allowed ----
    const reuseSafe = gov.reuseSafe;
    const lookup = cache.lookup(text, modelId, level, reuseSafe);
    if (lookup.entry) {
      try {
        const cached = lookup.entry.payload['result'] as SlimResult;
        const fresh: SlimResult = { ...cached, modelId, fromCache: true };
        cache.recordOutcome(lookup, lookup.entry.payload['inputTokens'] as number ?? 0);
        lastEntryId.current = lookup.entry.id;
        setResult(fresh);
        setRunId((n) => n + 1);
        setCacheTick((c) => c + 1);
        setCacheOutcome({
          status: lookup.status, similarity: lookup.similarity, served: true,
          entryId: lookup.entry.id, at: Date.now(), note: lookup.note,
        });
        return;
      } catch {
        /* corrupt payload — fall through to a fresh run */
      }
    }
    setCacheOutcome(lookup.entry === null && lookup.status !== 'miss'
      ? {
          status: lookup.status, similarity: lookup.similarity, served: false,
          entryId: lookup.matchedId, at: Date.now(), note: lookup.note,
          partialContext: lookup.partialContext,
        }
      : null);

    // ---- fresh run (this is the "provider call") ----
    const r = optimizePrompt(text, level, model.tokenizerType);
    const slim: SlimResult = { ...r, modelId, fromCache: false };
    const outEst = estimateOutputTokens(text, modelId);
    const entry = cache.put(text, modelId, level, reuseSafe, {
      result: slim,
      inputTokens: r.originalTokens.tokens,
      outputTokens: outEst.tokens,
      shape: outEst.shape,
    });
    cache.recordOutcome(lookup, 0);
    lastEntryId.current = entry.id;
    setResult(slim);
    setRunId((n) => n + 1);
    setCacheTick((c) => c + 1);
  }, [text, level, model, modelId]);

  // level or model changed while a result is visible -> recompute immediately (local, <50ms)
  const reoptGuard = useRef(0);
  useEffect(() => {
    if (!result) return;
    if (result.modelId === modelId && result.level === level) return;
    if (!text.trim()) return;
    // route through the same governance+cache path on the next tick
    if (reoptGuard.current !== runId) {
      reoptGuard.current = runId;
      optimize();
    }
  }, [level, modelId, result, text, model, optimize, runId]);

  useEffect(() => {
    savePrefs({ modelId, level, requests });
  }, [modelId, level, requests]);

  /** Automatic projection of the response length for the current prompt. */
  const outputEstimate: OutputEstimate | null = useMemo(
    () => (text.trim() ? estimateOutputTokens(text, modelId) : null),
    [text, modelId],
  );

  /** Effective output tokens used for cost math: override wins, else projection. */
  const outputTokens: number | null =
    outputOverride ?? outputEstimate?.tokens ?? null;

  const savings: SavingsSummary | null = useMemo(
    () =>
      result
        ? computeSavings(model, result.originalTokens.tokens, result.optimizedTokens.tokens, requests)
        : null,
    [result, model, requests],
  );

  const reset = useCallback(() => {
    setText('');
    setResult(null);
    setSampleId('');
    setOutputOverride(null);
    setGovernance(null);
    setCacheOutcome(null);
  }, []);

  const loadSample = useCallback((id: string) => {
    const s = getSample(id);
    if (s) {
      setText(s.text);
      setSampleId(id);
      setResult(null);
      setOutputOverride(null);
      setGovernance(null);
      setCacheOutcome(null);
    }
  }, []);

  /** Record the real response length for the last cache entry (calibration). */
  const recordMeasuredOutput = useCallback((tokens: number) => {
    if (!lastEntryId.current || !(tokens > 0)) return false;
    const ok = getPromptCache().recordMeasuredOutput(lastEntryId.current, tokens);
    if (ok) setCacheTick((c) => c + 1);
    return ok;
  }, []);

  const clearCache = useCallback(() => {
    getPromptCache().clear();
    setCacheOutcome(null);
    setCacheTick((c) => c + 1);
  }, []);

  const cacheStats = useMemo(
    () => getPromptCache().stats(),
    // cacheTick forces refresh after each interaction
    [cacheTick, runId],
  );

  /** true when the user edited the prompt after the last optimize run */
  const stale = result !== null && result.originalText !== text;

  return {
    text, setText,
    modelId, setModelId, model,
    level, setLevel,
    requests, setRequests,
    outputEstimate, outputTokens, outputOverride, setOutputOverride,
    analysis, result, savings, stale, runId,
    sampleId, loadSample,
    optimize, reset,
    governance, cacheOutcome, cacheStats, recordMeasuredOutput, clearCache,
  };
}

export type PromptSlim = ReturnType<typeof usePromptSlim>;
