// Mizan server: auth + shared database + static frontend. Node 24 built-ins only.
//   npm run build && npm start        → http://localhost:8069
// Env: PORT, MIZAN_DB (sqlite path), MIZAN_ADMIN_PASSWORD (first start), MIZAN_SECURE_COOKIE=1 behind HTTPS.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '../src/seed.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { installCustomFields } from '../src/models/studio.js';
import { openStorage } from './storage.js';
import { handleApi, publicApply, publicBook, publicCart, publicOrder, publicOrderStatus, publicRegister, publicSite, publicSlots } from './api.js';
import { migrateAppointments } from '../src/models/appointments.js';
import { publicAnswer, publicAsk, publicBlogPost, publicBlogSite, publicForumThread, publicVote } from './blog.js';
import { smtpConfig } from './smtp.js';
import { livechatInfo, livechatMessage, livechatPoll, livechatRate, livechatStart } from './livechat.js';
import { sendDocument, sendMailing } from './mail.js';
import { deliver, deliverMailing, trackingResponse } from './mailtrack.js';
import { dueAbWinners, dueMailings, selectWinner, sendWinner } from '../src/models/mailing.js';
import { handleWebhook, MAX_WEBHOOK_BODY, readRaw, verifyWebhook, WEBHOOK_WRITE } from './whatsapp.js';
import { aiDraft, digitizeBill, ingestIot, integrationStatus, issueIotToken, quoteShipping, sendSmsCampaign, sendWhatsApp, syncMarketplace } from './integrations.js';
import { checkPagePassword, resolveUrl, robots, sitemap } from '../src/models/websiteplus.js';
import { search } from '../src/orm.js';
import { createPortal } from './portal.js';
import { createSigning, remindSigners, sendSignRequest } from './signing.js';

const ENV = process.env;
/** Server actions: endpoint → integration it needs, model it touches, extra models it logs to, admin-only flag, implementation. */
const ACTIONS = {
  '/api/ai/draft': { need: 'ai', model: (b) => b.model, run: (b, u) => aiDraft(db, u, b) },
  '/api/integrations/digitize': { need: 'ai', model: () => 'account.move', run: (b) => digitizeBill(db, b) },
  // Sending also logs a WhatsApp message, so the store may write that model on top of the user's own.
  '/api/integrations/whatsapp': { need: 'whatsapp', model: (b) => b.model, extra: ['whatsapp.message'], run: (b, u, store) => sendWhatsApp(ENV, store, u, b) },
  '/api/integrations/sms-campaign': { need: 'sms', model: () => 'sms.campaign', run: (b, u, store) => sendSmsCampaign(ENV, store, b) },
  '/api/integrations/shipping-rate': { need: 'shipping_api', model: () => 'sale.order', run: (b) => quoteShipping(ENV, db, b) },
  '/api/integrations/marketplace-sync': { need: 'marketplace', admin: true, model: () => 'marketplace.connector', run: (b) => syncMarketplace(db, b) },
  '/api/iot/token': { admin: true, model: () => 'iot.device', run: (b) => issueIotToken(db, b) },
  // E-signature: email each signer their private link (server/signing.js serves the link).
  '/api/sign/send': { need: 'smtp', model: () => 'sign.request', run: (b, u, store, baseUrl) => sendSignRequest(SMTP, db, b, baseUrl) },
  '/api/sign/remind': { need: 'smtp', model: () => 'sign.request', run: (b, u, store, baseUrl) => remindSigners(SMTP, db, b, baseUrl) },
};

const SMTP = smtpConfig();
import { modelsForApps } from '../src/models/index.js';
import { runScheduledJobs } from '../src/models/scheduler.js';

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

// ---- database: one row per record, incremental saves (see storage.js) ----
const storage = openStorage(sql);
let db = migrateAppointments(storage.load());
/** Persist and adopt a new database state; `full` rewrites everything (reset, first start). */
const commitDb = (next, { full = false } = {}) => { storage.save(full ? null : db, next); db = next; };
/**
 * Live db access for long-running work: get() is the current db, commit(next) applies what changed between the
 * db get() returned and `next` to whatever the db is now, so concurrent edits are never reverted.
 */
