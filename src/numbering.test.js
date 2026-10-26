import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { postMove } from './models/accounting.js';
import { nextName } from './models/common.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

const draft = (db, price) => create(db, 'account.move', { partner_id: 1, move_type: 'out_invoice', state: 'draft', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: price, tax: 0 }] });
const names = (db) => search(db, 'account.move').map((m) => m.name).filter((n) => n && n !== '/');

test('two users posting from the same snapshot get different invoice numbers', () => {
  let base = seed();
  const a = draft(base, 100);
  const b = draft(a.db, 200);
  base = applyDiff(base, diffDb(base, b.db), {});
  const alice = postMove(base, a.id);
  const bob = postMove(base, b.id);
  assert.equal(read(alice, 'account.move', a.id).name, read(bob, 'account.move', b.id).name);
  let server = applyDiff(base, diffDb(base, alice), {});
  server = applyDiff(server, diffDb(base, bob), {});
  const [first, second] = [read(server, 'account.move', a.id).name, read(server, 'account.move', b.id).name];
  assert.notEqual(first, second);
  assert.equal(new Set(names(server)).size, names(server).length);
  assert.equal(Number(second.slice(-5)), Number(first.slice(-5)) + 1);
});

test('a number freed by a deletion is never handed out again', () => {
  const prefix = 'TEST/2026/';
  const db = { records: { 'account.move': [{ id: 1, name: `${prefix}00001` }, { id: 2, name: `${prefix}00002` }] } };
  const gone = { records: { 'account.move': [db.records['account.move'][1]] } };
  assert.equal(nextName(gone, 'account.move', prefix), `${prefix}00003`);
});

test('existing duplicates in stored data are left alone', () => {
  const base = seed();
  const dup = search(base, 'account.move').find((m) => m.name && m.name !== '/');
  const stored = { ...base, records: { ...base.records, 'account.move': [...base.records['account.move'], { ...base.records['account.move'].find((m) => m.id === dup.id), id: 500 }] } };
  const edited = { ...stored, records: { ...stored.records, 'account.move': stored.records['account.move'].map((m) => (m.id === dup.id ? { ...m, ref: 'edited' } : m)) } };
  const out = applyDiff(stored, diffDb(stored, edited), {});
  assert.equal(read(out, 'account.move', dup.id).ref, 'edited');
  assert.equal(out.records['account.move'].filter((m) => m.name === dup.name).length, 2);
});
