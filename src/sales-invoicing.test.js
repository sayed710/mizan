import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

test('a sales order invoices only what is left, tracks delivered quantities and uses its payment term', () => {
  const db0 = seed();
  const term = search(db0, 'account.payment.term').find((t) => t.name === '30 Days').id;
  const { db, id } = create(db0, 'sale.order', { partner_id: 3, payment_term_id: term, commitment_date: '2026-12-01', order_line: [{ product_id: 7, qty: 4, price_unit: 100, tax: 0 }] });
  const confirmed = run(db, 'sale.order', id, 'Confirm').db;
  const picking = search(confirmed, 'stock.picking').find((p) => p.sale_id === id);
  assert.equal(picking.scheduled_date, '2026-12-01');

  const delivered = run(confirmed, 'stock.picking', picking.id, 'Validate').db;
  assert.equal(read(delivered, 'sale.order', id).order_line[0].qty_delivered, 4);

  const invoiced = run(delivered, 'sale.order', id, 'Create Invoice').db;
  const inv = search(invoiced, 'account.move').find((m) => m.sale_id === id);
  assert.equal(inv.invoice_payment_term_id, term);
  assert.equal(inv.invoice_line_ids[0].qty, 4);
  assert.equal(read(invoiced, 'sale.order', id).invoice_status, 'invoiced');
  assert.throws(() => run(invoiced, 'sale.order', id, 'Create Invoice'), /already invoiced/);
});

test('delivered-quantity products invoice only what was delivered; product tax and income account apply', () => {
  const db0 = seed();
  const income = db0.records['account.account'].find((a) => a.code === '450000').id;
  let db = write(db0, 'product', 7, { invoice_policy: 'delivery', sale_tax: 5, property_account_income_id: income });
  const line = models['sale.order'].fields.order_line.onchange({ product_id: 7, qty: 5 }, 'product_id', db, {});
  assert.equal(line.tax, 5);
  const created = create(db, 'sale.order', { partner_id: 3, order_line: [{ ...line, qty: 5, price_unit: 100 }] });
  db = run(created.db, 'sale.order', created.id, 'Confirm').db;
  assert.throws(() => run(db, 'sale.order', created.id, 'Create Invoice'), /Nothing left to invoice/);
  const picking = search(db, 'stock.picking').find((p) => p.sale_id === created.id);
  const partial = write(db, 'stock.picking', picking.id, { move_ids: [{ product_id: 7, qty: 2 }] });
  const delivered = run(partial, 'stock.picking', picking.id, 'Validate').db;
  const invoiced = run(delivered, 'sale.order', created.id, 'Create Invoice').db;
  const inv = search(invoiced, 'account.move').find((m) => m.sale_id === created.id);
  assert.equal(inv.invoice_line_ids[0].qty, 2);
  const posted = models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(invoiced, read(invoiced, 'account.move', inv.id)).db;
  assert.ok(read(posted, 'account.move', inv.id).line_ids.some((l) => l.account_id === income && l.credit > 0));
});
