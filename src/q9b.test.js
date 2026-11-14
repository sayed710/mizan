import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountingCompany, createCompanyWithDefaultInvoiceJournals, withDefaultBankJournal } from './test-support/accounting-company.js';
import { payMove, postMove } from './models/accounting.js';
import { cashFlow } from './models/reports.js';
import { reversePayment } from './models/pay.js';
import { closeFiscalYear, reopenFiscalYear, revalueForeignBalances } from './models/closing.js';
import { postEntry } from './models/ledger.js';
import { migrate } from './migrations.js';
import { models } from './models/index.js';
import { applyRule } from './models/reconcile.js';
import { taxesByTax } from './models/finance.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';

test('revaluation preserves thousandths on initial posting and changed reruns', () => {
  const own = create(seed(), 'res.currency', { name: 'Three decimal currency', rounding: 0.001, rate_ids: [
    { date: '2025-01-01', rate: 1 }, { date: '2025-02-01', rate: 1.001 },
  ] });
  const company = createCompanyWithDefaultInvoiceJournals(own.db, { name: 'Precision company', currency_id: own.id });
  const invoice = create(company.db, 'account.move', { move_type: 'out_invoice', partner_id: 2, company_id: company.id,
    currency_id: company.db.settings.base_currency_id, invoice_date: '2025-01-02', invoice_line_ids: [{ qty: 1, price_unit: 1, tax: 0 }] });
  let db = postMove(invoice.db, invoice.id);
  const cutoff = '2025-02-28';
  db = revalueForeignBalances(db, cutoff, { companyId: company.id });
  let entries = search(db, 'account.move').filter((m) => m.company_id === company.id && m.revaluation_date === cutoff);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].line_ids.map((l) => [l.debit, l.credit]), [[0.001, 0], [0, 0.001]]);
  assert.equal(revalueForeignBalances(db, cutoff, { companyId: company.id }), db);

  db = write(db, 'res.currency', own.id, { rate_ids: [{ date: '2025-01-01', rate: 1 }, { date: '2025-02-01', rate: 1.002 }] });
  db = revalueForeignBalances(db, cutoff, { companyId: company.id });
  entries = search(db, 'account.move').filter((m) => m.company_id === company.id && m.revaluation_date === cutoff);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[1].line_ids.map((l) => [l.debit, l.credit]), [[0.001, 0], [0, 0.001]]);
  assert.equal(read(db, 'account.move', entries[1].reversal_move_id).state, 'posted');
  assert.equal(revalueForeignBalances(db, cutoff, { companyId: company.id }), db);
});

