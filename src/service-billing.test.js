import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => {
  const out = models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));
  return out?.db ?? out;
};
const service = (db) => search(db, 'product').find((p) => p.default_code === 'SRV-002');

test('a purchased service is billable on the ordered quantity, with no receipt', () => {
  const db0 = seed();
  const srv = service(db0);
  // Products created without the form onchange still carry the "received quantities" default.
  assert.equal(srv.purchase_method ?? 'receive', 'receive');
  const { db, id } = create(db0, 'purchase.order', { partner_id: 2, order_line: [{ product_id: srv.id, qty: 3, price_unit: 20, tax: 0 }] });
  const confirmed = run(db, 'purchase.order', id, 'Confirm Order');
  const po = read(confirmed, 'purchase.order', id);
  assert.equal(po.order_line[0].purchase_method, 'purchase');
  assert.equal(po.invoice_status, 'to_invoice');
  assert.equal(search(confirmed, 'stock.picking').filter((p) => p.purchase_id === id).length, 0);
  const billed = run(confirmed, 'purchase.order', id, 'Create Bill');
  const bill = search(billed, 'account.move').find((m) => m.move_type === 'in_invoice' && m.purchase_id === id);
  assert.deepEqual(bill.invoice_line_ids.map((l) => [l.product_id, l.qty]), [[srv.id, 3]]);
});

test('the bill policy on purchase lines is a declared field, so the server keeps it', () => {
  assert.ok(models['purchase.order'].fields.order_line.fields.purchase_method);
});
