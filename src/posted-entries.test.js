import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, unlink, write } from './orm.js';
import { payMove, postMove } from './models/accounting.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { handleApi } from '../server/api.js';

const clerk = { author: 'clerk', isAdmin: false };
const save = (db, next) => applyDiff(db, diffDb(db, next), clerk);
const forged = (db, model, rec) => applyDiff(db, { upserts: { [model]: [rec] }, deletes: {}, messages: [], removedMessages: [] }, clerk);
const postedInvoice = (db) => db.records['account.move'].find((m) => m.state === 'posted' && m.move_type === 'out_invoice');
const api = (db, method, path, body) => handleApi({ method, path, query: new URLSearchParams(), body, db, user: { name: 'clerk', isAdmin: false } });

test('a forged posted entry must be balanced and numbered', () => {
  const db = seed();
  const id = 9000;
  assert.throws(() => forged(db, 'account.move', { id, name: 'INV/2026/99999', move_type: 'out_invoice', state: 'posted', line_ids: [{ account_id: 1, debit: 1000000, credit: 0 }] }), /balanced/);
  assert.throws(() => forged(db, 'account.move', { id, name: '/', move_type: 'entry', state: 'posted', line_ids: [{ account_id: 1, debit: 5, credit: 0 }, { account_id: 2, debit: 0, credit: 5 }] }), /number/);
  const out = api(db, 'POST', '/api/v1/account.move', { name: 'INV/2026/88888', move_type: 'out_invoice', state: 'posted', amount_paid: 123 });
  assert.equal(out.status, 400);
});

test('a posted invoice cannot be marked paid, edited or deleted directly', () => {
  const db = seed();
  const inv = postedInvoice(db);
  assert.throws(() => save(db, write(db, 'account.move', inv.id, { amount_paid: inv.amount_total ?? 100 })), /paid amount|payments/i);
  assert.throws(() => forged(db, 'account.move', { ...inv, payments: [...(inv.payments ?? []), { date: '2026-10-26', amount: 50, move_id: 424242 }], amount_paid: (inv.amount_paid ?? 0) + 50 }), /posted journal entry/);
  assert.throws(() => forged(db, 'account.move', { ...inv, line_ids: [] }), /reset them to draft/);
  assert.throws(() => forged(db, 'account.move', { ...inv, state: 'cancel' }), /draft/);
  assert.throws(() => applyDiff(db, { upserts: {}, deletes: { 'account.move': [inv.id] } }, clerk), /cannot be deleted/);
  assert.equal(api(db, 'PATCH', `/api/v1/account.move/${inv.id}`, { invoice_line_ids: [{ name: 'x', qty: 1, price_unit: 1, tax: 0 }] }).status, 400);
});

test('a posted payment needs its posted journal entry', () => {
  const db = seed();
  assert.throws(() => forged(db, 'account.payment', { id: 9001, name: 'PBNK1/2026/0099', state: 'posted', amount: 500, date: '2026-10-26', payment_type: 'inbound' }), /journal entry/);
});

test('the real workflow still posts, pays, resets and deletes drafts', () => {
  let db = seed();
  const draft = create(db, 'account.move', { partner_id: 1, move_type: 'out_invoice', state: 'draft', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
  db = save(db, draft.db);
  db = save(db, postMove(db, draft.id));
  assert.equal(read(db, 'account.move', draft.id).state, 'posted');
  const half = read(db, 'account.move', draft.id).amount_total / 2;
  db = save(db, payMove(db, draft.id, half));
  assert.equal(read(db, 'account.move', draft.id).payment_state, 'partial');
  assert.throws(() => save(db, write(db, 'account.move', draft.id, { state: 'draft' })), /Paid entries/);
  const other = create(db, 'account.move', { partner_id: 1, move_type: 'out_invoice', state: 'draft', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 10, tax: 0 }] });
  db = save(db, postMove(save(db, other.db), other.id));
  db = save(db, write(db, 'account.move', other.id, { state: 'draft' }));
  db = save(db, unlink(db, 'account.move', [other.id]));
  assert.equal(read(db, 'account.move', other.id) ?? null, null);
});

