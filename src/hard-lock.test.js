import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { payMove } from './models/accounting.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

const LOCK = '2026-12-31';
const locked = () => {
  const db = seed();
  return { ...db, settings: { ...db.settings, lock_date: LOCK, hard_lock_date: LOCK } };
};
const invoiceIn = (db) => db.records['account.move'].map((m) => read(db, 'account.move', m.id))
  .find((m) => m.state === 'posted' && m.move_type === 'out_invoice' && m.invoice_date <= LOCK && m.amount_residual > 0);
const save = (db, next) => applyDiff(db, diffDb(db, next), { author: 'clerk', isAdmin: false });

test('a hard-locked entry cannot be marked paid, archived, or moved to another company or journal', () => {
  const db = locked();
  const inv = invoiceIn(db);
  assert.ok(inv, 'seed has a posted invoice in the locked period');
  for (const vals of [
    { amount_paid: inv.amount_total },
    { amount_paid: inv.amount_total, payments: [...(inv.payments ?? []), { date: '2026-06-01', amount: inv.amount_total }], payment_date: '2026-06-01' },
    { active: false },
    { company_id: 2 },
    { journal_id: 99 },
    { fiscal_position_id: 1 },
  ]) {
    assert.throws(() => save(db, write(db, 'account.move', inv.id, vals)), /locked/, JSON.stringify(vals));
  }
});

test('a payment dated after the lock still settles a locked invoice', () => {
  const db = locked();
  const inv = invoiceIn(db);
  const paid = payMove(db, inv.id, inv.amount_residual, '2027-01-05');
  const saved = save(db, paid);
  assert.equal(read(saved, 'account.move', inv.id).payment_state, 'paid');
});

test('a payment cannot be booked into, or changed inside, the locked period', () => {
  const db = locked();
  const inv = invoiceIn(db);
  assert.throws(() => save(db, payMove(db, inv.id, inv.amount_residual, '2026-06-01')), /locked/);
  const vals = { state: 'posted', amount: 10, date: '2026-06-01', payment_type: 'inbound' };
  assert.throws(() => create(db, 'account.payment', vals), /locked/);
  const forged = { upserts: { 'account.payment': [{ id: 900, ...vals }] }, deletes: {}, messages: [], removedMessages: [] };
  assert.throws(() => applyDiff(db, forged, { author: 'clerk', isAdmin: false }), /locked/);
  const draft = create(db, 'account.payment', { state: 'draft', amount: 10, date: '2026-06-01', payment_type: 'inbound' });
  assert.doesNotThrow(() => save(db, draft.db));
});

test('a forged payment object cannot mark a locked invoice paid', () => {
  const db = locked();
  const inv = invoiceIn(db);
  const other = db.records['account.move'].find((m) => m.state === 'posted' && m.id !== inv.id && !(m.line_ids ?? []).some((l) => l.partner_id === inv.partner_id));
  for (const forged of [{ date: '2027-01-05', amount: inv.amount_residual }, { date: '2027-01-05', amount: inv.amount_residual, move_id: other?.id ?? 999999 }]) {
    const next = write(db, 'account.move', inv.id, { amount_paid: (Number(inv.amount_paid) || 0) + inv.amount_residual, payment_date: '2027-01-05', payments: [...(inv.payments ?? []), forged] });
    assert.throws(() => save(db, next), /locked/, JSON.stringify(forged));
  }
});

test('an early-payment discount after the lock settles a locked invoice', async () => {
  const { payWithDiscount } = await import('./models/accounting.js');
  const { search } = await import('./orm.js');
  const base = seed();
  const term = search(base, 'account.payment.term').find((t) => t.name === '2/7 Net 30').id;
  const made = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-12-30', invoice_payment_term_id: term, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const { models } = await import('./models/index.js');
  const posted = models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(made.db, read(made.db, 'account.move', made.id)).db;
  const db = { ...posted, settings: { ...posted.settings, lock_date: LOCK, hard_lock_date: LOCK } };
  const saved = save(db, payWithDiscount(db, made.id, 98, '2027-01-02'));
  assert.equal(read(saved, 'account.move', made.id).amount_residual, 0);
});

test('posted payments and reconciled bank lines inside the lock cannot be deleted or renumbered', () => {
  const db = locked();
  const pay = { id: 9001, name: 'PBNK1/2026/9001', state: 'posted', amount: 10, date: '2026-06-01', payment_type: 'inbound', partner_type: 'customer' };
  const line = { id: 9002, payment_ref: 'Old', state: 'reconciled', amount: 10, date: '2026-06-01', unique_import_id: 'abc' };
  const withThem = { ...db, records: { ...db.records, 'account.payment': [...(db.records['account.payment'] ?? []), pay], 'account.bank.statement.line': [...(db.records['account.bank.statement.line'] ?? []), line] } };
  const opts = { author: 'clerk', isAdmin: false };
  assert.throws(() => applyDiff(withThem, { upserts: {}, deletes: { 'account.payment': [pay.id] } }, opts), /locked/);
  assert.throws(() => applyDiff(withThem, { upserts: {}, deletes: { 'account.bank.statement.line': [line.id] } }, opts), /locked/);
  assert.throws(() => applyDiff(withThem, { upserts: { 'account.payment': [{ ...pay, name: 'X' }] } }, opts), /locked/);
  assert.throws(() => applyDiff(withThem, { upserts: { 'account.payment': [{ ...pay, partner_type: 'supplier' }] } }, opts), /locked/);
  assert.throws(() => applyDiff(withThem, { upserts: { 'account.bank.statement.line': [{ ...line, unique_import_id: 'xyz' }] } }, opts), /locked/);
});
