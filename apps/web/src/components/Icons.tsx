/** Tiny inline icon set (no icon library). 24px grid, stroke-based. */

interface IconProps {
  className?: string;
}

const base = (className?: string) => ({
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className,
  'aria-hidden': true,
});

export const IconLightning = ({ className }: IconProps) => (
  <svg {...base(className)}><path d="M13 2 3 14h8l-1 8 11-13h-8l1-7z" /></svg>
);
export const IconShield = ({ className }: IconProps) => (
  <svg {...base(className)}><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z" /></svg>
);
export const IconCopy = ({ className }: IconProps) => (
  <svg {...base(className)}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
);
export const IconDownload = ({ className }: IconProps) => (
  <svg {...base(className)}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></svg>
);
export const IconReset = ({ className }: IconProps) => (
  <svg {...base(className)}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
);
export const IconDiff = ({ className }: IconProps) => (
  <svg {...base(className)}><path d="M12 3v18" /><path d="M4 8h4M4 16h4M16 12h4" /></svg>
);
export const IconCheck = ({ className }: IconProps) => (
  <svg {...base(className)}><path d="m4 12 5 5L20 6" /></svg>
);
export const IconWarn = ({ className }: IconProps) => (
  <svg {...base(className)}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></svg>
);
export const IconChip = ({ className }: IconProps) => (
  <svg {...base(className)}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></svg>
);
export const IconScale = ({ className }: IconProps) => (
  <svg {...base(className)}><path d="M12 3v18M8 21h8" /><path d="m5 7 14-2" /><path d="M5 7 2 14a3 3 0 0 0 6 0L5 7zM19 5l-3 7a3 3 0 0 0 6 0l-3-7z" /></svg>
);
/** PromptPolice mark: badge/shield with a five-point star. */
export const IconBadge = ({ className }: IconProps) => (
  <svg {...base(className)}>
    <path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z" />
    <path d="m12 8.2 1.15 2.33 2.57.37-1.86 1.81.44 2.56L12 14.05l-2.3 1.22.44-2.56-1.86-1.81 2.57-.37L12 8.2z" />
  </svg>
);