const storeFor = (opts) => {
  let base = db;
  return {
    get: () => { base = db; return db; },
    commit: (next) => { commitDb(applyDiff(db, diffDb(base, next), opts)); base = db; },
  };
};
if (!db) commitDb(seed(), { full: true });
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

// Sessions use opaque random tokens, not a signing secret. Persist a separate key in the existing kv store.
sql.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES ('website_cookie_secret', ?)").run(randomBytes(32).toString('hex'));
const PAGE_SECRET = sql.prepare("SELECT value FROM kv WHERE key = 'website_cookie_secret'").get().value;
const pageToken = (p) => createHmac('sha256', PAGE_SECRET).update(`${p.id}:${p.visibility_password}`).digest('hex');
const pageUnlocked = (req, p) => {
  const given = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`mizan_page_${p.id}=`))?.split('=')[1] ?? '';
  return /^[a-f0-9]{64}$/.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(pageToken(p)));
};
const pageAccess = (req) => (p) => p.visibility === 'password' ? pageUnlocked(req, p) : !!sessionUser(req);
const siteOf = (req) => ({ ...publicSite(db, pageAccess(req)), ...publicBlogSite(db), livechat: livechatInfo(db) });

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
const CHAT_MESSAGES_PER_WINDOW = 30;
const TRACKING_HITS_PER_WINDOW = 300;
const CART_PRICINGS_PER_WINDOW = 120;
const WHATSAPP_HOOKS_PER_WINDOW = 600;
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

