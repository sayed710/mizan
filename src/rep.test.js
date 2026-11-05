import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postMove, releaseCashBasis, payWithDiscount } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { accountId } from './models/ledger.js';
import { models } from './models/index.js';
import { taxReport, taxesByGrid, validateTaxReturnPeriod } from './models/finance.js';
import { applyDiff, diffDb } from './sync.js';

test('invoice and bill post signed tax repartition rows to their configured accounts', () => {
  let db = seed();
  const first = accountId(db, '251000');
  const secondRecord = create(db, 'account.account', { name: 'Reverse tax', code: 'REV-TAX', account_type: 'liability_current', company_id: 1 });
  db = secondRecord.db;
  const rows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 200, account_id: first, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: -100, account_id: secondRecord.id, tag_ids: [] },
  ];
  const refundFirst = create(db, 'account.account', { name: 'Refund tax positive', code: 'REF-TAX-A', account_type: 'liability_current', company_id: 1 });
  db = refundFirst.db;
  const refundSecond = create(db, 'account.account', { name: 'Refund tax negative', code: 'REF-TAX-B', account_type: 'liability_current', company_id: 1 });
  db = refundSecond.db;
  const invoiceRows = rows.map((row) => row.repartition_type === 'tax' && row.account_id === first ? { ...row, factor_percent: 100 } : row);
  const refundRows = invoiceRows.map((row) => ({ ...row, account_id: row.account_id === first ? refundFirst.id : row.account_id === secondRecord.id ? refundSecond.id : null }));
  const tax = create(db, 'account.tax', { name: 'Signed split', amount: 10, type_tax_use: 'sale', invoice_repartition_line_ids: invoiceRows, refund_repartition_line_ids: refundRows });
  db = tax.db;
  for (const moveType of ['out_invoice', 'in_invoice', 'out_refund', 'in_refund']) {
    const move = create(db, 'account.move', { move_type: moveType, partner_id: 1, invoice_date: '2026-06-01', invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', tax.id)) }] });
    db = postMove(move.db, move.id);
    const items = read(db, 'account.move', move.id).line_ids.filter((line) => line.tax_name === 'Signed split');
    assert.equal(items.length, 2);
    const refund = moveType.endsWith('_refund');
    const sign = ['out_invoice', 'in_refund'].includes(moveType) ? -1 : 1;
    const positive = items.find((line) => line.account_id === (refund ? refundFirst.id : first));
    const negative = items.find((line) => line.account_id === (refund ? refundSecond.id : secondRecord.id));
    assert.equal(positive.debit - positive.credit, sign * 10);
    assert.equal(negative.debit - negative.credit, -sign * 10);
    const counterpart = read(db, 'account.move', move.id).line_ids.find((line) => line.name === read(db, 'account.move', move.id).name);
    assert.equal(counterpart.debit + counterpart.credit, 100);
  }
});

test('early discount reverses all signed invoice tax rows', () => {
  let db = seed();
  const first = accountId(db, '251000');
  const other = create(db, 'account.account', { name: 'Discount reverse', code: 'DISCREV', account_type: 'liability_current', company_id: 1 });
  const rows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 200, account_id: first, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: -100, account_id: other.id, tag_ids: [] },
  ];
  const tax = create(other.db, 'account.tax', { name: 'Discount reverse', amount: 10, type_tax_use: 'sale', invoice_repartition_line_ids: rows, refund_repartition_line_ids: rows });
  const term = create(tax.db, 'account.payment.term', { name: '2% included', early_discount: true, discount_percent: 2, discount_days: 10, discount_tax_computation: 'included' });
  const invoice = create(term.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(term.db, 'account.tax', tax.id)) }] });
  db = postMove(invoice.db, invoice.id);
  db = payWithDiscount(db, invoice.id, 107.8, '2026-01-11');
  const paid = read(db, 'account.move', invoice.id);
  const entry = read(db, 'account.move', paid.payments.at(-1).move_id);
  assert.equal(entry.line_ids.find((line) => line.account_id === first && line.tax_id === tax.id).debit, 0.4);
  assert.equal(entry.line_ids.find((line) => line.account_id === other.id && line.tax_id === tax.id).credit, 0.2);
});

