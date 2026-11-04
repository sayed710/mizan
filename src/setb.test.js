import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove, payWithDiscount } from './models/accounting.js';
import { partnerLedger } from './models/reports.js';
import { validateTaxReturnPeriod } from './models/finance.js';

const runBtn = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('Finding 5: bank statement reconciliation matching payments created without an outstanding account', () => {
  // Post a customer invoice and register payment via a bank journal where outstanding_receipts_account_id is empty.
  // The payment posts directly to the bank account (101401) and records outstanding_account_id: null.
  // Import a bank statement line matching the transaction and execute matchPayment (via "Match Payment" button).
  const base = seed();
  const company = read(base, 'res.company', 1);
  assert.equal(company.outstanding_receipts_account_id ?? null, null);

  const draft = create(base, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  let db = postMove(draft.db, draft.id);

  const payment = create(db, 'account.payment', {
    invoice_id: draft.id,
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 100,
    date: '2026-01-02',
  });
  db = runBtn(payment.db, 'account.payment', payment.id, 'Confirm');
  const p = read(db, 'account.payment', payment.id);
  assert.equal(p.state, 'posted');
  assert.equal(p.outstanding_account_id, null);

  const bankAcc = search(db, 'account.account').find((a) => a.code === '101401').id;
  const pEntry = read(db, 'account.move', p.move_id);
  assert.ok(pEntry.line_ids.some((l) => l.account_id === bankAcc && l.debit === 100));

  const stmtLine = create(db, 'account.bank.statement.line', {
    date: '2026-01-03',
    payment_ref: 'Direct bank match',
    amount: 100,
    payment_id: p.id,
  });

  // This should not throw 'Cannot identify the payment outstanding item'
  db = runBtn(stmtLine.db, 'account.bank.statement.line', stmtLine.id, 'Match Payment');
  const matched = read(db, 'account.bank.statement.line', stmtLine.id);
  assert.equal(matched.state, 'reconciled');
  assert.equal(matched.open_amount, 0);
  assert.equal(matched.payment_id, p.id);
  assert.equal(matched.bank_move_id, p.move_id);

  // Test unreconcile
  db = runBtn(db, 'account.bank.statement.line', stmtLine.id, 'Unreconcile');
  const unreconciled = read(db, 'account.bank.statement.line', stmtLine.id);
  assert.equal(unreconciled.state, 'to_check');
  assert.equal(read(db, 'account.payment', p.id).state, 'posted');
  assert.equal(read(db, 'account.move', draft.id).amount_residual, 0);
});

test('Finding 7: cash rounding with biggest_tax strategy alters posted journal items and invoice amount_tax', () => {
  const base = seed();
  const tax = search(base, 'account.tax').find((t) => t.type_tax_use === 'sale' && t.amount === 14);
  assert.ok(tax);

  const rounding = create(base, 'account.cash.rounding', {
    name: 'Cash 0.05 biggest_tax',
    rounding: 0.05,
    rounding_method: 'HALF-UP',
    strategy: 'biggest_tax',
  });

  const inv = create(rounding.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_cash_rounding_id: rounding.id,
    invoice_line_ids: [{ qty: 1, price_unit: 100.02, tax_id: tax.id, tax: 14 }],
  });

  const doc = read(inv.db, 'account.move', inv.id);
  // Untaxed: $100.02, Tax unrounded: $14.0028 -> $14.00, unrounded total: $114.02.
  // Rounded total at 0.05 precision is $114.00, diff -$0.02.
  // With biggest_tax, tax must be adjusted to $13.98 so $100.02 + $13.98 == $114.00.
  assert.equal(doc.amount_untaxed, 100.02);
  assert.equal(doc.amount_total, 114.00);
  assert.equal(doc.amount_tax, 13.98);

  const posted = postMove(inv.db, inv.id);
  const postedDoc = read(posted, 'account.move', inv.id);
  assert.equal(postedDoc.amount_untaxed, 100.02);
  assert.equal(postedDoc.amount_tax, 13.98);
  assert.equal(postedDoc.amount_total, 114.00);

  const taxLine = postedDoc.line_ids.find((l) => l.tax_id === tax.id);
  assert.ok(taxLine);
  assert.equal(taxLine.credit, 13.98);
});

test('Finding 8: early-payment discount entries populate currency_id and amount_currency', () => {
  const base = seed();
  const eur = create(base, 'res.currency', {
    name: 'EUR',
    unit_name: 'Euro',
    rate_ids: [{ date: '0001-01-01', rate: 1.25 }], // 1 USD = 1.25 EUR, so 1 EUR = 0.8 USD
  });

  const term = create(eur.db, 'account.payment.term', {
    name: '2% 10 Net 30',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  });

  const inv = create(term.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    currency_id: eur.id,
    invoice_date: '2026-01-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ qty: 1, price_unit: 1000, tax: 0 }],
  });
  let db = postMove(inv.db, inv.id);

  // Pay 980 EUR within 10 days, 20 EUR discount
  db = payWithDiscount(db, inv.id, 980, '2026-01-05');
  const paid = read(db, 'account.move', inv.id);
  assert.equal(paid.amount_residual, 0);

  const discountEntry = search(db, 'account.move').find((m) => m.ref === `Early payment discount ${paid.name}`);
  assert.ok(discountEntry);
  const counterpartLine = discountEntry.line_ids.find((l) => l.account_id === search(db, 'account.account').find((a) => a.code === '121000').id);
  assert.ok(counterpartLine);
  assert.equal(counterpartLine.currency_id, eur.id);
  assert.equal(counterpartLine.amount_currency, -20);

  // Verify partner ledger clears foreign currency residual
  const ledger = partnerLedger(db, { from: '2026-01-01', to: '2026-01-31' });
  const partnerRow = ledger.find((r) => r.partner_id === 3);
  assert.ok(partnerRow);
  const eurCurrencyTotal = partnerRow.lines
    .filter((l) => l.currency_id === eur.id)
    .reduce((sum, l) => sum + (l.amount_currency || 0), 0);
  assert.equal(eurCurrencyTotal, 0);
});