test('legacy bank counterpart migration prefers the unique owned account over a shared account', () => {
  const base = seed();
  const shared = create(base, 'account.account', { name: 'Shared expense', code: 'Q9B-LEGACY', account_type: 'expense', company_id: null });
  const owned = create(shared.db, 'account.account', { name: 'Company expense', code: 'Q9B-LEGACY', account_type: 'expense', company_id: 1 });
  const journal = search(owned.db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const line = create(owned.db, 'account.bank.statement.line', { company_id: 1, journal_id: journal.id, date: '2025-01-02', payment_ref: 'Legacy expense', amount: -15 });
  const legacy = { ...line.db, schema_version: 29, records: { ...line.db.records,
    'account.bank.statement.line': line.db.records['account.bank.statement.line'].map((row) => row.id === line.id ? { ...row, counterpart: 'Q9B-LEGACY', counterpart_account_id: null } : row) } };
  for (const old of [legacy, migrate(legacy, 30)]) {
    const upgraded = migrate(old);
    const migrated = read(upgraded, 'account.bank.statement.line', line.id);
    assert.equal(migrated.counterpart_account_id, owned.id);
    const action = models['account.bank.statement.line'].form.buttons.find((button) => button.label === 'Book to Account');
    const booked = action.run(upgraded, migrated).db;
    const move = read(booked, 'account.move', read(booked, 'account.bank.statement.line', line.id).move_id);
    assert.ok(move.line_ids.some((item) => item.account_id === owned.id && item.debit === 15));
  }
});

test('legacy bank counterpart migration falls back to unique shared accounts and preserves ambiguity', () => {
  const base = seed();
  const shared = create(base, 'account.account', { name: 'Shared expense', code: 'Q9B-SHARED', account_type: 'expense', company_id: null });
  const company = create(shared.db, 'res.company', { name: 'Other company', currency_id: shared.db.settings.base_currency_id });
  const ownBank = withDefaultBankJournal(company.db, company.id);
  const journal = search(ownBank, 'account.journal').find((j) => j.type === 'bank' && j.company_id === company.id);
  const line = create(ownBank, 'account.bank.statement.line', { journal_id: journal.id, company_id: company.id, date: '2025-01-02', payment_ref: 'Legacy', amount: -15 });
  const legacy = { ...line.db, schema_version: 29, records: { ...line.db.records,
    'account.bank.statement.line': line.db.records['account.bank.statement.line'].map((row) => row.id === line.id ? { ...row, counterpart: 'Q9B-SHARED', counterpart_account_id: null } : row) } };
  assert.equal(read(migrate(legacy), 'account.bank.statement.line', line.id).counterpart_account_id, shared.id);
  const ambiguous = { ...legacy, records: { ...legacy.records, 'account.account': [...legacy.records['account.account'], { ...read(legacy, 'account.account', shared.id), id: 99999 }] } };
  const unresolved = read(migrate(ambiguous), 'account.bank.statement.line', line.id);
  assert.equal(unresolved.counterpart_account_id, null);
  assert.equal(unresolved.counterpart, 'Q9B-SHARED');
});

test('global legacy reconciliation rules use shared accounts across companies and retain unresolved choices', () => {
  const branch = accountingCompany(seed());
  const shared = create(branch.db, 'account.account', { name: 'Shared fee', code: 'Q9B-RULE', account_type: 'expense', company_id: null });
  const owned = create(shared.db, 'account.account', { name: 'Company fee', code: 'Q9B-RULE', account_type: 'expense', company_id: 1 });
  const onlyOwned = create(owned.db, 'account.account', { name: 'Private fee', code: 'Q9B-PRIVATE', account_type: 'expense', company_id: 1 });
  const rule = create(onlyOwned.db, 'account.reconcile.model', { name: 'Global fee', company_id: null, rule_type: 'writeoff_button', line_ids: [{ account_code: 'Q9B-RULE', amount_type: 'percentage', amount: 100 }] });
  const missing = create(rule.db, 'account.reconcile.model', { name: 'Unresolved fee', company_id: null, rule_type: 'writeoff_button', line_ids: [{ account_code: 'Q9B-PRIVATE', amount_type: 'percentage', amount: 100 }] });
  const db = migrate({ ...missing.db, schema_version: 30 }, 31);
  const migratedRule = read(db, 'account.reconcile.model', rule.id);
  assert.equal(migratedRule.line_ids[0].account_id, shared.id);
  const unresolved = read(db, 'account.reconcile.model', missing.id);
  assert.equal(unresolved.line_ids[0].account_id, null);
  assert.equal(unresolved.line_ids[0].account_code, 'Q9B-PRIVATE');
  const journal = search(db, 'account.journal').find((j) => j.company_id === branch.id && j.type === 'bank');
  const line = create(db, 'account.bank.statement.line', { company_id: branch.id, journal_id: journal.id, date: '2025-01-02', payment_ref: 'Fee', amount: -15 });
  assert.throws(() => applyRule(line.db, unresolved, read(line.db, 'account.bank.statement.line', line.id)), /configure the counterpart account/i);
  const booked = applyRule(line.db, migratedRule, read(line.db, 'account.bank.statement.line', line.id));
  const move = read(booked, 'account.move', read(booked, 'account.bank.statement.line', line.id).move_id);
  assert.ok(move.line_ids.some((item) => item.account_id === shared.id && item.debit === 15));
});

test('reconciliation write-offs keep identically named taxes distinct in the tax report', () => {
  let db = seed();
  const expense = create(db, 'account.account', { name: 'Write-off', code: 'Q9B-WRITEOFF', account_type: 'expense', company_id: 1 });
  const taxAccount = create(expense.db, 'account.account', { name: 'Tax account', code: 'Q9B-TAX', account_type: 'liability_current', company_id: 1 });
  const first = create(taxAccount.db, 'account.tax', { name: 'Same write-off tax', amount: 10, amount_type: 'percent', type_tax_use: 'sale', company_id: 1, ...defaultTaxRepartitionLines(taxAccount.id) });
  const second = create(first.db, 'account.tax', { name: 'Same write-off tax', amount: 20, amount_type: 'percent', type_tax_use: 'sale', company_id: 1, ...defaultTaxRepartitionLines(taxAccount.id) });
  db = second.db;
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  for (const [tax, amount] of [[first.id, 110], [second.id, 120]]) {
    const rule = create(db, 'account.reconcile.model', { name: 'Taxed write-off', company_id: 1, rule_type: 'writeoff_button', line_ids: [{ account_id: expense.id, amount_type: 'percentage', amount: 100, tax_ids: [tax] }] });
    const statement = create(rule.db, 'account.bank.statement.line', { company_id: 1, journal_id: journal.id, date: '2040-04-01', payment_ref: 'Taxed write-off', amount });
    db = applyRule(statement.db, read(statement.db, 'account.reconcile.model', rule.id), read(statement.db, 'account.bank.statement.line', statement.id));
    const move = read(db, 'account.move', read(db, 'account.bank.statement.line', statement.id).move_id);
    assert.equal(move.line_ids.find((line) => line.tax_name === 'Same write-off tax').tax_id, tax);
  }
  const rows = taxesByTax(db, { from: '2040-04-01', to: '2040-04-01' }).filter((row) => row.name === 'Same write-off tax').sort((a, b) => a.tax - b.tax);
  assert.deepEqual(rows.map((row) => [row.tax_id, row.base, row.tax]), [[first.id, 100, 10], [second.id, 100, 20]]);
});

test('reopening validates the original earnings account after company configuration changes', () => {
  const posted = postEntry(seed(), { journal: 'MISC', date: '2041-06-01', lines: [
    { account: '600000', debit: 100 }, { account: '101401', credit: 100 },
  ] });
  const year = create(posted.db, 'account.fiscal.year', { name: '2041', date_from: '2041-01-01', date_to: '2041-12-31' });
  const closed = closeFiscalYear(year.db, year.id);
  const original = read(closed, 'res.company', 1).current_year_earnings_account_id;
  const alternate = create(closed, 'account.account', { name: 'Alternate earnings', code: 'Q9B-EARN', account_type: 'equity', company_id: 1 });
  const changed = write(alternate.db, 'res.company', 1, { current_year_earnings_account_id: alternate.id });
  const reopened = reopenFiscalYear(changed, year.id);
  assert.equal(read(changed, 'account.fiscal.year', year.id).closing_earnings_account_id, original);
  assert.throws(() => write(changed, 'account.fiscal.year', year.id, { closing_earnings_account_id: alternate.id }), /closing.*account/i);
  const fiscalYear = read(reopened, 'account.fiscal.year', year.id);
  assert.equal(fiscalYear.state, 'open');
  const closing = read(reopened, 'account.move', fiscalYear.closing_move_id);
  const reversal = read(reopened, 'account.move', fiscalYear.opening_move_id);
  assert.deepEqual(reversal.line_ids.map((l) => [l.account_id, l.debit, l.credit]), closing.line_ids.map((l) => [l.account_id, l.credit, l.debit]));
  const reclosed = closeFiscalYear(reopened, year.id);
  assert.equal(read(reclosed, 'account.fiscal.year', year.id).closing_earnings_account_id, alternate.id);
  assert.equal(read(reopenFiscalYear(reclosed, year.id), 'account.fiscal.year', year.id).state, 'open');
});

test('cash flow retains historical exchange attribution after changing exchange accounts', () => {
  const fx = create(seed(), 'res.currency', { name: 'Q9B FX', rate_ids: [
    { date: '2042-01-01', rate: 2 }, { date: '2042-01-02', rate: 1 },
  ] });
  const asset = create(fx.db, 'account.account', { name: 'Investment', code: 'Q9B-ASSET', account_type: 'asset_fixed', company_id: 1 });
  const tag = create(asset.db, 'account.account.tag', { name: 'Investment activity', cash_flow_activity: 'investing' });
  const configured = write(tag.db, 'account.account', asset.id, { tag_ids: [tag.id] });
  const invoice = create(configured, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2042-01-01', currency_id: fx.id,
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0, account_id: asset.id }] });
  const paid = payMove(postMove(invoice.db, invoice.id), invoice.id, 100, '2042-01-02');
  const period = { from: '2042-01-02', to: '2042-01-02' };
  const before = cashFlow(paid, period);
  assert.equal(before.investing, 100);
  const gain = create(paid, 'account.account', { name: 'New gain', code: 'Q9B-GAIN', account_type: 'income_other', company_id: 1 });
  const loss = create(gain.db, 'account.account', { name: 'New loss', code: 'Q9B-LOSS', account_type: 'expense_other', company_id: 1 });
  const changed = write(loss.db, 'res.company', 1, { income_currency_exchange_account_id: gain.id, expense_currency_exchange_account_id: loss.id });
  const after = cashFlow(changed, period);
  assert.deepEqual([after.operating, after.investing, after.financing, after.unclassified, after.net],
    [before.operating, before.investing, before.financing, before.unclassified, before.net]);
  const payment = search(changed, 'account.payment').find((p) => p.invoice_id === invoice.id);
  const reversed = reversePayment(changed, payment, '2042-01-03');
  const reversal = cashFlow(reversed, { from: '2042-01-03', to: '2042-01-03' });
  assert.deepEqual([reversal.operating, reversal.investing, reversal.net], [0, -100, -100]);
});

test('reversing a general entry cancels signed tax bases in the tax report', () => {
  const taxAccount = create(seed(), 'account.account', { name: 'Reversal tax', code: 'Q9B-REV-TAX', account_type: 'liability_current', company_id: 1 });
  const posted = postEntry(taxAccount.db, { journal: 'MISC', date: '2043-01-01', company: 1, lines: [
    { account: '101401', debit: 10 },
    { account_id: taxAccount.id, credit: 10, tax_name: 'Reversal tax', tax_side: 'sale', tax_base: 100, tax_base_signed: true },
  ] });
  const period = { from: '2043-01-01', to: '2043-01-02' };
  const before = taxesByTax(posted.db, period).find((row) => row.name === 'Reversal tax');
  assert.deepEqual([before.base, before.tax], [100, 10]);
  const action = models['account.move'].form.buttons.find((button) => button.label === 'Reverse Entry');
  const reversed = action.run(posted.db, read(posted.db, 'account.move', posted.id), { date: '2043-01-02' }).db;
  const after = taxesByTax(reversed, period).find((row) => row.name === 'Reversal tax');
  assert.deepEqual([after.base, after.tax], [0, 0]);
});
