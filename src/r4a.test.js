import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { postMove } from './models/accounting.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { accountId } from './models/ledger.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';
import { closeSession, payCart, refundOrder, sessionTotals, startSession } from './models/pos.js';
import { createPortal } from '../server/portal.js';

test('priced invoice lines changed to sections and notes never affect posting', () => {
  let { db, id } = create(seed(), 'account.move', {
    move_type: 'out_invoice', partner_id: 1,
    invoice_line_ids: [
      { name: 'Product', qty: 1, price_unit: 100, tax: 10, ...defaultTaxRepartitionLines(1) },
      { name: 'Section', qty: 2, price_unit: 50, tax: 10 },
      { name: 'Note', qty: 1, price_unit: 75, tax: 20, tax_cash_basis: true },
    ],
  });
  const lines = read(db, 'account.move', id).invoice_line_ids;
  db = write(db, 'account.move', id, { invoice_line_ids: [lines[0], { ...lines[1], display_type: 'line_section' }, { ...lines[2], display_type: 'line_note' }] });
  let invoice = read(db, 'account.move', id);
  assert.equal(invoice.amount_untaxed, 100);
  assert.equal(invoice.amount_tax, 10);
  assert.equal(invoice.amount_total, 110);
  db = postMove(db, id);
  invoice = read(db, 'account.move', id);
  assert.equal(invoice.state, 'posted');
  assert.equal(invoice.amount_total, 110);
  assert.equal(invoice.line_ids.reduce((sum, line) => sum + line.debit, 0), 110);
  assert.equal(invoice.line_ids.reduce((sum, line) => sum + line.credit, 0), 110);
  assert.equal(invoice.line_ids.filter((line) => line.tax_name && !line.tax_zero).reduce((sum, line) => sum + line.credit, 0), 10);
  assert.deepEqual(invoice.line_ids.flatMap((line) => line.invoice_sources ?? []).map((source) => source.index), [0]);
});

test('POS checkout and refund preserve three-decimal currency units', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'TST', rounding: 0.001 });
  db = write(currency.db, 'res.company', 1, { currency_id: currency.id });
  db = write(db, 'product', 1, { list_price: 10.125, sale_tax: 0, tax_id: null });
  const session = startSession(db, 0.001);
  db = session.db;
  const request = { cart: [{ product_id: 1, qty: 1 }], method: 'cash', request_key: 'precision-sale-1' };
  const sale = payCart(db, request);
  db = sale.db;
  const order = read(db, 'pos.order', sale.id);
  assert.equal(sale.total, 10.125);
  assert.equal(order.amount_total, 10.125);
  assert.equal(order.payment_ids[0].amount, 10.125);
  assert.equal(payCart(db, request).total, 10.125);
  assert.equal(sessionTotals(db, read(db, 'pos.session', session.id)).expected, 10.126);
  for (const entry of order.accounting_entries) {
    const move = read(db, 'account.move', entry.move_id);
    assert.equal(move.line_ids.reduce((sum, line) => sum + line.debit, 0), 10.125);
    assert.equal(move.line_ids.reduce((sum, line) => sum + line.credit, 0), 10.125);
  }
  const refund = refundOrder(db, order);
  const returned = read(refund.db, 'pos.order', refund.id);
  assert.equal(refund.total, 10.125);
  assert.equal(returned.payment_ids[0].amount, 10.125);
  assert.equal(sessionTotals(refund.db, read(refund.db, 'pos.session', session.id)).expected, 0.001);
  for (const entry of returned.accounting_entries) {
    const move = read(refund.db, 'account.move', entry.move_id);
    assert.equal(move.line_ids.reduce((sum, line) => sum + line.debit, 0), 10.125);
    assert.equal(move.line_ids.reduce((sum, line) => sum + line.credit, 0), 10.125);
  }
  db = write(refund.db, 'product', 1, { list_price: 0.001 });
  const tinyRequest = { cart: [{ product_id: 1, qty: 1 }], payments: [{ method: 'cash', amount: 0.002 }] };
  assert.throws(() => payCart(db, tinyRequest), /add up/);
  const tiny = payCart(db, { ...tinyRequest, payments: [{ method: 'cash', amount: 0.001 }] });
  assert.equal(tiny.total, 0.001);
  assert.ok(read(tiny.db, 'pos.order', tiny.id).accounting_entries.length > 0);
  const tinyRefund = refundOrder(tiny.db, read(tiny.db, 'pos.order', tiny.id));
  assert.equal(tinyRefund.total, 0.001);
  assert.ok(read(tinyRefund.db, 'pos.order', tinyRefund.id).accounting_entries.length > 0);
  const closed = closeSession(tinyRefund.db, read(tinyRefund.db, 'pos.session', session.id), 0.001);
  assert.equal(read(closed, 'pos.session', session.id).cash_difference, 0);
});

