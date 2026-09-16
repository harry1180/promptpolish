import { useEffect, useState } from 'react';
import { makeHistoryStore, type HistoryEntry } from '@promptslim/shared';
import type { OptimizationLevel } from '@promptslim/shared-types';
import { getModel } from '@promptslim/model-config';
import { formatNumber, formatPercent } from '@promptslim/pricing-engine';

const store = makeHistoryStore(localStorage);

export function HistoryPanel({
  saveText,
  onSaveTextChange,
}: {
  saveText: boolean;
  onSaveTextChange: (v: boolean) => void;
}) {
  const { entries, clear } = useHistoryLite(saveText);
  if (entries.length === 0) {
    return (
      <section className="card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-mist">History</h2>
        <p className="mt-2 text-sm text-mist">
          No optimizations yet. Results stay in this browser (LocalStorage) — nothing is uploaded.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-soft">
          <input type="checkbox" checked={saveText} onChange={(e) => onSaveTextChange(e.target.checked)} className="accent-[#34f5c5]" />
          Save prompt text in history
          <span className="text-xs text-mist">(default off — counts only are stored)</span>
        </label>
      </section>
    );
  }
  return (
    <section className="card overflow-hidden" aria-label="Optimization history">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-mist">
          History <span className="text-mist/60">· last {entries.length}</span>
        </h2>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-mist">
            <input type="checkbox" checked={saveText} onChange={(e) => onSaveTextChange(e.target.checked)} className="accent-[#34f5c5]" />
            Save prompt text
          </label>
          <button onClick={clear} className="text-xs text-mist underline-offset-2 hover:text-danger hover:underline">
            Clear
          </button>
        </div>
      </div>
      <ul className="max-h-72 divide-y divide-line/60 overflow-y-auto thin-scroll">
        {entries.map((e) => {
          const m = getModel(e.modelId);
          return (
            <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 text-sm">
              <span className="w-28 shrink-0 font-mono text-xs text-mist">{new Date(e.date).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="shrink-0 text-slate-soft">{m ? `${m.provider} ${m.modelName}` : e.modelId}</span>
              <span className="w-24 shrink-0 text-xs capitalize text-mist">{e.level}</span>
              <span className="ml-auto font-mono text-xs text-mist">
                {formatNumber(e.originalTokens)} → {formatNumber(e.optimizedTokens)}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-mint">{formatPercent(e.reductionPercent)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Internal lightweight variant: history is shared through localStorage so the
 * panel re-reads on mount/save toggling without prop drilling the last result. */
function useHistoryLite(saveText: boolean) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  useEffect(() => {
    const sync = () => setEntries(store.load());
    sync();
    window.addEventListener('promptslim:history', sync);
    return () => window.removeEventListener('promptslim:history', sync);
  }, [saveText]);
  const clear = () => {
    store.clear();
    setEntries([]);
  };
  return { entries: entries as Array<HistoryEntry & { modelId: string }>, clear };
}

export function makeEntry(
  opts: {
    modelId: string;
    level: OptimizationLevel;
    originalTokens: number;
    optimizedTokens: number;
    reductionPercent: number;
    originalText: string;
    optimizedText: string;
  },
): HistoryEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    date: new Date().toISOString(),
    modelId: opts.modelId,
    level: opts.level,
    originalTokens: opts.originalTokens,
    optimizedTokens: opts.optimizedTokens,
    reductionPercent: opts.reductionPercent,
    originalText: opts.originalText,
    optimizedText: opts.optimizedText,
  };
}

export function pushHistory(entry: HistoryEntry, saveText: boolean): void {
  const record: HistoryEntry = saveText
    ? entry
    : { ...entry, originalText: undefined, optimizedText: undefined };
  store.save([record, ...store.load()].slice(0, 50));
  window.dispatchEvent(new Event('promptslim:history'));
}
