// Mizan server: auth + shared database + static frontend. Node 24 built-ins only.
//   npm run build && npm start        → http://localhost:8069
// Env: PORT, MIZAN_DB (sqlite path), MIZAN_ADMIN_PASSWORD (first start), MIZAN_SECURE_COOKIE=1 behind HTTPS.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '../src/seed.js';
import { applyDiff } from '../src/sync.js';
import { installCustomFields } from '../src/models/studio.js';
import { handleApi, publicApply, publicOrder, publicSite } from './api.js';
import { smtpConfig } from './smtp.js';
import { sendDocument, sendMailing } from './mail.js';

const SMTP = smtpConfig();
import { modelsForApps } from '../src/models/index.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 8069);
const SESSION_DAYS = 14;
const MAX_BODY = 5 * 1024 * 1024;
const COOKIE = 'mizan_session';

const sql = new DatabaseSync(process.env.MIZAN_DB ?? join(ROOT, 'mizan.sqlite'));
sql.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    salt TEXT NOT NULL, hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, apps TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL);
`);

try { sql.exec('ALTER TABLE users ADD COLUMN apps TEXT'); } catch { /* column already exists */ }

/** Comma-separated app ids a user may open; null/empty = all apps. */
const parseApps = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter((x) => /^[a-z]+$/.test(x)) : null);

// ---- database snapshot (ponytail: whole db as one JSON row; split into per-model tables when data grows) ----
const loadDb = () => {
  const row = sql.prepare('SELECT value FROM kv WHERE key = ?').get('db');
  return row ? JSON.parse(row.value) : null;
};
const saveDb = (db) => sql.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('db', JSON.stringify(db));
let db = loadDb();
if (!db) { db = seed(); saveDb(db); }
installCustomFields(db.settings?.customFields);

// ---- users & sessions ----
const hashPassword = (password, salt = randomBytes(16).toString('hex')) => ({ salt, hash: scryptSync(password, salt, 64).toString('hex') });
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function createUser({ login, name, password, isAdmin = false, apps = '' }) {
  if (!/^[\w.@-]{3,64}$/.test(login ?? '')) throw new Error('Login must be 3-64 letters, digits or . @ - _');
  if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters');
  const { salt, hash } = hashPassword(password);
  const allowed = parseApps(apps);
  sql.prepare('INSERT INTO users (login, name, salt, hash, is_admin, apps) VALUES (?, ?, ?, ?, ?, ?)')
    .run(login, String(name || login).slice(0, 100), salt, hash, isAdmin ? 1 : 0, allowed?.length ? allowed.join(',') : null);
}

if (!sql.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
  const password = process.env.MIZAN_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');
  createUser({ login: 'admin', name: 'Admin', password, isAdmin: true });
  console.info(`Created user "admin". Password: ${process.env.MIZAN_ADMIN_PASSWORD ? '(from MIZAN_ADMIN_PASSWORD)' : password}`);
}

function checkPassword(login, password) {
  const user = sql.prepare('SELECT * FROM users WHERE login = ?').get(String(login ?? ''));
  const { hash } = hashPassword(String(password ?? ''), user?.salt ?? 'x'.repeat(32));
  if (!user) return null;
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex')) ? user : null;
}

function sessionUser(req) {
  const token = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token) return null;
  const row = sql.prepare('SELECT u.id, u.login, u.name, u.is_admin, u.apps, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha256(token));
  if (!row || row.expires < Date.now()) return null;
  return { id: row.id, login: row.login, name: row.name, isAdmin: !!row.is_admin, apps: parseApps(row.apps) };
}

/** User owning a "Bearer mzn_…" API key, or null. Keys are stored only as SHA-256 hashes. */
function apiKeyUser(req) {
  const key = /^Bearer (mzn_[\w-]{20,})$/.exec(req.headers.authorization ?? '')?.[1];
  if (!key) return null;
  const row = sql.prepare('SELECT u.id, u.login, u.name, u.is_admin, u.apps FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?').get(sha256(key));
  return row ? { id: row.id, login: row.login, name: row.name, isAdmin: !!row.is_admin, apps: parseApps(row.apps) } : null;
}

// Secure cookies by default in production; MIZAN_SECURE_COOKIE=0 to serve plain HTTP (e.g. LAN), =1 to force.
const SECURE = process.env.MIZAN_SECURE_COOKIE ? process.env.MIZAN_SECURE_COOKIE === '1' : process.env.NODE_ENV === 'production';
const cookie = (value, maxAge) => `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`;

/** Models a session/API user may touch (null = everything). */
const allowedFor = (u) => (u.isAdmin || !u.apps?.length ? null : modelsForApps(u.apps));
const visibleDb = (u) => {
  const allowed = allowedFor(u);
  if (!allowed) return db;
  return {
    ...db,
    records: Object.fromEntries(Object.entries(db.records).filter(([m]) => allowed.has(m))),
    messages: db.messages.filter((m) => allowed.has(m.model)),
  };
};

// ---- rate limit: 10 failures per key (ip+login, or ip for API keys) per 15 minutes ----
const failures = new Map();
const WINDOW = 15 * 60 * 1000;
const recent = (k) => (failures.get(k) ?? []).filter((t) => Date.now() - t < WINDOW);
const tooMany = (k) => recent(k).length >= 10;
const recordFailure = (k) => failures.set(k, [...recent(k), Date.now()]);
setInterval(() => { for (const k of failures.keys()) if (!recent(k).length) failures.delete(k); }, WINDOW).unref();
// Behind a reverse proxy set MIZAN_TRUST_PROXY=1 so limits apply per client, not per proxy.
const clientIp = (req) => (process.env.MIZAN_TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

// ---- http helpers ----
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

function readJson(req) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error('Request too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { ok(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { fail(new Error('Invalid JSON')); }
    });
    req.on('error', fail);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};

async function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST + sep) && file !== DIST) return send(res, 403, { error: 'Forbidden' });
  try {
    if (!(await stat(file)).isFile()) throw new Error('dir');
  } catch {
    file = join(DIST, 'index.html'); // SPA fallback
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Run "npm run build" first' });
  }
}

// ---- routes ----
async function api(req, res, path) {
  const ip = clientIp(req);
  if (path === '/api/public/site' && req.method === 'GET') return send(res, 200, publicSite(db));
  if (path === '/api/public/apply' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`apply:${ip}`)) return send(res, 429, { error: 'Too many applications, try again later' });
    recordFailure(`apply:${ip}`);
    const out = publicApply(db, await readJson(req));
    if (out.db) { db = out.db; saveDb(db); }
    return send(res, out.status, out.body);
  }
  if (path === '/api/public/order' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`order:${ip}`)) return send(res, 429, { error: 'Too many orders, try again later' });
    recordFailure(`order:${ip}`); // counts every order: max 10 per client per 15 minutes
    const out = publicOrder(db, await readJson(req));
    if (out.db) { db = out.db; saveDb(db); }
    return send(res, out.status, out.body);
  }
  if (path.startsWith('/api/v1/')) {
    // Bearer-token API: no cookies involved, so no CSRF exposure; rate-limit failed keys like logins.
    if (tooMany(`key:${ip}`)) return send(res, 429, { error: 'Too many attempts, try again later' });
    const keyUser = apiKeyUser(req);
    if (!keyUser) { recordFailure(`key:${ip}`); return send(res, 401, { error: 'Invalid or missing API key' }); }
    const body = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : null;
    const out = handleApi({ method: req.method, path, query: new URL(req.url, 'http://x').searchParams, body, db, user: keyUser, allowed: allowedFor(keyUser) });
    if (out.db) { db = out.db; saveDb(db); }
    return send(res, out.status, out.body);
  }
  // CSRF: state-changing calls must be JSON with a custom header (not sendable by cross-site forms).
  if (req.method !== 'GET' && (req.headers['x-requested-with'] !== 'mizan' || !String(req.headers['content-type']).startsWith('application/json'))) {
    return send(res, 403, { error: 'Missing CSRF header' });
  }
  if (path === '/api/login' && req.method === 'POST') {
    const { login, password } = await readJson(req);
    const limitKey = `login:${ip}:${String(login ?? '').toLowerCase().slice(0, 64)}`;
    if (tooMany(limitKey)) return send(res, 429, { error: 'Too many attempts, try again later' });
    const user = checkPassword(login, password);
    if (!user) { recordFailure(limitKey); return send(res, 401, { error: 'Wrong login or password' }); }
    const token = randomBytes(32).toString('base64url');
    sql.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha256(token), user.id, Date.now() + SESSION_DAYS * 864e5);
    return send(res, 200, { id: user.id, login: user.login, name: user.name, isAdmin: !!user.is_admin, apps: parseApps(user.apps) }, { 'Set-Cookie': cookie(token, SESSION_DAYS * 86400) });
  }

  const user = sessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });

  if (path === '/api/session' && req.method === 'GET') return send(res, 200, { ...user, smtp: !!SMTP });
  if ((path === '/api/mail/document' || path === '/api/mail/mailing') && req.method === 'POST') {
    if (!SMTP) return send(res, 400, { error: 'Email is not configured (MIZAN_SMTP_HOST / MIZAN_SMTP_FROM)' });
    const body = await readJson(req);
    const model = path.endsWith('mailing') ? 'mailing.mailing' : String(body.model ?? '');
    const allowed = allowedFor(user);
    if (allowed && !allowed.has(model)) return send(res, 403, { error: `No access to ${model}` });
    try {
      const out = await (path.endsWith('mailing') ? sendMailing : sendDocument)(SMTP, db, user, body);
      if (out.db) { db = out.db; saveDb(db); }
      return send(res, out.status, out.body);
    } catch (e) {
      return send(res, 502, { error: `Email could not be sent: ${e.message}` });
    }
  }
  if (path === '/api/logout' && req.method === 'POST') {
    const token = (req.headers.cookie ?? '').match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];
    if (token) sql.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }
  if (path === '/api/db' && req.method === 'GET') return send(res, 200, visibleDb(user));
  if (path === '/api/diff' && req.method === 'POST') {
    const diff = await readJson(req);
    try {
      db = applyDiff(db, diff, { author: user.name, isAdmin: user.isAdmin, allowed: allowedFor(user) });
    } catch (e) {
      return send(res, 400, { error: e.message, db: visibleDb(user) });
    }
    saveDb(db);
    return send(res, 200, visibleDb(user));
  }
  if (path === '/api/reset' && req.method === 'POST') {
    if (!user.isAdmin) return send(res, 403, { error: 'Admins only' });
    db = seed();
    saveDb(db);
    return send(res, 200, db);
  }
  if (path === '/api/keys') {
    if (req.method === 'GET') return send(res, 200, sql.prepare('SELECT name, created FROM api_keys WHERE user_id = ? ORDER BY created').all(user.id));
    if (req.method === 'POST') {
      const { name } = await readJson(req);
      const key = `mzn_${randomBytes(24).toString('base64url')}`;
      sql.prepare('INSERT INTO api_keys (key_hash, user_id, name, created) VALUES (?, ?, ?, ?)').run(sha256(key), user.id, String(name || 'API key').slice(0, 60), Date.now());
      return send(res, 201, { key }); // shown once; only the hash is stored
    }
    if (req.method === 'DELETE') {
      const created = Number(new URL(req.url, 'http://x').searchParams.get('created'));
      sql.prepare('DELETE FROM api_keys WHERE user_id = ? AND created = ?').run(user.id, created);
      return send(res, 200, { ok: true });
    }
  }
  if (path === '/api/users') {
    if (!user.isAdmin) return send(res, 403, { error: 'Admins only' });
    if (req.method === 'GET') return send(res, 200, sql.prepare('SELECT id, login, name, is_admin AS isAdmin, apps FROM users ORDER BY id').all());
    if (req.method === 'POST') {
      try {
        createUser(await readJson(req));
      } catch (e) {
        return send(res, 400, { error: /UNIQUE/.test(e.message) ? 'Login already exists' : e.message });
      }
      return send(res, 201, { ok: true });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (path.startsWith('/api/')) await api(req, res, path);
    else await serveStatic(req, res);
  } catch (e) {
    console.error(`${req.method} ${path} failed:`, e);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => console.info(`Mizan listening on http://localhost:${PORT}`));

sql.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
