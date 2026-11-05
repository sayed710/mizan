import test from 'node:test';
import assert from 'node:assert/strict';
import { create, emptyDb, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { invoiceLines, paymentJournal } from './models/ledger.js';
import { bankModels } from './models/bank.js';
import { createCompany } from './models/company.js';
import { postPayment } from './models/pay.js';
import { payOrder, startSession } from './models/pos.js';

test('invoice counterpart uses the explicitly configured partner receivable', () => {
  let db = seed();
  const account = create(db, 'account.account', { code: '120100', name: 'Custom receivable', account_type: 'asset_receivable', company_id: 1 });
  db = write(account.db, 'res.partner', 1, { property_account_receivable_id: account.id });
  const lines = invoiceLines(db, { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_date: '2026-01-01', name: 'Test', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  assert.ok(lines.some((line) => line.account_id === account.id));
});

test('vendor bill counterpart uses the explicitly configured partner payable', () => {
  let db = seed();
  const account = create(db, 'account.account', { code: '210100', name: 'Custom payable', account_type: 'liability_payable', company_id: 1 });
  db = write(account.db, 'res.partner', 2, { property_account_payable_id: account.id });
  const lines = invoiceLines(db, { move_type: 'in_invoice', company_id: 1, partner_id: 2, invoice_date: '2026-01-01', name: 'Test', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  assert.ok(lines.some((line) => line.account_id === account.id));
});

test('payment journal rejects an unconfigured liquidity account', () => {
  const db = seed();
  const journal = create(db, 'account.journal', { name: 'Unconfigured', code: 'EMPTY', type: 'bank' });
  assert.equal(read(journal.db, 'account.journal', journal.id).default_account_id, undefined);
  assert.throws(() => paymentJournal(journal.db, journal.id), /account/i);
});

test('company chart defaults resolve receivable, payable, and payment journal by record ID for invoices and payments', () => {
  let db = seed();
  const receivable = create(db, 'account.account', { code: '120100', name: 'Configured receivable', account_type: 'asset_receivable', company_id: 1 });
  const payable = create(receivable.db, 'account.account', { code: '210100', name: 'Configured payable', account_type: 'liability_payable', company_id: 1 });
  const bank = create(payable.db, 'account.account', { code: '101999', name: 'Configured bank', account_type: 'asset_cash' });
  const journal = create(bank.db, 'account.journal', { name: 'Configured bank journal', code: 'CUSTOM', type: 'bank', default_account_id: bank.id });
  db = write(journal.db, 'res.company', 1, { account_default_receivable_id: receivable.id, account_default_payable_id: payable.id });
  const originalDefault = search(db, 'account.journal').find((j) => j.default_for_payments);
  db = write(db, 'account.journal', originalDefault.id, { default_for_payments: false });
  db = write(db, 'account.journal', journal.id, { default_for_payments: true });

  const customerLines = invoiceLines(db, { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_date: '2026-01-01', name: 'Customer', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  const vendorLines = invoiceLines(db, { move_type: 'in_invoice', company_id: 1, partner_id: 2, invoice_date: '2026-01-01', name: 'Vendor', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  assert.ok(customerLines.some((line) => line.account_id === receivable.id));
  assert.ok(vendorLines.some((line) => line.account_id === payable.id));
  assert.deepEqual(paymentJournal(db, null, 1), { id: journal.id, code: 'CUSTOM', accountId: bank.id, account_id: bank.id, account: '101999' });
  const payment = create(db, 'account.payment', { company_id: 1, partner_id: 1, partner_type: 'customer', payment_type: 'inbound', amount: 25, date: '2026-01-02' });
  db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const posted = read(db, 'account.payment', payment.id);
  const paymentMove = read(db, 'account.move', posted.move_id);
  assert.equal(posted.journal_id, journal.id);
  assert.ok(paymentMove.line_ids.some((line) => line.account_id === receivable.id));
  assert.ok(paymentMove.line_ids.some((line) => line.account_id === bank.id));
});

test('a new company keeps its configured counterpart account identities and payment journal', () => {
  const db = seed();
  const branch = createCompany(db, { name: 'Chart branch' });
  const created = read(branch.db, 'res.company', branch.id);
  const accounts = search(branch.db, 'account.account').filter((account) => account.company_id === branch.id);
  assert.equal(created.account_default_receivable_id, accounts.find((account) => account.account_type === 'asset_receivable').id);
  assert.equal(created.account_default_payable_id, accounts.find((account) => account.account_type === 'liability_payable').id);
  assert.equal(paymentJournal(branch.db, null, branch.id).id, paymentJournal(branch.db, null, 1).id);
});

test('POS posts the configured company receivable account', () => {
  let db = seed();
  const account = create(db, 'account.account', { code: '120100', name: 'POS receivable', account_type: 'asset_receivable', company_id: 1 });
  db = write(account.db, 'res.partner', 1, { property_account_receivable_id: account.id });
  db = startSession(db, 0).db;
  const paid = payOrder(db, { lines: [{ product_id: 5, qty: 1, price_unit: 20, tax: 0 }], method: 'cash', partner_id: 1 });
  const order = read(paid.db, 'pos.order', paid.id);
  const entry = search(paid.db, 'account.move').find((move) => move.ref === order.name);
  assert.ok(entry.line_ids.some((line) => line.account_id === account.id));
});

test('bank reconciliation refuses a selected journal with no liquidity account', () => {
  const db = seed();
  const journal = create(db, 'account.journal', { name: 'Unconfigured statement journal', code: 'EMPTY', type: 'bank' });
  const line = create(journal.db, 'account.bank.statement.line', {
    date: '2026-01-02', payment_ref: 'Bank transaction', amount: 20, journal_id: journal.id, counterpart: '450000',
  });
  const action = bankModels['account.bank.statement.line'].form.buttons.find((button) => button.label === 'Book to Account');
  assert.throws(() => action.run(line.db, read(line.db, 'account.bank.statement.line', line.id)), /liquidity account/i);
});

test('company creation without an installed source chart gives a readable configuration error', () => {
  const base = create(emptyDb(), 'res.currency', { name: 'USD', rounding: 0.01, rate_ids: [{ date: '0001-01-01', rate: 1, company_id: null }] });
  const company = create(base.db, 'res.company', { name: 'Unconfigured company', currency_id: base.id });
  assert.throws(() => invoiceLines(company.db, { company_id: company.id, move_type: 'out_invoice', invoice_line_ids: [] }), /default receivable/i);
  assert.throws(() => paymentJournal(company.db, null, company.id), /default.*journal/i);
});
