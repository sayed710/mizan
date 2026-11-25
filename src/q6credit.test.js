import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { addDays, today } from './models/common.js';
import { seed } from './seed.js';

test('credit warnings compare dated foreign amounts and receivables in company currency', () => {
  const base = write(seed(), 'res.company', 1, { account_use_credit_limit: true });
  const currency = search(base, 'res.currency').find((c) => c.name === 'EUR');
  const partner = create(base, 'res.partner', { name: 'Credit customer', use_partner_credit_limit: true, credit_limit: 1050 });
  const dated = addDays(today(), -30);
  const inv = create(partner.db, 'account.move', { move_type: 'out_invoice', partner_id: partner.id, currency_id: currency.id, invoice_date: dated, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 920, tax: 0 }] });
  const posted = models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(inv.db, read(inv.db, 'account.move', inv.id)).db;
  const sale = create(posted, 'sale.order', { partner_id: partner.id, date_order: today(), currency_id: currency.id, order_line: [{ product_id: 1, qty: 1, price_unit: 90, tax: 0 }] });
  const warn = (db, model, id) => models[model].form.warning(read(db, model, id), db);
  assert.match(warn(sale.db, 'sale.order', sale.id), /Credit customer has reached its credit limit of: \$1,050\.00\. Total amount due \(including this document\): \$1,100\.00/);
  const draft = create(posted, 'account.move', { move_type: 'out_invoice', partner_id: partner.id, currency_id: currency.id, invoice_date: today(), invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 90, tax: 0 }] });
  assert.match(warn(draft.db, 'account.move', draft.id), /Credit customer has reached its credit limit of: \$1,050\.00\. Total amount due \(including this document\): \$1,100\.00/);
  const higherLimit = write(sale.db, 'res.partner', partner.id, { credit_limit: 1150 });
  assert.ok(!warn(higherLimit, 'sale.order', sale.id));
});

for (const model of ['account.move', 'sale.order']) {
  test(`cancelling a ${model} suppresses its credit warning even when existing debt exceeds the limit`, () => {
    const base = write(seed(), 'res.company', 1, { account_use_credit_limit: true });
    const partner = create(base, 'res.partner', { name: 'Cancelled document customer', use_partner_credit_limit: true, credit_limit: 100 });
    const existing = create(partner.db, 'account.move', { move_type: 'out_invoice', partner_id: partner.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 150, tax: 0 }] });
    const post = models['account.move'].form.buttons.find((button) => button.label === 'Confirm');
    const posted = post.run(existing.db, read(existing.db, 'account.move', existing.id)).db;
    const values = model === 'account.move'
      ? { move_type: 'out_invoice', partner_id: partner.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }] }
      : { partner_id: partner.id, order_line: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }] };
    const document = create(posted, model, values);
    const form = models[model].form;
    assert.match(form.warning(read(document.db, model, document.id), document.db), /credit limit/);
    const cancelled = form.buttons.find((button) => button.label === 'Cancel').run(document.db, read(document.db, model, document.id)).db;
    assert.equal(read(cancelled, model, document.id).state, 'cancel');
    assert.equal(form.warning(read(cancelled, model, document.id), cancelled), '');
  });
}

