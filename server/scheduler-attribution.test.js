import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seed } from '../src/seed.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { create, read, search } from '../src/orm.js';
import { queueMailing } from '../src/models/mailing.js';
import { resumeQueued } from './mailtrack.js';

test('scheduled mailing store commits retain the Scheduler audit identity', () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const closure = source.slice(source.indexOf('const storeFor ='), source.indexOf('\nif (!db) commitDb'));
  const db = seed();
  const commits = [];
  const storeFor = new Function('db', 'epoch', 'sameEpoch', 'commitDb', 'applyDiff', 'diffDb', 'ownLease', `${closure}; return storeFor;`)(db, 1, () => {}, (next, options) => commits.push({ next, ...options }), applyDiff, diffDb, () => {});
  const store = storeFor({ author: 'Scheduler', isAdmin: true });
  const base = store.get();
  store.commit({ ...base, records: { ...base.records, 'mailing.mailing': base.records['mailing.mailing'].map((m) => ({ ...m, subject: 'Scheduled change' })) } });
  assert.equal(commits.length, 1);
  assert.equal(commits[0].actor, 'Scheduler');
});

test('scheduled mailing store commits retain the Scheduler audit identity across queued sends and bounces', async () => {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  const closure = source.slice(source.indexOf('const storeFor ='), source.indexOf('\nif (!db) commitDb'));
  let db = seed();
  const list = search(db, 'mailing.list')[0].id;
  const { db: start, id } = create(db, 'mailing.mailing', { subject: 'Hi', list_id: list, body: 'Hello' });
  db = queueMailing(start, read(start, 'mailing.mailing', id), { queued: true });
  const commits = [];
  const runner = new Function('state', 'epoch', 'sameEpoch', 'commitDb', 'applyDiff', 'diffDb', 'ownLease', `
    let db = state.db;
    ${closure};
    return {
      storeFor,
      setDb(next) { db = next; state.db = next; }
    };
  `);
  const state = { db };
  let instance;
  const storeFor = (...args) => instance.storeFor(...args);
  instance = runner(state, 1, () => {}, (next, options) => {
    instance.setDb(next);
    commits.push({ next, ...options });
  }, applyDiff, diffDb, () => {});

  const store = storeFor({ author: 'Scheduler', isAdmin: true });
  const delivered = await resumeQueued({ host: '127.0.0.1', port: 9, from: 'a@x.example' }, store, 'https://erp.example');
  assert.equal(delivered, 0);
  assert.ok(commits.length > 0);
  assert.ok(commits.every((c) => c.actor === 'Scheduler'));
});
