import { useSyncExternalStore } from 'react';
import { diffDb, isEmptyDiff, rebaseDiff } from './sync.js';
import { createQueue } from './queue.js';
import { migrate } from './migrations.js';
import { setActiveCompany, setAuthor, updateSettings } from './orm.js';
import { setCompanies } from './models/company.js';
import { setActor } from './models/authority.js';
import { installCustomFields } from './models/studio.js';
import { setCurrency } from './ui.jsx';
import { t } from './i18n.js';

// Two modes: "server" (shared db behind /api, login required) or "local" (browser-only demo).
const KEY = 'mizan-db-v32';
const POLL_MS = 15000;
const listeners = new Set();
let mode = 'local';
let user = null;
let db = null;
let confirmed = null; // last state the server acknowledged
let generation = 0; // bumped when a save fails, so saves queued on top of it are dropped
const enqueue = createQueue(); // saves and polls, in order
// Which database generation this browser last synced with; the server refuses edits made before a restore.
let epoch = null;

const COMPANY_KEY = 'mizan-company';
const savedCompany = () => { try { return Number(localStorage.getItem(COMPANY_KEY)) || 1; } catch { return 1; } };

/** Companies defined in settings (the first one mirrors the company name/currency fields). */
export const companiesOf = (d) => {
  const records = (d?.records?.['res.company'] ?? []).filter((c) => c.active !== false);
  if (records.length) return records.map((c) => ({ id: c.id, name: c.name, currency: d.records['res.currency']?.find((x) => x.id === c.currency_id)?.name ?? d.settings?.currency ?? 'USD' }));
  return d?.settings?.companies?.length ? d.settings.companies : [{ id: 1, name: d?.settings?.company ?? 'My Company', currency: d?.settings?.currency ?? 'USD' }];
};
export const currentCompany = (d = db) => companiesOf(d).find((c) => c.id === (d?.settings?.current_company_id ?? savedCompany())) ?? companiesOf(d)[0];
export function switchCompany(id) {
  const current = Number(id);
  if (!companiesOf(db).some((c) => c.id === current)) return;
  commit(db.records['res.company']?.length ? setCompanies(db, { current, allowed: [current] })
    : updateSettings(db, { current_company_id: current, allowed_company_ids: [current] }));
}

const applyContext = () => {
  installCustomFields(db?.settings?.customFields);
  const company = currentCompany();
  if (db.settings?.current_company_id == null) db = updateSettings(db, { current_company_id: company.id, allowed_company_ids: db.settings?.allowed_company_ids ?? [company.id] });
  setActiveCompany(null);
  setCurrency(company.currency ?? db?.settings?.currency);
};

const notify = () => {
  applyContext();
  listeners.forEach((l) => l());
};

// The demo seed is only needed in browser-only mode, so it is loaded on demand.
const demoData = async () => (await import('./seed.js')).seed();

async function loadLocal() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return migrate(JSON.parse(saved));
  } catch {
    // corrupt or blocked storage: fall back to demo data
  }
  return demoData();
}

async function api(path, body, headers = {}) {
  const res = await fetch(path, body === undefined
    ? { credentials: 'same-origin', headers }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan', ...(path === '/api/diff' && epoch ? { 'X-Mizan-Epoch': epoch } : {}) }, body: JSON.stringify(body) });
  const nextEpoch = res.headers.get('x-mizan-epoch') ?? epoch;
  if (epoch && nextEpoch !== epoch) generation++; // drop edits queued against the replaced database
  epoch = nextEpoch;
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  return { ok: res.ok, status: res.status, isJson, data, etag: res.headers.get('etag') };
}

// The server's tag for the copy we hold; a poll with nothing new comes back 304 with no body.
let dbTag = null;
async function pull() {
  const r = await api('/api/db', undefined, dbTag ? { 'If-None-Match': dbTag } : {});
  if (r.status === 304) return;
  if (r.status === 401) location.reload();
  if (!r.ok || !r.data) throw new Error(r.data?.error ?? `Could not load the database (HTTP ${r.status})`);
  db = confirmed = r.data;
  dbTag = r.etag;
  notify();
}

const pollFailed = (e) => console.warn('Mizan: refresh failed, will retry', e);

/** Detect the backend; resolves to { mode, user }. A non-JSON answer means no backend (static/dev hosting). */
export async function initStore() {
  let session = null;
  try {
    session = await api('/api/session');
  } catch {
    // no backend reachable: local mode
  }
  if (session?.isJson) {
    mode = 'server';
    if (session.ok) {
      user = session.data;
      setAuthor(user.name);
      setActor(user);
      // A backend that answers but cannot serve the database is an error, not a reason to fall back to demo data.
      await pull();
      if (!db) throw new Error('The server did not return the database');
      setInterval(() => { if (document.visibilityState === 'visible') enqueue(pull, pollFailed); }, POLL_MS);
    }
    return { mode, user };
  }
  db = await loadLocal();
  applyContext();
  return { mode, user };
}

export const getDb = () => db;
export const getUser = () => user;
export const isServer = () => mode === 'server';

/** Id reassignments from the server, in arrival order. */
const remaps = [];

/**
 * Apply a pure ORM transition: optimistic locally, then synced (server) or persisted (local).
 * Returns a promise of { ok, error } that settles once the server has accepted or refused the change, so callers
 * can confirm success (or keep the user's input) only then. With `quiet`, a refusal is left to the caller to show;
 * otherwise it is shown in a translated alert.
 */
export function commit(next, { quiet = false } = {}) {
  // Diff against the snapshot this transition was computed from, so a poll landing in between
  // can't turn other users' newer changes into reverts.
  const diff = mode === 'server' ? diffDb(db, next) : null;
  const known = remaps.length;
  db = next;
  notify();
  if (mode === 'local') {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* storage full/blocked: keep working in memory */ }
    return Promise.resolve({ ok: true });
  }
  dbTag = null;
  const gen = generation;
  const failed = (message) => {
    generation++;
    db = confirmed ?? db;
    notify();
    const error = t(message);
    if (!quiet) alert(`${error} ${t('Showing the last saved data; please redo any edits made since.')}`);
    return { ok: false, error };
  };
  return enqueue(async () => {
    if (isEmptyDiff(diff)) return { ok: true };
    if (gen !== generation) return { ok: false, error: t('Could not save changes') }; // built on top of a failed save
    const r = await api('/api/diff', remaps.slice(known).reduce(rebaseDiff, diff));
    dbTag = null;
    if (r.ok) {
      const { remapped, ...saved } = r.data;
      db = confirmed = saved;
      if (remapped) {
        remaps.push(remapped);
        window.dispatchEvent(new CustomEvent('mizan:remapped', { detail: remapped }));
      }
      notify();
      return { ok: true };
    }
    if (r.data?.db) confirmed = r.data.db;
    return failed(r.data?.error ?? 'Could not save changes');
  }, async (e) => {
    const result = failed(`${t('Could not save changes')}: ${e.message}.`);
    await pull().catch(pollFailed);
    return result;
  });
}