test('sales credit warning counts only the uninvoiced balance after an invoice is posted and paid', async () => {
  const { payMove } = await import('./models/accounting.js');
  const base = write(seed(), 'res.company', 1, { account_use_credit_limit: true });
  const partner = create(base, 'res.partner', { name: 'Sales credit customer', use_partner_credit_limit: true, credit_limit: 150 });
  const order = create(partner.db, 'sale.order', { partner_id: partner.id, order_line: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const run = (db, model, id, label, options) => models[model].form.buttons.find((button) => button.label === label).run(db, read(db, model, id), options).db;
  const warning = (db) => models['sale.order'].form.warning(read(db, 'sale.order', order.id), db);
  let db = run(order.db, 'sale.order', order.id, 'Confirm');
  assert.equal(warning(db), '');
  db = run(db, 'sale.order', order.id, 'Create Invoice', { method: 'regular' });
  const invoice = search(db, 'account.move').find((move) => move.sale_id === order.id && move.move_type === 'out_invoice');
  db = run(db, 'account.move', invoice.id, 'Confirm');
  assert.equal(read(db, 'account.move', invoice.id).amount_residual, 100);
  assert.equal(warning(db), '');
  db = payMove(db, invoice.id, 100, today());
  assert.equal(warning(db), '');
});

test('sales credit warning tracks partial down payments and cancelled draft invoices', () => {
  const base = write(seed(), 'res.company', 1, { account_use_credit_limit: true });
  const partner = create(base, 'res.partner', { name: 'Partial sales customer', use_partner_credit_limit: true, credit_limit: 90 });
  const order = create(partner.db, 'sale.order', { partner_id: partner.id, order_line: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const run = (db, model, id, label, options) => models[model].form.buttons.find((button) => button.label === label).run(db, read(db, model, id), options).db;
  const warning = (db) => models['sale.order'].form.warning(read(db, 'sale.order', order.id), db);
  let db = run(order.db, 'sale.order', order.id, 'Confirm');
  assert.match(warning(db), /Partial sales customer has reached its credit limit of: \$90\.00\. Total amount due \(including this document\): \$100\.00/);
  db = run(db, 'sale.order', order.id, 'Create Invoice', { method: 'fixed', amount: 40 });
  const invoice = search(db, 'account.move').find((move) => move.sale_id === order.id && move.move_type === 'out_invoice');
  assert.equal(warning(db), '');
  const cancelled = run(db, 'account.move', invoice.id, 'Cancel');
  assert.match(warning(cancelled), /Partial sales customer has reached its credit limit of: \$90\.00\. Total amount due \(including this document\): \$100\.00/);
  db = run(db, 'account.move', invoice.id, 'Confirm');
  assert.match(warning(db), /Partial sales customer has reached its credit limit of: \$90\.00\. Total amount due \(including this document\): \$100\.00/);
});

test('sales credit warning uses the invoice partner and falls back to the customer', () => {
  const base = write(seed(), 'res.company', 1, { account_use_credit_limit: true });
  const customer = create(base, 'res.partner', { name: 'Sales contact', use_partner_credit_limit: true, credit_limit: 500 });
  const billing = create(customer.db, 'res.partner', { name: 'Billing contact', use_partner_credit_limit: true, credit_limit: 100 });
  const existing = create(billing.db, 'account.move', { move_type: 'out_invoice', partner_id: billing.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 80, tax: 0 }] });
  const run = (db, model, id, label, options) => models[model].form.buttons.find((button) => button.label === label).run(db, read(db, model, id), options).db;
  const posted = run(existing.db, 'account.move', existing.id, 'Confirm');
  const sale = create(posted, 'sale.order', { partner_id: customer.id, partner_invoice_id: billing.id, order_line: [{ product_id: 1, qty: 1, price_unit: 30, tax: 0 }] });
  const warning = (db) => models['sale.order'].form.warning(read(db, 'sale.order', sale.id), db);
  assert.match(warning(sale.db), /Billing contact has reached its credit limit of: \$100\.00\. Total amount due \(including this document\): \$110\.00/);
  const fallback = write(sale.db, 'sale.order', sale.id, { partner_invoice_id: null });
  assert.equal(warning(fallback), '');
  let db = run(sale.db, 'sale.order', sale.id, 'Confirm');
  db = run(db, 'sale.order', sale.id, 'Create Invoice', { method: 'regular' });
  const invoice = search(db, 'account.move').find((move) => move.sale_id === sale.id);
  assert.equal(invoice.partner_id, billing.id);
  assert.match(models['account.move'].form.warning(invoice, db), /Billing contact has reached its credit limit of: \$100\.00\. Total amount due \(including this document\): \$110\.00/);
});
