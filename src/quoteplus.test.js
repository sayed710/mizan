import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { addDays, amounts, today } from './models/common.js';
import { ecommerceModels } from './models/ecommerce.js';
import { isBalanced } from './models/ledger.js';
import { addOption, applyTemplate, expireQuotes, payQuote, prepaymentAmount, quotePlusModels, signQuote } from './models/quoteplus.js';

const definition = quotePlusModels['sale.order'];
const isExpired = (db, id) => definition.fields.is_expired.compute(read(db, 'sale.order', id));
const quote = (vals = {}) => create(seed(), 'sale.order', {
  partner_id: 1, validity_date: addDays(today(), 10),
  order_line: [{ product_id: 1, qty: 2, price_unit: 100, discount: 10, tax: 14 }], ...vals,
});

test('quotation templates replace lines with customer pricelist prices, taxes, terms and validity without mutation', () => {
  const original = seed();
  const pl = create(original, 'product.pricelist', { name: 'Template prices', items: [{ product_id: 1, min_qty: 2, fixed_price: 70 }, { product_id: 6, fixed_price: 25 }] });
  const partner = write(pl.db, 'res.partner', 1, { pricelist_id: pl.id });
  const t = create(partner, 'sale.order.template', {
    name: 'Office', number_of_days: 12, line_ids: [{ product_id: 1, qty: 2, discount: 10 }],
    option_ids: [{ product_id: 6, name: 'Assembly', qty: 1, discount: 5 }], note: 'Net thirty',
    require_signature: true, require_payment: true, prepayment_percent: 25, mail_template: 'Thank you',
  });
  const q = create(t.db, 'sale.order', { partner_id: 1, order_line: [{ product_id: 2, qty: 1, price_unit: 999 }] });
  const before = structuredClone(q.db);
  const after = applyTemplate(q.db, q.id, t.id);
  const r = read(after, 'sale.order', q.id);
  assert.deepEqual(q.db, before);
  assert.equal(r.order_line.length, 1);
  assert.equal(r.order_line[0].price_unit, 70);
  assert.equal(r.order_line[0].discount, 10);
  assert.equal(r.order_line[0].tax, read(after, 'product', 1).sale_tax ?? 14);
  assert.equal(r.option_ids[0].price_unit, 25);
  assert.equal(r.option_ids[0].name, 'Assembly');
  assert.equal(r.option_ids[0].is_present, false);
  assert.equal(r.pricelist_id, pl.id);
  assert.equal(r.validity_date, addDays(today(), 12));
  assert.equal(r.note, 'Net thirty');
  assert.equal(r.require_signature, true);
  assert.equal(r.require_payment, true);
  assert.equal(r.prepayment_percent, 25);
  assert.equal(r.sale_order_template_id, t.id);
  assert.equal(read(original, 'res.partner', 1).pricelist_id, read(seed(), 'res.partner', 1).pricelist_id);
});

test('optional products are added once with their original price and discount and computed presence follows product matching', () => {
  const q = quote({ order_line: [{ product_id: 6, qty: 2, price_unit: 100, tax: 14 }], option_ids: [{ product_id: 1, name: 'Chair', qty: 3, price_unit: 77, discount: 12, tax: 14 }] });
  const after = addOption(q.db, q.id, 0);
  const r = read(after, 'sale.order', q.id);
  assert.deepEqual(r.order_line[1], { product_id: 1, name: 'Chair', qty: 3, price_unit: 77, discount: 12, tax: 14 });
  assert.equal(r.option_ids[0].is_present, true);
  assert.strictEqual(addOption(after, q.id, 0), after);
  const compute = definition.fields.option_ids.fields.is_present.compute;
  assert.equal(compute(r.option_ids[0], r), true);
  assert.equal(compute(r.option_ids[0], { order_line: [] }), false);
  assert.equal(read(q.db, 'sale.order', q.id).order_line.length, 1);
  assert.throws(() => addOption(q.db, q.id, -1), /index/);
  assert.throws(() => addOption(q.db, q.id, 0.5), /index/);
});

test('signing records acceptance and reuses confirmation including delivery creation', () => {
  const q = quote();
  const after = signQuote(q.db, q.id, { name: '  Customer  ', signature: 'signed', date: today() });
  const r = read(after, 'sale.order', q.id);
  assert.equal(r.state, 'sale');
  assert.equal(r.signed_by, 'Customer');
  assert.equal(r.signed_on, today());
  assert.equal(r.signature, 'signed');
  assert.ok(search(after, 'stock.picking').some((p) => p.sale_id === q.id));
  assert.equal(read(q.db, 'sale.order', q.id).state, 'draft');
  assert.throws(() => signQuote(after, q.id, { name: 'Again', signature: 'x' }), /draft or sent/);
});

test('signing required-payment quotes leaves them sent and rejects missing names, signatures, expired quotes and wrong states', () => {
  const q = quote({ state: 'sent', require_payment: true });
  const args = { name: 'Customer', signature: 'signed' };
  assert.equal(read(signQuote(q.db, q.id, args), 'sale.order', q.id).state, 'sent');
  assert.throws(() => signQuote(q.db, q.id, { ...args, name: '  ' }), /name/);
  assert.throws(() => signQuote(q.db, q.id, { ...args, signature: '' }), /signature/);
  assert.throws(() => signQuote(write(q.db, 'sale.order', q.id, { validity_date: addDays(today(), -1) }), q.id, args), /expired/);
  for (const state of ['sale', 'cancel']) assert.throws(() => signQuote(write(q.db, 'sale.order', q.id, { state }), q.id, args), /draft or sent/);
  assert.throws(() => signQuote(q.db, 99999, args), /not found/);
  const validToday = write(q.db, 'sale.order', q.id, { validity_date: today() });
  assert.equal(read(signQuote(validToday, q.id, args), 'sale.order', q.id).signed_by, 'Customer');
});

