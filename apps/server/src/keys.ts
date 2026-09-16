import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Provider API keys at rest: AES-256-GCM under a master key. The master key
 * comes from PP_MASTER_KEY (hex) or is auto-generated once into
 * <dbdir>/master.key (0600 best-effort) — so a backup of the DB without the
 * key file is useless to an attacker. Keys are decrypted only for the
 * lifetime of one provider call and never returned by any endpoint; the API
 * only ever exposes masked forms.
 */

function loadMasterKey(dbPath: string): Buffer {
  const env = process.env.PP_MASTER_KEY;
  if (env) {
    const k = Buffer.from(env, 'hex');
    if (k.length !== 32) throw new Error('PP_MASTER_KEY must be 64 hex chars (32 bytes)');
    return k;
  }
  const file = dbPath === ':memory:' ? null : dirname(dbPath) + '/master.key';
  if (file && existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  const key = randomBytes(32);
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  }
  return key;
}

export class KeyVault {
  private master: Buffer;
  private db: DatabaseSync;
  constructor(db: DatabaseSync, dbPath: string) {
    this.db = db;
    this.master = loadMasterKey(dbPath);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.master, iv);
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return [iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  }

  decrypt(bundle: string): string {
    const [iv, tag, ct] = bundle.split('.').map((s) => Buffer.from(s, 'base64'));
    if (!iv || !tag || !ct) throw new Error('corrupt key blob');
    const d = createDecipheriv('aes-256-gcm', this.master, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }

  put(userId: number, provider: string, apiKey: string): void {
    this.db
      .prepare(
        `INSERT INTO provider_keys (user_id, provider, key_blob, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET key_blob = excluded.key_blob, updated_at = excluded.updated_at`,
      )
      .run(userId, provider, this.encrypt(apiKey), Date.now());
  }

  get(userId: number, provider: string): string | null {
    const row = this.db
      .prepare('SELECT key_blob FROM provider_keys WHERE user_id = ? AND provider = ?')
      .get(userId, provider) as { key_blob: string } | undefined;
    if (!row) return null;
    try {
      return this.decrypt(row.key_blob);
    } catch {
      return null; // master key rotated or blob corrupt — treat as missing
    }
  }

  list(userId: number): Array<{ provider: string; masked: string; addedAt: number }> {
    const rows = this.db
      .prepare('SELECT provider, key_blob, updated_at FROM provider_keys WHERE user_id = ?')
      .all(userId) as unknown as Array<{ provider: string; key_blob: string; updated_at: number }>;
    return rows.map((r) => {
      let masked = '••••';
      try {
        masked = maskKey(this.decrypt(r.key_blob));
      } catch { /* keep generic mask */ }
      return { provider: r.provider, masked, addedAt: r.updated_at };
    });
  }

  remove(userId: number, provider: string): boolean {
    const r = this.db
      .prepare('DELETE FROM provider_keys WHERE user_id = ? AND provider = ?')
      .run(userId, provider);
    return r.changes > 0;
  }
}

/** "sk-proj-…F1x9" style — last 4 chars only. */
export function maskKey(key: string): string {
  const tail = key.slice(-4);
  return `${key.slice(0, 6)}…${tail}`;
}
