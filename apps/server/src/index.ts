import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, insertEvent, queryEvents, tagFacetsFromDb, parseTags, type EventRow, type UserRow } from './db.ts';
import {
  clearedCookie, createSession, destroySession, hashPassword, normalizeEmail,
  readCookie, sessionCookie, sessionUserId, userByEmail, userById, validEmail, verifyPassword,
} from './auth.ts';
import { KeyVault } from './keys.ts';
import { handleChat } from './chat.ts';
import {
  buildAggregate, validateFilters, validateTags,
} from '@promptslim/analytics';
import { isMainModule } from './main-entry.ts';
import { getModel, catalog } from '@promptslim/model-config';
import { inputCostPerRequest } from '@promptslim/pricing-engine';
import type {
  AccountInfo, AggregateRequest, OptimizationLevel, UsageEventRow,
} from '@promptslim/shared-types';

/**
 * PromptPolice org server: accounts (signup with tags), tag-snapshotted usage
 * events, and cross-user tag-combination aggregation for the executive
 * dashboard. Zero framework deps — node:http + node:sqlite + node:crypto.
 *
 * Security notes (decision records):
 * - Passwords: scrypt + per-user salt, constant-time compare (auth.ts).
 * - Sessions: opaque 256-bit token, SHA-256 stored, HttpOnly SameSite=Lax cookie.
 * - Events NEVER carry prompt text — only counts and server-computed costs.
 * - Costs are computed here from model-config prices at write time, so a
 *   later price change cannot silently rewrite history (re-price = new field).
 * - Dashboard scope: any authenticated member sees org-wide aggregates. The
 *   product's users are cost-center owners/executives; per-user ACLs are a
 *   documented Phase-4 seam (RBAC layer in front of aggregate()).
 */

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.PP_DB ?? 'data/promptpolice.db';
const MAX_BODY = 256 * 1024;
const LEVELS = new Set(['conservative', 'balanced', 'aggressive']);
const KNOWN_PROVIDERS = new Set(catalog.models.map((m) => m.provider));

export interface ServerHandle {
  server: ReturnType<typeof createServer>;
  db: DatabaseSync;
  url: string;
}

function json(res: ServerResponse, status: number, body: unknown, cookie?: string): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    ...(cookie ? { 'set-cookie': cookie } : {}),
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/* brute-force guard: per (ip, email) window on login */
const attempts = new Map<string, { count: number; resetAt: number }>();
function tooMany(key: string): boolean {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60_000 });
    return false;
  }
  a.count += 1;
  return a.count > 10;
}

function accountOf(u: UserRow): AccountInfo {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    tags: parseTags(u.tags_json),
    createdAt: u.created_at,
  };
}

function eventRowToDomain(r: EventRow, userByIdMap: Map<number, string>): UsageEventRow {
  return {
    id: r.id,
    userId: r.user_id,
    email: userByIdMap.get(r.user_id),
    ts: r.ts,
    modelId: r.model_id,
    level: r.level as OptimizationLevel,
    originalTokens: r.original_tokens,
    optimizedTokens: r.optimized_tokens,
    fromCache: r.from_cache === 1,
    costOriginalUsd: r.cost_original_usd,
    costOptimizedUsd: r.cost_optimized_usd,
    tags: parseTags(r.tags_json),
    source: r.source === 'chat' ? 'chat' : 'optimizer',
    outputTokens: r.output_tokens,
    actualCostUsd: r.actual_cost_usd,
  };
}

export interface AppOptions {
  /** injected provider fetch for tests (chat.ts); production uses global fetch */
  fetchImpl?: typeof fetch;
  /** where the master key file lives (":memory:" keeps vault keys process-only, for tests) */
  dbPath?: string;
}

