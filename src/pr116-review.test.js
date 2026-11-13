import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { total } from './models/common.js';
import { isBalanced } from './models/ledger.js';
import { isValidBankBic } from './models/partnerbank.js';
import { invoiceTermNote } from './models/terms.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';

const rounding = (db, vals) => create(db, 'account.cash.rounding', { rounding: 0.05, rounding_method: 'HALF-UP', ...vals });

test('a BIC needs a letter country code in positions five and six', () => {
  assert.equal(isValidBankBic('DEUTDEFF'), true);
  assert.equal(isValidBankBic('DEUTDEFF500'), true);
  assert.equal(isValidBankBic('AAAA12BB'), false);
  assert.equal(isValidBankBic('AAAA12BB500'), false);
});

test('a currency-restricted rounding method is rejected and hidden on documents in another currency', () => {
  let db = seed();
  const cad = create(db, 'res.currency', { name: 'CAD', rate_ids: [{ date: '2026-01-01', rate: 1.4 }] });
  db = cad.db;
  const onlyCad = rounding(db, { name: 'CAD only', strategy: 'biggest_tax', currency_ids: [cad.id] });
  db = onlyCad.db;
  const field = models['account.move'].fields.invoice_cash_rounding_id;
  const lines = [{ name: 'Item', qty: 1, price_unit: 100.03, tax_ids: [1] }];

  assert.throws(() => create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_cash_rounding_id: onlyCad.id, invoice_line_ids: lines }), /does not apply to this currency/);
  assert.equal(field.domain(read(db, 'account.cash.rounding', onlyCad.id), { company_id: 1 }, db), false);

  const cadMove = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: cad.id, invoice_date: '2026-03-01', invoice_cash_rounding_id: onlyCad.id, invoice_line_ids: lines });
  assert.equal(field.domain(read(db, 'account.cash.rounding', onlyCad.id), { company_id: 1, currency_id: cad.id }, db), true);
  assert.equal(read(cadMove.db, 'account.move', cadMove.id).invoice_cash_rounding_id, onlyCad.id);
});

test("another company's rounding method is rejected on an invoice", () => {
  let db = seed();
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two' });
  db = c2.db;
  const own = rounding(db, { name: 'Company one', strategy: 'biggest_tax', company_id: 1 });
  db = own.db;
  assert.equal(models['account.move'].fields.invoice_cash_rounding_id.domain(read(db, 'account.cash.rounding', own.id), { company_id: c2.id }, db), false);
  assert.throws(() => create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, company_id: c2.id, invoice_date: '2026-03-01', invoice_cash_rounding_id: own.id, invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 10 }] }), /belongs to another company/);
});

test('a biggest-tax rounding leaves an untaxed invoice unrounded and posts it without rounding accounts', () => {
  let db = seed();
  const biggest = rounding(db, { name: 'Biggest tax', strategy: 'biggest_tax' });
  db = biggest.db;
  const move = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_cash_rounding_id: biggest.id, invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100.03, tax_ids: [] }] });
  assert.equal(total(read(move.db, 'account.move', move.id), move.db), 100.03);
  const posted = read(postMove(move.db, move.id), 'account.move', move.id);
  assert.equal(posted.state, 'posted');
  assert.ok(isBalanced(posted.line_ids));
  assert.equal(posted.line_ids.some((l) => l.name === 'Cash Rounding'), false);
});

test('the company currency keeps its Rates tab when it is not the base currency', () => {
  const db = seed();
  const own = db.records['res.company'].find((c) => c.id === 1).currency_id;
  const tabs = models['res.currency'].form.tabs;
  assert.deepEqual(tabs(read(db, 'res.currency', own), db), []);
  const otherBase = { ...db, settings: { ...db.settings, base_currency_id: db.records['res.currency'].find((c) => c.id !== own).id } };
  assert.deepEqual(tabs(read(otherBase, 'res.currency', own), otherBase).map((tab) => tab.label), ['Rates']);
});

test('the printed invoice shows the payment-term note or name unless the term is hidden from invoices', () => {
  let db = seed();
  const shown = create(db, 'account.payment.term', { name: '30 Days', note: 'Payment terms: 30 days', line_ids: [{ value: 'percent', value_amount: 100, nb_days: 30 }] });
  db = shown.db;
  const named = create(db, 'account.payment.term', { name: '45 Days', line_ids: [{ value: 'percent', value_amount: 100, nb_days: 45 }] });
  db = named.db;
  const hidden = create(db, 'account.payment.term', { name: 'Hidden', display_on_invoice: false, line_ids: [{ value: 'percent', value_amount: 100, nb_days: 10 }] });
  db = hidden.db;
  assert.equal(invoiceTermNote(db, { invoice_payment_term_id: shown.id }), 'Payment terms: 30 days');
  assert.equal(invoiceTermNote(db, { invoice_payment_term_id: named.id }), 'Payment Terms: 45 Days');
  assert.equal(invoiceTermNote(db, { invoice_payment_term_id: hidden.id }), null);
  assert.equal(invoiceTermNote(db, {}), null);
});
