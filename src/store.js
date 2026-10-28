import { useSyncExternalStore } from 'react';
import { seed } from './seed.js';
import { diffDb, isEmptyDiff } from './sync.js';
import { createQueue } from './queue.js';
import { setActiveCompany, setAuthor, updateSettings } from './orm.js';
import { setCompanies } from './models/company.js';
import { setActor } from './models/authority.js';
import { installCustomFields } from './models/studio.js';
import { setCurrency } from './ui.jsx';

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

function loadLocal() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    // corrupt or blocked storage: fall back to demo data
  }
  return seed();
}

async function api(path, body) {
  const res = await fetch(path, body === undefined
    ? { credentials: 'same-origin' }
    : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify(body) });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  return { ok: res.ok, status: res.status, isJson, data };
}

async function pull() {
  const r = await api('/api/db');
  if (r.status === 401) location.reload();
  if (!r.ok || !r.data) throw new Error(r.data?.error ?? `Could not load the database (HTTP ${r.status})`);
  db = confirmed = r.data;
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
      // Never fall back to demo data here: the next save would write it over the real records.
      await pull();
      setInterval(() => { if (document.visibilityState === 'visible') enqueue(pull, pollFailed); }, POLL_MS);
    }
    return { mode, user };
  }
  db = loadLocal();
  applyContext();
  return { mode, user };
}

export const getDb = () => db;
export const getUser = () => user;
export const isServer = () => mode === 'server';

/** Apply a pure ORM transition: optimistic locally, then synced (server) or persisted (local). */
export function commit(next) {
  // Diff against the snapshot this transition was computed from, so a poll landing in between
  // can't turn other users' newer changes into reverts.
  const diff = mode === 'server' ? diffDb(db, next) : null;
  db = next;
  notify();
  if (mode === 'local') {
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* storage full/blocked: keep working in memory */ }
    return;
  }
  const gen = generation;
  const failed = (message) => {
    generation++;
    db = confirmed ?? db;
    notify();
    alert(`${message} Showing the last saved data; please redo any edits made since.`);
  };
  enqueue(async () => {
    if (gen !== generation || isEmptyDiff(diff)) return; // built on top of a failed save
    const r = await api('/api/diff', diff);
    if (r.ok) { db = confirmed = r.data; notify(); return; }
    if (r.data?.db) confirmed = r.data.db;
    failed(r.data?.error ?? 'Could not save changes.');
  }, (e) => {
    failed(`Could not save changes: ${e.message}.`);
    return pull().catch(pollFailed);
  });
}

/** Run a server-side action (e.g. send email) and refresh the shared database. */
export async function serverAction(path, body) {
  const r = await api(path, body);
  if (!r.ok) throw new Error(r.data?.error ?? 'Action failed');
  // The action already happened: a failed refresh must not look like a failed action (users would retry and send twice).
  await pull().catch((e) => { pollFailed(e); enqueue(pull, pollFailed); });
  return r.data;
}

export async function resetDemo() {
  if (mode === 'local') return commit(seed());
  const r = await api('/api/reset', { confirm: 'RESET' });
  if (r.ok) { db = r.data; notify(); } else alert(r.data?.error ?? 'Reset failed');
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
export const revokeKey = (created) => fetch(`/api/keys?created=${Number(created)}`, { method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' } });
export async function createKey(name) {
  const r = await api('/api/keys', { name });
  if (!r.ok) throw new Error(r.data?.error ?? 'Could not create key');
  return r.data.key;
}
export async function addUser(vals) {
  const r = await api('/api/users', vals);
  if (!r.ok) throw new Error(r.data?.error ?? 'Could not create user');
}

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useDb = () => useSyncExternalStore(subscribe, getDb);

// The store holds the loaded database; hot-swapping this module would drop it, so reload the page instead.
if (import.meta.hot) import.meta.hot.decline();
