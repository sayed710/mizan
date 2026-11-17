import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { models } from './models/index.js';
import { invoiceLineAccount, resolveCompanyAccount, resolveDocumentJournal } from './models/ledger.js';
import { postMove } from './models/accounting.js';

const PARTNER_ACCOUNTING_FIELDS = [
  'property_account_position_id',
  'property_payment_term_id',
  'property_supplier_payment_term_id',
  'property_account_receivable_id',
  'property_account_payable_id',
];

test('partner form exposes every accounting default in an Accounting tab', () => {
  const form = models['res.partner'].form;
  const visible = new Set([
    ...(form.groups ?? []).flat(),
    ...(form.tabs ?? []).flatMap((tab) => [...(tab.fields ?? []), ...(tab.groups ?? []).flat()]),
  ]);
  for (const field of PARTNER_ACCOUNTING_FIELDS) {
    assert.ok(visible.has(field), `${field} must be editable on the partner form`);
    assert.ok(models['res.partner'].fields[field], `${field} must be a declared partner field`);
  }
  const tab = (form.tabs ?? []).find((t) => t.label === 'Accounting');
  assert.ok(tab, 'partner form has an Accounting tab');
  assert.deepEqual(tab.fields, PARTNER_ACCOUNTING_FIELDS);
});

test('a new invoice or bill takes the partner fiscal position and the payment term for its side', () => {
  const base = seed();
  const fiscal = create(base, 'account.fiscal.position', { name: 'Defaults position', country: 'Testland' });
  const customerTerm = create(fiscal.db, 'account.payment.term', {
    name: 'Defaults customer terms',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 0, delay_type: 'days_after' }],
  });
  const supplierTerm = create(customerTerm.db, 'account.payment.term', {
    name: 'Defaults supplier terms',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  });
  const partner = create(supplierTerm.db, 'res.partner', {
    name: 'Defaults partner',
    property_payment_term_id: customerTerm.id,
    property_supplier_payment_term_id: supplierTerm.id,
    property_account_position_id: fiscal.id,
  });

  const invoice = models['account.move'].onchange({ move_type: 'out_invoice', partner_id: partner.id, invoice_date: '2026-01-01' }, 'partner_id', partner.db);
  assert.equal(invoice.invoice_payment_term_id, customerTerm.id);
  assert.equal(invoice.fiscal_position_id, fiscal.id);
  assert.equal(invoice.invoice_date_due, '2026-01-01');

  const bill = models['account.move'].onchange({ move_type: 'in_invoice', partner_id: partner.id, invoice_date: '2026-01-01' }, 'partner_id', partner.db);
  assert.equal(bill.invoice_payment_term_id, supplierTerm.id);
  assert.equal(bill.fiscal_position_id, fiscal.id);
  assert.equal(bill.invoice_date_due, '2026-01-31');
});

test('a posted invoice and bill book the partner receivable and payable on the counterpart line', () => {
  const base = seed();
  const receivable = create(base, 'account.account', { name: 'Defaults receivable', code: 'DEF-AR', account_type: 'asset_receivable', company_id: 1, reconcile: true });
  const payable = create(receivable.db, 'account.account', { name: 'Defaults payable', code: 'DEF-AP', account_type: 'liability_payable', company_id: 1, reconcile: true });
  const db = write(payable.db, 'res.partner', 1, { property_account_receivable_id: receivable.id, property_account_payable_id: payable.id });

  for (const [moveType, accountType, expected] of [
    ['out_invoice', 'asset_receivable', receivable.id],
    ['in_invoice', 'liability_payable', payable.id],
  ]) {
    const made = create(db, 'account.move', {
      move_type: moveType,
      partner_id: 1,
      invoice_date: '2026-01-01',
      invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax_id: null, tax: 0 }],
    });
    const posted = postMove(made.db, made.id);
    const lines = read(posted, 'account.move', made.id).line_ids.filter((l) => read(posted, 'account.account', l.account_id)?.account_type === accountType);
    assert.deepEqual(lines.map((l) => l.account_id), [expected], `${moveType} counterpart account`);
  }
});

test('invoice and bill line accounts resolve product, then category, then journal default', () => {
  const base = seed();
  const income = create(base, 'account.account', { name: 'Defaults category income', code: 'DEF-CAT-INC', account_type: 'income' });
  const expense = create(income.db, 'account.account', { name: 'Defaults category expense', code: 'DEF-CAT-EXP', account_type: 'expense' });
  const category = create(expense.db, 'product.category', { name: 'Defaults category', property_account_income_categ_id: income.id, property_account_expense_categ_id: expense.id });
  const product = create(category.db, 'product', { name: 'Defaults category product', type: 'service', categ_id: category.id });
  const line = { product_id: product.id, qty: 1, price_unit: 100, tax_id: null, tax: 0 };
  const invoiceMove = { move_type: 'out_invoice', partner_id: 1, invoice_line_ids: [line] };
  const billMove = { move_type: 'in_invoice', partner_id: 1, invoice_line_ids: [line] };

  assert.equal(invoiceLineAccount(product.db, invoiceMove, line), income.id, 'product without its own account inherits the category income account');
  assert.equal(invoiceLineAccount(product.db, billMove, line), expense.id, 'product without its own account inherits the category expense account');

  const ownIncome = create(product.db, 'account.account', { name: 'Defaults own income', code: 'DEF-OWN-INC', account_type: 'income' });
  const withOwn = write(ownIncome.db, 'product', product.id, { property_account_income_id: ownIncome.id });
  assert.equal(invoiceLineAccount(withOwn, invoiceMove, line), ownIncome.id, 'the product own account wins over the category');

  const bareCategory = create(withOwn, 'product.category', { name: 'Defaults bare category' });
  const bareProduct = create(bareCategory.db, 'product', { name: 'Defaults bare product', type: 'service', categ_id: bareCategory.id });
  const bareLine = { product_id: bareProduct.id, qty: 1, price_unit: 100, tax_id: null, tax: 0 };
  const bareMove = { move_type: 'out_invoice', partner_id: 1, invoice_line_ids: [bareLine] };
  const journal = resolveDocumentJournal(bareProduct.db, bareMove, { required: true });
  const expected = resolveCompanyAccount(bareProduct.db, journal.default_account_id, bareMove.company_id ?? 1);
  assert.equal(invoiceLineAccount(bareProduct.db, bareMove, bareLine), expected, 'without product or category accounts the journal default is used');
});

test('a category belonging to another company does not supply the line account', () => {
  const base = seed();
  const income = create(base, 'account.account', { name: 'Company 2 category income', code: 'DEF-C2-INC', account_type: 'income' });
  const category = create(income.db, 'product.category', { name: 'Company 2 category', company_id: 2, property_account_income_categ_id: income.id });
  const product = create(category.db, 'product', { name: 'Company 2 category product', type: 'service', categ_id: category.id });
  const line = { product_id: product.id, qty: 1, price_unit: 100, tax_id: null, tax: 0 };
  const move = { move_type: 'out_invoice', partner_id: 1, company_id: 1, invoice_line_ids: [line] };
  const journal = resolveDocumentJournal(product.db, move, { required: true });
  assert.equal(invoiceLineAccount(product.db, move, line), resolveCompanyAccount(product.db, journal.default_account_id, 1));
});
