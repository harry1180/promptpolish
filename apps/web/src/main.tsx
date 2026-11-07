import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import ControlTower from './act';
import TradingUSA from './tradingusa';
import Crypto from './crypto';
import './styles.css';

const root: Root = createRoot(document.getElementById('root')!);

function render(): void {
  const path = window.location.pathname;
  const isTradingUSA = path === '/tradingusa' || path.startsWith('/tradingusa/');
  const isCrypto = path === '/crypto' || path.startsWith('/crypto/');
  const isControlTower = path.startsWith('/agent-control-tower');
  root.render(
    <React.StrictMode>
      {isTradingUSA ? (
        <TradingUSA />
      ) : isCrypto ? (
        <Crypto />
      ) : isControlTower ? (
        <ControlTower />
      ) : (
        <App />
      )}
    </React.StrictMode>,
  );
}

// Routing is pushState/popstate only: re-render on popstate so the control
// tower's "back to PromptPolice" link and the browser back button swap the
// mounted tree without a full reload.
window.addEventListener('popstate', render);

render();