const postedPaid = () => {
  let db = seed();
  const draft = create(db, 'account.move', { partner_id: 1, move_type: 'out_invoice', state: 'draft', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
  db = save(db, postMove(save(db, draft.db), draft.id));
  return { db, id: draft.id };
};

test('a posted entry cannot be archived, re-dated for follow-ups, or posted straight from cancelled', () => {
  const db = seed();
  const inv = postedInvoice(db);
  assert.throws(() => save(db, write(db, 'account.move', inv.id, { active: false })), /reset them to draft/);
  assert.throws(() => save(db, write(db, 'account.move', inv.id, { invoice_date_due: '2099-01-01' })), /reset them to draft/);
  const cancelled = { id: 9100, name: 'INV/2026/91000', move_type: 'out_invoice', state: 'cancel', partner_id: 1, line_ids: [{ account_id: 1, debit: 5, credit: 0 }, { account_id: 2, debit: 0, credit: 5 }] };
  const withCancelled = { ...db, records: { ...db.records, 'account.move': [...db.records['account.move'], cancelled] } };
  assert.throws(() => forged(withCancelled, 'account.move', { ...cancelled, state: 'posted' }), /Only draft entries/);
});

test('a forged payment cannot point at an unrelated entry, an invoice, or more than its entry booked', () => {
  const { db, id } = postedPaid();
  const inv = read(db, 'account.move', id);
  const other = postedInvoice(db);
  const misc = db.records['account.move'].find((m) => m.state === 'posted' && m.move_type === 'entry' && !(m.line_ids ?? []).some((l) => l.partner_id === inv.partner_id));
  for (const move_id of [other.id, misc?.id, id].filter(Boolean)) {
    assert.throws(() => forged(db, 'account.move', { ...inv, payments: [{ date: '2026-10-26', amount: 50, move_id }], amount_paid: 50 }), /posted journal entry/, String(move_id));
  }
  const paid = save(db, payMove(db, id, 40));
  const entry = read(paid, 'account.move', id).payments[0].move_id;
  const again = read(paid, 'account.move', id);
  assert.throws(() => forged(paid, 'account.move', { ...again, payments: [...again.payments, { date: '2026-10-26', amount: 40, move_id: entry }], amount_paid: 80 }), /more than its journal entry/);
  assert.throws(() => forged(paid, 'account.payment', { id: 9200, name: 'PBNK1/2026/9200', state: 'posted', partner_id: 1, amount: 100, move_id: other.id, payment_type: 'inbound' }), /journal entry/);
  assert.throws(() => forged(paid, 'account.payment', { id: 9201, name: 'PBNK1/2026/9201', state: 'posted', partner_id: 1, amount: 40, move_id: entry, payment_type: 'inbound' }), /another payment/);
});

test('the entry behind a posted payment cannot be reset or deleted', () => {
  const { db, id } = postedPaid();
  const paid = save(db, payMove(db, id, 40));
  const entry = read(paid, 'account.move', read(paid, 'account.move', id).payments[0].move_id);
  assert.throws(() => forged(paid, 'account.move', { ...entry, state: 'draft' }), /reverse the payment/);
  const drafted = { ...paid, records: { ...paid.records, 'account.move': paid.records['account.move'].map((m) => (m.id === entry.id ? { ...m, state: 'draft' } : m)) } };
  assert.throws(() => applyDiff(drafted, { upserts: {}, deletes: { 'account.move': [entry.id] } }, clerk), /reverse the payment/);
});

test('an invoice with a discount line on its own account still posts with positive journal items', async () => {
  const { accountId } = await import('./models/ledger.js');
  let db = seed();
  const draft = create(db, 'account.move', { partner_id: 1, move_type: 'out_invoice', state: 'draft', invoice_line_ids: [
    { name: 'Service', qty: 1, price_unit: 100, tax: 0 },
    { name: 'Discount: Reward', qty: 1, price_unit: -10, tax: 0, account_id: accountId(db, '690200') },
  ] });
  db = save(db, postMove(save(db, draft.db), draft.id));
  const lines = read(db, 'account.move', draft.id).line_ids;
  assert.ok(lines.every((l) => l.debit >= 0 && l.credit >= 0));
  assert.equal(lines.find((l) => l.account_id === accountId(db, '690200'))?.debit, 10);
});
