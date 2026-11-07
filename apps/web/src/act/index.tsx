/**
 * Agent Control Tower — path-routed shell (no router dependency).
 *
 * Mounted by main.tsx when the pathname starts with /agent-control-tower.
 * Routing is history pushState/popstate only: PRODUCTION_NAV covers the 18
 * production pages, DEMO_NAV the 3 demo pages (when the server says demo is
 * enabled), and presentation mode (Executive Demo) hides the sidebar chrome
 * while keeping the banner and branding.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ActEnvContext,
  BASE_PATH,
  DEMO_BANNER,
  DEMO_NAV,
  PRODUCTION_NAV,
  resolveRoute,
  useActContext,
  useRoute,
} from './data';
import type { ActContextInfo } from './data';
import { Badge, EmptyState, ErrorBoundary, ErrorState, Loading } from './ui';

import { OverviewPage } from './pages/Overview';
import { PassportsPage, PassportDetailPage, RegistryPage } from './pages/Registry';
import { ApprovalsPage, DecisionsPage } from './pages/Decisions';
import { PolicyStudioPage, WhatIfPage } from './pages/Policy';
import { ModalityPage } from './pages/Modality';
import { AppetitePage, UseCasesPage } from './pages/Risk';
import { BlastPage, IncidentsPage, PerformancePage } from './pages/Performance';
import { EvidencePage, ReplayPage } from './pages/Evidence';
import { FrameworksPage } from './pages/Frameworks';
import { AdministrationPage, IntegrationsPage, ReadinessPage } from './pages/Admin';
import { ExecutiveDemoPage } from './demo/ExecutiveDemo';
import { ScenarioLabPage } from './demo/ScenarioLab';
import { DemoResetPage } from './demo/DemoReset';

function renderRoute(key: string, segments: string[]): ReactNode {
  switch (key) {
    case 'overview':
      return <OverviewPage />;
    case 'registry':
      return <RegistryPage />;
    case 'passports':
      return segments[1] ? <PassportDetailPage agentId={segments[1]} /> : <PassportsPage />;
    case 'decisions':
      return <DecisionsPage />;
    case 'approvals':
      return <ApprovalsPage />;
    case 'policies':
      return <PolicyStudioPage />;
    case 'modality':
      return <ModalityPage />;
    case 'appetite':
      return <AppetitePage />;
    case 'use-cases':
      return <UseCasesPage />;
    case 'performance':
      return <PerformancePage />;
    case 'blast-radius':
      return <BlastPage />;
    case 'incidents':
      return <IncidentsPage />;
    case 'evidence':
      return segments[1] ? <ReplayPage decisionId={segments[1]} /> : <EvidencePage />;
    case 'frameworks':
      return <FrameworksPage />;
    case 'whatif':
      return <WhatIfPage />;
    case 'integrations':
      return <IntegrationsPage />;
    case 'readiness':
      return <ReadinessPage />;
    case 'administration':
      return <AdministrationPage />;
    case 'demo-executive':
      return <ExecutiveDemoPage />;
    case 'demo-lab':
      return <ScenarioLabPage />;
    case 'demo-reset':
      return <DemoResetPage />;
    default:
      return (
        <EmptyState title="Page not found">
          <p>
            No control-tower page matches this path. Return to the{' '}
            <a href={BASE_PATH} className="text-mint underline">
              Executive Overview
            </a>
            .
          </p>
        </EmptyState>
      );
  }
}

function Sidebar({
  ctx,
  routeLabel,
  navigate,
}: {
  ctx: ActContextInfo;
  routeLabel: string;
  navigate: (to: string) => void;
}) {
  const demoEnabled = ctx.mode === 'demo' && ctx.demo.enabled;

  const link = (to: string, label: string) => {
    const active = routeLabel === label;
    return (
      <a
        key={to}
        href={to}
        onClick={(e) => {
          e.preventDefault();
          navigate(to);
        }}
        aria-current={active ? 'page' : undefined}
        className={`block rounded-md border-l-2 px-3 py-1.5 text-sm ${
          active
            ? 'border-mint bg-mint/10 text-mint'
            : 'border-transparent text-mist hover:bg-ink-800 hover:text-slate-soft'
        }`}
      >
        {label}
      </a>
    );
  };

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-ink-900 lg:flex">
      <div className="border-b border-line px-4 py-4">
        <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-mint">Control Tower</div>
        <div className="mt-1 text-sm text-slate-soft">Agent governance console</div>
        <div className="mt-1 font-mono text-[11px] text-mist">{ctx.tenant}</div>
      </div>

      <nav aria-label="Control Tower navigation" className="thin-scroll flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
        <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-mist/70">Production</div>
        {PRODUCTION_NAV.map((item) => link(item.to, item.label))}

        {demoEnabled && (
          <>
            <div className="mt-4 px-3 pb-1 text-[10px] uppercase tracking-wider text-mist/70">Demo</div>
            {DEMO_NAV.map((item) => link(item.to, item.label))}
          </>
        )}
      </nav>

      <div className="border-t border-line px-4 py-3 text-[11px] text-mist">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
          className="text-mist hover:text-mint"
        >
          ← PromptPolice
        </a>
        <p className="mt-2 leading-4">
          {ctx.production.entitled
            ? 'Production store: entitled for this tenant.'
            : `Production: ${ctx.production.reason}`}
        </p>
        <p className="mt-1 font-mono text-[10px] text-mist/70">seed {ctx.seedVersion}</p>
      </div>
    </aside>
  );
}

export default function ControlTower() {
  const { path, navigate } = useRoute();
  const { ctx, loading, error, reload } = useActContext();

  const route = resolveRoute(path);
  const demoLive = ctx !== null && ctx.mode === 'demo' && ctx.demo.enabled;

  // presentation mode is the default on the executive demo route; the page
  // itself can toggle the chrome back on/off
  const [presenting, setPresenting] = useState(true);
  useEffect(() => {
    if (route.key === 'demo-executive') setPresenting(true);
  }, [route.key]);
  const presentation = route.key === 'demo-executive' && presenting;

  const env = useMemo(
    () => ({ ctx, navigate, presentation, setPresentation: setPresenting }),
    [ctx, navigate, presentation],
  );

  let body: ReactNode;
  if (!ctx) {
    body = error ? (
      <ErrorState message={`Could not read the control-tower context: ${error}`} onRetry={reload} />
    ) : (
      <Loading label={loading ? 'Loading Agent Control Tower context…' : 'Loading…'} />
    );
  } else {
    body = (
      <ErrorBoundary key={route.key} label={`The ${route.label ?? route.key} page`}>
        {renderRoute(route.key, route.segments)}
      </ErrorBoundary>
    );
  }

  return (
    <ActEnvContext.Provider value={env}>
      <div className="flex min-h-screen flex-col bg-ink-950">
        <header className="border-b border-line bg-ink-900">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-2.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.3em] text-mist">
              Agent Control Tower
            </span>
            {demoLive ? (
              <span className="border border-amber-soft/50 bg-amber-soft/10 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-amber-soft">
                {DEMO_BANNER}
              </span>
            ) : ctx ? (
              <Badge tone="info">{ctx.mode === 'production' ? 'PRODUCTION' : 'NO DATA SOURCE'}</Badge>
            ) : null}
            <span className="ml-auto font-mono text-[11px] text-mist">
              {ctx ? `${ctx.tenant} · generated ${new Date(ctx.generatedAt).toISOString().slice(0, 19).replace('T', ' ')}Z` : ''}
            </span>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {!presentation && ctx && <Sidebar ctx={ctx} routeLabel={route.label} navigate={navigate} />}

          <main className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-6 py-4">
              <div>
                <h1 className="text-lg font-semibold text-slate-soft">{route.label}</h1>
                {!presentation && (
                  <p className="mt-0.5 text-xs text-mist">
                    {demoLive
                      ? 'Synthetic demo dataset — every figure below is computed server-side from the seed plus live demo events.'
                      : 'Configured environment only — this page never fabricates rows.'}
                  </p>
                )}
              </div>
              {!presentation && ctx && (
                <div className="flex items-center gap-2">
                  <Badge tone={demoLive ? 'warn' : 'info'}>{ctx.mode}</Badge>
                  {!ctx.production.entitled && <Badge tone="info">production unavailable</Badge>}
                </div>
              )}
            </div>

            <div className={presentation ? 'px-8 py-8 text-[17px]' : 'p-6'}>
              {ctx && demoLive && !ctx.production.entitled && !route.key.startsWith('demo') && (
                <p className="mb-4 border-l-2 border-amber-soft/50 bg-ink-900/60 py-2 pl-3 text-xs text-mist">
                  Production data is unavailable: <span className="font-mono text-amber-soft">&ldquo;{ctx.production.reason}&rdquo;</span>{' '}
                  — this page therefore shows the synthetic demo dataset only.
                </p>
              )}
              {body}
            </div>
          </main>
        </div>
      </div>
    </ActEnvContext.Provider>
  );
}