async function serveStatic(req, res, status = 200, routeHash) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(DIST + sep) && file !== DIST) return send(res, 403, { error: 'Forbidden' });
  try {
    if (!(await stat(file)).isFile()) throw new Error('dir');
  } catch {
    file = join(DIST, 'index.html'); // SPA fallback
  }
  try {
    let body = await readFile(file);
    const headers = { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', ...SECURITY_HEADERS };
    if (extname(file) === '.html' && routeHash) {
      const script = `if (!location.hash) location.hash = ${JSON.stringify(routeHash).replace(/</g, '\\u003c')};`;
      body = body.toString().replace('</head>', `<script>${script}</script></head>`);
      headers['Content-Security-Policy'] += `; script-src 'self' 'sha256-${createHash('sha256').update(script).digest('base64')}'`;
      headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(status, headers);
    res.end(body);
  } catch {
    send(res, 404, { error: 'Run "npm run build" first' });
  }
}

// ---- routes ----
/** Public base URL for links in emails: MIZAN_PUBLIC_URL, else this request's host. */
const baseUrlOf = (req) => (process.env.MIZAN_PUBLIC_URL ?? `${SECURE ? 'https' : 'http'}://${req.headers.host ?? `localhost:${PORT}`}`).replace(/\/$/, '');
// No Host allow-list exists: crawler URLs are relative unless the operator configured MIZAN_PUBLIC_URL.
const websiteOrigin = () => {
  try { const url = new URL(process.env.MIZAN_PUBLIC_URL); return ['http:', 'https:'].includes(url.protocol) ? url.origin : ''; } catch { return ''; }
};
let lastBaseUrl = process.env.MIZAN_PUBLIC_URL ?? `http://localhost:${PORT}`;
let mailBaseKnown = false;

async function api(req, res, path) {
  const ip = clientIp(req);
  if (path.startsWith('/api/public/mail/') && ['GET', 'POST'].includes(req.method)) {
    if (recent(`track:${ip}`).length >= TRACKING_HITS_PER_WINDOW) return send(res, 429, { error: 'Too many requests' });
    recordFailure(`track:${ip}`);
    const out = trackingResponse(db, path, undefined, req.method);
    if (!out) return send(res, 404, { error: 'Not found' });
    if (out.db && out.db !== db) commitDb(applyDiff(db, diffDb(db, out.db), { author: 'Mailing tracker', isAdmin: false, allowed: new Set(['mailing.trace', 'mailing.mailing', 'mailing.contact', 'mail.blacklist']) }));
    res.writeHead(out.status, out.headers);
    return res.end(out.body);
  }
  // WhatsApp Cloud API webhook: verification token on GET, HMAC-signed raw body on POST; Meta retries on non-2xx.
  if (path === '/api/public/whatsapp/webhook' && ['GET', 'POST'].includes(req.method)) {
    if (recent(`whatsapp:${ip}`).length >= WHATSAPP_HOOKS_PER_WINDOW) return send(res, 429, { error: 'Too many requests' });
    recordFailure(`whatsapp:${ip}`);
    if (req.method === 'GET') {
      const out = verifyWebhook(ENV, new URL(req.url, 'http://x').searchParams);
      res.writeHead(out.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(out.body);
    }
    let raw;
    try { raw = await readRaw(req, MAX_WEBHOOK_BODY); } catch { return send(res, 413, { error: 'Request too large' }); }
    const out = handleWebhook(ENV, db, raw, req.headers['x-hub-signature-256']);
    if (out.db && out.db !== db) commitDb(applyDiff(db, diffDb(db, out.db), WEBHOOK_WRITE));
    return send(res, out.status, out.body);
  }
  if (path === '/api/public/site' && req.method === 'GET') return send(res, 200, siteOf(req));
  // Blog posts and forum threads: GET counts the visit; visitor posts wait for validation, votes count once per client.
  const blogRead = /^\/api\/public\/(blog|forum)\/(\d+)$/.exec(path);
  if (blogRead && req.method === 'GET') {
    const out = (blogRead[1] === 'blog' ? publicBlogPost : publicForumThread)(db, blogRead[2]);
    if (out.db) commitDb(out.db);
    return send(res, out.status, out.body);
  }
  const forumRoutes = { '/api/public/forum/ask': publicAsk, '/api/public/forum/answer': publicAnswer, '/api/public/forum/vote': publicVote };
  if (forumRoutes[path] && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    const limitKey = path.endsWith('/vote') ? `vote:${ip}` : `forum:${ip}`;
    if (tooMany(limitKey)) return send(res, 429, { error: 'Too many requests, try again later' });
    recordFailure(limitKey); // counts every post or vote: max 10 per client per 15 minutes
    const out = forumRoutes[path](db, await readJson(req), ip);
    if (out.db) commitDb(out.db);
    return send(res, out.status, out.body);
  }
  if (path === '/api/iot/ingest' && req.method === 'POST') {
    if (tooMany(`iot:${ip}`)) return send(res, 429, { error: 'Too many failed attempts' });
    const token = /^Bearer (iot_[\w-]{20,})$/.exec(req.headers.authorization ?? '')?.[1];
    const next = token && ingestIot(db, token, await readJson(req));
    if (!next) { recordFailure(`iot:${ip}`); return send(res, 401, { error: 'Unknown device token' }); }
    commitDb(applyDiff(db, diffDb(db, next), { author: 'IoT', isAdmin: false }));
    return send(res, 200, { ok: true });
  }
  if (path === '/api/public/apply' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`apply:${ip}`)) return send(res, 429, { error: 'Too many applications, try again later' });
    recordFailure(`apply:${ip}`);
    const out = publicApply(db, await readJson(req));
    if (out.db) commitDb(out.db);
    return send(res, out.status, out.body);
  }
  // Event registrations and appointment bookings: same CSRF header and per-client limit as job applications.
  const publicForms = { '/api/public/register': publicRegister, '/api/public/book': publicBook };
  if (publicForms[path] && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`form:${ip}`)) return send(res, 429, { error: 'Too many requests, try again later' });
    recordFailure(`form:${ip}`);
    const out = publicForms[path](db, await readJson(req));
    if (out.db) commitDb(out.db);
    return send(res, out.status, out.body);
  }
  // Live chat: starts count like public forms; messages, polls and ratings are limited on wrong tokens.
  if (path === '/api/public/livechat/start' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`chat:${ip}`)) return send(res, 429, { error: 'Too many requests, try again later' });
    recordFailure(`chat:${ip}`);
    const out = livechatStart(db, await readJson(req));
    if (out.db) commitDb(out.db);
    return send(res, out.status, out.body);
  }
  const chatRoutes = { 'POST /api/public/livechat/message': livechatMessage, 'POST /api/public/livechat/rate': livechatRate, 'GET /api/public/livechat/poll': livechatPoll };
  const chatRoute = chatRoutes[`${req.method} ${path}`];
  if (chatRoute) {
    if (req.method === 'POST' && req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`chatauth:${ip}`)) return send(res, 429, { error: 'Too many failed attempts' });
    const input = req.method === 'GET' ? new URL(req.url, 'http://x').searchParams : await readJson(req);
    if (path.endsWith('/message')) {
      const key = `chatmsg:${Number(input?.sessionId) || 0}`;
      if (recent(key).length >= CHAT_MESSAGES_PER_WINDOW) return send(res, 429, { error: 'You are sending messages too fast, please wait a moment' });
      recordFailure(key);
    }
    const out = chatRoute(db, input);
    if (out.denied) recordFailure(`chatauth:${ip}`);
    if (out.db) commitDb(out.db);
    return send(res, out.status, out.body);
  }
  if (path === '/api/public/order' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`order:${ip}`)) return send(res, 429, { error: 'Too many orders, try again later' });
    recordFailure(`order:${ip}`); // counts every order: max 10 per client per 15 minutes
    const out = publicOrder(db, await readJson(req));
    if (out.db) commitDb(out.db);
    return send(res, out.status, out.body);
  }
  // Cart prices are read-only (computed server-side); order status is limited on wrong tokens like live chat.
  if (path === '/api/public/cart' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (recent(`cart:${ip}`).length >= CART_PRICINGS_PER_WINDOW) return send(res, 429, { error: 'Too many requests, try again later' });
    recordFailure(`cart:${ip}`);
    const out = publicCart(db, await readJson(req));
    return send(res, out.status, out.body);
  }
  const slotsRoute = /^\/api\/public\/appointment\/(\d+)\/slots$/.exec(path);
  if (slotsRoute && req.method === 'GET') {
    if (recent(`slots:${ip}`).length >= CART_PRICINGS_PER_WINDOW) return send(res, 429, { error: 'Too many requests, try again later' });
    recordFailure(`slots:${ip}`);
    const out = publicSlots(db, slotsRoute[1], new URL(req.url, 'http://x').searchParams);
    return send(res, out.status, out.body);
  }
  if (path === '/api/public/order-status' && req.method === 'GET') {
    if (tooMany(`orderstatus:${ip}`)) return send(res, 429, { error: 'Too many failed attempts' });
    const out = publicOrderStatus(db, new URL(req.url, 'http://x').searchParams);
    if (out.denied) recordFailure(`orderstatus:${ip}`);
    return send(res, out.status, out.body);
  }
  if (path.startsWith('/api/v1/')) {
    // Bearer-token API: no cookies involved, so no CSRF exposure; rate-limit failed keys like logins.
    if (tooMany(`key:${ip}`)) return send(res, 429, { error: 'Too many attempts, try again later' });
    const keyUser = apiKeyUser(req);
    if (!keyUser) { recordFailure(`key:${ip}`); return send(res, 401, { error: 'Invalid or missing API key' }); }
    const body = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : null;
    const out = handleApi({ method: req.method, path, query: new URL(req.url, 'http://x').searchParams, body, db, user: keyUser, allowed: allowedFor(keyUser) });
    if (out.db) commitDb(out.db);
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

  if (path === '/api/session' && req.method === 'GET') return send(res, 200, { ...user, smtp: !!SMTP, integrations: { ...integrationStatus(), smtp: !!SMTP } });
  const action = ACTIONS[path];
  if (action && req.method === 'POST') {
    if (action.need && !{ ...integrationStatus(), smtp: !!SMTP }[action.need]) return send(res, 400, { error: `The ${action.need} integration is not configured` });
    if (action.admin && !user.isAdmin) return send(res, 403, { error: 'Admins only' });
    const body = await readJson(req);
    const model = action.model(body);
    const allowed = allowedFor(user);
    if (allowed && !allowed.has(model)) return send(res, 403, { error: `No access to ${model}` });
    try {
      const snapshot = db;
      const storeAllowed = allowed && action.extra ? new Set([...allowed, ...action.extra]) : allowed;
      const out = await action.run(body, user, storeFor({ author: user.name, isAdmin: user.isAdmin, allowed: storeAllowed }), baseUrlOf(req));
      // Changes made by integrations go through the same validation as client edits, applied on top of edits made meanwhile.
      if (out.db) commitDb(applyDiff(db, diffDb(snapshot, out.db), { author: user.name, isAdmin: user.isAdmin, allowed }));
      return send(res, 200, { ok: true, message: out.message, text: out.text });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if ((path === '/api/mail/document' || path === '/api/mail/mailing') && req.method === 'POST') {
    if (!SMTP) return send(res, 400, { error: 'Email is not configured (MIZAN_SMTP_HOST / MIZAN_SMTP_FROM)' });
    const body = await readJson(req);
    const model = path.endsWith('mailing') ? 'mailing.mailing' : String(body.model ?? '');
    const allowed = allowedFor(user);
    if (allowed && !allowed.has(model)) return send(res, 403, { error: `No access to ${model}` });
    try {
      lastBaseUrl = baseUrlOf(req);
      mailBaseKnown = true;
      const snapshot = db;
      const out = path.endsWith('mailing')
        ? await sendMailing(SMTP, storeFor({ author: user.name, isAdmin: user.isAdmin, allowed }), body, lastBaseUrl)
        : await sendDocument(SMTP, db, user, body);
      if (out.db) commitDb(applyDiff(db, diffDb(snapshot, out.db), { author: user.name, isAdmin: user.isAdmin, allowed }));
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
      commitDb(applyDiff(db, diff, { author: user.name, isAdmin: user.isAdmin, allowed: allowedFor(user) }));
    } catch (e) {
      return send(res, 400, { error: e.message, db: visibleDb(user) });
    }
    return send(res, 200, visibleDb(user));
  }
  if (path === '/api/reset' && req.method === 'POST') {
    if (!user.isAdmin) return send(res, 403, { error: 'Admins only' });
    commitDb(seed(), { full: true });
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

async function website(req, res, path) {
  const url = new URL(req.url, 'http://x');
  const user = sessionUser(req);
  const back = url.searchParams.get('return');
  if (req.method === 'GET' && path === '/' && user && /^\/(?!\/)/.test(back ?? '') && !/[\u0000-\u0020\u007f\\]/.test(back)) {
    res.writeHead(302, { Location: back, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (req.method === 'GET' && ['/sitemap.xml', '/robots.txt'].includes(path)) {
    const xml = path === '/sitemap.xml';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': `${xml ? 'application/xml' : 'text/plain'}; charset=utf-8`, 'Cache-Control': 'public, max-age=300' });
    return res.end((xml ? sitemap : robots)(db, websiteOrigin()));
  }
  if (!['GET', 'POST'].includes(req.method) || path.startsWith('/assets/') || extname(path)) return serveStatic(req, res);
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return send(res, 400, { error: 'Invalid URL' }); }
  const access = resolveUrl(db, decoded);
  const page = search(db, 'website.page').find((p) => p.slug.replace(/^\/+|\/+$/g, '') === decoded.replace(/^\/+|\/+$/g, ''));
  if (access?.redirect && req.method === 'GET') {
    res.writeHead(access.redirect.status, { Location: access.redirect.to, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (access?.needsPassword && !pageUnlocked(req, page)) {
    let status = 200;
    if (req.method === 'POST') {
      const key = `pagepassword:${clientIp(req)}`;
      if (tooMany(key)) return send(res, 429, { error: 'Too many attempts, try again later' });
      recordFailure(key);
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Cross-site request refused' });
      if (!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) return send(res, 415, { error: 'Submit the password form' });
      let raw;
      try { raw = await readRaw(req, 4096); } catch { return send(res, 413, { error: 'Request too large' }); }
      if (checkPagePassword(page, new URLSearchParams(raw.toString('utf8')).get('password'))) {
        res.writeHead(303, { Location: path, 'Cache-Control': 'no-store', 'Set-Cookie': `mizan_page_${page.id}=${pageToken(page)}; HttpOnly; SameSite=Lax; Path=${/^[\w\-./%~]*$/.test(path) ? path : '/'}; Max-Age=1209600${SECURE ? '; Secure' : ''}` });
        return res.end();
      }
      status = 403;
    }
    const action = path.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Page password</title></head><body><main><h1>Page password</h1>${status === 403 ? '<p role="alert">Wrong password</p>' : ''}<form method="post" action="${action}"><label>Password <input type="password" name="password" autocomplete="current-password" required maxlength="4000"></label><button type="submit">Continue</button></form></main></body></html>`);
  }
  if (access?.needsLogin && !user) {
    res.writeHead(302, { Location: `/?return=${encodeURIComponent(path + url.search)}#/`, 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (req.method === 'POST') return send(res, 405, { error: 'Method not allowed' });
  if (url.searchParams.has('website_data')) return send(res, access ? 200 : 404, siteOf(req));
  const builtIn = path === '/' || /^\/(shop|blog|forum)(\/|$)/.test(path);
  const hash = user ? '#/website/site' : /^\/(shop|blog|forum)(\/|$)/.test(path) ? `#/shop/${path.replace(/^\/(shop\/?)?/, '')}` : `#/shop/page/${encodeURIComponent(decoded.replace(/^\/+|\/+$/g, ''))}`;
  return serveStatic(req, res, access || builtIn ? 200 : 404, path === '/' ? undefined : hash);
}

const portal = createPortal({ sql, getDb: () => db, commitDb, sessionUser, allowedFor, clientIp, tooMany, recordFailure, readRaw, securityHeaders: SECURITY_HEADERS });
const signing = createSigning({ getDb: () => db, commitDb, clientIp, tooMany, recordFailure, readRaw, securityHeaders: SECURITY_HEADERS });

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (await portal.handle(req, res)) return;
    if (await signing(req, res)) return;
    if (path.startsWith('/api/')) await api(req, res, path);
    else await website(req, res, path);
  } catch (e) {
    console.error(`${req.method} ${path} failed:`, e);
    if (!res.headersSent) send(res, 500, { error: 'Server error' });
  }
}).listen(PORT, () => console.info(`Mizan listening on http://localhost:${server.address().port}`));

// Scheduled actions (recurring invoices, accruals): at start, then hourly; saved only when something changed.
const JOB_INTERVAL_MS = 60 * 60 * 1000;
const runJobs = () => {
  try {
    const next = runScheduledJobs(db);
    if (next !== db) commitDb(applyDiff(db, diffDb(db, next), { author: 'Scheduler' }));
  } catch (e) {
    console.error('Scheduled job failed:', e.message);
  }
};
runJobs();
setInterval(runJobs, JOB_INTERVAL_MS).unref();

// Scheduled mailings and A/B test winners go out by email (only when SMTP is configured).
const MAIL_JOB_INTERVAL_MS = 10 * 60 * 1000;
// Links in scheduled emails need the public address; without MIZAN_PUBLIC_URL they wait for a manual send to learn it.
const runMailJobs = async () => {
  if (!SMTP || (!process.env.MIZAN_PUBLIC_URL && !mailBaseKnown)) return;
  const at = new Date().toISOString().slice(0, 10);
  const jobs = [
    ...dueMailings(db, at).map((m) => (store) => deliverMailing(SMTP, store, m.id, lastBaseUrl)),
    ...dueAbWinners(db, at).map((key) => (store) => {
      const winner = selectWinner(store.get(), key);
      return winner ? deliver(SMTP, store, (x, opts) => sendWinner(x, winner.id, opts), lastBaseUrl) : null;
    }),
  ];
  for (const job of jobs) {
    try {
      await job(storeFor({ author: 'Scheduler' }));
    } catch (e) {
      console.error('Scheduled mailing failed:', e.message);
    }
  }
};
runMailJobs();
setInterval(runMailJobs, MAIL_JOB_INTERVAL_MS).unref();

sql.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
