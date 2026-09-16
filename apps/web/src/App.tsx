import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { SAMPLE_PROMPTS } from '@promptslim/optimizer';
import { catalog } from '@promptslim/model-config';
import { usePromptSlim, type PromptSlim } from './hooks/usePromptSlim';
import { useAccount, type AccountState } from './hooks/useAccount';
import { api } from './api/account';
import { ModelSelector } from './components/ModelSelector';
import { LevelSelector } from './components/LevelSelector';
import { PromptPane } from './components/PromptPane';
import { MetricsRow, CostComparison } from './components/CostPanels';
import { GovernanceBanner } from './components/GovernanceBanner';
import { CachePanel } from './components/CachePanel';
import { ChangesPanel } from './components/ChangesPanel';
import { StructureCard, QualityCard } from './components/InsightCards';
import { ExportMenu } from './components/ExportMenu';
import { SensitiveBanner } from './components/SensitiveBanner';
import { HistoryPanel, makeEntry, pushHistory } from './components/HistoryPanel';
import { AuthPanel } from './components/AuthPanel';
import { AskPanel } from './components/AskPanel';
import { DashboardPanel } from './components/DashboardPanel';
import { IconBadge, IconLightning, IconShield } from './components/Icons';

const DiffView = lazy(() =>
  import('./components/DiffView').then((m) => ({ default: m.DiffView })),
);
const ModelComparison = lazy(() =>
  import('./components/ModelComparison').then((m) => ({ default: m.ModelComparison })),
);