test('Finding 11: vendor bills adopt supplier payment terms instead of customer payment terms', () => {
  const base = seed();
  const termCustomer = create(base, 'account.payment.term', {
    name: 'Customer Terms (Immediate)',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 0, delay_type: 'days_after' }],
  });
  const termSupplier = create(termCustomer.db, 'account.payment.term', {
    name: 'Supplier Terms (Net 30)',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  });

  const partner = create(termSupplier.db, 'res.partner', {
    name: 'Acme Corp',
    property_payment_term_id: termCustomer.id,
    property_supplier_payment_term_id: termSupplier.id,
  });

  // Out invoice (Customer Invoice) onchange
  const customerInv = { move_type: 'out_invoice', invoice_date: '2026-01-01', partner_id: partner.id };
  const custChanges = models['account.move'].onchange(customerInv, 'partner_id', partner.db);
  assert.equal(custChanges.invoice_payment_term_id, termCustomer.id);
  assert.equal(custChanges.invoice_date_due, '2026-01-01');

  // In invoice (Vendor Bill) onchange
  const vendorBill = { move_type: 'in_invoice', invoice_date: '2026-01-01', partner_id: partner.id };
  const billChanges = models['account.move'].onchange(vendorBill, 'partner_id', partner.db);
  assert.equal(billChanges.invoice_payment_term_id, termSupplier.id);
  assert.equal(billChanges.invoice_date_due, '2026-01-31');
});

test('Finding 12: manual invoice lines default to company default sale/purchase tax and tags, or 0% when none', () => {
  const base = seed();
  const mainCo = read(base, 'res.company', 1);

  // Create custom 15% taxes with tags
  const tagSale = create(base, 'account.account.tag', { name: 'VAT 15% Sale Tag', applicability: 'taxes' });
  const tagPurch = create(tagSale.db, 'account.account.tag', { name: 'VAT 15% Purch Tag', applicability: 'taxes' });

  const saleAcc = search(tagPurch.db, 'account.account').find((a) => a.code === '251000').id;
  const purchAcc = search(tagPurch.db, 'account.account').find((a) => a.code === '131000').id;

  const tax15Sale = create(tagPurch.db, 'account.tax', {
    name: 'VAT 15% Sale',
    type_tax_use: 'sale',
    amount: 15,
    amount_type: 'percent',
    account_id: saleAcc,
    tag_ids: [tagSale.id],
  });
  const tax15Purch = create(tax15Sale.db, 'account.tax', {
    name: 'VAT 15% Purchase',
    type_tax_use: 'purchase',
    amount: 15,
    amount_type: 'percent',
    account_id: purchAcc,
    tag_ids: [tagPurch.id],
  });

  const coConfigured = write(tax15Purch.db, 'res.company', mainCo.id, {
    account_sale_tax_id: tax15Sale.id,
    account_purchase_tax_id: tax15Purch.id,
  });

  // Test Customer Invoice manual line
  const customerInv = { move_type: 'out_invoice', company_id: mainCo.id };
  const saleLine = models['account.move'].fields.invoice_line_ids.newLine(customerInv, coConfigured);
  assert.equal(saleLine.tax, 15);
  assert.equal(saleLine.tax_id, tax15Sale.id);
  assert.equal(saleLine.tax_account_id, saleAcc);
  assert.deepEqual(saleLine.tax_tag_ids, [tagSale.id]);

  // Test Vendor Bill manual line
  const bill = { move_type: 'in_invoice', company_id: mainCo.id };
  const billLine = models['account.move'].fields.invoice_line_ids.newLine(bill, coConfigured);
  assert.equal(billLine.tax, 15);
  assert.equal(billLine.tax_id, tax15Purch.id);
  assert.equal(billLine.tax_account_id, purchAcc);
  assert.deepEqual(billLine.tax_tag_ids, [tagPurch.id]);

  // Posting an invoice with this manual line must not fail validateTaxReturnPeriod
  const createdInv = create(coConfigured, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Manual Service', ...saleLine, qty: 1, price_unit: 100 }],
  });
  const postedDb = postMove(createdInv.db, createdInv.id);
  assert.doesNotThrow(() => validateTaxReturnPeriod(postedDb, '2026-01-01', '2026-01-31', mainCo.id));

  // When no default tax is configured on company, defaults to 0% tax
  const coNoTax = write(coConfigured, 'res.company', mainCo.id, {
    account_sale_tax_id: null,
    account_purchase_tax_id: null,
  });
  const noTaxLine = models['account.move'].fields.invoice_line_ids.newLine(customerInv, coNoTax);
  assert.equal(noTaxLine.tax, 0);
  assert.equal(noTaxLine.tax_id, null);
  assert.deepEqual(noTaxLine.tax_tag_ids, []);
});
