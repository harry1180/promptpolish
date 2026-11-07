/**
 * ExecutionGuard — the hard boundary that makes real-money trading
 * impossible in this release.
 *
 * EXECUTION_MODE is PAPER_ONLY. The only registered BrokerAdapter is
 * PaperBrokerAdapter. RobinhoodAdapter exists as an interface definition
 * ONLY: it performs no network I/O, holds no credentials, and every call
 * throws. Future real-money adapters may only be registered after an
 * explicit, reviewed change to this file — there is no env var, no UI
 * toggle and no API that can enable them.
 */
import { EXECUTION_MODE } from '@promptslim/tucore';

export interface BrokerOrderRequest {
  portfolio: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  qty: number;
  signalId: number | null;
}

export interface BrokerOrderResult {
  accepted: boolean;
  destination: string;
  note: string;
}

export interface BrokerAdapter {
  readonly name: string;
  readonly supportsRealMoney: false;
  placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult>;
}

export class PaperBrokerAdapter implements BrokerAdapter {
  readonly name = 'PaperBrokerAdapter';
  readonly supportsRealMoney = false as const;

  async placeOrder(req: BrokerOrderRequest): Promise<BrokerOrderResult> {
    if (!Number.isInteger(req.qty) || req.qty <= 0) {
      return { accepted: false, destination: this.name, note: 'invalid quantity' };
    }
    return { accepted: true, destination: this.name, note: 'queued for paper execution' };
  }
}

/** Future interface — NOT implemented, NOT registered, all calls throw. */
export interface RobinhoodAdapter extends BrokerAdapter {
  readonly name: 'RobinhoodAdapter';
}

export class ExecutionGuard {
  readonly mode = EXECUTION_MODE;
  readonly realMoneyBlocked = true;
  private adapters = new Map<string, BrokerAdapter>();
  private paper = new PaperBrokerAdapter();

  constructor() {
    this.register(this.paper);
    // NOTE: no real-money adapter is registered and none can be enabled
    // through configuration. RobinhoodAdapter is an interface definition
    // awaiting officially supported APIs at some future date.
  }

  register(adapter: BrokerAdapter): void {
    if (adapter.supportsRealMoney) throw new Error('real-money adapters are not permitted in EXECUTION_MODE=PAPER_ONLY');
    this.adapters.set(adapter.name, adapter);
  }

  /** The only valid execution destination. */
  executor(): BrokerAdapter {
    if (this.mode !== 'PAPER_ONLY') throw new Error('ExecutionGuard invariant violated');
    return this.paper;
  }

  listAdapters(): string[] {
    return [...this.adapters.keys()];
  }

  status(): { mode: string; realMoneyBlocked: boolean; adapters: string[]; prohibited: string[] } {
    return {
      mode: this.mode,
      realMoneyBlocked: this.realMoneyBlocked,
      adapters: this.listAdapters(),
      prohibited: [
        'real brokerage BUY', 'real brokerage SELL', 'options execution',
        'crypto execution', 'fund transfers', 'deposits', 'withdrawals',
        'broker order submission',
      ],
    };
  }
}
