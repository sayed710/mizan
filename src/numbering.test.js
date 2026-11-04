import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
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

const posted = (db, id) => postMove(db, id);
const savedPair = () => {
  let base = seed();
  const a = draft(base, 100);
  const b = draft(a.db, 200);
  base = applyDiff(base, diffDb(base, b.db), {});
  return { base, a, b, alice: posted(base, a.id), bob: posted(base, b.id) };
};

test('deleting the latest numbered record on the server never frees its number', () => {
  const prefix = 'DEL/2026/';
  let db = { ...seed(), records: { ...seed().records, 'account.payment': [{ id: 1, name: `${prefix}00001`, state: 'draft' }, { id: 2, name: `${prefix}00002`, state: 'draft' }] } };
  db = applyDiff(db, { upserts: {}, deletes: { 'account.payment': [2] } }, {});
  assert.equal(nextName(db, 'account.payment', prefix), `${prefix}00003`);
  const late = applyDiff(db, { upserts: { 'account.payment': [{ id: 3, name: `${prefix}00001`, state: 'draft' }] } }, {});
  assert.equal(read(late, 'account.payment', 3).name, `${prefix}00003`);
});

test('custom expense report references are kept as typed', () => {
  const db = seed();
  const employee_id = db.records['hr.employee'][0].id;
  const sheets = [{ id: 1, name: 'Travel 2026', employee_id, state: 'draft' }, { id: 2, name: 'Travel 2026', employee_id, state: 'draft' }];
  const out = applyDiff(db, { upserts: { 'hr.expense.sheet': sheets } }, {});
  assert.deepEqual(out.records['hr.expense.sheet'].map((s) => s.name), ['Travel 2026', 'Travel 2026']);
});

test('generated expense sheet names are unique and keep their high-water mark', () => {
  const base = seed();
  const employee_id = base.records['hr.employee'][0].id;
  const out = applyDiff(base, { upserts: { 'hr.expense.sheet': [{ id: 900, name: 'EXP/00001', employee_id, state: 'draft' }, { id: 901, name: 'EXP/00001', employee_id, state: 'draft' }] } });
  assert.deepEqual(out.records['hr.expense.sheet'].filter((r) => r.id >= 900).map((r) => r.name), ['EXP/00001', 'EXP/00002']);
  const gone = applyDiff(out, { deletes: { 'hr.expense.sheet': [901] } });
  assert.equal(nextName(gone, 'hr.expense.sheet', 'EXP/'), 'EXP/00003');
});

test('a later edit after a missed renumbering response already preserves the server-assigned number', () => {
  const { base, b, alice, bob } = savedPair();
  const first = applyDiff(base, diffDb(base, alice));
  const assigned = applyDiff(first, diffDb(base, bob));
  const name = read(assigned, 'account.move', b.id).name;
  const edited = write(bob, 'account.move', b.id, { ref: 'Changed after missed response' });
  const saved = applyDiff(assigned, diffDb(bob, edited));
  assert.equal(read(saved, 'account.move', b.id).name, name);
  assert.equal(read(saved, 'account.move', b.id).ref, 'Changed after missed response');
});

test('explicit resubmission of a stale provisional name cannot renumber an existing document', () => {
  const { base, b, alice, bob } = savedPair();
  const assigned = applyDiff(applyDiff(base, diffDb(base, alice)), diffDb(base, bob));
  const storedName = read(assigned, 'account.move', b.id).name;
  const stale = bob.records['account.move'].find((m) => m.id === b.id);
  const saved = applyDiff(assigned, { upserts: { 'account.move': [{ ...stale, ref: 'Retry with provisional name' }] } });
  assert.equal(read(saved, 'account.move', b.id).name, storedName);
  assert.equal(read(saved, 'account.move', b.id).ref, 'Retry with provisional name');
});

test('server renumbering uses the request author and newly enabled audit setting', () => {
  const { base, a, b, alice, bob } = savedPair();
  const server = applyDiff(base, diffDb(base, alice), { author: 'First' });
  const diff = diffDb(base, bob);
  diff.settings = { ...base.settings, audit_trail: true };
  const saved = applyDiff(server, diff, { author: 'Second', isAdmin: true });
  const msg = saved.messages.find((m) => m.res_id === b.id && m.model === 'account.move' && m.body.includes('assigned by the server'));
  assert.ok(msg, 'audit enablement takes effect in this diff');
  assert.equal(msg.author, 'Second');
  assert.notEqual(read(saved, 'account.move', a.id).name, read(saved, 'account.move', b.id).name);
});

test('a renumbered invoice carries the final number on its booked journal item and in the audit trail', () => {
  const { base, a, b, alice, bob } = savedPair();
  const audited = { ...base, settings: { ...base.settings, audit_trail: true } };
  let server = applyDiff(audited, diffDb(base, alice), {});
  server = applyDiff(server, diffDb(base, bob), {});
  const second = read(server, 'account.move', b.id);
  assert.notEqual(second.name, read(server, 'account.move', a.id).name);
  assert.ok(second.line_ids.some((l) => l.name === second.name), 'counterpart item shows the final number');
  assert.ok(second.line_ids.every((l) => l.name !== read(server, 'account.move', a.id).name));
  assert.ok(server.messages.some((m) => m.model === 'account.move' && m.res_id === b.id && m.body.includes(`→ ${second.name}`)));
});
