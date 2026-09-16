interface MetricCardProps {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'mint' | 'amber' | 'violet';
  popKey?: string | number; // change to re-trigger the pop animation
}

const TONES = {
  default: 'text-slate-soft',
  mint: 'text-mint',
  amber: 'text-amber-soft',
  violet: 'text-violet-soft',
} as const;

export function MetricCard({ label, value, sub, tone = 'default', popKey }: MetricCardProps) {
  return (
    <div className="card px-4 py-3.5">
      <div className="text-[11px] uppercase tracking-[0.14em] text-mist">{label}</div>
      <div
        key={popKey}
        className={`animate-pop mt-1 font-mono text-2xl md:text-[28px] font-semibold leading-tight ${TONES[tone]}`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-mist">{sub}</div>}
    </div>
  );
}
