import { useSyncExternalStore } from 'react';
import { seed } from './seed.js';

// ponytail: whole db in localStorage, fine for a demo; replace with an HTTP API + Postgres for multi-user.
const KEY = 'mizan-db-v2';
const listeners = new Set();

function load() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return JSON.parse(saved);
  } catch {
    // corrupt or blocked storage: fall back to demo data
  }
  return seed();
}

let db = load();

export const getDb = () => db;

/** Apply a pure ORM transition and persist. */
export function commit(next) {
  db = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    // storage full/blocked: keep working in memory
  }
  listeners.forEach((l) => l());
}

export const resetDemo = () => commit(seed());

const subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useDb = () => useSyncExternalStore(subscribe, getDb);
