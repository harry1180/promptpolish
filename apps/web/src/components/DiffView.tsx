import { useMemo } from 'react';
import { diffStats, diffWords } from '@promptslim/shared';

interface DiffViewProps {
  original: string;
  optimized: string;
}

export function DiffView({ original, optimized }: DiffViewProps) {
  const parts = useMemo(() => diffWords(original, optimized), [original, optimized]);
  const stats = useMemo(() => diffStats(parts), [parts]);
  return (
    <div className="animate-fade-slide">
      <div className="mb-3 flex flex-wrap gap-4 text-xs text-mist">
        <span><span className="diff-removed">strikethrough</span> = removed ({stats.removedWords} words)</span>
        <span><span className="diff-added">highlight</span> = new/changed ({stats.addedWords} words)</span>
        <span>plain = preserved</span>
      </div>
      <pre className="thin-scroll max-h-[420px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-ink-900/70 p-4 font-mono text-[13px] leading-relaxed">
        {parts.map((p, i) =>
          p.type === 'equal' ? (
            <span key={i}>{p.text}</span>
          ) : (
            <span key={i} className={p.type === 'removed' ? 'diff-removed' : 'diff-added'}>
              {p.text}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}
