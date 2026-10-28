// Mizan server: auth + shared database + static frontend. Node 24 built-ins only.
//   npm run build && npm start        → http://localhost:8069
// Env: PORT, MIZAN_DB (sqlite path), MIZAN_ADMIN_PASSWORD (first start), MIZAN_SECURE_COOKIE=1 behind HTTPS,
// MIZAN_ALLOW_RESET=1 to allow resetting to demo data when NODE_ENV=production.
// MIZAN_FORCE_TAKEOVER=1 to take the database over from a crashed server.
import { createServer } from 'node:http';
import { constants as zlibConstants, gzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed } from '../src/seed.js';
import { applyDiff, assignIds, diffDb, repairSeq } from '../src/sync.js';
import { runOperation } from '../src/operations.js';
import { backupSummary, checkBackup } from '../src/backup.js';
import { auditEntries } from '../src/audit.js';
import { installCustomFields } from '../src/models/studio.js';
import { claimWriter, loadRepaired, openStorage } from './storage.js';
import { runPosting } from './posting.js';
import { openBlobs, RASTER, referencesBlob } from './blobs.js';
import { handleApi, publicApply, publicBook, publicCart, publicOrder, publicOrderStatus, publicRegister, publicSite, publicSlots } from './api.js';
import { migrate } from '../src/migrations.js';
import { createVisitTracker, visitKey, publicAnswer, publicAsk, publicBlogPost, publicBlogSite, publicForumThread, publicVote } from './blog.js';
import { smtpConfig } from './smtp.js';
import { livechatInfo, livechatMessage, livechatPoll, livechatRate, livechatStart } from './livechat.js';
import { recordSent, sendDocument, sendMailing } from './mail.js';
import { deliver, deliverMailing, resumeQueued, trackingResponse } from './mailtrack.js';
import { dueAbWinners, dueMailings, selectWinner, sendWinner } from '../src/models/mailing.js';
import { handleWebhook, MAX_WEBHOOK_BODY, readRaw, verifyWebhook, WEBHOOK_WRITE } from './whatsapp.js';
import { aiDraft, digitizeBill, ingestIot, integrationStatus, issueIotToken, quoteShipping, sendSmsCampaign, sendWhatsApp, syncMarketplace } from './integrations.js';
import { checkPagePassword, resolveUrl, robots, sitemap } from '../src/models/websiteplus.js';
import { read, search } from '../src/orm.js';
import { countProduct } from '../src/models/valuation.js';
import { createPortal } from './portal.js';
import { createSigning, publicOrigin, remindSigners, sendSignRequest } from './signing.js';

const ENV = process.env;
/** Server actions: endpoint → integration it needs, model it touches, extra models it logs to, admin-only flag, implementation. */
const ACTIONS = {
  '/api/ai/draft': { need: 'ai', model: (b) => b.model, run: (b, u, _store, view) => aiDraft(view, u, b) },
  '/api/integrations/digitize': { need: 'ai', model: () => 'account.move', run: (b, _u, _store, view) => digitizeBill(view, b) },
  // Sending also logs a WhatsApp message, so the store may write that model on top of the user's own.
  '/api/integrations/whatsapp': { need: 'whatsapp', model: (b) => b.model, extra: ['whatsapp.message'], run: (b, u, store) => sendWhatsApp(ENV, store, u, b) },
  '/api/integrations/sms-campaign': { need: 'sms', model: () => 'sms.campaign', run: (b, u, store) => sendSmsCampaign(ENV, store, b) },
  '/api/integrations/shipping-rate': { need: 'shipping_api', model: () => 'sale.order', run: (b, _u, _store, view) => quoteShipping(ENV, view, b) },
  '/api/integrations/marketplace-sync': { need: 'marketplace', admin: true, model: () => 'marketplace.connector', run: (b, _u, _store, view) => syncMarketplace(view, b) },
  '/api/iot/token': { admin: true, model: () => 'iot.device', run: (b, _u, _store, view) => issueIotToken(view, b) },
  '/api/barcode/count': { model: () => 'product', extra: ['stock.inventory.count', 'stock.valuation.layer', 'account.move'], run: (b, _u, _store, view) => ({ db: countProduct(view, { productId: Number(b.productId), counted: Number(b.counted), observed: b.observed, company: b.company }) }) },
  // E-signature: email each signer their private link (server/signing.js serves the link).
  // Signer links carry private tokens, so they are only built on the configured public address, never from the request's Host header.
  '/api/sign/send': { need: 'smtp', model: () => 'sign.request', run: (b, u, store) => sendSignRequest(SMTP, store, b, publicOrigin()) },
  '/api/sign/remind': { need: 'smtp', model: () => 'sign.request', run: (b, u, store) => remindSigners(SMTP, store, b, publicOrigin()) },
};

const SMTP = smtpConfig();
import { menuModelsForApps, modelsForApps, redactForApps, writableModelsForApps, readOnlyForApps } from '../src/models/index.js';
import { runScheduledJobs } from '../src/models/scheduler.js';
import { restrictRecords, setCompanies, visibleTo } from '../src/models/company.js';
import { scheduleSnapshots } from './backup.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Built client; MIZAN_DIST points elsewhere (tests use a small fixture so they do not depend on a prior build).
const DIST = resolve(process.env.MIZAN_DIST || join(ROOT, 'dist'));
const PORT = Number(process.env.PORT ?? 8069);
const SESSION_DAYS = 14;
const MAX_BODY = 5 * 1024 * 1024;
const MAX_BACKUP = 200 * 1024 * 1024; // matches the whole-db size cap in src/sync.js
const COOKIE = 'mizan_session';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const IDEMPOTENCY_KEY_MAX = 200;