test('grouped deferrals post and reverse sub-cent company currency units', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'TST', rounding: 0.001 });
  db = write(currency.db, 'res.company', 1, { currency_id: currency.id, deferred_generation_method: 'manual_grouped' });
  const compute = models['account.deferral'].form.buttons.find((button) => button.label === 'Compute');
  const generate = models['account.deferral'].listActions.find((action) => action.label === 'Generate Entries');
  for (const amount of [0.001, 0.014]) {
    const created = create(db, 'account.deferral', {
      name: 'Schedule', kind: 'revenue', amount, company_id: 1,
      start_date: '2030-01-01', end_date: '2030-01-31',
      deferred_account_id: accountId(db, '212000'), recognition_account_id: accountId(db, '400000'),
    });
    db = compute.run(created.db, read(created.db, 'account.deferral', created.id)).db;
    assert.equal(read(db, 'account.deferral', created.id).board[0].amount, amount);
  }
  db = generate.run(db, [], '2030-01-31');
  const entry = db.records['account.move'].find((move) => move.is_deferred_grouped && !move.reversed_entry_id && move.deferral_date === '2030-01-31');
  assert.ok(entry);
  assert.equal(entry.state, 'posted');
  assert.equal(entry.line_ids.find((line) => line.account_id === accountId(db, '212000')).debit, 0.015);
  assert.deepEqual(entry.line_ids.filter((line) => line.account_id === accountId(db, '400000')).map((line) => line.credit), [0.001, 0.014]);
  const reversal = read(db, 'account.move', entry.reversal_move_id);
  assert.equal(reversal.state, 'posted');
  assert.deepEqual(reversal.line_ids.map((line) => [line.debit, line.credit]), entry.line_ids.map((line) => [line.credit, line.debit]));
});

test('resetting a grouped invoice removes its sub-cent contribution', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'TST', rounding: 0.001 });
  db = write(currency.db, 'res.company', 1, { currency_id: currency.id, deferred_generation_method: 'manual_grouped' });
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: '2099-01-01',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 0.001, tax: 0, deferred_start_date: '2099-01-01', deferred_end_date: '2099-01-31' }],
  });
  db = postMove(invoice.db, invoice.id);
  const generate = models['account.deferral'].listActions.find((action) => action.label === 'Generate Entries');
  db = generate.run(db, [], '2099-01-31');
  const entry = db.records['account.move'].find((move) => move.is_deferred_grouped && !move.reversed_entry_id && move.deferral_date === '2099-01-31');
  assert.ok(entry);
  const reset = models['account.move'].form.buttons.find((button) => button.label === 'Reset to Draft');
  db = reset.run(db, read(db, 'account.move', invoice.id)).db;
  assert.equal(read(db, 'account.move', invoice.id).state, 'draft');
  assert.equal(db.records['account.deferral'].find((schedule) => schedule.source_move_id === invoice.id).state, 'cancel');
});

