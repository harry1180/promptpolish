import { useState } from 'react';
import type { TagMap } from '@promptslim/shared-types';
import { validateTags } from '@promptslim/analytics';
import type { AccountState } from '../hooks/useAccount';

interface TagRow {
  key: string;
  value: string;
}

const rowsToMap = (rows: TagRow[]): TagMap => {
  const m: TagMap = {};
  for (const r of rows) {
    const k = r.key.trim();
    const v = r.value.trim();
    if (k && v) m[k] = v;
  }
  return m;
};

/** Sign in / create account panel. Signup collects organization tags as
 *  key→value pairs (cost center, team, environment, …) — these become the
 *  dimensions the executive dashboard aggregates and filters on. */
export function AuthPanel({ account, onDone }: { account: AccountState; onDone?: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [rows, setRows] = useState<TagRow[]>([{ key: 'cost_center', value: '' }]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const tagMap = rowsToMap(rows);
    if (mode === 'signup') {
      // surface client-side validation with the same rules the server enforces
      const v = validateTags(tagMap);
      if (v.errors.length) {
        setErrors(v.errors);
        setBusy(false);
        return;
      }
      const errs = await account.signup({ email, password, name, tags: tagMap });
      if (errs.length) setErrors(errs);
    } else {
      const errs = await account.login(email, password);
      if (errs.length) setErrors(errs);
    }
    setBusy(false);
    if (onDone) onDone();
  };

  return (
    <section className="card p-5 md:p-6" aria-label="Account" id="account">
      <div className="mb-4 flex gap-2" role="tablist" aria-label="Account mode">
        {(['signup', 'login'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => { setMode(m); setErrors([]); }}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors ${
              mode === m ? 'bg-mint text-ink-950' : 'text-mist hover:text-slate-soft'
            }`}
          >
            {m === 'signup' ? 'Create account' : 'Sign in'}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-mist">Work email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Work email"
            placeholder="you@company.com"
            className="card w-full bg-ink-800 px-3 py-2 text-slate-soft outline-none focus:border-mint/50"
          />
        </label>
        {mode === 'signup' && (
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-mist">Display name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Display name"
              placeholder="Ada from Platform Finance"
              className="card w-full bg-ink-800 px-3 py-2 text-slate-soft outline-none focus:border-mint/50"
            />
          </label>
        )}
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-mist">Password</span>
          <input
            type="password"
            required
            minLength={mode === 'signup' ? 8 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Password"
            placeholder={mode === 'signup' ? 'at least 8 characters' : '••••••••'}
            className="card w-full bg-ink-800 px-3 py-2 text-slate-soft outline-none focus:border-mint/50"
          />
        </label>

        {mode === 'signup' && (
          <fieldset className="pt-1">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wider text-mist">
              Organization tags
            </legend>
            <p className="mb-2 text-xs text-mist">
              Key/value pairs that tie this account to your org structure — e.g.{' '}
              <code className="text-violet-soft">cost_center = 10</code>, <code className="text-violet-soft">team = payments</code>.
              Every prompt run is stamped with them, so the executive dashboard can aggregate any combination
              across all users who share the same tags.
            </p>
            {rows.map((r, i) => (
              <div key={i} className="mb-2 flex items-center gap-2">
                <input
                  value={r.key}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                  aria-label={`Tag ${i + 1} key`}
                  placeholder="key (e.g. cost_center)"
                  className="card w-1/2 bg-ink-800 px-3 py-1.5 font-mono text-xs text-slate-soft outline-none focus:border-mint/50"
                />
                <span className="text-mist">=</span>
                <input
                  value={r.value}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  aria-label={`Tag ${i + 1} value`}
                  placeholder="value (e.g. 10)"
                  className="card w-1/2 bg-ink-800 px-3 py-1.5 font-mono text-xs text-slate-soft outline-none focus:border-mint/50"
                />
                <button
                  type="button"
                  aria-label={`Remove tag ${i + 1}`}
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  className="px-1 text-mist transition-colors hover:text-danger"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setRows([...rows, { key: '', value: '' }])}
              className="text-xs font-medium text-mint underline-offset-2 hover:underline"
            >
              + Add tag
            </button>
          </fieldset>
        )}

        {errors.length > 0 && (
          <ul className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-mint px-4 py-2.5 font-semibold text-ink-950 transition-colors hover:bg-mint-dim disabled:opacity-50"
        >
          {busy ? 'Working…' : mode === 'signup' ? 'Create account & continue' : 'Sign in'}
        </button>
      </form>
    </section>
  );
}