const DB_PATH = process.env.MIZAN_DB ?? join(ROOT, 'mizan.sqlite');
const sql = new DatabaseSync(DB_PATH);
// Wiping everything back to demo data is off unless MIZAN_ALLOW_RESET=1, or NODE_ENV=development (and not MIZAN_ALLOW_RESET=0).
const RESET_ALLOWED = process.env.MIZAN_ALLOW_RESET === '1' || (process.env.NODE_ENV === 'development' && process.env.MIZAN_ALLOW_RESET !== '0');
sql.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    salt TEXT NOT NULL, hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, apps TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS idempotency (user_id INTEGER NOT NULL, key TEXT NOT NULL, model TEXT NOT NULL, record_id INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (user_id, key));
  CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, res_id INTEGER NOT NULL, action TEXT NOT NULL, changes TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS audit_log_record ON audit_log (model, res_id);
`);

try { sql.exec('ALTER TABLE users ADD COLUMN apps TEXT'); } catch { /* column already exists */ }
// companies: the company ids a user may work in (null = all); selection: their own company switcher state (JSON).
try { sql.exec('ALTER TABLE users ADD COLUMN companies TEXT'); } catch { /* column already exists */ }
try { sql.exec('ALTER TABLE users ADD COLUMN selection TEXT'); } catch { /* column already exists */ }

/** Comma-separated app ids a user may open; null/empty = all apps. */
const parseApps = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter((x) => /^[a-z]+$/.test(x)) : null);
/** Comma-separated company ids a user may work in; null/empty = all companies. */
const parseCompanies = (v) => {
  const parts = String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  const ids = [...new Set(parts.map(Number))];
  // A stored grant that cannot be read must not turn into "every company": it grants none.
  return ids.every((n) => Number.isInteger(n) && n > 0) ? ids : [];
};
const userOf = (row) => ({
  id: row.id, login: row.login, name: row.name, isAdmin: !!row.is_admin, apps: parseApps(row.apps),
  companies: row.is_admin ? null : parseCompanies(row.companies), selection: row.selection ?? null,
});

// ---- database: one row per record, incremental saves (see storage.js) ----
let writer;
try {
  writer = claimWriter(sql, { force: process.env.MIZAN_FORCE_TAKEOVER === '1' });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
// A competing process may hold the write lock for a moment: wait for it instead of failing, and never let a failed renewal kill the timer.
sql.exec('PRAGMA busy_timeout = 5000');
setInterval(() => { try { writer.renew(); } catch (e) { console.error(`Lease renewal failed, will retry: ${e.message}`); } }, 10 * 1000).unref();
process.on('exit', () => { try { writer.release(); } catch { /* database already closed */ } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
// IPC lets Windows test hosts request a normal exit (TerminateProcess skips exit handlers).
process.on('message', (message) => { if (message === 'shutdown') process.exit(0); });
/** Stop (and refuse the write) when another server took over this database. */
const ownLease = () => {
  try {
    writer.assert();
  } catch (e) {
    console.error(e.message);
    setImmediate(() => process.exit(1));
    throw e;
  }
};
/** A direct SQLite write (sessions, users, API keys) only runs while this server still holds the lease. */
const writeSql = (text, ...args) => { ownLease(); return sql.prepare(text).run(...args); };
const storage = openStorage(sql, { beforeWrite: ownLease });
const blobs = openBlobs(sql, { beforeWrite: ownLease });
let db = loadRepaired(storage, (loaded) => repairSeq(migrate(loaded)));
{
  const moved = blobs.externalize(db); // Migrate legacy inline uploads after schema/sequence repair.
  if (moved !== db) { storage.save(db, moved); db = moved; }
}
/** Persist and adopt a new database state; `full` rewrites everything (reset, first start). */
let revision = 0;
const startedAt = Date.now().toString(36);
const logChange = sql.prepare('INSERT INTO audit_log (at, actor, model, res_id, action, changes) VALUES (?, ?, ?, ?, ?, ?)');
/**
 * Store `next` and log, with server time and who did it, every record it creates, changes or deletes. The log is
 * append-only: nothing in the app updates or deletes its rows. A full replace (restore, reset) is logged as one row.
 */
const commitDb = (raw, { full = false, actor = 'system', action = 'replace', audit = true } = {}) => {
  const next = blobs.externalize(raw);
  const at = new Date().toISOString();
  const entries = !audit ? [] : full ? [{ model: '*', res_id: 0, action, changes: {} }] : auditEntries(db, next);
  // The log rows and the data are written in one transaction: a failed save leaves neither behind.
  storage.save(full ? null : db, next, () => { for (const e of entries) logChange.run(at, actor, e.model, e.res_id, e.action, JSON.stringify(e.changes)); });
  db = next;
  revision++;
};
/** Log an account-administration step (never a password, hash or key) in the same transaction as the step itself. */
const withAudit = (actor, model, resId, action, changes, step) => {
  sql.exec('BEGIN IMMEDIATE');
  try {
    ownLease();
    const out = step();
    logChange.run(new Date().toISOString(), actor, model, resId ?? 0, action, JSON.stringify(changes));
    sql.exec('COMMIT');
    return out;
  } catch (e) {
    sql.exec('ROLLBACK');
    throw e;
  }
};
/** Changes whenever the whole database is replaced (restore, reset): work started before cannot be applied after. */
let epoch = Date.now();
const RESTORED = 'The data was restored while this was running; nothing was saved, reload and try again';
const sameEpoch = (at) => { if (at !== epoch) throw new Error(RESTORED); };
const visitors = createVisitTracker();
/**
 * Live db access for long-running work: get() is the current db, commit(next) applies what changed between the
 * db get() returned and `next` to whatever the db is now, so concurrent edits are never reverted.
 */
const storeFor = (opts, actor = opts.author, view = (d) => d) => {
  let base = view(db);
  let at = epoch;
  return {
    get: () => { base = view(db); at = epoch; return base; },
    commit: (next) => { sameEpoch(at); commitDb(applyDiff(db, diffDb(base, next), opts), { actor }); base = view(db); },
    check: ownLease,
  };
};
if (!db) commitDb(seed(), { full: true, action: 'seed' });
installCustomFields(db.settings?.customFields);

// ---- users & sessions ----
const hashPassword = (password, salt = randomBytes(16).toString('hex')) => ({ salt, hash: scryptSync(password, salt, 64).toString('hex') });
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function createUser({ login, name, password, isAdmin = false, apps = '', companies = '' }, actor = 'system') {
  if (!/^[\w.@-]{3,64}$/.test(login ?? '')) throw new Error('Login must be 3-64 letters, digits or . @ - _');
  if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters');
  const { salt, hash } = hashPassword(password);
  const allowed = parseApps(apps);
  const granted = parseCompanies(companies);
  if (granted && (!granted.length || granted.some((id) => !(db.records['res.company'] ?? []).some((c) => c.id === id)))) throw new Error('Allowed companies: select existing companies');
  const apps_ = allowed?.length ? allowed.join(',') : null;
  const row = { login, name: String(name || login).slice(0, 100), is_admin: isAdmin ? 1 : 0, apps: apps_, companies: granted?.join(',') ?? null };
  const made = withAudit(actor, 'auth.user', 0, 'create', Object.fromEntries(Object.entries(row).map(([k, v]) => [k, [null, v]])),
    () => writeSql('INSERT INTO users (login, name, salt, hash, is_admin, apps, companies) VALUES (?, ?, ?, ?, ?, ?, ?)', login, row.name, salt, hash, row.is_admin, apps_, row.companies));
  return made;
}

if (!sql.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
  const password = process.env.MIZAN_ADMIN_PASSWORD ?? randomBytes(9).toString('base64url');
  createUser({ login: 'admin', name: 'Admin', password, isAdmin: true });
  if (process.env.MIZAN_ADMIN_PASSWORD) console.info('Created user "admin" with the password from MIZAN_ADMIN_PASSWORD.');
  else {
    // Logs are often shipped elsewhere; keep the generated secret in an owner-only file instead.
    const file = `${DB_PATH}.admin-password`;
    writeFileSync(file, `${password}
