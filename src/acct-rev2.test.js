import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as sales from './models/sales.js';
import { invoiceReportModels } from './models/invoiceReport.js';

test('quantity to invoice uses each product invoicing policy', () => {
  const db = { records: { product: [{ id: 1, invoice_policy: 'order' }, { id: 2, invoice_policy: 'delivery' }] } };
  assert.equal(sales.qtyToInvoice(db, { product_id: 1, qty: 10, qty_delivered: 3, qty_invoiced: 2 }), 8);
  assert.equal(sales.qtyToInvoice(db, { product_id: 2, qty: 10, qty_delivered: 3, qty_invoiced: 2 }), 1);
  assert.equal(sales.qtyToInvoice(db, { product_id: 2, qty: 10, qty_delivered: 3, qty_invoiced: 5 }), -2);
});

test('invoice analysis exposes country, journal and fiscal position grouping', () => {
  const report = invoiceReportModels['account.invoice.report'];
  for (const field of ['country_id', 'journal_id', 'fiscal_position_id']) {
    assert.ok(report.fields[field]);
    assert.ok(report.groupBys.includes(field));
  }
});
