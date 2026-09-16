import { useState } from 'react';
import type { TokenCount } from '@promptslim/shared-types';
import { IconCheck, IconCopy } from './Icons';

interface PromptPaneProps {
  title: string;
  value: string;
  tokens: TokenCount | null;
  placeholder?: string;
  editable: boolean;
  onChange?: (v: string) => void;
  tone: 'original' | 'optimized';
  footer?: React.ReactNode;
  emptyHint?: string;
}

export function PromptPane({
  title,
  value,
  tokens,
  placeholder,
  editable,
  onChange,
  tone,
  footer,
  emptyHint,
}: PromptPaneProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className={`card flex min-w-0 flex-1 flex-col overflow-hidden ${tone === 'optimized' ? 'border-mint/25' : ''}`}>
      <div
        className={`flex items-center justify-between gap-2 border-b border-line px-4 py-2.5 ${
          tone === 'optimized' ? 'bg-mint/[0.04]' : 'bg-ink-900/60'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${tone === 'optimized' ? 'bg-mint' : 'bg-violet-soft'}`}
            aria-hidden
          />
          <h3 className={`text-sm font-semibold ${tone === 'optimized' ? 'text-mint' : 'text-slate-soft'}`}>
            {title}
          </h3>
        </div>
        <div className="flex items-center gap-2 text-xs text-mist whitespace-nowrap">
          {tokens && (
            <span className="font-mono" title={`Token engine: ${tokens.engine}`}>
              {tokens.tokens.toLocaleString()} tok · {tokens.method}
            </span>
          )}
          {!editable && value && (
            <button
              onClick={copy}
              className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-slate-soft transition-colors hover:border-mint/40 hover:text-mint"
              aria-label="Copy optimized prompt"
            >
              {copied ? <IconCheck className="text-mint" /> : <IconCopy />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
      </div>
      <div className="relative flex-1">
        {editable ? (
          <textarea
            value={value}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={placeholder ?? ''}
            spellCheck={false}
            aria-label={title}
            className="thin-scroll absolute inset-0 h-full w-full resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed text-slate-soft placeholder:text-mist/50"
          />
        ) : (
          <div className="thin-scroll absolute inset-0 overflow-y-auto p-4" role="textbox" aria-readonly="true" aria-label={title}>
            {value ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-slate-soft">
                {value}
              </pre>
            ) : (
              <div className="flex h-full min-h-[220px] items-center justify-center px-6 text-center text-sm text-mist/70">
                {emptyHint ?? 'Your optimized prompt will appear here.'}
              </div>
            )}
          </div>
        )}
      </div>
      {footer && <div className="border-t border-line px-4 py-2 text-xs text-mist">{footer}</div>}
    </div>
  );
}