test('quotation prepayment uses document currency precision for validation and posting', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'TST', rounding: 0.001 });
  db = write(currency.db, 'res.company', 1, { currency_id: currency.id });
  const quote = create(db, 'sale.order', {
    partner_id: 1, company_id: 1, currency_id: currency.id, require_payment: true, prepayment_percent: 50,
    order_line: [{ product_id: 1, qty: 1, price_unit: 10.125, tax: 0 }],
  });
  const button = models['sale.order'].form.buttons.find((item) => item.label === 'Register Prepayment');
  const record = read(quote.db, 'sale.order', quote.id);
  assert.equal(button.wizard(quote.db, record).fields[0].default, '5.063');
  assert.throws(() => button.run(quote.db, record, { amount: '5.0624' }), /prepayment amount/);
  const result = button.run(quote.db, record, { amount: '5.0626' }).db;
  const payment = result.records['account.payment'].find((item) => item.sale_id === quote.id);
  assert.equal(payment.amount, 5.063);
  assert.equal(payment.unapplied, 5.063);
  const move = read(result, 'account.move', payment.move_id);
  assert.equal(move.state, 'posted');
  assert.equal(move.line_ids.reduce((sum, line) => sum + line.debit, 0), 5.063);
  assert.equal(move.line_ids.reduce((sum, line) => sum + line.credit, 0), 5.063);
  assert.equal(read(result, 'sale.order', quote.id).state, 'sale');
});

test('foreign currency quotation prepayment retains document units and converts its journal entry', () => {
  const currency = create(seed(), 'res.currency', { name: 'TST', rounding: 0.001, rate_ids: [{ date: '2000-01-01', rate: 2 }] });
  const quote = create(currency.db, 'sale.order', {
    partner_id: 1, company_id: 1, currency_id: currency.id, require_payment: true, prepayment_percent: 50,
    order_line: [{ product_id: 1, qty: 1, price_unit: 10.125, tax: 0 }],
  });
  const button = models['sale.order'].form.buttons.find((item) => item.label === 'Register Prepayment');
  const result = button.run(quote.db, read(quote.db, 'sale.order', quote.id), { amount: '5.063' }).db;
  const payment = result.records['account.payment'].find((item) => item.sale_id === quote.id);
  assert.equal(payment.currency_id, currency.id);
  assert.equal(payment.amount, 5.063);
  const move = read(result, 'account.move', payment.move_id);
  assert.equal(move.line_ids.reduce((sum, line) => sum + line.debit, 0), 2.53);
  assert.equal(move.line_ids.reduce((sum, line) => sum + line.credit, 0), 2.53);
  assert.deepEqual(move.line_ids.map((line) => line.amount_currency), [5.063, -5.063]);
});

test('portal documents, printable views and listings use each document currency precision', async () => {
  const currency = create(seed(), 'res.currency', { name: 'TST', rounding: 0.001 });
  const invoice = create(currency.db, 'account.move', {
    partner_id: 1, move_type: 'out_invoice', currency_id: currency.id,
    invoice_line_ids: [{ name: '<service>', qty: 1, price_unit: 10.125, tax: 0 }],
  });
  const order = create(invoice.db, 'sale.order', {
    partner_id: 1, currency_id: currency.id, require_payment: true, prepayment_percent: 50,
    order_line: [{ product_id: 1, qty: 1, price_unit: 10.125, tax: 0 }],
    option_ids: [{ product_id: 2, qty: 1, price_unit: 1.234, tax: 0 }],
  });
  const db = order.db;
  const portal = createPortal({
    sql: { prepare: () => ({ run: () => {}, get: () => ({ value: 'test-secret' }) }) },
    getDb: () => db, sessionUser: () => ({ isPortal: true, partnerId: 1 }),
    securityHeaders: {}, env: {},
  });
  const get = async (url) => {
    let status, body;
    await portal.handle({ url, method: 'GET', headers: {} }, { writeHead: (code) => { status = code; }, end: (text) => { body = text; } });
    assert.equal(status, 200);
    return body;
  };
  const invoiceUrl = portal.portalUrl('account.move', read(db, 'account.move', invoice.id));
  for (const suffix of ['', '&print=1', '&download=1']) {
    const html = await get(invoiceUrl + suffix);
    assert.match(html, /&lt;service&gt;/);
    assert.doesNotMatch(html, /<service>/);
    assert.match(html, /<dt>Total<\/dt><dd>[^<]*10\.125<\/dd>/);
    assert.match(html, /<dt>Amount due<\/dt><dd>[^<]*10\.125<\/dd>/);
    assert.match(html, /<td>[^<]*10\.125<\/td>/);
  }
  const quoteUrl = portal.portalUrl('sale.order', read(db, 'sale.order', order.id));
  const quoteHtml = await get(quoteUrl);
  assert.match(quoteHtml, /Prepayment: [^<]*5\.063/);
  assert.match(quoteHtml, /1\.234/);
  assert.match(await get('/my'), /10\.125/);
});

