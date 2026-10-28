import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seed } from '../src/seed.js';
import { applyDiff, diffDb } from '../src/sync.js';

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