/** Run a server-side action (e.g. send email) and refresh the shared database. */
export async function serverAction(path, body) {
  const gen = generation;
  const known = remaps.length;
  // Queued behind pending saves, so the server sees the record as the user just saved it.
  const r = await enqueue(async () => {
    if (gen !== generation) return { ok: false, error: t('Could not save changes') };
    let id = body?.id;
    if (id != null) {
      for (const m of remaps.slice(known)) {
        if (body.model && m[body.model]?.[id] != null) id = m[body.model][id];
        else if (!body.model) {
          for (const map of Object.values(m)) {
            if (map[id] != null) { id = map[id]; break; }
          }
        }
      }
    }
    const payload = body && typeof body === 'object' && 'id' in body && id !== body.id ? { ...body, id } : body;
    return api(path, payload);
  }, (e) => { throw e; });
  if (r?.ok === false && 'error' in r) return r;
  if (!r.ok) throw new Error(r.data?.error ?? 'Action failed');
  // The action already happened: a failed refresh must not look like a failed action (users would retry and send twice).
  await pull().catch((e) => { pollFailed(e); enqueue(pull, pollFailed); });
  return r.data;
}

/** Admin restore on the server: without `confirm` it only reports what would change; with 'RESTORE' it replaces the data. */
export async function restoreBackup(backup, confirm) {
  const restore = async () => {
    const r = await api('/api/restore', { backup, confirm });
    if (!r.ok) throw new Error(r.data?.error ?? 'Restore failed');
    if (confirm) await pull();
    return r.data;
  };
  // Serialize replacement and refresh with saves; the new epoch discards edits queued during the restore.
  return confirm ? enqueue(restore, (e) => { throw e; }) : restore();
}

export async function resetDemo() {
  if (mode === 'local') return commit(await demoData());
  const r = await api('/api/reset', { confirm: 'RESET' });
  if (r.ok) { db = confirmed = r.data; dbTag = null; notify(); } else alert(r.data?.error ?? 'Reset failed');
}

export async function login(loginName, password) {
  const r = await api('/api/login', { login: loginName, password });
  if (!r.ok) throw new Error(r.data?.error ?? 'Login failed');
  location.reload();
}

export async function logout() {
  await api('/api/logout', {});
  location.reload();
}

export const listUsers = async () => (await api('/api/users')).data ?? [];
export const listKeys = async () => (await api('/api/keys')).data ?? [];
/** Server change log for a model (admins only); null when it cannot be read. */
export async function listAudit(model, limit = 500) {
  const r = await api(`/api/audit?model=${encodeURIComponent(model)}&limit=${limit}`);
  return r.ok ? r.data : null;
}
export const revokeKey = (created) => fetch(`/api/keys?created=${Number(created)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' } });
export async function createKey(name) {
  const r = await api('/api/keys', { name });
  if (!r.ok) throw new Error(r.data?.error ?? 'Could not create key');
  return r.data.key;
}
const postOrThrow = async (path, body, fallback) => {
  const r = await api(path, body);
  if (!r.ok) throw new Error(r.data?.error ?? fallback);
};
export const changePassword = (current, password) => postOrThrow('/api/password', { current, password }, 'Could not change password');
export const revokeOtherSessions = () => postOrThrow('/api/sessions/revoke', {}, 'Could not sign out other sessions');
export const revokeUser = (id, password) => postOrThrow('/api/users/revoke', password ? { id, password } : { id }, 'Could not revoke access');
export async function addUser(vals) {
  const r = await api('/api/users', vals);
  if (!r.ok) throw new Error(r.data?.error ?? 'Could not create user');
}

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useDb = () => useSyncExternalStore(subscribe, getDb, getDb);

// The store holds the loaded database; hot-swapping this module would drop it, so reload the page instead.
if (import.meta.hot) import.meta.hot.decline();