test('prepayments use discounted tax-inclusive totals, round cents and treat required zero percent as full payment', () => {
  const lines = [{ qty: 3, price_unit: 19.99, discount: 5, tax: 14 }];
  const total = amounts(lines).total;
  assert.equal(prepaymentAmount({ order_line: lines, require_payment: true, prepayment_percent: 25 }), Math.round(total * 25) / 100);
  assert.equal(prepaymentAmount({ amount_total: 1000, require_payment: true, prepayment_percent: 30 }), 300);
  for (const p of [0, 100]) assert.equal(prepaymentAmount({ order_line: lines, require_payment: true, prepayment_percent: p }), total);
  assert.equal(prepaymentAmount({ order_line: lines, require_payment: false, prepayment_percent: 0 }), 0);
  assert.throws(() => prepaymentAmount({ prepayment_percent: 101 }), /between 0 and 100/);
});

test('payQuote refuses underpayments and books a balanced order-specific credit without settling unrelated invoices', () => {
  const q = quote({ require_payment: true, prepayment_percent: 25 });
  const due = prepaymentAmount(read(q.db, 'sale.order', q.id));
  const before = structuredClone(q.db);
  assert.throws(() => payQuote(q.db, q.id, due - 0.01), /prepayment amount/);
  for (const amount of [0, -1, Infinity, NaN]) assert.throws(() => payQuote(q.db, q.id, amount), /positive and finite/);
  const after = payQuote(q.db, q.id, due + 10, { date: today(), journal: 'BNK1' });
  const payment = search(after, 'account.payment').find((p) => p.sale_id === q.id);
  const entry = read(after, 'account.move', payment.move_id);
  assert.equal(payment.state, 'posted');
  assert.equal(payment.amount, due + 10);
  assert.equal(payment.unapplied, due + 10);
  assert.equal(payment.partner_id, 1);
  assert.equal(entry.state, 'posted');
  assert.equal(entry.invoice_date, today());
  assert.ok(isBalanced(entry.line_ids));
  assert.equal(entry.line_ids.reduce((s, l) => s + l.debit, 0), due + 10);
  const accountCode = (l) => read(after, 'account.account', l.account_id).code;
  assert.equal(accountCode(entry.line_ids.find((l) => l.debit)), '101401');
  assert.equal(accountCode(entry.line_ids.find((l) => l.credit)), '121000');
  assert.equal(read(after, 'sale.order', q.id).state, 'sale');
  assert.ok(search(after, 'stock.picking').some((p) => p.sale_id === q.id));
  for (const m of search(q.db, 'account.move')) assert.deepEqual(read(after, 'account.move', m.id), m);
  assert.deepEqual(q.db, before);
  assert.throws(() => payQuote(after, q.id, due), /draft or sent/);
  assert.throws(() => payQuote(write(q.db, 'sale.order', q.id, { validity_date: addDays(today(), -1) }), q.id, due), /expired/);
  assert.throws(() => payQuote(q.db, q.id, due, { journal: 'INV' }), /bank or cash/);
});

test('expiry scheduler preserves states, computes expiry at its date and adds only one note per deadline', () => {
  const q = quote({ validity_date: addDays(today(), 2) });
  const sent = create(q.db, 'sale.order', { partner_id: 1, state: 'sent', validity_date: addDays(today(), -1) });
  const sold = create(sent.db, 'sale.order', { partner_id: 1, state: 'sale', validity_date: addDays(today(), -1) });
  const after = expireQuotes(sold.db, addDays(today(), 3));
  assert.equal(read(after, 'sale.order', q.id).state, 'draft');
  assert.equal(read(after, 'sale.order', sent.id).state, 'sent');
  assert.equal(isExpired(after, q.id), true);
  assert.equal(isExpired(after, sent.id), true);
  assert.equal(isExpired(after, sold.id), false);
  const notes = (db, id) => db.messages.filter((m) => m.model === 'sale.order' && m.res_id === id && m.body.startsWith('Quotation expired'));
  assert.equal(notes(after, q.id).length, 1);
  assert.equal(notes(expireQuotes(after, addDays(today(), 4)), q.id).length, 1);
  assert.equal(notes(after, sold.id).length, 0);
  assert.equal(isExpired(q.db, q.id), false);
});

test('template validation, defaults, seed loading and latest sale definition are preserved', () => {
  const db = seed();
  assert.ok(search(db, 'sale.order').length >= 3);
  const t = create(db, 'sale.order.template', { name: 'Default' });
  assert.equal(read(t.db, 'sale.order.template', t.id).number_of_days, 30);
  assert.throws(() => create(db, 'sale.order.template', { name: 'Bad', prepayment_percent: -1 }), /between 0 and 100/);
  assert.throws(() => create(db, 'sale.order.template', { name: 'Bad', number_of_days: -1 }), /Validity/);
  assert.ok(definition.fields.payment_provider);
  assert.equal(definition.fields.invoice_status, ecommerceModels['sale.order'].fields.invoice_status);
  assert.ok(definition.form.buttons.some((b) => b.label === 'Apply Coupon'));
  assert.ok(definition.form.buttons.some((b) => b.label === 'Create Invoice'));
  for (const label of ['Apply Template', 'Add Option', 'Sign', 'Register Prepayment']) assert.ok(definition.form.buttons.some((b) => b.label === label));
  const q = quote();
  assert.throws(() => applyTemplate(q.db, q.id, 99999), /active quotation template/);
  assert.throws(() => applyTemplate(write(t.db, 'sale.order.template', t.id, { active: false }), 1, t.id), /active quotation template/);
});
