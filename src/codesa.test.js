import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { closeSession } from './models/pos.js';
import { postDueEntries } from './models/deferred.js';
import { createSheet, submitSheet, approveSheet, postSheet } from './models/expenseplus.js';
import { migrate } from './migrations.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';

test('bank reconciliation uses the selected journal suspense account', () => {
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank');
  assert.ok(journal.suspense_account_id, 'demo bank journal must configure suspense');
  const invoice = search(db, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted' && m.amount_residual > 0);
  const account = create(db, 'account.account', { name: 'Custom suspense', code: '928001', account_type: 'asset_current', company_id: 1 });
  db = write(account.db, 'account.journal', journal.id, { suspense_account_id: account.id });
  const line = create(db, 'account.bank.statement.line', { date: '2026-10-01', payment_ref: 'Excess', amount: invoice.amount_residual + 10, move_id: invoice.id, journal_id: journal.id, company_id: 1 });
  const run = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match').run;
  const result = run(line.db, read(line.db, 'account.bank.statement.line', line.id)).db;
  const statement = read(result, 'account.bank.statement.line', line.id);
  assert.ok(read(result, 'account.move', statement.bank_move_id).line_ids.some((l) => l.account_id === account.id));
  const missing = { ...line.db, records: { ...line.db.records, 'account.journal': line.db.records['account.journal'].map((rec) => (rec.id === journal.id ? { ...rec, suspense_account_id: null } : rec)) } };
  assert.throws(() => run(missing, read(missing, 'account.bank.statement.line', line.id)), /Configure the suspense account on journal Bank/);
});

test('deferral recognition requires configured accounts and uses their IDs', () => {
  let db = seed();
  const deferred = create(db, 'account.account', { name: 'Custom deferred', code: '928003', account_type: 'liability_current', company_id: 1 });
  const income = create(deferred.db, 'account.account', { name: 'Custom income', code: '928004', account_type: 'income', company_id: 1 });
  db = write(income.db, 'res.company', 1, { deferred_revenue_account_id: deferred.id });
  const schedule = create(db, 'account.deferral', { name: 'Custom deferral', company_id: 1, kind: 'revenue', state: 'running', recognition_account_id: income.id, board: [{ date: '2026-10-31', amount: 10, posted: false }] });
  const posted = postDueEntries(schedule.db, read(schedule.db, 'account.deferral', schedule.id), '2026-10-31');
  const entry = read(posted, 'account.move', read(posted, 'account.deferral', schedule.id).board[0].move_id);
  assert.ok(entry.line_ids.some((l) => l.account_id === deferred.id && l.debit === 10));
  assert.ok(entry.line_ids.some((l) => l.account_id === income.id && l.credit === 10));
  const missing = write(schedule.db, 'res.company', 1, { deferred_revenue_account_id: null });
  assert.throws(() => postDueEntries(missing, read(missing, 'account.deferral', schedule.id), '2026-10-31'), /deferred revenue account/i);
});

test('POS cash differences use the cash journal configured accounts', () => {
  let db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'cash');
  const profit = create(db, 'account.account', { name: 'Custom gain', code: '928002', account_type: 'income_other', company_id: 1 });
  const loss = create(profit.db, 'account.account', { name: 'Custom loss', code: '928008', account_type: 'expense_other', company_id: 1 });
  db = write(loss.db, 'account.journal', journal.id, { profit_account_id: profit.id, loss_account_id: loss.id });
  const method = create(db, 'pos.payment.method', { name: 'Custom cash', type: 'cash', company_id: 1, journal_id: journal.id });
  const config = create(method.db, 'pos.config', { name: 'Custom register', company_id: 1, payment_method_ids: [method.id] });
  const session = create(config.db, 'pos.session', { name: 'Custom session', company_id: 1, config_id: config.id, state: 'opened', cash_start: 0 });
  const closed = closeSession(session.db, read(session.db, 'pos.session', session.id), 5);
  const entry = search(closed, 'account.move').find((m) => m.ref === 'Custom session cash difference');
  assert.ok(entry.line_ids.some((line) => line.account_id === profit.id && line.credit === 5));
  const missing = write(session.db, 'account.journal', journal.id, { profit_account_id: null });
  assert.throws(() => closeSession(missing, read(missing, 'pos.session', session.id), 5), /profit account/i);
  const started = write(session.db, 'pos.session', session.id, { cash_start: 10 });
  const short = closeSession(started, read(started, 'pos.session', session.id), 5);
  const shortageEntry = search(short, 'account.move').find((m) => m.ref === 'Custom session cash difference');
  assert.ok(shortageEntry.line_ids.some((line) => line.account_id === loss.id && line.debit === 5));
  const missingLoss = write(started, 'account.journal', journal.id, { loss_account_id: null });
  assert.throws(() => closeSession(missingLoss, read(missingLoss, 'pos.session', session.id), 5), /loss account/i);
});

