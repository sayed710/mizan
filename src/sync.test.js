import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiff, diffDb, isEmptyDiff } from './sync.js';
import { create, read, unlink, write } from './orm.js';
import { seed } from './seed.js';

test('diff of identical snapshots is empty', () => {
  const db = seed();
  assert.ok(isEmptyDiff(diffDb(db, db)));
});

test('concurrent edits to different records both survive', () => {
  const base = seed();
  const alice = write(base, 'crm.lead', 1, { stage_id: 'won' });
  const bob = write(base, 'crm.lead', 2, { priority: 3 });
  let server = applyDiff(base, diffDb(base, alice));
  server = applyDiff(server, diffDb(base, bob));
  assert.equal(read(server, 'crm.lead', 1).stage_id, 'won');
  assert.equal(read(server, 'crm.lead', 2).priority, 3);
  assert.equal(server.messages.length, 1);
});

test('creates, deletes and sequences are applied', () => {
  const base = seed();
  const { db: created, id } = create(base, 'helpdesk.ticket', { name: 'Printer jam' });
  const next = unlink(created, 'crm.lead', [3]);
  const server = applyDiff(base, diffDb(base, next));
  assert.equal(read(server, 'helpdesk.ticket', id).name, 'Printer jam');
  assert.equal(read(server, 'crm.lead', 3), undefined);
  assert.equal(server.seq['helpdesk.ticket'], id);
});

test('untrusted input is validated and stripped', () => {
  const base = seed();
  assert.throws(() => applyDiff(base, { upserts: { 'evil.model': [{ id: 1 }] } }), /Unknown model/);
  assert.throws(() => applyDiff(base, { upserts: { 'crm.lead': [{ id: 99, name: '' }] } }), /required/);
  const server = applyDiff(base, { upserts: { 'crm.lead': [{ id: 99, name: 'X', __proto__: { admin: true }, isAdmin: true }] } });
  const rec = read(server, 'crm.lead', 99);
  assert.equal(rec.isAdmin, undefined);
  assert.equal(Object.getPrototypeOf(rec), Object.prototype);
});