export function createApp(db: DatabaseSync, opts: AppOptions = {}): ReturnType<typeof createServer> {
  const secure = process.env.PP_COOKIE_SECURE === '1';
  const vault = new KeyVault(db, opts.dbPath ?? DB_PATH);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const ip = req.socket.remoteAddress ?? '?';
    let user: UserRow | null = null;
    let token: string | null = null;

    try {
      const uid = (() => {
        token = readCookie(req.headers.cookie, 'pp_session');
        return sessionUserId(db, token);
      })();
      user = uid ? (userById(db, uid) ?? null) : null;

      /* ---------------- auth ---------------- */
      if (path === '/api/signup' && req.method === 'POST') {
        const body = (await readBody(req)) as { email?: string; password?: string; name?: string; tags?: unknown };
        const email = normalizeEmail(String(body.email ?? ''));
        const name = String(body.name ?? '').trim().slice(0, 120);
        const password = String(body.password ?? '');
        const errors: string[] = [];
        if (!validEmail(email)) errors.push('a valid email is required');
        if (password.length < 8) errors.push('password must be at least 8 characters');
        const tagVal = validateTags(body.tags);
        errors.push(...tagVal.errors);
        if (userByEmail(db, email)) errors.push('an account with this email already exists');
        if (errors.length) return json(res, 400, { errors });

        const now = Date.now();
        const r = db
          .prepare('INSERT INTO users (email, name, pass_salt, pass_hash, tags_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(email, name, ...(() => { const [s, h] = hashPassword(password).split(':'); return [s, h]; })(), JSON.stringify(tagVal.tags), now);
        const created = userById(db, Number(r.lastInsertRowid))!;
        const sess = createSession(db, created.id);
        return json(res, 201, { account: accountOf(created) }, sessionCookie(sess.token, 30 * 24 * 3600, secure));
      }

      if (path === '/api/login' && req.method === 'POST') {
        const body = (await readBody(req)) as { email?: string; password?: string };
        const email = normalizeEmail(String(body.email ?? ''));
        const password = String(body.password ?? '');
        if (tooMany(`${ip}|${email}`)) return json(res, 429, { errors: ['too many attempts — try again in 15 minutes'] });
        const u = userByEmail(db, email);
        if (!u || !verifyPassword(password, `${u.pass_salt}:${u.pass_hash}`)) {
          return json(res, 401, { errors: ['invalid email or password'] });
        }
        const sess = createSession(db, u.id);
        return json(res, 200, { account: accountOf(u) }, sessionCookie(sess.token, 30 * 24 * 3600, secure));
      }

      if (path === '/api/logout' && req.method === 'POST') {
        destroySession(db, token);
        return json(res, 200, { ok: true }, clearedCookie(secure));
      }

      if (path === '/api/me' && req.method === 'GET') {
        if (!user) return json(res, 401, { errors: ['not signed in'] });
        return json(res, 200, { account: accountOf(user) });
      }

      if (path === '/api/me/tags' && req.method === 'PUT') {
        if (!user) return json(res, 401, { errors: ['not signed in'] });
        const body = (await readBody(req)) as { tags?: unknown };
        const v = validateTags(body.tags);
        if (v.errors.length) return json(res, 400, { errors: v.errors });
        db.prepare('UPDATE users SET tags_json = ? WHERE id = ?').run(JSON.stringify(v.tags), user.id);
        // future events snapshot the NEW tags; past events keep their snapshot
        return json(res, 200, { account: accountOf({ ...user, tags_json: JSON.stringify(v.tags) }) });
      }

      /* ---------------- events ---------------- */
      if (path === '/api/events' && req.method === 'POST') {
        if (!user) return json(res, 401, { errors: ['not signed in'] });
        const body = (await readBody(req)) as Record<string, unknown>;
        const model = getModel(String(body.modelId ?? ''));
        const level = String(body.level ?? '') as OptimizationLevel;
        const original = Number(body.originalTokens);
        const optimized = Number(body.optimizedTokens);
        if (!model) return json(res, 400, { errors: ['unknown modelId'] });
        if (!LEVELS.has(level)) return json(res, 400, { errors: ['level must be conservative|balanced|aggressive'] });
        if (!Number.isInteger(original) || original < 0 || original > 100_000_000) return json(res, 400, { errors: ['originalTokens invalid'] });
        if (!Number.isInteger(optimized) || optimized < 0 || optimized > original) return json(res, 400, { errors: ['optimizedTokens invalid (must be ≤ originalTokens)'] });
        const tsRaw = Number(body.ts);
        const ts = Number.isFinite(tsRaw) && tsRaw > 0 && tsRaw <= Date.now() + 60_000 ? Math.floor(tsRaw) : Date.now();
        const fromCache = body.fromCache === true;
        const costOriginal = inputCostPerRequest(model, original);
        const costOptimized = inputCostPerRequest(model, optimized);
        const tags = parseTags(user.tags_json);
        insertEvent(db, {
          user_id: user.id, ts, model_id: model.id, level,
          original_tokens: original, optimized_tokens: optimized,
          from_cache: fromCache ? 1 : 0,
          cost_original_usd: costOriginal, cost_optimized_usd: costOptimized,
          tags_json: JSON.stringify(tags),
          source: 'optimizer', output_tokens: 0, actual_cost_usd: 0,
        });
        return json(res, 201, { ok: true, tagsRecorded: tags });
      }

      /* ---------------- provider API keys ---------------- */
      if (path === '/api/keys' && req.method === 'GET') {
        if (!user) return json(res, 401, { errors: ['not signed in'] });
        return json(res, 200, { keys: vault.list(user.id) });
      }

      if (path === '/api/keys' && req.method === 'PUT') {
        if (!user) return json(res, 401, { errors: ['not signed in'] });
        const body = (await readBody(req)) as { provider?: string; apiKey?: string };
        const provider = String(body.provider ?? '').trim();
        const apiKey = String(body.apiKey ?? '').trim();
        if (!KNOWN_PROVIDERS.has(provider)) {
          return json(res, 400, { errors: [`unknown provider — choose from ${[...KNOWN_PROVIDERS].join(', ')}`] });
        }
        if (apiKey.length < 8 || apiKey.length > 512 || /\s/.test(apiKey)) {
          return json(res, 400, { errors: ['apiKey looks malformed (8–512 non-space chars)'] });
        }
        vault.put(user.id, provider, apiKey);
        return json(res, 200, { keys: vault.list(user.id) });
      }

      if (path === '/api/keys' && req.method === 'DELETE') {
        if (!user) return json(res, 401, { errors: ['not signed in'] });
        const provider = String(url.searchParams.get('provider') ?? '').trim();
        const removed = vault.remove(user.id, provider);
        return json(res, removed ? 200 : 404, removed ? { keys: vault.list(user.id) } : { errors: ['no key saved for that provider'] });
      }

      /* ---------------- governed LLM chat gateway ---------------- */
      if (path === '/api/chat' && req.method === 'POST') {
        if (!user) return json(res, 401, { errors: ['not signed in'] });
        const body = (await readBody(req)) as Record<string, unknown>;
        const { status, body: out } = await handleChat(db, vault, user, body, { fetchImpl: opts.fetchImpl });
        return json(res, status, out);
      }

      /* ---------------- dashboard queries ---------------- */
      if (path === '/api/aggregate' && req.method === 'POST') {
        if (!user) return json(res, 401, { errors: ['not signed in'] });
        const body = (await readBody(req)) as AggregateRequest;
        const f = validateFilters(body.filters);
        if (f.errors.length) return json(res, 400, { errors: f.errors });
        const groupBy = Array.isArray(body.groupBy)
          ? body.groupBy.map(String).map((k) => k.trim()).filter(Boolean).slice(0, 3)
          : [];
        const since = Number.isFinite(body.since as number) ? (body.since as number) : null;
        const until = Number.isFinite(body.until as number) ? (body.until as number) : null;
        const rows = queryEvents(db, f.filters, since, until);
        // resolve emails once per distinct user (for the group-by-user view)
        const emailById = new Map<number, string>();
        for (const r of rows) if (!emailById.has(r.user_id)) {
          const u = userById(db, r.user_id);
          if (u) emailById.set(u.id, u.email);
        }
        const domain = rows.map((r) => eventRowToDomain(r, emailById));
        // "__user" synthetic group key: bucket by account email
        const prepared: UsageEventRow[] = groupBy.includes('__user')
          ? domain.map((e) => ({ ...e, tags: { ...e.tags, __user: e.email ?? `user-${e.userId}` } }))
          : domain;
        const agg = buildAggregate(prepared, { filters: f.filters, groupBy, since, until });
        return json(res, 200, agg);
      }

      if (path === '/api/tags/facets' && req.method === 'GET') {
        if (!user) return json(res, 401, { errors: ['not signed in'] });
        return json(res, 200, { facets: tagFacetsFromDb(db) });
      }

      if (path === '/api/health' && req.method === 'GET') {
        return json(res, 200, { ok: true, ts: Date.now() });
      }

      json(res, 404, { errors: ['not found'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'internal error';
      json(res, msg === 'body too large' || msg === 'invalid JSON body' ? 400 : 500, {
        errors: [msg === 'internal error' ? 'internal error' : msg],
      });
    }
  });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const db = openDb(DB_PATH);
  const server = createApp(db);
  server.listen(PORT, () => {
    console.log(`PromptPolice server on http://localhost:${PORT} (db: ${DB_PATH})`);
  });
}