test('portal displays amounts at the precision of very small currency increments', async () => {
  let db = seed();
  const cases = [
    { rounding: 1e-10, amount: 1.0000000001, expected: '1.0000000001' },
    { rounding: 1.0000000001, amount: 1.0000000001, expected: '1.0000000001' },
    { rounding: 1e-15, amount: 0.000000000000001, expected: '0.000000000000001' },
    { rounding: 0.05, amount: 1.05, expected: '1.05' },
  ];
  const invoices = [];
  for (const [index, item] of cases.entries()) {
    const currency = create(db, 'res.currency', { name: `T${index}`, rounding: item.rounding });
    const invoice = create(currency.db, 'account.move', {
      partner_id: 1, move_type: 'out_invoice', currency_id: currency.id,
      invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: item.amount, tax: 0 }],
    });
    db = invoice.db;
    invoices.push(invoice.id);
  }
  const portal = createPortal({
    sql: { prepare: () => ({ run: () => {}, get: () => ({ value: 'test-secret' }) }) },
    getDb: () => db, sessionUser: () => ({ isPortal: true, partnerId: 1 }), securityHeaders: {}, env: {},
  });
  for (const [index, item] of cases.entries()) {
    let status, html;
    const url = portal.portalUrl('account.move', read(db, 'account.move', invoices[index]));
    await portal.handle({ url, method: 'GET', headers: {} }, { writeHead: (code) => { status = code; }, end: (text) => { html = text; } });
    assert.equal(status, 200);
    assert.ok(html.includes(`<dt>Total</dt><dd>${item.expected}</dd>`), `rounding ${item.rounding}: ${html}`);
  }
});

test('currency rounding changes are blocked only while the currency is in use', () => {
  const currency = create(seed(), 'res.currency', { name: 'TST', rounding: 0.01, rate_ids: [{ date: '2000-01-01', rate: 1 }] });
  const draft = create(currency.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: currency.id, invoice_line_ids: [{ qty: 1, price_unit: 10.25, tax: 0 }] });
  let db = write(draft.db, 'res.currency', currency.id, { rounding: 0.001 });
  assert.equal(read(db, 'res.currency', currency.id).rounding, 0.001);
  db = postMove(db, draft.id);
  const posted = read(db, 'account.move', draft.id);
  assert.throws(() => write(db, 'res.currency', currency.id, { rounding: 1 }), /rounding.*use/i);
  assert.equal(read(db, 'account.move', draft.id).amount_total, posted.amount_total);
  assert.equal(read(db, 'account.move', draft.id).amount_residual, posted.amount_residual);
  assert.equal(read(write(db, 'res.currency', currency.id, { symbol: 'changed', rounding: 0.001 }), 'res.currency', currency.id).symbol, 'changed');

  const companyDb = write(currency.db, 'res.company', 1, { currency_id: currency.id });
  assert.throws(() => write(companyDb, 'res.currency', currency.id, { rounding: 1 }), /rounding.*use/i);
  const payment = create(currency.db, 'account.payment', { partner_id: 1, state: 'posted', currency_id: currency.id, amount: 1 });
  assert.throws(() => write(payment.db, 'res.currency', currency.id, { rounding: 1 }), /rounding.*use/i);
  const draftPayment = create(currency.db, 'account.payment', { partner_id: 1, state: 'draft', currency_id: currency.id, amount: 1 });
  assert.equal(read(write(draftPayment.db, 'res.currency', currency.id, { rounding: 1 }), 'res.currency', currency.id).rounding, 1);
  const journal = create(currency.db, 'account.move', { move_type: 'entry', line_ids: [{ account_id: accountId(currency.db, '121000'), currency_id: currency.id, amount_currency: 1, debit: 1, credit: 0 }] });
  assert.throws(() => write(journal.db, 'res.currency', currency.id, { rounding: 1 }), /rounding.*use/i);
});
