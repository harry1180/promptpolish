import { useMemo } from 'react';
import { detectSensitive, redactSensitive } from '@promptslim/privacy-detector';
import { IconShield } from './Icons';

interface SensitiveBannerProps {
  text: string;
  dismissed: boolean;
  onDismiss: () => void;
  onRedact: (redacted: string) => void;
}

export function SensitiveBanner({ text, dismissed, onDismiss, onRedact }: SensitiveBannerProps) {
  const hits = useMemo(() => (dismissed || !text ? [] : detectSensitive(text)), [text, dismissed]);
  if (hits.length === 0) return null;
  return (
    <div
      role="alert"
      className="animate-fade-slide card flex flex-wrap items-center gap-x-4 gap-y-2 border-amber-soft/40 bg-amber-soft/[0.06] px-4 py-3"
    >
      <div className="flex items-center gap-2 text-amber-soft">
        <IconShield />
        <span className="text-sm font-semibold">Potential sensitive information detected</span>
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        {hits.map((h) => (
          <span key={h.label} className="rounded-full border border-amber-soft/30 px-2 py-0.5 text-amber-soft/90" title={h.samples.join(', ')}>
            {h.label} × {h.count}
          </span>
        ))}
      </div>
      <div className="ml-auto flex gap-2">
        <button
          onClick={() => onRedact(redactSensitive(text))}
          className="rounded-md border border-amber-soft/40 bg-amber-soft/10 px-3 py-1.5 text-xs font-medium text-amber-soft transition-colors hover:bg-amber-soft/20"
        >
          Redact before optimizing
        </button>
        <button
          onClick={onDismiss}
          className="rounded-md border border-line px-3 py-1.5 text-xs text-mist transition-colors hover:text-slate-soft"
        >
          Continue anyway
        </button>
      </div>
      <p className="w-full text-[11px] text-mist/80">
        Detection runs 100% locally — nothing is sent anywhere. Redaction replaces values with [REDACTED:category] markers.
      </p>
    </div>
  );
}