test('bank counterpart uses the explicitly selected account', () => {
  const db = seed();
  const account = create(db, 'account.account', { name: 'Custom expense', code: '928005', account_type: 'expense', company_id: 1 });
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const line = create(account.db, 'account.bank.statement.line', { date: '2026-10-01', payment_ref: 'Custom cost', amount: -15, journal_id: journal.id, company_id: 1, counterpart_account_id: account.id });
  const run = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Book to Account').run;
  const booked = run(line.db, read(line.db, 'account.bank.statement.line', line.id)).db;
  const entry = read(booked, 'account.move', read(booked, 'account.bank.statement.line', line.id).move_id);
  assert.ok(entry.line_ids.some((l) => l.account_id === account.id && l.debit === 15));
  const missing = write(line.db, 'account.bank.statement.line', line.id, { counterpart_account_id: null });
  assert.throws(() => run(missing, read(missing, 'account.bank.statement.line', line.id)), /select.*counterpart account/i);
});

test('expense report posts to configured expense and tax accounts', () => {
  let db = seed();
  const expenseAccount = create(db, 'account.account', { name: 'Custom costs', code: '928006', account_type: 'expense', company_id: 1 });
  const taxAccount = create(expenseAccount.db, 'account.account', { name: 'Custom tax', code: '928007', account_type: 'asset_current', company_id: 1 });
  const tax = create(taxAccount.db, 'account.tax', { name: 'Custom tax', type_tax_use: 'purchase', amount: 14, amount_type: 'percent', ...defaultTaxRepartitionLines(taxAccount.id), company_id: 1 });
  const journal = search(tax.db, 'account.journal').find((j) => j.type === 'purchase');
  db = write(tax.db, 'account.journal', journal.id, { default_account_id: expenseAccount.id });
  const expense = create(db, 'hr.expense', { name: 'Custom expense', employee_id: 2, total_amount: 114, tax: 14, tax_id: tax.id });
  const report = createSheet(expense.db, [expense.id], { name: 'Custom report' });
  db = submitSheet(report.db, report.id);
  db = approveSheet(db, report.id, read(db, 'hr.expense.sheet', report.id).manager_id || 1);
  const posted = postSheet(db, report.id, '2026-10-01');
  const entry = read(posted, 'account.move', read(posted, 'hr.expense.sheet', report.id).move_id);
  assert.ok(entry.line_ids.some((l) => l.account_id === expenseAccount.id && l.debit === 100));
  assert.ok(entry.line_ids.some((l) => l.account_id === taxAccount.id && l.debit === 14));
  const missingTax = write(db, 'hr.expense', expense.id, { tax_id: null });
  assert.throws(() => postSheet(missingTax, report.id, '2026-10-01'), /expense tax/i);
  const missingAccount = { ...db, records: { ...db.records, 'account.journal': db.records['account.journal'].map((rec) => (rec.id === journal.id ? { ...rec, default_account_id: null } : rec)) } };
  assert.throws(() => postSheet(missingAccount, report.id, '2026-10-01'), /expense account/i);
});

test('migration maps only company-owned chart accounts by code and type', () => {
  let db = seed();
  const company = create(db, 'res.company', { name: 'Migration company' });
  const suspense = create(company.db, 'account.account', { name: 'Suspense', code: '101404', account_type: 'asset_current', company_id: company.id });
  const wrong = create(suspense.db, 'account.account', { name: 'Wrong type', code: '450000', account_type: 'expense', company_id: company.id });
  const seededJ = create(wrong.db, 'account.journal', { name: 'Branch cash', code: 'BC', type: 'cash', company_id: company.id, suspense_account_id: suspense.id });
  const legacyJournals = seededJ.db.records['account.journal'].map((rec) => (rec.id === seededJ.id ? { ...rec, suspense_account_id: null } : rec));
  db = { ...seededJ.db, schema_version: 29, records: { ...seededJ.db.records, 'account.journal': legacyJournals } };
  const migrated = migrate(db);
  assert.equal(read(migrated, 'account.journal', seededJ.id).suspense_account_id, suspense.id);
  assert.equal(read(migrated, 'account.journal', seededJ.id).profit_account_id ?? null, null);
});

test('migration resolves a stored statement counterpart code to that company account', () => {
  let db = seed();
  const rent = search(db, 'account.account').find((a) => a.code === '630000' && (a.company_id ?? 1) === 1);
  const line = search(db, 'account.bank.statement.line').find((l) => l.counterpart_account_id === rent.id);
  const { counterpart_account_id: _drop, ...legacy } = line;
  db = { ...db, schema_version: 29, records: { ...db.records, 'account.bank.statement.line': db.records['account.bank.statement.line'].map((l) => (l.id === line.id ? { ...legacy, counterpart: '630000' } : l)) } };
  const migrated = read(migrate(db), 'account.bank.statement.line', line.id);
  assert.equal(migrated.counterpart_account_id, rent.id);
  assert.equal('counterpart' in migrated, false);
});
