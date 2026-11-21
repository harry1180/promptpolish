/**
 * Crypto — path-routed shell for the 24/7 spot PAPER-TRADING dashboard
 * (no router dependency), mounted by main.tsx when the pathname starts with
 * /crypto. Routing is history pushState/popstate only, following the
 * TradingUSA / Control-Tower pattern.
 *
 * Two badges are ALWAYS visible in the header: the amber paper-trading badge
 * (executionMode is PAPER_ONLY server-side) and the 24/7 badge, because this
 * book never closes.
 */

import type { ReactNode } from 'react';
import { getStatus } from './api';
import type { StatusResponse } from './api';
import {
  ALWAYS_OPEN,
  BASE_PATH,
  NAV,
  PAPER_BANNER,
  STATUS_REFRESH_MS,
  resolveRoute,
  useEndpoint,
  useRoute,
} from './data';
import { ErrorBoundary, StatusPill, time } from '../tradingusa/ui';

import { OverviewPage } from './pages/Overview';
import { MarketPage } from './pages/Market';
import { Kalshi15mPage } from './pages/Kalshi15m';
import { SignalsPage } from './pages/Signals';
import { PaperTradingPage } from './pages/PaperTrading';
import { LearningPage } from './pages/Learning';
import { SystemPage } from './pages/System';

export { ALWAYS_OPEN, BASE_PATH, NAV, PAPER_BANNER };

function renderRoute(key: string): ReactNode {
  switch (key) {
    case 'overview':
      return <OverviewPage />;
    case 'market':
      return <MarketPage />;
    case 'kalshi15m':
      return <Kalshi15mPage />;
    case 'signals':
      return <SignalsPage />;
    case 'paper-trading':
      return <PaperTradingPage />;
    case 'learning':
      return <LearningPage />;
    case 'system':
      return <SystemPage />;
    default:
      return (
        <section className="card p-6">
          <h2 className="text-sm font-semibold text-slate-soft">Page not found</h2>
          <p className="mt-2 text-sm text-mist">
            No crypto page matches this path. Open{' '}
            <a href={`${BASE_PATH}/overview`} className="text-mint underline">
              Overview
            </a>
            .
          </p>
        </section>
      );
  }
}

function Header({ status }: { status: ReturnType<typeof useEndpoint<StatusResponse>> }) {
  const provider = status.data?.provider;
  const stream = status.data?.stream;
  const universe = status.data?.universe;
  const counts = status.data?.counts;

  return (
    <header className="border-b border-line bg-ink-900">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <span className="font-mono text-sm uppercase tracking-[0.3em] text-mint">Crypto</span>
        <span className="border border-amber-soft/50 bg-amber-soft/10 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-amber-soft">
          {PAPER_BANNER}
        </span>
        <span className="border border-mint/40 bg-mint/10 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-mint">
          {ALWAYS_OPEN}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mist">
          {provider && (
            <span className="flex items-center gap-1" title={provider.lastError ?? provider.name}>
              {provider.name}
              <StatusPill status={provider.status} />
            </span>
          )}
          <span className="flex items-center gap-1">
            {stream?.live ? 'websocket' : 'rest poll'}
            <StatusPill status={stream?.live ? 'CONNECTED' : provider?.status ?? 'UNAVAILABLE'} />
          </span>
          {universe && <span className="font-mono">{universe.active} coins</span>}
          {counts && <span className="font-mono">{counts.openPositions} open</span>}
          {status.data && (
            <span className="font-mono">{status.data.executionMode === 'PAPER_ONLY' ? 'paper only' : '—'}</span>
          )}
        </span>
      </div>
    </header>
  );
}

function Sidebar({ routeKey, navigate }: { routeKey: string; navigate: (to: string) => void }) {
  return (
    <aside className="hidden w-52 shrink-0 flex-col border-r border-line bg-ink-900 lg:flex">
      <nav aria-label="crypto navigation" className="thin-scroll flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
        {NAV.map((item) => {
          const active = routeKey === item.key;
          return (
            <a
              key={item.key}
              href={item.to}
              aria-current={active ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(item.to);
              }}
              className={`block rounded-md border-l-2 px-3 py-1.5 text-sm ${
                active
                  ? 'border-mint bg-mint/10 text-mint'
                  : 'border-transparent text-mist hover:bg-ink-800 hover:text-slate-soft'
              }`}
            >
              {item.label}
            </a>
          );
        })}
      </nav>
      <div className="border-t border-line px-4 py-3 text-[11px] text-mist">
        <a
          href="/tradingusa/overview"
          onClick={(e) => {
            e.preventDefault();
            navigate('/tradingusa/overview');
          }}
          className="text-mist hover:text-mint"
        >
          &larr; TradingUSA
        </a>
        <p className="mt-1.5 leading-4">Spot paper execution only — long-only, no leverage, exchange fees modeled.</p>
      </div>
    </aside>
  );
}

export default function Crypto() {
  const { path, navigate } = useRoute();
  const route = resolveRoute(path);
  const status = useEndpoint<StatusResponse>('/status', getStatus, STATUS_REFRESH_MS);

  const body = (
    <ErrorBoundary key={route.key} label={`The ${route.label} page`}>
      {renderRoute(route.key)}
    </ErrorBoundary>
  );

  return (
    <div className="flex min-h-screen flex-col bg-ink-950 bg-hero">
      <Header status={status} />
      <div className="flex min-h-0 flex-1">
        <Sidebar routeKey={route.key} navigate={navigate} />
        <main className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-3">
            <div>
              <h1 className="text-base font-semibold text-slate-soft">{route.label}</h1>
              <p className="mt-0.5 text-xs text-mist">
                Realtime Kraken data · fee-aware paper fills · long-only spot book · 24/7 session.
              </p>
            </div>
            <span className="font-mono text-[11px] text-mist">
              {status.data?.provider?.lastUpdate ? `quotes ${time(status.data.provider.lastUpdate)}` : ''}
            </span>
          </div>
          <div className="space-y-5 p-5">
            {status.error && (
              <p role="alert" className="border-l-2 border-amber-soft/60 bg-ink-900/70 py-2 pl-3 text-xs text-amber-soft">
                Crypto status unavailable: {status.error}
              </p>
            )}
            {body}
          </div>
          <footer className="border-t border-line px-5 py-3 text-[11px] text-mist">
            Crypto paper book · Kraken spot ·{' '}
            <a href="/" className="text-mist hover:text-mint" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
              PromptPolice
            </a>
          </footer>
        </main>
      </div>
    </div>
  );
}
