/**
 * TradingUSA — path-routed shell for the 15-page market-intelligence +
 * PAPER-TRADING dashboard (no router dependency).
 *
 * Mounted by main.tsx when the pathname starts with /tradingusa. Routing is
 * history pushState/popstate only, following the act/ Control-Tower pattern.
 *
 * The amber paper-trading badge is ALWAYS visible in the header — this
 * dashboard never touches real money (executionMode is PAPER_ONLY
 * server-side; see GET /settings → locked).
 */

import type { ReactNode } from 'react';
import { getAi, getStatus } from './api';
import type { AiResponse, StatusResponse } from './api';
import {
  BASE_PATH,
  NAV,
  PAPER_BANNER,
  STATUS_REFRESH_MS,
  resolveRoute,
  useEndpoint,
  useRoute,
} from './data';
import { EmptyState, ErrorBoundary, SessionBadge, StatusPill, dateText, time } from './ui';
import type { Endpoint } from './data';

import { OverviewPage } from './pages/Overview';
import { SignalDetailPage, SignalsPage } from './pages/Signals';
import { ScannerPage } from './pages/Scanner';
import { MarketPage } from './pages/Market';
import { StocksPage } from './pages/Stocks';
import { StockPage } from './pages/StockPage';
import { PortfolioPage } from './pages/Portfolio';
import { PaperTradingPage } from './pages/PaperTrading';
import { StrategiesPage } from './pages/Strategies';
import { ResearchPage } from './pages/Research';
import { SourcesPage } from './pages/Sources';
import { LearningPage } from './pages/Learning';
import { BacktestsPage } from './pages/Backtests';
import { ReportPage } from './pages/Report';
import { AiPage } from './pages/Ai';
import { SystemPage } from './pages/System';
import { SettingsPage } from './pages/Settings';

export { BASE_PATH, NAV, PAPER_BANNER };

function renderRoute(key: string, segments: string[]): ReactNode {
  switch (key) {
    case 'overview':
      return <OverviewPage />;
    case 'signals':
      return segments[1] ? <SignalDetailPage signalId={segments[1]} /> : <SignalsPage />;
    case 'scanner':
      return <ScannerPage />;
    case 'market':
      return <MarketPage />;
    case 'stocks':
      return segments[1] ? <StockPage ticker={segments[1].toUpperCase()} /> : <StocksPage />;
    case 'portfolio':
      return <PortfolioPage />;
    case 'paper-trading':
      return <PaperTradingPage />;
    case 'strategies':
      return <StrategiesPage />;
    case 'research':
      return <ResearchPage />;
    case 'sources':
      return <SourcesPage />;
    case 'learning':
      return <LearningPage />;
    case 'backtests':
      return <BacktestsPage />;
    case 'report':
      return <ReportPage />;
    case 'ai':
      return <AiPage />;
    case 'system':
      return <SystemPage />;
    case 'settings':
      return <SettingsPage />;
    default:
      return (
        <EmptyState title="Page not found">
          <p>
            No TradingUSA page matches this path. Return to the{' '}
            <a href={`${BASE_PATH}/overview`} className="text-mint underline">
              Overview
            </a>
            .
          </p>
        </EmptyState>
      );
  }
}

function Header({ status, ai }: { status: Endpoint<StatusResponse>; ai: Endpoint<AiResponse> }) {
  const market = status.data?.market;
  const next = market?.nextSession;
  const nextLabel = next
    ? `${dateText(next.date)}${next.openMs ? ` · open ${time(next.openMs)}` : ''}`
    : '—';
  const providers = ai.data?.providers ?? [];
  const marketData = status.data?.providers?.marketData;

  return (
    <header className="border-b border-line bg-ink-900">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <span className="font-mono text-sm uppercase tracking-[0.3em] text-mint">TradingUSA</span>
        <span className="border border-amber-soft/50 bg-amber-soft/10 px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-amber-soft">
          {PAPER_BANNER}
        </span>
        <span className="flex items-center gap-2">
          <SessionBadge session={market?.session} date={market?.date ?? null} />
          <span className="font-mono text-[11px] text-mist" title="next session">
            next: {nextLabel}
          </span>
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {providers.map((p) => (
            <span key={p.name} className="flex items-center gap-1 text-[11px] text-mist">
              {p.name}
              <StatusPill status={p.status} />
            </span>
          ))}
          {marketData && (
            <span className="flex items-center gap-1 text-[11px] text-mist">
              {marketData.name ?? 'market data'}
              <StatusPill status={marketData.status} />
            </span>
          )}
          {status.data && (
            <span className="font-mono text-[11px] text-mist">{status.data.timezone}</span>
          )}
        </span>
      </div>
    </header>
  );
}

function Sidebar({ routeKey, navigate }: { routeKey: string; navigate: (to: string) => void }) {
  return (
    <aside className="hidden w-52 shrink-0 flex-col border-r border-line bg-ink-900 lg:flex">
      <nav aria-label="TradingUSA navigation" className="thin-scroll flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
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
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
          className="text-mist hover:text-mint"
        >
          &larr; PromptPolice
        </a>
        <p className="mt-1.5 leading-4">Research + paper execution only — no broker connectivity.</p>
      </div>
    </aside>
  );
}

export default function TradingUSA() {
  const { path, navigate } = useRoute();
  const route = resolveRoute(path);
  const status = useEndpoint<StatusResponse>('/status', getStatus, STATUS_REFRESH_MS);
  const ai = useEndpoint<AiResponse>('/ai', getAi);

  const body = (
    <ErrorBoundary key={route.key} label={`The ${route.label} page`}>
      {renderRoute(route.key, route.segments)}
    </ErrorBoundary>
  );

  return (
    <div className="flex min-h-screen flex-col bg-ink-950 bg-hero">
      <Header status={status} ai={ai} />
      <div className="flex min-h-0 flex-1">
        <Sidebar routeKey={route.key} navigate={navigate} />
        <main className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-5 py-3">
            <div>
              <h1 className="text-base font-semibold text-slate-soft">{route.label}</h1>
              <p className="mt-0.5 text-xs text-mist">
                Delayed market data · paper fills only · signals are immutable once created.
              </p>
            </div>
            <span className="font-mono text-[11px] text-mist">
              {status.data ? `as of ${time(status.data.now)}` : ''}
            </span>
          </div>
          <div className="space-y-5 p-5">
            {status.error && (
              <p role="alert" className="border-l-2 border-amber-soft/60 bg-ink-900/70 py-2 pl-3 text-xs text-amber-soft">
                Market status unavailable: {status.error}
              </p>
            )}
            {body}
          </div>
          <footer className="border-t border-line px-5 py-3 text-[11px] text-mist">
            TradingUSA research dashboard ·{' '}
            <a href="/" className="text-mist hover:text-mint" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
              PromptPolice
            </a>
          </footer>
        </main>
      </div>
    </div>
  );
}