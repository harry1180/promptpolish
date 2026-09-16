import { useEffect, useState } from 'react';
import { catalog } from '@promptslim/model-config';
import type { ProviderKeyInfo } from '@promptslim/shared-types';
import { api } from '../api/account';

/**
 * Bring-your-own provider keys. Keys go straight to the org server over the
 * same-origin API, are AES-256-GCM encrypted at rest, and are only ever
 * echoed back masked. The browser never keeps a copy.
 */
export function KeysPanel() {
  const [keys, setKeys] = useState<ProviderKeyInfo[]>([]);
  const [provider, setProvider] = useState<string>(providers()[0] ?? '');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void api.keys().then((r) => { if (r.ok && r.data) setKeys(r.data.keys); });
  }, []);

  async function save() {
    setBusy(true);
    setMsg('');
    const r = await api.saveKey(provider, apiKey);
    if (r.ok && r.data) {
      setKeys(r.data.keys);
      setApiKey('');
      setMsg(`${provider} key saved (encrypted at rest).`);
    } else setMsg(r.errors.join(' · '));
    setBusy(false);
  }

  async function remove(p: string) {
    const r = await api.deleteKey(p);
    if (r.ok && r.data) setKeys(r.data.keys);
  }

  const saved = new Set(keys.map((k) => k.provider));
  return (
    <div className="card p-4">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-sm font-semibold text-slate-soft"
      >
        <span>
          Bring your own keys
          <span className="ml-2 font-mono text-xs text-mist">
            {saved.size > 0 ? [...saved].join(' · ') : 'none saved'}
          </span>
        </span>
        <span className="text-mist">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-mist">
            PromptPolice calls providers with <em>your</em> account keys. Stored AES-256-GCM
            encrypted server-side, shown masked only, decrypted just for the moment of a call.
          </p>
          <ul className="space-y-1.5">
            {keys.map((k) => (
              <li key={k.provider} className="flex items-center gap-3 text-xs">
                <span className="w-24 font-semibold text-slate-soft">{k.provider}</span>
                <span className="font-mono text-mist">{k.masked}</span>
                <button
                  onClick={() => void remove(k.provider)}
                  className="ml-auto text-mist underline-offset-2 hover:text-danger hover:underline"
                >
                  remove
                </button>
              </li>
            ))}
            {keys.length === 0 && <li className="text-xs italic text-mist">No keys yet.</li>}
          </ul>
          <div className="flex flex-wrap gap-2">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              aria-label="Provider for new key"
              className="card cursor-pointer bg-ink-800 px-2 py-1.5 text-sm text-slate-soft"
            >
              {providers().map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              aria-label="API key"
              placeholder="paste provider API key"
              autoComplete="off"
              spellCheck={false}
              className="card min-w-0 flex-1 bg-ink-800 px-3 py-1.5 font-mono text-xs text-slate-soft outline-none focus:border-mint/50"
            />
            <button
              onClick={() => void save()}
              disabled={busy || apiKey.trim().length < 8}
              className="rounded-lg bg-mint px-3 py-1.5 text-sm font-semibold text-ink-950 hover:bg-mint-dim disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save key'}
            </button>
          </div>
          {msg && <p className="text-xs text-mint">{msg}</p>}
        </div>
      )}
    </div>
  );
}

function providers(): string[] {
  return Array.from(new Set(catalog.models.map((m) => m.provider)));
}
