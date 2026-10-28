import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label && (b.when?.(read(db, model, id)) ?? true)).run(db, read(db, model, id)).db;

const confirmedSale = () => {
  const { db, id } = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 2, price_unit: 100, tax: 0 }] });
  return { db: run(db, 'sale.order', id, 'Confirm'), id };
};

test('a confirmed sales order cancels with its open delivery and draft invoice (FLOW-017)', () => {
  const { db, id } = confirmedSale();
  const invoiced = run(db, 'sale.order', id, 'Create Invoice');
  const cancelled = run(invoiced, 'sale.order', id, 'Cancel');
  assert.equal(read(cancelled, 'sale.order', id).state, 'cancel');
  assert.deepEqual(search(cancelled, 'stock.picking').filter((p) => p.sale_id === id).map((p) => p.state), ['cancel']);
  assert.deepEqual(search(cancelled, 'account.move').filter((m) => m.sale_id === id).map((m) => m.state), ['cancel']);
});

test('delivered goods and posted invoices must be returned or credited before cancelling', () => {
  const { db, id } = confirmedSale();
  const picking = search(db, 'stock.picking').find((p) => p.sale_id === id);
  const delivered = run(db, 'stock.picking', picking.id, 'Validate');
  assert.throws(() => run(delivered, 'sale.order', id, 'Cancel'), /Return the delivered goods/);

  const invoiced = run(db, 'sale.order', id, 'Create Invoice');
  const inv = search(invoiced, 'account.move').find((m) => m.sale_id === id);
  const posted = run(invoiced, 'account.move', inv.id, 'Confirm');
  assert.throws(() => run(posted, 'sale.order', id, 'Cancel'), /credit note/);
  const credited = run(posted, 'account.move', inv.id, 'Credit Note');
  const refund = search(credited, 'account.move').find((m) => m.move_type === 'out_refund' && m.invoice_origin === read(posted, 'account.move', inv.id).name);
  const refunded = refund.state === 'posted' ? credited : run(credited, 'account.move', refund.id, 'Confirm');
  assert.equal(read(run(refunded, 'sale.order', id, 'Cancel'), 'sale.order', id).state, 'cancel');
});

test('a confirmed purchase order cancels with its open receipt', () => {
  const { db: db0, id } = create(seed(), 'purchase.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 3, price_unit: 40, tax: 0 }] });
  const confirmed = run(db0, 'purchase.order', id, 'Confirm Order');
  const cancelled = run(confirmed, 'purchase.order', id, 'Cancel');
  assert.equal(read(cancelled, 'purchase.order', id).state, 'cancel');
  assert.deepEqual(search(cancelled, 'stock.picking').filter((p) => p.purchase_id === id).map((p) => p.state), ['cancel']);
  const receipt = search(confirmed, 'stock.picking').find((p) => p.purchase_id === id);
  const received = run(confirmed, 'stock.picking', receipt.id, 'Validate');
  assert.throws(() => run(received, 'purchase.order', id, 'Cancel'), /Return the received goods/);
});
