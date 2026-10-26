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
