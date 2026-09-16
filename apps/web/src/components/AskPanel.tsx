import { useRef, useState } from 'react';
import { getModel } from '@promptslim/model-config';
import { formatUSD } from '@promptslim/pricing-engine';
import { api } from '../api/account';
import type { ChatResponse } from '@promptslim/shared-types';
import { ChatModelSelect } from './ChatModelSelect';
import { KeysPanel } from './KeysPanel';

/**
 * Governed Ask: a real LLM conversation, executed by the org server.
 * The text that gets sent is what the optimizer pane holds — governance
 * screens it server-side first (PII / injection → fail-closed refusal),
 * then AUTO or the user's chosen model answers, and the call lands in the
 * dashboard with exact provider token counts and real spend.
 */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  meta?: ChatResponse['meta'];
}

export function AskPanel({
  promptText,
  originalTokens,
  wasOptimized,
  onRunOptimize,
}: {
  promptText: string;
  originalTokens: number | null;
  wasOptimized: boolean;
  onRunOptimize: () => void;
}) {
  const [modelId, setModelId] = useState<string>('auto');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [followUp, setFollowUp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLOListElement>(null);

  const canSend = !busy && (turns.length === 0 ? promptText.trim().length > 0 : followUp.trim().length > 0);

  async function send(text: string) {
    setBusy(true);
    setError('');
    const nextTurns: Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(nextTurns);
    const r = await api.chat({
      messages: nextTurns.map((t) => ({ role: t.role, content: t.content })),
      modelId,
      originalTokens: turns.length === 0 ? (originalTokens ?? undefined) : undefined,
      sentWasOptimized: turns.length === 0 ? wasOptimized : undefined,
    });
    setBusy(false);
    if (r.ok && r.data) {
      setTurns([...nextTurns, { role: 'assistant', content: r.data.text, meta: r.data.meta }]);
      queueScroll();
    } else {
      setError(r.errors.join(' · ') || 'the model call failed');
      setTurns(turns); // roll back the optimistic user turn on refusal
    }
  }

  function queueScroll() {
    requestAnimationFrame(() => {
      // jsdom lacks Element.scrollTo; guard so the rAF callback never throws
      listRef.current?.scrollTo?.({ top: listRef.current.scrollHeight, behavior: 'smooth' });
    });
  }

  const firstSend = () => void send(promptText.trim());
  const followUpSend = () => {
    const t = followUp.trim();
    if (!t) return;
    setFollowUp('');
    void send(t);
  };

  return (
    <section className="card p-4 md:p-5" id="ask" aria-label="Ask the LLM">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.12em] text-mist">
          Ask the LLM — governed
        </h2>
        <span className="rounded-full border border-mint/30 bg-mint/[0.06] px-2 py-0.5 text-[10px] font-medium text-mint">
          governance-screened · your keys · every call metered
        </span>
        <div className="ml-auto">
          <ChatModelSelect value={modelId} onChange={setModelId} />
        </div>
      </div>

      <KeysPanel />

      {turns.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-line px-4 py-6 text-center">
          <p className="text-sm text-mist">
            {promptText.trim()
              ? <>Sends the prompt currently in the <span className="text-slate-soft">Optimized</span> pane{wasOptimized ? ' (optimized ✓)' : ' (raw — not optimized yet)'} through the governance gate, then to {modelId === 'auto' ? 'the AUTO-routed model' : `your chosen model (${getModel(modelId)?.modelName ?? modelId})`}.</>
              : 'Paste a prompt above (or load an example), then ask the model here.'}
          </p>
          {!wasOptimized && promptText.trim() && (
            <button
              onClick={onRunOptimize}
              className="mt-3 rounded-lg border border-mint/40 px-3 py-1.5 text-xs font-semibold text-mint transition-colors hover:bg-mint/10"
            >
              Optimize first (recommended — cheaper answer)
            </button>
          )}
          <div className="mt-4">
            <button
              onClick={firstSend}
              disabled={!canSend}
              className="rounded-xl bg-mint px-5 py-2.5 text-sm font-semibold text-ink-950 shadow-lg shadow-mint/20 transition-transform hover:scale-[1.02] disabled:opacity-40 disabled:hover:scale-100"
            >
              {busy ? 'Asking…' : 'Send to the model'}
            </button>
          </div>
        </div>
      ) : (
        <ol ref={listRef} className="thin-scroll mt-3 max-h-96 space-y-3 overflow-y-auto pr-1" aria-label="Conversation">
          {turns.map((t, i) => (
            <li key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                t.role === 'user' ? 'bg-mint/15 text-slate-soft ring-1 ring-mint/25' : 'bg-ink-700/70 text-slate-soft ring-1 ring-line'
              }`}>
                <span className="whitespace-pre-wrap break-words">{t.content}</span>
                {t.meta && <MetaLine meta={t.meta} />}
              </div>
            </li>
          ))}
          {busy && <li className="text-xs text-mist">model is thinking…</li>}
        </ol>
      )}

      {error && (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
          {error}
        </div>
      )}

      {turns.length > 0 && (
        <div className="mt-3 flex gap-2">
          <input
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canSend) followUpSend(); }}
            aria-label="Follow-up message"
            placeholder="Ask a follow-up…"
            className="card min-w-0 flex-1 bg-ink-800 px-3 py-2 text-sm text-slate-soft outline-none focus:border-mint/50"
            disabled={busy}
          />
          <button
            onClick={followUpSend}
            disabled={!canSend}
            className="rounded-lg bg-mint px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-mint-dim disabled:opacity-40"
          >
            Send
          </button>
          <button
            onClick={() => { setTurns([]); setError(''); }}
            className="card rounded-lg px-3 py-2 text-xs text-mist hover:text-slate-soft"
          >
            New chat
          </button>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-mist">
        Governance: queries labeled <span className="text-danger">block</span> or{' '}
        <span className="text-amber-soft">redact-required</span> (PII, injection attempts) are refused
        by the server before anything is sent to a provider — refusal costs nothing and is audited.
        Governed input is <span className="text-slate-soft">English-only</span>: non-English text
        (any script) is refused too, because translated instructions bypass the English guardrail
        rules — the classic translation-jailbreak class. Every accepted call is recorded with its
        exact provider usage and your account&apos;s tags, so it shows up in the executive dashboard
        rollups.
      </p>
    </section>
  );
}

function MetaLine({ meta }: { meta: ChatResponse['meta'] }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line/70 pt-2 font-mono text-[10px] text-mist">
      <span className="text-violet-soft">{meta.provider} {meta.modelName}{meta.routed ? ' · AUTO' : ''}</span>
      <span title="Exact token counts reported by the provider">
        in {meta.inputTokens.toLocaleString()} · out {meta.outputTokens.toLocaleString()} tok
      </span>
      <span className="text-slate-soft">cost {formatUSD(meta.costUsd)}</span>
      {meta.savingsUsd !== null && meta.savingsUsd > 0 && (
        <span className="text-mint">saved {formatUSD(meta.savingsUsd)} via optimization</span>
      )}
      {meta.governance === 'review' ? (
        <span className="rounded bg-amber-soft/15 px-1.5 py-0.5 text-amber-soft" title="Regulated-intent query — answered with review caveat">
          governed: review
        </span>
      ) : (
        <span className="rounded bg-mint/10 px-1.5 py-0.5 text-mint">governed: allow</span>
      )}
      {meta.routeReason && <span className="basis-full text-[9px] italic">{meta.routeReason}</span>}
    </div>
  );
}
