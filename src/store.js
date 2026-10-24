import { useSyncExternalStore } from 'react';
import { seed } from './seed.js';
import { diffDb, isEmptyDiff } from './sync.js';
import { setAuthor } from './orm.js';
import { installCustomFields } from './models/studio.js';
import { setCurrency } from './ui.jsx';

// Two modes: "server" (shared db behind /api, login required) or "local" (browser-only demo).
const KEY = 'mizan-db-v11';
const POLL_MS = 15000;
const listeners = new Set();
let mode = 'local';
let user = null;
let db = null;
let inflight = Promise.resolve();

const notify = () => {
  installCustomFields(db?.settings?.customFields);
  setCurrency(db?.settings?.currency);
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
  if (r.ok) { db = r.data; notify(); }
  if (r.status === 401) location.reload();
}

/** Detect the backend; resolves to { mode, user }. A non-JSON answer means no backend (static/dev hosting). */
export async function initStore() {
  try {
    const r = await api('/api/session');
    if (r.isJson) {
      mode = 'server';
      if (r.ok) {
        user = r.data;
        setAuthor(user.name);
        await pull();
        setInterval(() => { if (document.visibilityState === 'visible') inflight = inflight.then(pull); }, POLL_MS);
      }
      return { mode, user };
    }
  } catch {
    // no backend reachable: local mode
  }
  db = loadLocal();
  installCustomFields(db.settings?.customFields);
  setCurrency(db.settings?.currency);
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
  inflight = inflight.then(async () => {
    if (isEmptyDiff(diff)) return;
    const r = await api('/api/diff', diff);
    if (r.ok || r.data?.db) { db = r.ok ? r.data : r.data.db; notify(); }
    if (!r.ok) alert(r.data?.error ?? 'Could not save changes');
  });
}

/** Run a server-side action (e.g. send email) and refresh the shared database. */
export async function serverAction(path, body) {
  const r = await api(path, body);
  if (!r.ok) throw new Error(r.data?.error ?? 'Action failed');
  await pull();
  return r.data;
}

export async function resetDemo() {
  if (mode === 'local') return commit(seed());
  const r = await api('/api/reset', {});
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
