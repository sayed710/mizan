import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { models } from './models/index.js';
import { today } from './models/common.js';
import { invoiceKpis } from './dashboardKpis.js';
import { seed } from './seed.js';

const post = (db, vals) => {
  const made = create(db, 'account.move', { partner_id: 2, invoice_date: today(), invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }], ...vals });
  return models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(made.db, read(made.db, 'account.move', made.id)).db;
};

test('invoicing KPIs are net of customer credit notes and vendor refunds', () => {
  const base = seed();
  const before = invoiceKpis(base, today().slice(0, 7));
  const withInvoice = post(base, { move_type: 'out_invoice' });
  const withRefund = post(withInvoice, { move_type: 'out_refund' });
  const after = invoiceKpis(withRefund, today().slice(0, 7));
  assert.equal(after.receivable, before.receivable);
  assert.equal(after.invoicedThisMonth, before.invoicedThisMonth);
  const customer = (k) => k.topCustomers.find(([id]) => Number(id) === 2)?.[1] ?? 0;
  assert.equal(customer(after), customer(before));
  const bills = post(post(base, { move_type: 'in_invoice' }), { move_type: 'in_refund' });
  assert.equal(invoiceKpis(bills, today().slice(0, 7)).payable, before.payable);
});

test('the overdue count is what the linked Overdue filter shows', () => {
  const db = post(seed(), { move_type: 'out_invoice', invoice_date_due: '2000-01-01' });
  const overdue = models['account.move'].filters.flat().find((f) => f.id === 'overdue');
  const listed = db.records['account.move'].filter((m) => m.move_type === 'out_invoice' && overdue.fn(m));
  assert.equal(invoiceKpis(db, today().slice(0, 7)).overdue, listed.length);
  assert.ok(listed.length > 0);
});
