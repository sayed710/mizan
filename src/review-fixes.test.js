import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, unlink, updateSettings } from './orm.js';
import { models } from './models/index.js';
import { applyDiff } from './sync.js';
import { payWithDiscount } from './models/accounting.js';
import { postBatch } from './models/payments.js';
import { addDays, today } from './models/common.js';
import { seed } from './seed.js';

const button = (model, label) => models[model].form.buttons.find((b) => b.label === label);
const post = (db, id) => button('account.move', 'Confirm').run(db, read(db, 'account.move', id)).db;
const bill = (db, vals = {}) => {
  const { db: next, id } = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }], ...vals });
  return { db: post(next, id), id };
};

test('the server stores a lock date sent by an admin', () => {
  assert.equal(applyDiff(seed(), { upserts: {}, deletes: {}, settings: { lock_date: '2026-03-31' } }).settings.lock_date, '2026-03-31');
});

test('a diff cannot renumber a posted entry and delete it under the audit trail', () => {
  const { db, id } = bill(updateSettings(seed(), { audit_trail: true }));
  const move = read(db, 'account.move', id);
  assert.throws(() => applyDiff(db, { upserts: { 'account.move': [{ ...move, name: '/' }] }, deletes: { 'account.move': [id] } }), /audit trail/);
});

test('an early-payment discount never pays more than the amount due', () => {
  const db0 = seed();
  const term = search(db0, 'account.payment.term').find((t) => t.name === '2/7 Net 30').id;
  const { db, id } = bill(db0, { invoice_payment_term_id: term, invoice_date: today() });
  const full = payWithDiscount(db, id, 100);
  assert.equal(read(full, 'account.move', id).amount_paid, 100);
  const net = payWithDiscount(db, id, 98);
  assert.equal(read(net, 'account.move', id).amount_paid, 100);
  assert.equal(read(net, 'account.move', id).amount_residual, 0);
});

test('a batch refuses the same invoice twice', () => {
  const { db, id } = bill(seed());
  const { db: withBatch, id: batch } = create(db, 'account.batch.payment', { batch_type: 'inbound', lines: [{ move_id: id, amount: 100 }, { move_id: id, amount: 100 }] });
  assert.throws(() => postBatch(withBatch, read(withBatch, 'account.batch.payment', batch)), /only once/);
});

test('cancelling or deleting an order invoice makes its quantities invoiceable again', () => {
  const { db: d0, id: so } = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 1, qty: 2, price_unit: 100, tax: 0 }] });
  const confirmed = button('sale.order', 'Confirm').run(d0, read(d0, 'sale.order', so)).db;
  const invoiced = button('sale.order', 'Create Invoice').run(confirmed, read(confirmed, 'sale.order', so)).db;
  const inv = search(invoiced, 'account.move').find((m) => m.sale_id === so);
  assert.equal(read(invoiced, 'sale.order', so).invoice_status, 'invoiced');
  const cancelled = button('account.move', 'Cancel').run(invoiced, inv).db;
  assert.equal(read(cancelled, 'sale.order', so).invoice_status, 'to_invoice');
  assert.equal(read(unlink(invoiced, 'account.move', [inv.id]), 'sale.order', so).invoice_status, 'to_invoice');
});

test('payments dated after the lock date still settle a locked invoice', () => {
  const { db, id } = bill(seed(), { invoice_date: addDays(today(), -20) });
  const locked = updateSettings(db, { lock_date: addDays(today(), -5) });
  assert.equal(read(payWithDiscount(locked, id, 100), 'account.move', id).amount_residual, 0);
  assert.throws(() => payWithDiscount(locked, id, 100, addDays(today(), -10)), /locked/);
});
