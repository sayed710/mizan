import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { journalItems } from './models/ledger.js';
import { applyRule } from './models/reconcile.js';
import { seed } from './seed.js';

const LINE = 'account.bank.statement.line';
const run = (db, id, label) => models[LINE].form.buttons.find((b) => b.label === label).run(db, read(db, LINE, id)).db;
const addLine = (db, vals) => create(db, LINE, { date: '2026-10-01', payment_ref: 'test', state: 'to_check', ...vals });
const openInvoice = (db) => search(db, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted' && m.amount_residual > 0);
const openBill = (db) => search(db, 'account.move').find((m) => m.move_type === 'in_invoice' && m.state === 'posted' && m.amount_residual > 0);

test('a line larger than what is due is refused instead of reconciled for less', () => {
  const db0 = seed();
  const inv = openInvoice(db0);
  const { db, id } = addLine(db0, { amount: inv.amount_residual + 500, move_id: inv.id });
  assert.throws(() => run(db, id, 'Match'), /only has .* left to pay/);
});

test('money received cannot settle a vendor bill, and money paid out cannot settle an invoice', () => {
  const db0 = seed();
  const { db, id } = addLine(db0, { amount: 10, move_id: openBill(db0).id });
  assert.throws(() => run(db, id, 'Match'), /Money received/);
  const { db: db2, id: id2 } = addLine(db0, { amount: -10, move_id: openInvoice(db0).id });
  assert.throws(() => run(db2, id2, 'Match'), /Money paid out/);
});

test('a paid or draft document cannot be matched, so no line is reconciled without an entry', () => {
  const db0 = seed();
  const inv = openInvoice(db0);
  const paid = write(db0, 'account.move', inv.id, { amount_paid: inv.amount_total });
  const { db, id } = addLine(paid, { amount: 10, move_id: inv.id });
  assert.throws(() => run(db, id, 'Match'), /nothing left to pay/);
  assert.equal(read(db, LINE, id).state, 'to_check');
});

test('a partial amount pays exactly the line amount', () => {
  const db0 = seed();
  const inv = openInvoice(db0);
  const { db, id } = addLine(db0, { amount: 10, move_id: inv.id });
  const done = run(db, id, 'Match');
  assert.equal(read(done, LINE, id).state, 'reconciled');
  assert.equal(read(done, 'account.move', inv.id).amount_paid, (Number(inv.amount_paid) || 0) + 10);
});

test('booking to an account links the line to its bank entry', () => {
  const db0 = seed();
  const rent = search(db0, LINE).find((l) => l.payment_ref.includes('rent'));
  const db = run(db0, rent.id, 'Book to Account');
  const line = read(db, LINE, rent.id);
  const entry = read(db, 'account.move', line.move_id);
  assert.equal(entry.state, 'posted');
  assert.equal(journalItems(db).filter((l) => l.move_id === entry.id).reduce((s, l) => s + l.debit, 0), 1800);
});

test('a zero line is refused by every reconciliation path', () => {
  const db0 = seed();
  const { db, id } = addLine(db0, { amount: 0, counterpart: '690000' });
  assert.throws(() => run(db, id, 'Book to Account'), /of 0/);
  assert.throws(() => applyRule(db, { rule_type: 'writeoff_button', line_ids: [{ account_code: '690000', amount_type: 'percentage', amount: 100 }] }, read(db, LINE, id)), /of 0/);
});

test('a line cannot be marked reconciled without a posted entry, nor changed once reconciled', () => {
  const db0 = seed();
  const line = search(db0, LINE)[0];
  assert.throws(() => write(db0, LINE, line.id, { state: 'reconciled' }), /posted journal entry/);
  const rent = search(db0, LINE).find((l) => l.payment_ref.includes('rent'));
  const db = run(db0, rent.id, 'Book to Account');
  assert.throws(() => write(db, LINE, rent.id, { amount: -1 }), /cannot be changed/);
  assert.throws(() => write(db, LINE, rent.id, { state: 'to_check' }), /cannot be changed/);
});

test('server mode: the booked entry and the reconciled line are accepted in one change set', async () => {
  const { applyDiff, diffDb } = await import('./sync.js');
  const db0 = seed();
  const rent = search(db0, LINE).find((l) => l.payment_ref.includes('rent'));
  const next = run(db0, rent.id, 'Book to Account');
  const d = diffDb(db0, next);
  const reordered = { ...d, upserts: Object.fromEntries(Object.entries(d.upserts).sort(([a], [b]) => a.localeCompare(b))) };
  const out = applyDiff(db0, reordered, { author: 'Admin' });
  assert.equal(out.records[LINE].find((l) => l.id === rent.id).state, 'reconciled');
});

test('a bank line cannot cite an entry that does not exist, locally or on the server', async () => {
  const { applyDiff, diffDb } = await import('./sync.js');
  const db0 = seed();
  const line = search(db0, LINE)[0];
  assert.throws(() => write(db0, LINE, line.id, { state: 'reconciled', move_id: 987654 }), /posted journal entry/);
  const forged = { ...db0, records: { ...db0.records, [LINE]: db0.records[LINE].map((l) => (l.id === line.id ? { ...l, state: 'reconciled', move_id: 987654 } : l)) } };
  assert.throws(() => applyDiff(db0, diffDb(db0, forged), { author: 'Clerk' }), /posted journal entry/);
});

test('an entry matched with a reconciled bank line cannot be reset, cancelled or deleted, nor can the label drift', async () => {
  const { applyDiff, diffDb } = await import('./sync.js');
  const db0 = seed();
  const rent = search(db0, LINE).find((l) => l.payment_ref.includes('rent'));
  const db = run(db0, rent.id, 'Book to Account');
  const booked = read(db, LINE, rent.id).move_id;
  assert.throws(() => write(db, 'account.move', booked, { state: 'draft' }), /has to stay posted/);
  assert.throws(() => write(db, 'account.move', booked, { state: 'cancel' }), /has to stay posted/);
  assert.throws(() => applyDiff(db, { upserts: {}, deletes: { 'account.move': [booked] } }, { author: 'Clerk' }), /cannot be deleted/);
  const reset = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => (m.id === booked ? { ...m, state: 'draft' } : m)) } };
  assert.throws(() => applyDiff(db, diffDb(db, reset), { author: 'Clerk' }), /has to stay posted/);
  assert.throws(() => write(db, LINE, rent.id, { payment_ref: 'something else' }), /cannot be changed/);
});