`, { mode: 0o600 });
    console.info(`Created user "admin". Its generated password is in ${file}; delete that file after signing in.`);
  }
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
  const row = sql.prepare('SELECT u.*, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(sha256(token));
  if (!row || row.expires < Date.now()) return null;
  return userOf(row);
}

/** User owning a "Bearer mzn_…" API key, or null. Keys are stored only as SHA-256 hashes. */
function apiKeyUser(req) {
  const key = /^Bearer (mzn_[\w-]{20,})$/.exec(req.headers.authorization ?? '')?.[1];
  if (!key) return null;
  const row = sql.prepare('SELECT u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?').get(sha256(key));
  return row ? userOf(row) : null;
}

// Secure cookies by default in production; MIZAN_SECURE_COOKIE=0 to serve plain HTTP (e.g. LAN), =1 to force.
const SECURE = process.env.MIZAN_SECURE_COOKIE ? process.env.MIZAN_SECURE_COOKIE === '1' : process.env.NODE_ENV === 'production';
const cookie = (value, maxAge) => `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`;

// Sessions use opaque random tokens, not a signing secret. Persist a separate key in the existing kv store.
writeSql("INSERT OR IGNORE INTO kv (key, value) VALUES ('website_cookie_secret', ?)", randomBytes(32).toString('hex'));
const PAGE_SECRET = sql.prepare("SELECT value FROM kv WHERE key = 'website_cookie_secret'").get().value;
const pageToken = (p) => createHmac('sha256', PAGE_SECRET).update(`${p.id}:${p.visibility_password}`).digest('hex');
const pageUnlocked = (req, p) => {
  const given = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`mizan_page_${p.id}=`))?.split('=')[1] ?? '';
  return /^[a-f0-9]{64}$/.test(given) && timingSafeEqual(Buffer.from(given), Buffer.from(pageToken(p)));
};
const pageAccess = (req) => (p) => p.visibility === 'password' ? pageUnlocked(req, p) : !!sessionUser(req);
const siteOf = (req) => ({ ...publicSite(db, pageAccess(req)), ...publicBlogSite(db), livechat: livechatInfo(db) });

const readOnlyFor = (u) => (u.isAdmin || !u.apps?.length ? null : readOnlyForApps(u.apps));
/** Models a session/API user may change (null = everything). */
const allowedFor = (u) => (u.isAdmin || !u.apps?.length ? null : writableModelsForApps(u.apps));
/** Models on a user's own app menus (null = everything): who may share portal links or run booking operations, never via a relation. */
const menuModelsFor = (u) => (u.isAdmin || !u.apps?.length ? null : menuModelsForApps(u.apps));
/** Models a session/API user may read (null = everything). */
const readableFor = (u) => (u.isAdmin || !u.apps?.length ? null : modelsForApps(u.apps));
/** Company ids a user may work in (null = all). */
const companiesFor = (u) => (u.companies ? new Set(u.companies) : null);
/**
 * The user's own company switcher state, kept to the companies they may use: each user has their own current and
 * selected companies instead of one setting shared by everyone.
 */
const selectionFor = (u) => {
  const granted = companiesFor(u);
  const usable = (db.records['res.company'] ?? []).filter((c) => c.active !== false && visibleTo(granted, 'res.company', c)).map((c) => c.id);
  let saved = null;
  try { saved = JSON.parse(u.selection ?? 'null'); } catch { /* ignore a damaged selection */ }
  const allowed = (saved?.allowed ?? db.settings.allowed_company_ids ?? []).filter((id) => usable.includes(id));
  const current = [saved?.current, db.settings.current_company_id].find((id) => allowed.includes(id)) ?? allowed[0] ?? usable[0] ?? 1;
  return { current_company_id: current, allowed_company_ids: allowed.length ? allowed : [current] };
};
/** Validate a user's company switcher state without storing it; throws when it names a company they may not use. */
const checkSelection = (u, { current_company_id: current, allowed_company_ids: allowed }) => {
  const granted = companiesFor(u);
  if (granted && (!granted.has(current) || !Array.isArray(allowed) || !allowed.every((id) => granted.has(id)))) throw new Error('No access to that company');
  setCompanies(db, { current, allowed });
  return JSON.stringify({ current, allowed: [...new Set(allowed)] });
};
const saveSelection = (u, selection) => {
  writeSql('UPDATE users SET selection = ? WHERE id = ?', selection, u.id);
  u.selection = selection;
};
/** Records a user may read: their apps' models, only their companies' records, and their own company selection. */
const visibleDb = (u, { models = true } = {}) => {
  const allowed = models ? readableFor(u) : null;
  const companies = companiesFor(u);
  const { records: inCompanies, hidden } = restrictRecords(db, companies);
  const records = allowed ? Object.fromEntries(Object.entries(inCompanies).filter(([model]) => allowed.has(model))) : inCompanies;
  const selection = selectionFor(u);
  // A user limited to some companies gets those companies' identity, not the group-wide VAT number and bank account.
  const own = companies && (db.records['res.company'] ?? []).find((c) => c.id === selection.current_company_id);
  const identity = !companies ? {} : {
    company: own?.name ?? db.settings.company, company_vat: own?.vat ?? '', company_iban: '',
    ...(Array.isArray(db.settings.companies) ? { companies: db.settings.companies.filter((c) => companies.has(c.id)) } : {}),
  };
  const visible = {
    ...db,
    records,
    messages: db.messages.filter((m) => (!allowed || allowed.has(m.model)) && !hidden.has(`${m.model}:${m.res_id}`)),
    settings: { ...db.settings, ...identity, ...selection },
  };
  return models && allowed ? redactForApps(visible, u.apps) : visible;
};
/** The database as a user may read it for server-side work: other companies' records are left out. */
const scopeFor = (u) => (companiesFor(u) ? visibleDb(u, { models: false }) : db);
/** Write options for a user: who they are, what they may change, and in which companies. */
const writeOptions = (u, allowed = allowedFor(u)) => ({ author: u.name, isAdmin: u.isAdmin, login: u.login, allowed, readOnly: readOnlyFor(u), companies: companiesFor(u) });

// ---- rate limit: 10 failures per key (ip+login, or ip for API keys) per 15 minutes ----
// Stored in SQLite so a restart does not reset an attacker's counter.
sql.exec('CREATE TABLE IF NOT EXISTS rate_events (key TEXT NOT NULL, at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS rate_events_key_at ON rate_events (key, at);');
const WINDOW = 15 * 60 * 1000;
const CHAT_MESSAGES_PER_WINDOW = 30;
const TRACKING_HITS_PER_WINDOW = 300;
const CART_PRICINGS_PER_WINDOW = 120;
const WHATSAPP_HOOKS_PER_WINDOW = 600;
const ACCOUNT_FAILURES_PER_WINDOW = 50;
const hits = (k) => sql.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND at > ?').get(k, Date.now() - WINDOW).n;
const tooMany = (k) => hits(k) >= 10;
const recordFailure = (k) => writeSql('INSERT INTO rate_events (key, at) VALUES (?, ?)', k, Date.now());
setInterval(() => writeSql('DELETE FROM rate_events WHERE at <= ?', Date.now() - WINDOW), WINDOW).unref();
// Behind a reverse proxy set MIZAN_TRUST_PROXY=1 so limits apply per client, not per proxy.
const clientIp = (req) => (process.env.MIZAN_TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || '?';

// ---- http helpers ----
// Large JSON answers (the synced database) are gzipped for clients that accept it; level 1 keeps CPU low.
const GZIP_MIN = 8 * 1024;
/** A stored file: raster images inline, anything else as a download so it never renders as a page on this origin. */
function sendBlob(res, row, publicImage) {
  if (!row || (publicImage && !RASTER.test(row.type))) return send(res, 404, { error: 'Not found' });
  const inline = RASTER.test(row.type);
  res.writeHead(200, {
    ...SECURITY_HEADERS, 'Content-Type': inline ? row.type : 'application/octet-stream',
    'Cache-Control': 'private, max-age=31536000, immutable', ...(inline ? {} : { 'Content-Disposition': 'attachment' }),
  });
  res.end(Buffer.from(row.data));
}

const send = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  const head = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...headers };
  if (!res.acceptsGzip || text.length < GZIP_MIN) {
    res.writeHead(status, head);
    return res.end(text);
  }
  gzip(text, { level: zlibConstants.Z_BEST_SPEED }, (err, zipped) => {
    if (err) { res.writeHead(status, head); return res.end(text); }
    res.writeHead(status, { ...head, 'Content-Encoding': 'gzip' });
    res.end(zipped);
  });
};

function readJson(req, limit = MAX_BODY) {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { fail(new Error('Request too large')); req.destroy(); } else chunks.push(c);
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
    if (hits(`track:${ip}`) >= TRACKING_HITS_PER_WINDOW) return send(res, 429, { error: 'Too many requests' });
    recordFailure(`track:${ip}`);
    const out = trackingResponse(db, path, undefined, req.method);
    if (!out) return send(res, 404, { error: 'Not found' });
    if (out.db && out.db !== db) commitDb(applyDiff(db, diffDb(db, out.db), { author: 'Mailing tracker', isAdmin: false, allowed: new Set(['mailing.trace', 'mailing.mailing', 'mailing.contact', 'mail.blacklist']) }), { actor: 'public' });
    res.writeHead(out.status, out.headers);
    return res.end(out.body);
  }
  // WhatsApp Cloud API webhook: verification token on GET, HMAC-signed raw body on POST; Meta retries on non-2xx.
  if (path === '/api/public/whatsapp/webhook' && ['GET', 'POST'].includes(req.method)) {
    if (hits(`whatsapp:${ip}`) >= WHATSAPP_HOOKS_PER_WINDOW) return send(res, 429, { error: 'Too many requests' });
    recordFailure(`whatsapp:${ip}`);
    if (req.method === 'GET') {
      const out = verifyWebhook(ENV, new URL(req.url, 'http://x').searchParams);
      res.writeHead(out.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(out.body);
    }
    let raw;
    try { raw = await readRaw(req, MAX_WEBHOOK_BODY); } catch { return send(res, 413, { error: 'Request too large' }); }
    const out = handleWebhook(ENV, db, raw, req.headers['x-hub-signature-256']);
    if (out.db && out.db !== db) commitDb(applyDiff(db, diffDb(db, out.db), WEBHOOK_WRITE), { actor: 'whatsapp' });
    return send(res, out.status, out.body);
  }
  if (path === '/api/public/site' && req.method === 'GET') return send(res, 200, siteOf(req));
  // Website images by their random id (the id is only shown where the image is shown).
  const imagePath = /^\/api\/public\/image\/([0-9a-f]{32})$/.exec(path);
  if (imagePath && req.method === 'GET') return sendBlob(res, blobs.get(imagePath[1]), true);
  // Blog posts and forum threads: GET counts the visit; visitor posts wait for validation, votes count once per client.
  const blogRead = /^\/api\/public\/(blog|forum)\/(\d+)$/.exec(path);
  if (blogRead && req.method === 'GET') {
    // A visitor counts once per post per hour, so reloads and bots cannot turn reads into a stream of saves.
    // The key uses the numeric id (so /1 and /01 are one post) and is remembered only once the visit is saved.
    const key = visitKey(ip, blogRead[1], blogRead[2]);
    const read = blogRead[1] === 'blog' ? publicBlogPost : publicForumThread;
    const out = read(db, blogRead[2], { count: !visitors.seen(key) });
    if (out.db) { commitDb(out.db, { actor: 'public', audit: false }); visitors.mark(key); }
    return send(res, out.status, out.body);
  }
  const forumRoutes = { '/api/public/forum/ask': publicAsk, '/api/public/forum/answer': publicAnswer, '/api/public/forum/vote': publicVote };
  if (forumRoutes[path] && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    const limitKey = path.endsWith('/vote') ? `vote:${ip}` : `forum:${ip}`;
    if (tooMany(limitKey)) return send(res, 429, { error: 'Too many requests, try again later' });
    recordFailure(limitKey); // counts every post or vote: max 10 per client per 15 minutes
    const body = await readJson(req);
    const out = forumRoutes[path](db, body, ip);
    if (out.db) commitDb(out.db, { actor: 'public' });
    return send(res, out.status, out.body);
  }
  if (path === '/api/iot/ingest' && req.method === 'POST') {
    if (tooMany(`iot:${ip}`)) return send(res, 429, { error: 'Too many failed attempts' });
    const token = /^Bearer (iot_[\w-]{20,})$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) { recordFailure(`iot:${ip}`); return send(res, 401, { error: 'Unknown device token' }); }
    const body = await readJson(req).catch(() => null);
    if (!body) { recordFailure(`iot:${ip}`); return send(res, 400, { error: 'Invalid JSON' }); }
    const next = ingestIot(db, token, body);
    if (!next) { recordFailure(`iot:${ip}`); return send(res, 401, { error: 'Unknown device token' }); }
    commitDb(applyDiff(db, diffDb(db, next), { author: 'IoT', isAdmin: false }), { actor: 'iot' });
    return send(res, 200, { ok: true });
  }
  if (path === '/api/public/apply' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`apply:${ip}`)) return send(res, 429, { error: 'Too many applications, try again later' });
    recordFailure(`apply:${ip}`);
    const body = await readJson(req);
    const out = publicApply(db, body);
    if (out.db) commitDb(out.db, { actor: 'public' });
    return send(res, out.status, out.body);
  }
  // Event registrations and appointment bookings: same CSRF header and per-client limit as job applications.
  const publicForms = { '/api/public/register': publicRegister, '/api/public/book': publicBook };
  if (publicForms[path] && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`form:${ip}`)) return send(res, 429, { error: 'Too many requests, try again later' });
    recordFailure(`form:${ip}`);
    const body = await readJson(req);
    const out = publicForms[path](db, body);
    if (out.db) commitDb(out.db, { actor: 'public' });
    return send(res, out.status, out.body);
  }
  // Live chat: starts count like public forms; messages, polls and ratings are limited on wrong tokens.
  if (path === '/api/public/livechat/start' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`chat:${ip}`)) return send(res, 429, { error: 'Too many requests, try again later' });
    recordFailure(`chat:${ip}`);
    const body = await readJson(req);
    const out = livechatStart(db, body);
    if (out.db) commitDb(out.db, { actor: 'public' });
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
      if (hits(key) >= CHAT_MESSAGES_PER_WINDOW) return send(res, 429, { error: 'You are sending messages too fast, please wait a moment' });
      recordFailure(key);
    }
    const out = chatRoute(db, input);
    if (out.denied) recordFailure(`chatauth:${ip}`);
    if (out.db) commitDb(out.db, { actor: 'public' });
    return send(res, out.status, out.body);
  }
  if (path === '/api/public/order' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (tooMany(`order:${ip}`)) return send(res, 429, { error: 'Too many orders, try again later' });
    recordFailure(`order:${ip}`); // counts every order: max 10 per client per 15 minutes
    const body = await readJson(req);
    const out = publicOrder(db, body);
    if (out.db) commitDb(out.db, { actor: 'public' });
    return send(res, out.status, out.body);
  }
  // Cart prices are read-only (computed server-side); order status is limited on wrong tokens like live chat.
  if (path === '/api/public/cart' && req.method === 'POST') {
    if (req.headers['x-requested-with'] !== 'mizan') return send(res, 403, { error: 'Missing CSRF header' });
    if (hits(`cart:${ip}`) >= CART_PRICINGS_PER_WINDOW) return send(res, 429, { error: 'Too many requests, try again later' });
    recordFailure(`cart:${ip}`);
    const body = await readJson(req);
    const out = publicCart(db, body);
    return send(res, out.status, out.body);
  }
  const slotsRoute = /^\/api\/public\/appointment\/(\d+)\/slots$/.exec(path);
  if (slotsRoute && req.method === 'GET') {
    if (hits(`slots:${ip}`) >= CART_PRICINGS_PER_WINDOW) return send(res, 429, { error: 'Too many requests, try again later' });
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
    // A retried create with the same Idempotency-Key returns the record made the first time.
    const idemKey = req.method === 'POST' ? String(req.headers['idempotency-key'] ?? '').slice(0, IDEMPOTENCY_KEY_MAX) : '';
    if (idemKey) {
      writeSql('DELETE FROM idempotency WHERE created < ?', Date.now() - IDEMPOTENCY_TTL_MS);
      const prior = sql.prepare('SELECT model, record_id FROM idempotency WHERE user_id = ? AND key = ?').get(keyUser.id, idemKey);
      if (prior && prior.model !== path.split('/')[3]) return send(res, 422, { error: 'Idempotency-Key was already used for another model' });
      if (prior) return send(res, 200, read(visibleDb(keyUser), prior.model, prior.record_id) ?? { id: prior.record_id, deleted: true });
    }
    // Reads see what the web client sees; writes are checked against the stricter write set.
    const reading = req.method === 'GET';
    const out = handleApi({ method: req.method, path, query: new URL(req.url, 'http://x').searchParams, body, db: reading ? visibleDb(keyUser) : db, user: keyUser, allowed: reading ? readableFor(keyUser) : allowedFor(keyUser), readOnly: readOnlyFor(keyUser), companies: companiesFor(keyUser), company: selectionFor(keyUser).current_company_id });
    if (out.db) commitDb(out.db, { actor: `api:${keyUser.login}` });
    if (idemKey && out.status === 201) writeSql('INSERT INTO idempotency VALUES (?, ?, ?, ?, ?)', keyUser.id, idemKey, path.split('/')[3], out.body.id, Date.now());
    return send(res, out.status, out.body);
  }
  // CSRF: state-changing calls must be JSON with a custom header (not sendable by cross-site forms).
  if (req.method !== 'GET' && (req.headers['x-requested-with'] !== 'mizan' || !String(req.headers['content-type']).startsWith('application/json'))) {
    return send(res, 403, { error: 'Missing CSRF header' });
  }
  if (path === '/api/login' && req.method === 'POST') {
    const { login, password } = await readJson(req);
    const account = String(login ?? '').toLowerCase().slice(0, 64);
    const limitKey = `login:${ip}:${account}`;
    // A per-account ceiling also slows attacks spread over many IPs; it is higher so one attacker cannot lock the user out quickly.
    const accountKey = `login-account:${account}`;
    if (tooMany(limitKey) || hits(accountKey) >= ACCOUNT_FAILURES_PER_WINDOW) return send(res, 429, { error: 'Too many attempts, try again later' });
    const user = checkPassword(login, password);
    if (!user) { recordFailure(limitKey); recordFailure(accountKey); return send(res, 401, { error: 'Wrong login or password' }); }
    const token = randomBytes(32).toString('base64url');
    writeSql('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)', sha256(token), user.id, Date.now() + SESSION_DAYS * 864e5);
    return send(res, 200, { id: user.id, login: user.login, name: user.name, isAdmin: !!user.is_admin, apps: parseApps(user.apps) }, { 'Set-Cookie': cookie(token, SESSION_DAYS * 86400) });
  }

  const user = sessionUser(req);
  if (!user) return send(res, 401, { error: 'Not logged in' });

  if (path === '/api/session' && req.method === 'GET') return send(res, 200, { ...user, selection: undefined, canReset: user.isAdmin && RESET_ALLOWED, smtp: !!SMTP, integrations: { ...integrationStatus(), smtp: !!SMTP } });
  const action = ACTIONS[path];
  if (action && req.method === 'POST') {
    if (action.need && !{ ...integrationStatus(), smtp: !!SMTP }[action.need]) return send(res, 400, { error: `The ${action.need} integration is not configured` });
    if (action.admin && !user.isAdmin) return send(res, 403, { error: 'Admins only' });
    const body = await readJson(req);
    const model = action.model(body);
    const allowed = allowedFor(user);
    if (allowed && !allowed.has(model)) return send(res, 403, { error: `No access to ${model}` });
    try {
      const snapshot = scopeFor(user);
      const at = epoch;
      const storeAllowed = allowed && action.extra ? new Set([...allowed, ...action.extra]) : allowed;
      const out = await action.run(body, user, storeFor(writeOptions(user, storeAllowed), user.login, () => scopeFor(user)), snapshot);
      // Changes made by integrations go through the same validation as client edits, applied on top of edits made meanwhile.
      sameEpoch(at);
      if (out.db) commitDb(applyDiff(db, diffDb(snapshot, out.db), writeOptions(user, storeAllowed)), { actor: user.login });
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
      const snapshot = scopeFor(user);
      const at = epoch;
      const out = path.endsWith('mailing')
        ? await sendMailing(SMTP, storeFor(writeOptions(user, allowed), user.login, () => scopeFor(user)), body, lastBaseUrl)
        : await sendDocument(SMTP, snapshot, user, body);
      if (at !== epoch) return send(res, 409, { error: 'The email was sent, but the data was restored meanwhile, so the send was not recorded' });
      if (!out.db) return send(res, out.status, out.body);
      const stored = recordSent(db, snapshot, out.db, writeOptions(user, allowed));
      commitDb(stored.db, { actor: user.login });
      return send(res, out.status, stored.notice ? { ...out.body, message: stored.notice } : out.body);
    } catch (e) {
      return send(res, 502, { error: `Email could not be sent: ${e.message}` });
    }
  }
  if (path === '/api/logout' && req.method === 'POST') {
    const token = (req.headers.cookie ?? '').match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];
    if (token) writeSql('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }
  const blobPath = /^\/api\/blob\/([0-9a-f]{32})$/.exec(path);
  if (blobPath && req.method === 'GET') {
    // Use the same model, company and field visibility as GET /api/db before returning bytes.
    if (!referencesBlob(visibleDb(user), blobPath[1])) return send(res, 404, { error: 'Not found' });
    return sendBlob(res, blobs.get(blobPath[1]), false);
  }
  const stamp = () => ({ 'X-Mizan-Epoch': String(epoch) });
  if (path === '/api/db' && req.method === 'GET') {
    // The visible part depends on the user's apps, so the tag names the user as well as the revision.
    const tag = `"${startedAt}-${revision}-${sha256(JSON.stringify([user.id, user.apps, user.isAdmin, user.companies, user.selection]))}"`;
    if (req.headers['if-none-match'] === tag) { res.writeHead(304, { ETag: tag, ...stamp(), 'Cache-Control': 'no-store' }); return res.end(); }
    return send(res, 200, visibleDb(user), { ETag: tag, ...stamp() });
  }
  // Audit log: admins only, newest first, optionally narrowed to one model or one record.
  if (path === '/api/audit' && req.method === 'GET') {
    if (!user.isAdmin) return send(res, 403, { error: 'Admins only' });
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = Math.min(Math.max(Number(q.get('limit')) || 100, 1), 1000);
    // Newest first; pass the last id received as `before` for the next, older page.
    const before = q.has('before') ? Number(q.get('before')) : null;
    if (before !== null && !Number.isSafeInteger(before)) return send(res, 400, { error: 'before must be an audit entry id' });
    const rows = sql.prepare(`SELECT id, at, actor, model, res_id, action, changes FROM audit_log
      WHERE (?1 IS NULL OR model = ?1) AND (?2 IS NULL OR res_id = ?2) AND (?4 IS NULL OR id < ?4) ORDER BY id DESC LIMIT ?3`)
      .all(q.get('model'), q.has('id') ? Number(q.get('id')) : null, limit, before);
    return send(res, 200, rows.map((r) => ({ ...r, changes: JSON.parse(r.changes) })));
  }
  // Journal-posting actions (POS sales, payslips) run on the server with system rights; see posting.js.
  if (['/api/button', '/api/pos/pay', '/api/pos/close'].includes(path) && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const snapshot = scopeFor(user);
      const out = runPosting(snapshot, allowedFor(user), path, body);
      commitDb(applyDiff(db, diffDb(snapshot, out.db), writeOptions(user, null)), { actor: user.login });
      return send(res, 200, out.body);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (path === '/api/diff' && req.method === 'POST') {
    const body = await readJson(req);
    let remapped;
    // A browser that last synced before a restore would otherwise replay its queued edits onto the restored data.
    const seen = req.headers['x-mizan-epoch'];
    if (seen !== undefined && seen !== String(epoch)) return send(res, 409, { error: 'The data was restored by an administrator; your unsaved edits were discarded', db: visibleDb(user) }, stamp());
    try {
      const assigned = assignIds(db, body);
      remapped = assigned.remapped;
      const diff = assigned.diff;
      // The company switcher is per user: store it with the user, never in the shared settings. It is checked first
      // but only stored once the rest of the change has been accepted, so a rejected request changes nothing.
      let selection = null;
      if (diff?.settings && typeof diff.settings === 'object') {
        const { current_company_id: current, allowed_company_ids: chosen, ...rest } = diff.settings;
        const mine = selectionFor(user);
        if ((current !== undefined && current !== mine.current_company_id) || (chosen !== undefined && JSON.stringify(chosen) !== JSON.stringify(mine.allowed_company_ids))) {
          selection = checkSelection(user, { current_company_id: current ?? mine.current_company_id, allowed_company_ids: chosen ?? mine.allowed_company_ids });
        }
        diff.settings = rest;
      }
      commitDb(applyDiff(db, diff, writeOptions(user)), { actor: user.login });
      if (selection) saveSelection(user, selection);
    } catch (e) {
      return send(res, e.conflict ? 409 : 400, { error: e.message, db: visibleDb(user) }, stamp());
    }
    return send(res, 200, Object.keys(remapped).length ? { ...visibleDb(user), remapped } : visibleDb(user), stamp());
  }
  const op = /^\/api\/op\/([\w.]+)$/.exec(path);
  if (op && req.method === 'POST') {
    const body = await readJson(req).catch(() => null);
    if (!body || typeof body !== 'object') return send(res, 400, { error: 'Send a JSON object' });
    try {
      const snapshot = scopeFor(user);
      const out = runOperation(snapshot, op[1], body, { allowed: allowedFor(user), direct: menuModelsFor(user) });
      commitDb(applyDiff(db, diffDb(snapshot, out.db), writeOptions(user, out.allowed)), { actor: user.login });
      return send(res, 200, out.reply);
    } catch (e) {
      return send(res, e.status ?? 400, { error: e.message });
    }
  }
  if (path === '/api/restore' && req.method === 'POST') {
    if (!user.isAdmin) return send(res, 403, { error: 'Admins only' });
    try {
      const body = await readJson(req, MAX_BACKUP);
      const restored = migrate(checkBackup(body?.backup));
      // The company switcher belongs to each user, not to the shared backup being restored.
      for (const key of ['current_company_id', 'allowed_company_ids']) {
        if (key in db.settings) restored.settings[key] = db.settings[key];
        else delete restored.settings[key];
      }
      const summary = backupSummary(db, restored);
      // A dry run only reports what would change; the real restore needs the typed confirmation.
      if (body.confirm !== 'RESTORE') return send(res, 200, { dryRun: true, ...summary });
      commitDb(restored, { full: true, actor: user.login, action: 'restore' });
      epoch = Math.max(epoch + 1, Date.now());
      console.info(`Backup restored by ${user.login}: ${summary.restored} records (was ${summary.current})`);
      return send(res, 200, { ok: true, ...summary });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  // The full business database as JSON (not the caller's filtered copy): an export for reading and re-importing records, not a restore point (see README).
  if (path === '/api/backup' && req.method === 'GET') {
    if (!user.isAdmin) return send(res, 403, { error: 'Admins only' });
    return send(res, 200, db, { 'Content-Disposition': `attachment; filename="mizan-backup-${new Date().toISOString().slice(0, 10)}.json"` });
  }
  if (path === '/api/reset' && req.method === 'POST') {
    if (!user.isAdmin) return send(res, 403, { error: 'Admins only' });
    if (!RESET_ALLOWED) return send(res, 403, { error: 'Reset is disabled on this server (set MIZAN_ALLOW_RESET=1 to allow it)' });
    if ((await readJson(req)).confirm !== 'RESET') return send(res, 400, { error: 'Type RESET to confirm' });
    // Keep what is about to be wiped, next to the database file: owner-only, never over an existing file. The copy and
    // the reset happen in one synchronous step, so no other request can commit in between and be lost.
    const saved = `${DB_PATH}.before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(saved, JSON.stringify(db), { flag: 'wx', mode: 0o600 });
    console.info(`Data reset to the demo database by ${user.login}; previous data saved to ${saved}`);
    commitDb(seed(), { full: true, actor: user.login, action: 'reset' });
    epoch = Math.max(epoch + 1, Date.now());
    return send(res, 200, db, { 'X-Mizan-Epoch': String(epoch) });
  }
  if (path === '/api/keys') {
    if (req.method === 'GET') return send(res, 200, sql.prepare('SELECT name, created FROM api_keys WHERE user_id = ? ORDER BY created').all(user.id));
    if (req.method === 'POST') {
      const { name } = await readJson(req);
      const key = `mzn_${randomBytes(24).toString('base64url')}`;
      const label = String(name || 'API key').slice(0, 60);
      const created = Date.now();
      withAudit(user.login, 'auth.api_key', user.id, 'create', { name: [null, label], created: [null, created] },
        () => writeSql('INSERT INTO api_keys (key_hash, user_id, name, created) VALUES (?, ?, ?, ?)', sha256(key), user.id, label, created));
      return send(res, 201, { key }); // shown once; only the hash is stored
    }
    if (req.method === 'DELETE') {
      const created = Number(new URL(req.url, 'http://x').searchParams.get('created'));
      withAudit(user.login, 'auth.api_key', user.id, 'delete', { created: [created, null] },
        () => writeSql('DELETE FROM api_keys WHERE user_id = ? AND created = ?', user.id, created));
      return send(res, 200, { ok: true });
    }
  }
  if (path === '/api/users') {
    if (!user.isAdmin) return send(res, 403, { error: 'Admins only' });
    if (req.method === 'GET') return send(res, 200, sql.prepare('SELECT id, login, name, is_admin AS isAdmin, apps, companies FROM users ORDER BY id').all());
    if (req.method === 'POST') {
      try {
        createUser(await readJson(req), user.login);
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

const portal = createPortal({ sql, getDb: () => db, commitDb, sessionUser, allowedFor: menuModelsFor, canSee: (u, model, rec) => visibleTo(companiesFor(u), model, rec, db), clientIp, tooMany, recordFailure, readRaw, securityHeaders: SECURITY_HEADERS });
const signing = createSigning({ getDb: () => db, commitDb, clientIp, tooMany, recordFailure, readRaw, securityHeaders: SECURITY_HEADERS });

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  res.acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
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
    const next = runScheduledJobs(db, undefined, { onError: (job, e) => console.error(`Scheduled job ${job} failed:`, e) });
    if (next !== db) commitDb(applyDiff(db, diffDb(db, next), { author: 'Scheduler' }), { actor: 'scheduler' });
  } catch (e) {
    console.error('Scheduled job failed:', e);
  }
};
// The first run waits until the server is listening, so a restart answers requests before the jobs finish.
server.once('listening', () => setImmediate(runJobs));
setInterval(runJobs, JOB_INTERVAL_MS).unref();
scheduleSnapshots(DB_PATH);

// Scheduled mailings and A/B test winners go out by email (only when SMTP is configured).
const MAIL_JOB_INTERVAL_MS = 10 * 60 * 1000;
// Links in scheduled emails need the public address; without MIZAN_PUBLIC_URL they wait for a manual send to learn it.
const runMailJobs = async () => {
  if (!SMTP || (!process.env.MIZAN_PUBLIC_URL && !mailBaseKnown)) return;
  const at = new Date().toISOString().slice(0, 10);
  const jobs = [
    (store) => resumeQueued(SMTP, store, lastBaseUrl),
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
