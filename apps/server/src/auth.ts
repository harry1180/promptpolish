import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { UserRow } from './db.ts';

/**
 * Passwords: scrypt (N=2^15 per Node default params below, per-user random
 * salt), stored as salt:hash hex. No plaintext, no third-party auth.
 * Sessions: random 32-byte token; only its SHA-256 hits the DB, the raw
 * token goes into an HttpOnly cookie — a DB leak cannot replay a session.
 */

const SCRYPT_N = 1 << 15;
const SCRYPT_MAXMEM = 64 << 20; // must exceed 128 * N * r
const KEY_LEN = 64;
export const SESSION_TTL_MS = 30 * 24 * 3600_000; // 30 days

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    maxmem: SCRYPT_MAXMEM,
  });
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  try {
    const hash = scryptSync(password.normalize('NFKC'), Buffer.from(saltHex, 'hex'), KEY_LEN, {
      N: SCRYPT_N,
      maxmem: SCRYPT_MAXMEM,
    });
    return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  } catch {
    return false;
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

/* ---------------- sessions ---------------- */

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db: DatabaseSync, userId: number): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    tokenHash(token), userId, now, expiresAt,
  );
  return { token, expiresAt };
}

export function sessionUserId(db: DatabaseSync, token: string | null): number | null {
  if (!token) return null;
  const row = db
    .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(tokenHash(token)) as { user_id: number; expires_at: number } | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return null;
  }
  return row.user_id;
}

export function destroySession(db: DatabaseSync, token: string | null): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function userById(db: DatabaseSync, id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function userByEmail(db: DatabaseSync, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
}

/* cookie helpers (SameSite=Lax + HttpOnly + Path=/; Secure when behind TLS) */

export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  return `pp_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

export function clearedCookie(secure: boolean): string {
  return `pp_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