test('tax grids and return net signed invoice and refund rows', () => {
  let db = seed();
  const tags = [];
  for (const name of ['Invoice plus', 'Invoice minus', 'Refund plus', 'Refund minus']) {
    const tag = create(db, 'account.account.tag', { name, applicability: 'taxes' });
    db = tag.db;
    tags.push(tag.id);
  }
  const positive = accountId(db, '251000');
  const other = create(db, 'account.account', { name: 'Grid reverse', code: 'GRID-REV', account_type: 'liability_current', company_id: 1 });
  const rows = (a, b) => [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: positive, tag_ids: [a] },
    { repartition_type: 'tax', factor_percent: -100, account_id: other.id, tag_ids: [b] },
  ];
  const tax = create(other.db, 'account.tax', { name: 'Grid reverse', type_tax_use: 'sale', amount: 10, invoice_repartition_line_ids: rows(tags[0], tags[1]), refund_repartition_line_ids: rows(tags[2], tags[3]) });
  db = tax.db;
  for (const move_type of ['out_invoice', 'out_refund']) {
    const move = create(db, 'account.move', { move_type, partner_id: 1, invoice_date: '2035-06-01', invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', tax.id)) }] });
    db = postMove(move.db, move.id);
  }
  const period = { from: '2035-06-01', to: '2035-06-30', company_id: 1 };
  const grids = taxesByGrid(db, period);
  assert.deepEqual(tags.map((id) => grids.find((grid) => grid.id === id)?.tax), [10, -10, -10, 10]);
  assert.equal(taxReport(db, period).output, 0);
  assert.equal(validateTaxReturnPeriod(db, { date_from: period.from, date_to: period.to, company_id: 1 }).output, 0);
});

test('cash-basis release posts positive and negative repartition rows', () => {
  let db = seed();
  const positive = accountId(db, '251000');
  const negative = create(db, 'account.account', { name: 'Cash reverse', code: 'CASH-REV', account_type: 'liability_current', company_id: 1 });
  const rows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: positive, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: -100, account_id: negative.id, tag_ids: [] },
  ];
  const refundAccount = create(negative.db, 'account.account', { name: 'Cash refund', code: 'CASH-REF', account_type: 'liability_current', company_id: 1 });
  const refundRows = rows.map((row) => row.account_id === positive ? { ...row, account_id: refundAccount.id } : row);
  const tax = create(refundAccount.db, 'account.tax', { name: 'Cash reverse', type_tax_use: 'sale', amount: 10, tax_exigibility: 'on_payment', cash_basis_transition_account_id: accountId(db, '251100'), invoice_repartition_line_ids: rows, refund_repartition_line_ids: refundRows });
  const move = create(tax.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-06-01', invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }] });
  db = postMove(move.db, move.id);
  const released = releaseCashBasis(db, read(db, 'account.move', move.id), 1, '2026-06-02', { final: true });
  const lines = read(released.db, 'account.move', released.id).line_ids;
  assert.equal(lines.find((line) => line.account_id === positive).credit, 10);
  assert.equal(lines.find((line) => line.account_id === negative.id).debit, 10);
  const refund = create(released.db, 'account.move', { move_type: 'out_refund', partner_id: 1, invoice_date: '2026-06-03', invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(released.db, 'account.tax', tax.id)) }] });
  db = postMove(refund.db, refund.id);
  const refundRelease = releaseCashBasis(db, read(db, 'account.move', refund.id), 1, '2026-06-04', { final: true });
  const refundLines = read(refundRelease.db, 'account.move', refundRelease.id).line_ids;
  assert.equal(refundLines.find((line) => line.account_id === refundAccount.id).debit, 10);
  assert.equal(refundLines.find((line) => line.account_id === negative.id).credit, 10);
});

test('tax repartition guards reject invalid rows on write and sync', () => {
  const db = seed();
  const tax = create(db, 'account.tax', { name: 'Guarded tax', amount: 10, company_id: 1 });
  const before = read(tax.db, 'account.tax', tax.id);
  const badRows = before.invoice_repartition_line_ids.filter((row) => row.repartition_type !== 'base');
  assert.throws(() => write(tax.db, 'account.tax', tax.id, { invoice_repartition_line_ids: badRows }), /base/i);
  const foreign = create(tax.db, 'account.account', { name: 'Other company', code: 'FOREIGN-REP', account_type: 'liability_current', company_id: 2 });
  const foreignRows = before.refund_repartition_line_ids.map((row) => row.repartition_type === 'tax' ? { ...row, account_id: foreign.id } : row);
  assert.throws(() => write(foreign.db, 'account.tax', tax.id, { refund_repartition_line_ids: foreignRows }), /company/i);
  for (const change of [{ invoice_repartition_line_ids: badRows }, { refund_repartition_line_ids: foreignRows }]) {
    const forged = { ...foreign.db, records: { ...foreign.db.records, 'account.tax': foreign.db.records['account.tax'].map((row) => row.id === tax.id ? { ...row, ...change } : row) } };
    assert.throws(() => applyDiff(foreign.db, diffDb(foreign.db, forged), { isAdmin: true }), /base|company/i);
  }
});

test('expense posts both signed tax rows and their grids', () => {
  let db = seed();
  const payable = accountId(db, '230100');
  db = write(db, 'account.account', payable, { account_type: 'liability_payable', company_id: 1 });
  db = write(db, 'res.company', 1, { account_default_payable_id: payable });
  const positive = create(db, 'account.account.tag', { name: 'Expense positive', applicability: 'taxes' });
  const negative = create(positive.db, 'account.account.tag', { name: 'Expense negative', applicability: 'taxes' });
  const other = create(negative.db, 'account.account', { name: 'Expense reverse', code: 'EXP-REV', account_type: 'liability_current', company_id: 1 });
  const rows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: accountId(db, '131000'), tag_ids: [positive.id] },
    { repartition_type: 'tax', factor_percent: -100, account_id: other.id, tag_ids: [negative.id] },
  ];
  const tax = create(other.db, 'account.tax', { name: 'Expense reverse', type_tax_use: 'purchase', amount: 10, invoice_repartition_line_ids: rows, refund_repartition_line_ids: rows });
  const product = create(tax.db, 'product', { name: 'Expense product', type: 'service', property_account_expense_id: accountId(db, '610000') });
  const expense = create(product.db, 'hr.expense', { name: 'Reverse expense', state: 'approved', category: 'travel', product_id: product.id, tax_id: tax.id, total_amount: 100, tax: 10 });
  db = models['hr.expense'].form.buttons.find((button) => button.label === 'Post Journal Entries').run(expense.db, read(expense.db, 'hr.expense', expense.id)).db;
  const move = read(db, 'account.move', read(db, 'hr.expense', expense.id).move_id);
  assert.equal(move.line_ids.find((line) => line.account_id === accountId(db, '131000')).debit, 10);
  assert.equal(move.line_ids.find((line) => line.account_id === other.id).credit, 10);
  const period = { from: move.date, to: move.date };
  const report = taxReport(db, period);
  assert.equal(report.input, 0);
  const grids = taxesByGrid(db, period);
  assert.equal(grids.find((grid) => grid.id === positive.id).tax, 10);
  assert.equal(grids.find((grid) => grid.id === negative.id).tax, -10);
});