export default function App() {
  const slim = usePromptSlim();
  const account = useAccount();
  const [saveText, setSaveText] = useState(false);

  // Report each optimization run to the org server (metrics + tag snapshot
  // only — never prompt text). Silent when signed out or server is down.
  const lastReportedRun = useRef(0);
  useEffect(() => {
    if (!account.account || slim.runId === 0 || !slim.result || lastReportedRun.current === slim.runId) return;
    lastReportedRun.current = slim.runId;
    void api.recordEvent({
      modelId: slim.result.modelId,
      level: slim.result.level,
      originalTokens: slim.result.originalTokens.tokens,
      optimizedTokens: slim.result.optimizedTokens.tokens,
      fromCache: slim.result.fromCache,
    });
  }, [account.account, slim.runId, slim.result]);

  return (
    <div className="min-h-screen bg-hero">
      <Header account={account} />
      <main className="mx-auto max-w-6xl px-4 pb-20 md:px-8">
        <Hero />
        {account.account ? (
          <DashboardPanel accountTags={account.account.tags} />
        ) : (
          <AccountGate account={account} />
        )}
        <OptimizerSection slim={slim} saveText={saveText} onSaveText={setSaveText} />
        {account.account && (
          <div className="mb-14">
            <AskPanel
              promptText={slim.result && !slim.stale ? slim.result.optimizedText : slim.text}
              originalTokens={slim.result?.originalTokens.tokens ?? null}
              wasOptimized={slim.result !== null && !slim.stale && slim.result.optimizedTokens.tokens < slim.result.originalTokens.tokens}
              onRunOptimize={slim.optimize}
            />
          </div>
        )}
        <Suspense
          fallback={
            <div className="card flex h-40 items-center justify-center text-sm text-mist">
              Loading model comparison…
            </div>
          }
        >
          <ModelComparison
            inputTokens={slim.result?.optimizedTokens.tokens ?? slim.analysis?.tokens.tokens ?? null}
            outputTokens={slim.outputTokens}
            outputIsProjected={slim.outputOverride === null}
            selectedModelId={slim.modelId}
          />
        </Suspense>
        <HowItWorks />
        <Privacy />
        <Extension />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}

/* ---------------- header ---------------- */

function Header({ account }: { account: AccountState & { authTick: number } }) {
  const { account: me, checking } = account;
  return (
    <header className="sticky top-0 z-30 border-b border-line/60 bg-ink-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 md:px-8">
        <a href="#top" className="flex items-center gap-2.5" aria-label="PromptPolice home">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-mint/10 text-mint ring-1 ring-mint/30">
            <IconBadge />
          </span>
          <span className="text-lg font-semibold tracking-tight text-white">
            Prompt<span className="text-mint">Police</span>
          </span>
        </a>
        <span className="hidden text-xs text-mist md:inline">LLM prompt cost optimizer</span>
        <nav className="ml-auto flex items-center gap-5 text-sm text-mist">
          <a href="#optimizer" className="transition-colors hover:text-slate-soft">Optimizer</a>
          {me && <a href="#ask" className="transition-colors hover:text-slate-soft">Ask</a>}
          {me && <a href="#dashboard" className="transition-colors hover:text-slate-soft">Dashboard</a>}
          <a href="#models" className="transition-colors hover:text-slate-soft">Models</a>
          <a href="#privacy" className="transition-colors hover:text-slate-soft">Privacy</a>
          {checking ? (
            <span className="h-8 w-24 animate-pulse rounded-lg bg-ink-700" aria-label="Checking session" />
          ) : me ? (
            <div className="flex items-center gap-3">
              <span className="hidden max-w-[180px] truncate text-xs text-slate-soft sm:inline" title={me.email}>
                {me.name || me.email}
              </span>
              <button
                onClick={() => void account.logout()}
                className="card rounded-lg px-3.5 py-1.5 text-sm font-medium text-mist transition-colors hover:border-danger/50 hover:text-danger"
              >
                Sign out
              </button>
            </div>
          ) : (
            <a
              href="#account"
              className="rounded-lg bg-mint px-3.5 py-1.5 font-semibold text-ink-950 transition-colors hover:bg-mint-dim"
            >
              Sign up
            </a>
          )}
        </nav>
      </div>
    </header>
  );
}

/* ---------------- account gate (signup/login + why) ---------------- */

function AccountGate({ account }: { account: AccountState }) {
  return (
    <section className="mb-12 grid items-start gap-4 md:grid-cols-2" aria-label="Organization account">
      <div className="pt-2">
        <h2 className="text-2xl font-bold tracking-tight text-white">
          One org number, not fifty spreadsheets.
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-mist">
          Create a work account and tag it with your organization metadata —{' '}
          <span className="font-mono text-violet-soft">cost_center</span>,{' '}
          <span className="font-mono text-violet-soft">team</span>,{' '}
          <span className="font-mono text-violet-soft">environment</span>, anything. Every prompt
          you optimize is stamped with those tags, so the executive dashboard rolls up token and
          dollar savings across <em>every</em> user who shares a tag value — pick{' '}
          <span className="font-mono text-mint">cost_center = 10</span> and see all five of its
          users together.
        </p>
        <ul className="mt-4 space-y-2 text-sm text-slate-soft">
          <li className="flex gap-2"><IconLightning /> <span>Metrics only — prompt text never leaves your browser or your account’s history setting.</span></li>
          <li className="flex gap-2"><IconShield /> <span>Costs computed from the same audited price table the optimizer uses.</span></li>
        </ul>
      </div>
      <AuthPanel account={account} />
    </section>
  );
}

/* ---------------- hero ---------------- */

function Hero() {
  return (
    <section id="top" className="pt-14 pb-10 text-center md:pt-20">
      <p className="mx-auto mb-4 w-fit rounded-full border border-mint/30 bg-mint/[0.06] px-3 py-1 text-xs font-medium text-mint">
        Optimizer runs entirely in your browser · optional account for the org dashboard
      </p>
      <h1 className="mx-auto max-w-3xl text-4xl font-bold leading-tight tracking-tight text-white md:text-[52px] md:leading-[1.08]">
        Cut LLM prompt costs without changing what your prompt does.
      </h1>
      <p className="mx-auto mt-4 max-w-xl text-lg text-mist">
        Measure. Optimize. Compare. Save.
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-3">
        <a
          href="#optimizer"
          className="rounded-xl bg-mint px-6 py-3 text-base font-semibold text-ink-950 shadow-lg shadow-mint/20 transition-transform hover:bg-mint-dim hover:scale-[1.02]"
        >
          Optimize a Prompt
        </a>
        <a
          href="#models"
          className="card rounded-xl px-6 py-3 text-base font-medium text-slate-soft transition-colors hover:border-ink-600"
        >
          Compare Models
        </a>
      </div>
    </section>
  );
}

/* ---------------- optimizer ---------------- */

function OptimizerSection({
  slim,
  saveText,
  onSaveText,
}: {
  slim: PromptSlim;
  saveText: boolean;
  onSaveText: (v: boolean) => void;
}) {
  const { result } = slim;
  const [diff, setDiff] = useState(false);
  const [sensitiveDismissed, setSensitiveDismissed] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);

  // push to history when a new optimization run completes (runId changes);
  // ref-guard keeps React StrictMode's double-invocation from double-recording.
  const lastRun = useRef(0);
  useEffect(() => {
    if (slim.runId > 0 && slim.result && slim.runId !== lastRun.current) {
      lastRun.current = slim.runId;
      pushHistory(
        makeEntry({
          modelId: slim.modelId,
          level: slim.result.level,
          originalTokens: slim.result.originalTokens.tokens,
          optimizedTokens: slim.result.optimizedTokens.tokens,
          reductionPercent: slim.result.reductionPercent,
          originalText: slim.result.originalText,
          optimizedText: slim.result.optimizedText,
        }),
        saveText,
      );
      setHistoryTick((c) => c + 1);
    }
  }, [slim.runId, slim.result, slim.modelId, saveText]);

  return (
    <section id="optimizer" className="mb-14 scroll-mt-20">
      <div className="card space-y-4 p-4 md:p-5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <ModelSelector value={slim.modelId} onChange={slim.setModelId} />
          <div className="flex-1" />
          <label className="flex items-center gap-2 text-xs text-mist">
            Load example
            <select
              value={slim.sampleId}
              onChange={(e) => slim.loadSample(e.target.value)}
              className="card cursor-pointer bg-ink-800 px-2.5 py-1.5 text-sm text-slate-soft"
              aria-label="Load example prompt"
            >
              <option value="">Choose a sample…</option>
              {SAMPLE_PROMPTS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
        </div>

        <LevelSelector value={slim.level} onChange={slim.setLevel} />

        <GovernanceBanner report={slim.governance} />

        <SensitiveBanner
          text={slim.text}
          dismissed={sensitiveDismissed}
          onDismiss={() => setSensitiveDismissed(true)}
          onRedact={(redacted) => {
            slim.setText(redacted);
            setSensitiveDismissed(true);
          }}
        />

        <div className="flex min-h-[320px] flex-col gap-3 lg:h-[420px] lg:flex-row">
          <PromptPane
            title="Original Prompt"
            tone="original"
            value={slim.text}
            tokens={slim.analysis?.tokens ?? null}
            editable
            onChange={(v) => {
              slim.setText(v);
              setSensitiveDismissed(false);
            }}
            placeholder={'Paste your LLM prompt here…\n\nExample: "You are an expert financial analyst. I would like you to carefully analyze…"' }
            footer={
              slim.analysis ? (
                <span className="flex flex-wrap gap-x-3">
                  <span>{slim.analysis.words.toLocaleString()} words</span>
                  <span>{slim.analysis.characters.toLocaleString()} chars</span>
                  <span>{slim.analysis.sentences} sentences</span>
                  <span title={slim.analysis.tokens.engine} className="text-violet-soft">
                    ~{slim.analysis.tokens.tokens.toLocaleString()} tokens ({slim.analysis.tokens.method})
                  </span>
                </span>
              ) : (
                <span>Live token & cost estimates update as you type — all computation is local.</span>
              )
            }
          />
          <PromptPane
            title="Optimized Prompt"
            tone="optimized"
            value={result?.optimizedText ?? ''}
            tokens={result?.optimizedTokens ?? null}
            editable={false}
            emptyHint="Click “Optimize Prompt”. The shorter version — with variables, JSON schemas, XML tags and constraints preserved — appears here."
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            onClick={slim.optimize}
            disabled={!slim.text.trim()}
            className="flex items-center gap-2 rounded-xl bg-mint px-5 py-2.5 text-base font-semibold text-ink-950 shadow-lg shadow-mint/20 transition-all hover:bg-mint-dim disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconLightning />
            Optimize Prompt
          </button>
          {result && (
            <>
              <button
                onClick={() => setDiff((d) => !d)}
                className={`card px-4 py-2.5 text-sm ${diff ? 'border-violet-soft/50 text-violet-soft' : 'text-slate-soft'} transition-colors`}
              >
                {diff ? 'Hide diff' : 'Show diff'}
              </button>
              {slim.stale && (
                <span className="text-xs text-amber-soft">prompt changed — click Optimize again</span>
              )}
              <div className="flex-1" />
              <ExportMenu slim={slim} />
              <button
                onClick={() => {
                  slim.reset();
                  setDiff(false);
                }}
                className="card px-4 py-2.5 text-sm text-mist transition-colors hover:text-slate-soft"
              >
                Reset
              </button>
            </>
          )}
          <span className="flex items-center gap-1.5 rounded-full border border-mint/40 bg-mint/[0.07] px-3 py-1.5 text-xs font-semibold tracking-wider text-mint" title="All analysis and optimization runs locally in your browser.">
            <IconShield /> LOCAL
          </span>
        </div>

        {result && diff && (
          <Suspense
            fallback={<div className="h-40 animate-pulse rounded-lg border border-line bg-ink-900/50" />}
          >
            <DiffView original={result.originalText} optimized={result.optimizedText} />
          </Suspense>
        )}
      </div>

      <div className="mt-5 space-y-5">
        <MetricsRow slim={slim} />
        <CachePanel slim={slim} />
        {result && slim.analysis && (
          <div className="grid gap-5 lg:grid-cols-2">
            <StructureCard structure={slim.analysis.structure} />
            <QualityCard quality={slim.analysis.quality} />
          </div>
        )}
        <CostComparison slim={slim} />
        {result && <ChangesPanel changes={result.changeLog} preservation={result.preservation} />}
        <HistoryPanel key={historyTick} saveText={saveText} onSaveTextChange={onSaveText} />
      </div>
    </section>
  );
}

/* ---------------- static marketing sections ---------------- */

function HowItWorks() {
  const steps = [
    ['Measure', 'Paste any prompt. PromptPolice counts characters, words and tokens instantly and prices the input against your selected model — no account, no upload.'],
    ['Optimize', 'A deterministic two-stage engine removes politeness, duplicated instructions, restated constraints and filler — while placeholders, JSON schemas, XML tags and safety rules are protected verbatim.'],
    ['Verify', 'A preservation score and a calm diff show exactly what changed and confirm what was kept, so "shorter" never means "different job".'],
    ['Bank the savings', 'Scale the per-request dollar figure to 1K, 10K, 100K or 1M requests/month — and export the report as TXT, Markdown or JSON for your team.'],
  ];
  return (
    <section className="my-16">
      <h2 className="text-center text-2xl font-bold text-white md:text-3xl">How PromptPolice works</h2>
      <div className="mt-8 grid gap-4 md:grid-cols-4">
        {steps.map(([t, d], i) => (
          <div key={t} className="card p-5">
            <div className="font-mono text-xs text-mint">0{i + 1}</div>
            <div className="mt-1.5 font-semibold text-white">{t}</div>
            <p className="mt-2 text-sm leading-relaxed text-mist">{d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Privacy() {
  return (
    <section id="privacy" className="my-16 grid items-center gap-8 md:grid-cols-2">
      <div>
        <h2 className="text-2xl font-bold text-white md:text-3xl">Your prompts never leave your browser.</h2>
        <ul className="mt-5 space-y-3 text-sm text-mist">
          {[
            ['100% local analysis & optimization', 'Token counting, pricing math, the deterministic optimizer and sensitive-data detection all run in your tab. No server round-trip exists to intercept.'],
            ['No account required', 'Nothing to sign up for, nothing to leak, no prompt corpus collected for someone else\u2019s model training.'],
            ['History stays on-device', 'Recent optimizations live in LocalStorage — counts only unless you explicitly opt in to storing prompt text.'],
            ['AI mode is honest', 'The optional Stage-2 semantic optimizer (later phase) will always show a visible "AI OPTIMIZATION" badge and warn you before any prompt leaves the browser.'],
          ].map(([t, d]) => (
            <li key={t} className="flex gap-3">
              <span className="mt-0.5 h-fit rounded-md bg-mint/10 p-1.5 text-mint ring-1 ring-mint/30"><IconShield /></span>
              <div>
                <div className="font-medium text-slate-soft">{t}</div>
                <div className="mt-0.5 leading-relaxed">{d}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="card p-6 text-center">
        <div className="text-xs uppercase tracking-[0.2em] text-mist">local analysis stays in your browser</div>
        <div className="mt-4 font-mono text-sm leading-loose text-slate-soft/90">
          <span className="text-mist">// network requests during optimization:</span>
          <br />
          <span className="text-mint">none</span>
          <br />
          <br />
          <span className="text-mist">// prompt content sent to server:</span>
          <br />
          <span className="text-mint">none</span>
          <br />
          <br />
          <span className="text-mist">// account / tracking / analytics:</span>
          <br />
          <span className="text-mint">none</span>
        </div>
        <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-mint/40 bg-mint/[0.08] px-4 py-1.5 text-sm font-semibold text-mint">
          <IconShield /> LOCAL MODE
        </div>
      </div>
    </section>
  );
}

function Extension() {
  return (
    <section className="my-16 card p-6 md:p-10">
      <div className="grid items-center gap-8 md:grid-cols-2">
        <div>
          <div className="mb-2 inline-block rounded-full border border-violet-soft/40 bg-violet-soft/10 px-3 py-1 text-xs font-medium text-violet-soft">
            Coming in Phase 2 · Chrome Extension (Manifest V3)
          </div>
          <h2 className="text-2xl font-bold text-white">PromptPolice beside every chat window.</h2>
          <p className="mt-3 text-sm leading-relaxed text-mist">
            Highlight a prompt in ChatGPT, Claude or Gemini, right-click “Optimize with PromptPolice”, and the
            side panel — powered by the exact same optimization engine as this web app — shows the token
            reduction and dollar savings before you press send.
          </p>
          <ul className="mt-4 space-y-2 text-sm text-mist">
            <li>• Popup + persistent Chrome Side Panel mode</li>
            <li>• Context menu: “Optimize with PromptPolice” on selected text</li>
            <li>• Same cost math, same preservation score, still fully local</li>
          </ul>
        </div>
        <div className="rounded-xl border border-line bg-ink-900 p-4 shadow-2xl shadow-black/40">
          <div className="flex items-center gap-2 border-b border-line pb-3">
            <span className="h-2.5 w-2.5 rounded-full bg-danger/70" /><span className="h-2.5 w-2.5 rounded-full bg-amber-soft/70" /><span className="h-2.5 w-2.5 rounded-full bg-mint/70" />
            <span className="ml-2 rounded bg-ink-700 px-2 py-0.5 font-mono text-[11px] text-mist">chatgpt.com + PromptPolice side panel</span>
          </div>
          <div className="grid grid-cols-2 gap-3 pt-4">
            <div className="rounded-lg border border-line p-3">
              <div className="text-[10px] uppercase text-mist">Selected prompt</div>
              <div className="mt-2 space-y-1">
                {[70, 90, 55, 80, 65, 85, 40].map((w, i) => (
                  <div key={i} className="h-1.5 rounded bg-ink-600" style={{ width: `${w}%` }} />
                ))}
              </div>
              <div className="mt-3 font-mono text-xs text-violet-soft">2,843 tokens · ~$0.042</div>
            </div>
            <div className="rounded-lg border border-mint/30 bg-mint/[0.05] p-3">
              <div className="text-[10px] uppercase text-mint">Optimized</div>
              <div className="mt-2 space-y-1">
                {[60, 75, 50].map((w, i) => (
                  <div key={i} className="h-1.5 rounded bg-mint/30" style={{ width: `${w}%` }} />
                ))}
              </div>
              <div className="mt-3 font-mono text-xs text-mint">1,126 tokens · ~$0.017</div>
              <div className="mt-1 rounded bg-mint px-2 py-1 text-center font-mono text-[11px] font-bold text-ink-950">-60.4%</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  const qs: Array<[string, string]> = [
    ['Does shortening my prompt change what the model does?', 'That is the whole engineering problem, and PromptPolice treats protected content (placeholders like {{customer_name}}, JSON schemas, XML tags, output-format and safety instructions) as immutable. The preservation score tells you what it is confident about, and warnings flag anything a reviewer should check.'],
    ['How accurate are the token counts?', 'Counts are labeled “estimated” vs “exact”. The browser engine uses a tokenizer-shaped heuristic (~4 chars/token with structural awareness). An exact-tokenizer seam is built in for later drops of a real tokenizer.'],
    ['Where do the prices come from?', 'All pricing lives in one config file (models.json), with a “pricing last updated” stamp on every screen. Adding a model means adding one JSON entry — no code changes.'],
    ['Do you store or see my prompts?', 'No. Phase 1 has no backend at all — analysis and optimization happen in your browser tab. History is LocalStorage-only, counts-only by default.'],
    ['Why do savings differ between models?', 'Because a saved token costs different money per provider. The comparison table shows the same prompt priced across OpenAI, Anthropic, Google, DeepSeek, Qwen, Meta and Mistral.'],
  ];
  return (
    <section className="my-16 max-w-3xl mx-auto">
      <h2 className="text-center text-2xl font-bold text-white md:text-3xl">FAQ</h2>
      <div className="mt-6 space-y-2.5">
        {qs.map(([q, a]) => (
          <details key={q} className="card group px-5 py-4">
            <summary className="cursor-pointer list-none text-sm font-semibold text-slate-soft marker:hidden">
              {q}
            </summary>
            <p className="mt-2.5 text-sm leading-relaxed text-mist">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="my-16 rounded-2xl border border-mint/25 bg-mint/[0.06] p-10 text-center">
      <h2 className="text-2xl font-bold text-white md:text-3xl">Every prompt is a line item.</h2>
      <p className="mx-auto mt-3 max-w-md text-sm text-mist">
        {catalog.models.length} configured models. One paste. Your monthly spend will never look the same.
      </p>
      <a
        href="#optimizer"
        className="mt-6 inline-block rounded-xl bg-mint px-8 py-3.5 text-base font-semibold text-ink-950 transition-transform hover:scale-[1.02]"
      >
        Optimize a Prompt — free, local, no signup
      </a>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line/60 py-8 text-center text-xs text-mist">
      <div className="font-mono">PromptPolice v0.1.0 · Phase 1 (local optimizer)</div>
      <div className="mt-1.5">
        Pricing last updated {catalog.pricingLastUpdated} — verify provider pages before relying on figures. MIT-style MVP.
      </div>
    </footer>
  );
}
