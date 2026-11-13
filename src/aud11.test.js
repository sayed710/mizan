// AUD11 regression: a reconciliation model whose counterpart lines do not cover the whole open amount
// books those counterparts and leaves the remainder open on the statement line, like Odoo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { accountId, balances, isBalanced, journalItems } from './models/ledger.js';
import { trialBalance } from './models/reports.js';
import { applyRule, autoReconcile } from './models/reconcile.js';
import { round } from './money.js';

const LINE = 'account.bank.statement.line';
const button = (db, id, label) => models[LINE].form.buttons.find((b) => b.label === label).run(db, read(db, LINE, id)).db;
const bankJournal = (db) => search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
const feeId = (db) => accountId(db, '690000');
const expensesId = (db) => accountId(db, '600000');
const bankId = (db) => accountId(db, '101401');
const suspenseId = (db) => accountId(db, '101404');
const ledgerBalance = (db, id) => round(balances(db, journalItems(db, { company_id: 1 })).find((b) => b.account?.id === id)?.balance ?? 0);
const balanced = (db, label) => {
  assert.equal(round(trialBalance(db, { company_id: 1 }).totals.end), 0, `${label}: trial balance does not close`);
};
const feeRule = (db, vals) => create(db, 'account.reconcile.model', { name: 'Half fee', rule_type: 'writeoff_button', sequence: 1, active: true, match_nature: 'both', match_amount: '', match_label: '', line_ids: [{ account_id: feeId(db), label: 'Bank fee', amount_type: 'percentage', amount: 50 }], ...vals });
/** A 100.00 statement line for a 95.00 invoice, then the counterpart rule of the given type and amount. */
const partialWriteOff = (amountType, amount) => {
  const invoice = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 95, tax: 0 }] });
  const posted = postMove(invoice.db, invoice.id);
  const line = create(posted, LINE, { journal_id: bankJournal(posted).id, date: '2026-01-03', payment_ref: 'small fee', amount: 100, move_id: invoice.id, partner_id: 3 });
  const rule = create(line.db, 'account.reconcile.model', { name: 'Partial fee', rule_type: 'writeoff_button', line_ids: [{ account_id: feeId(line.db), label: 'Bank fee', amount_type: amountType, amount }] });
  return { db: applyRule(rule.db, read(rule.db, 'account.reconcile.model', rule.id), read(rule.db, LINE, line.id)), line: line.id, invoice: invoice.id, rule: rule.id };
};

for (const [amountType, amount] of [['fixed', 5], ['percentage', 5]]) test(`B4: a ${amountType} write-off of ${amount} books its counterparts and leaves the rest open on the statement line`, () => {
  const before = seed();
  const base = { bank: ledgerBalance(before, bankId(before)), fee: ledgerBalance(before, feeId(before)) };
  const x = partialWriteOff(amountType, amount);
  const line = read(x.db, LINE, x.line);
  assert.equal(line.state, 'to_check');
  assert.equal(line.open_amount, 95);
  assert.ok(line.bank_move_id && line.bank_move_id !== line.move_id, 'the bank movement is booked once, separately from the write-off entry');
  assert.deepEqual(line.allocations, [{ payment_move_id: line.move_id, amount, reconcile_model_id: x.rule }]);
  const writeoff = read(x.db, 'account.move', line.move_id);
  assert.ok(isBalanced(writeoff.line_ids));
  assert.equal(writeoff.line_ids.filter((l) => l.account_id === suspenseId(x.db)).reduce((sum, l) => sum + l.debit - l.credit, 0), amount);
  assert.equal(writeoff.line_ids.filter((l) => l.account_id === feeId(x.db)).reduce((sum, l) => sum + l.debit - l.credit, 0), -amount);
  const bank = read(x.db, 'account.move', line.bank_move_id);
  assert.equal(bank.line_ids.filter((l) => l.account_id === bankId(x.db))[0].debit, 100);
  assert.equal(bank.line_ids.filter((l) => l.account_id === suspenseId(x.db))[0].credit, 100);
  assert.equal(read(x.db, 'account.move', x.invoice).amount_residual, 95, 'the write-off does not settle the invoice');
  balanced(x.db, `B4 ${amountType} applied`);
  assert.equal(round(ledgerBalance(x.db, bankId(x.db)) - base.bank), 100);
  assert.equal(round(ledgerBalance(x.db, feeId(x.db)) - base.fee), -amount);
});

for (const [amountType, amount] of [['fixed', 5], ['percentage', 5]]) test(`B4: unreconciling a partial ${amountType} write-off restores the line`, () => {
  const before = seed();
  const base = { bank: ledgerBalance(before, bankId(before)), fee: ledgerBalance(before, feeId(before)) };
  const x = partialWriteOff(amountType, amount);
  const writeoffMoveId = read(x.db, LINE, x.line).move_id;
  const after = button(x.db, x.line, 'Unreconcile');
  const line = read(after, LINE, x.line);
  assert.equal(line.state, 'to_check');
  assert.equal(line.move_id, null);
  assert.equal(line.bank_move_id, null);
  assert.equal(line.open_amount, null);
  assert.deepEqual(line.allocations, []);
  assert.ok(search(after, 'account.move').some((m) => m.reversed_entry_id === writeoffMoveId), 'the write-off entry is reversed');
  assert.equal(read(after, 'account.move', x.invoice).amount_residual, 95);
  balanced(after, `B4 ${amountType} unreconciled`);
  assert.equal(round(ledgerBalance(after, bankId(after)) - base.bank), 0);
  assert.equal(round(ledgerBalance(after, feeId(after)) - base.fee), 0);
});

for (const [amountType, amount] of [['fixed', 5], ['percentage', 5]]) test(`B4: matching the rest to the invoice reconciles a line left open by a ${amountType} write-off`, () => {
  const before = seed();
  const base = { bank: ledgerBalance(before, bankId(before)), fee: ledgerBalance(before, feeId(before)) };
  const x = partialWriteOff(amountType, amount);
  let db = write(x.db, LINE, x.line, { move_id: x.invoice });
  db = button(db, x.line, 'Match');
  const line = read(db, LINE, x.line);
  assert.equal(line.state, 'reconciled');
  assert.equal(line.open_amount, 0);
  assert.equal(read(db, 'account.move', x.invoice).amount_residual, 0);
  assert.equal(round((line.allocations ?? []).reduce((sum, allocation) => sum + allocation.amount, 0)), 100);
  assert.equal((line.allocations ?? []).filter((a) => a.invoice_id).length, 1);
  balanced(db, `B4 ${amountType} matched`);
  assert.equal(round(ledgerBalance(db, bankId(db)) - base.bank), 100);
  assert.equal(round(ledgerBalance(db, feeId(db)) - base.fee), -amount);
});

// ---- PR #113 review: three findings on the partial write-off ----

test('Qodo 11.1: a second automatic run does not re-apply the same model to the rest of a partial write-off', () => {
  const before = seed();
  const base = { bank: ledgerBalance(before, bankId(before)), fee: ledgerBalance(before, feeId(before)) };
  const rule = feeRule(seed(), { name: 'Half fee', auto_reconcile: true, match_label: 'contains', match_label_param: 'card fee' });
  let db = rule.db;
  const line = create(db, LINE, { journal_id: bankJournal(db).id, date: '2026-01-03', payment_ref: 'card fee', amount: 1000, state: 'to_check' });
  db = line.db;
  const first = autoReconcile(db);
  const afterFirst = read(first, LINE, line.id);
  assert.equal(afterFirst.state, 'to_check', 'a 50% rule leaves half the line open');
  assert.equal(afterFirst.open_amount, 500);
  assert.deepEqual(afterFirst.allocations, [{ payment_move_id: afterFirst.move_id, amount: 500, reconcile_model_id: rule.id }], 'the allocation records the model that booked it');
  const movesAfterFirst = search(first, 'account.move').length;

  const second = autoReconcile(first);
  const afterSecond = read(second, LINE, line.id);
  assert.equal(afterSecond.state, 'to_check');
  assert.equal(afterSecond.open_amount, 500, 'the scheduled rerun leaves the reserved rest untouched');
  assert.deepEqual(afterSecond.allocations, afterFirst.allocations, 'the same model never allocates this line twice');
  assert.equal(search(second, 'account.move').length, movesAfterFirst, 'the rerun posts no entry');
  assert.equal(read(second, 'account.move', afterSecond.move_id).line_ids.filter((l) => l.account_id === suspenseId(second)).reduce((sum, l) => sum + l.debit - l.credit, 0), 500);
  balanced(second, '11.1 rerun');
  assert.equal(round(ledgerBalance(second, bankId(second)) - base.bank), 1000, 'the bank movement is booked once for the whole line');
  assert.equal(round(ledgerBalance(second, feeId(second)) - base.fee), -500, 'only the first 500 was written off');
});

test('Qodo 11.1: a different model can still take the rest a partial write-off left open', () => {
  const first = feeRule(seed(), { name: 'Half fee', auto_reconcile: true, match_label: 'contains', match_label_param: 'card fee' });
  let db = first.db;
  const line = create(db, LINE, { journal_id: bankJournal(db).id, date: '2026-01-03', payment_ref: 'card fee', amount: 1000, state: 'to_check' });
  db = autoReconcile(line.db);
  const opened = read(db, LINE, line.id);
  assert.equal(opened.open_amount, 500);

  const rest = create(db, 'account.reconcile.model', {
    name: 'Rest to expenses', rule_type: 'writeoff_button', sequence: 2, active: true, auto_reconcile: true,
    match_nature: 'both', match_amount: '', match_label: 'contains', match_label_param: 'card fee',
    line_ids: [{ account_id: expensesId(db), label: 'Rest', amount_type: 'percentage', amount: 100 }],
  });
  db = rest.db;
  const after = autoReconcile(db);
  const line2 = read(after, LINE, line.id);
  assert.equal(line2.state, 'reconciled');
  assert.equal(line2.open_amount, 0);
  assert.deepEqual(line2.allocations.map((a) => a.reconcile_model_id), [first.id, rest.id], 'each model books its own share');
  assert.deepEqual(line2.allocations.map((a) => a.amount), [500, 500]);
  assert.equal(round((line2.allocations ?? []).reduce((sum, allocation) => sum + allocation.amount, 0)), 1000);
  balanced(after, '11.1 second model');
});

test('Qodo 11.2: a fixed taxed counterpart above the balance is rejected instead of a negative percentage share', () => {
  let db = seed();
  const tax = search(db, 'account.tax').find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const rule = create(db, 'account.reconcile.model', {
    name: 'Oversized fee', rule_type: 'writeoff_button', line_ids: [
      { account_id: expensesId(db), label: 'Fixed fee', amount_type: 'fixed', amount: 150, tax_ids: [tax.id] },
      { account_id: feeId(db), label: 'Rest', amount_type: 'percentage', amount: 100 },
    ],
  });
  db = rule.db;
  const line = create(db, LINE, { journal_id: bankJournal(db).id, date: '2026-01-03', payment_ref: 'oversized fee', amount: 100, state: 'to_check' });
  db = line.db;
  const moves = search(db, 'account.move').length;
  assert.throws(() => applyRule(db, read(db, 'account.reconcile.model', rule.id), read(db, LINE, line.id)), /fixed counterpart lines exceed the amount to reconcile/);
  const after = read(db, LINE, line.id);
  assert.equal(after.state, 'to_check', 'the rejected rule books nothing');
  assert.ok(after.move_id == null, 'no write-off entry is linked');
  assert.ok(after.open_amount == null, 'no open amount was recorded');
  assert.deepEqual(after.allocations ?? [], [], 'nothing was allocated');
  assert.equal(search(db, 'account.move').length, moves, 'no entry is posted');
  balanced(db, '11.2 rejected');

  // A taxed fixed amount that fits the balance keeps its tax consistent with the amount it posted.
  const fitting = create(db, 'account.reconcile.model', {
    name: 'Fitting fee', rule_type: 'writeoff_button', line_ids: [
      { account_id: expensesId(db), label: 'Fixed fee', amount_type: 'fixed', amount: 50, tax_ids: [tax.id] },
      { account_id: feeId(db), label: 'Rest', amount_type: 'percentage', amount: 100 },
    ],
  });
  const booked = applyRule(db, read(fitting.db, 'account.reconcile.model', fitting.id), read(fitting.db, LINE, line.id));
  const applied = read(booked, LINE, line.id);
  assert.equal(applied.state, 'reconciled');
  const items = read(booked, 'account.move', applied.move_id).line_ids;
  assert.ok(isBalanced(items));
  const taxItem = items.find((l) => l.tax_name === 'VAT 14%');
  const expenseItem = items.find((l) => l.account_id === expensesId(booked));
  assert.equal(expenseItem.credit, 43.86, 'the posted fixed amount carries its own tax');
  assert.equal(taxItem.credit, 6.14);
  assert.equal(round(expenseItem.credit + taxItem.credit), 50, 'net plus tax is the posted fixed amount');
  assert.equal(items.find((l) => l.account_id === feeId(booked)).credit, 50, 'the percentage line takes the rest');
  balanced(booked, '11.2 fitting fixed fee');
});

/** A company whose currency rounds to whole units, banking in a currency worth two of its units. */
const coarseCompany = (db) => {
  const whole = create(db, 'res.currency', { name: 'WHOLE', rounding: 1, rate_ids: [{ date: '2020-01-01', rate: 1, company_id: null }] });
  let next = whole.db;
  const company = create(next, 'res.company', { name: 'Whole Co', currency_id: whole.id });
  next = company.db;
  const double = create(next, 'res.currency', { name: 'DOUBLE', rounding: 0.01, rate_ids: [{ date: '2020-01-01', rate: 2, company_id: null }] });
  next = double.db;
  const bank = create(next, 'account.account', { code: '101900', name: 'Bank Whole', account_type: 'asset_cash', company_id: company.id });
  next = bank.db;
  const suspense = create(next, 'account.account', { code: '101901', name: 'Suspense Whole', account_type: 'asset_current', company_id: company.id });
  next = suspense.db;
  const fee = create(next, 'account.account', { code: '600900', name: 'Fees Whole', account_type: 'expense', company_id: company.id });
  next = fee.db;
  const journal = create(next, 'account.journal', { name: 'Bank Whole', code: 'BNKW', type: 'bank', company_id: company.id, default_account_id: bank.id, suspense_account_id: suspense.id, currency_id: double.id });
  next = journal.db;
  const rule = create(next, 'account.reconcile.model', { name: 'Half fee', rule_type: 'writeoff_button', company_id: company.id, sequence: 1, active: true, match_nature: 'both', match_amount: '', match_label: '', line_ids: [{ account_id: fee.id, label: 'Half fee', amount_type: 'percentage', amount: 50 }] });
  return { db: rule.db, company: company.id, journal: journal.id, rule: rule.id, fee: fee.id, bank: bank.id, suspense: suspense.id };
};

test('Qodo 11.3: a 50% foreign share that rounds to the whole booked company amount reconciles the line', () => {
  const s = coarseCompany(seed());
  const line = create(s.db, LINE, { company_id: s.company, journal_id: s.journal, date: '2026-01-03', payment_ref: 'half fee', amount: 2, state: 'to_check' });
  const after = applyRule(line.db, read(line.db, 'account.reconcile.model', s.rule), read(line.db, LINE, line.id));
  const applied = read(after, LINE, line.id);
  assert.equal(applied.state, 'reconciled', 'the rounding gap is absorbed instead of leaving an unmatchable rest');
  assert.equal(applied.open_amount, 0);
  assert.deepEqual(applied.allocations, [{ payment_move_id: applied.move_id, amount: 1, reconcile_model_id: s.rule }], 'the whole booked company amount is allocated');
  const items = read(after, 'account.move', applied.move_id).line_ids;
  assert.ok(isBalanced(items));
  assert.equal(items.filter((l) => l.account_id === s.bank).reduce((sum, l) => sum + l.debit - l.credit, 0), 1);
  assert.equal(items.filter((l) => l.account_id === s.fee).reduce((sum, l) => sum + l.debit - l.credit, 0), -1);
  assert.equal(round(items.reduce((sum, l) => sum + (Number(l.amount_currency) || 0), 0)), 0, 'the entry also balances in journal currency');
  assert.equal(round(items.find((l) => l.account_id === s.bank).amount_currency), 2, 'the bank item books both journal units');
  assert.equal(round(items.find((l) => l.account_id === s.fee).amount_currency), -2, 'the counterpart absorbs the unit the increment cannot represent');
  assert.equal(search(after, 'account.move').length, search(line.db, 'account.move').length + 1, 'one entry books the whole line');
  // Nothing is left to_check for a later run to fail on.
  const rerun = autoReconcile(after);
  assert.equal(read(rerun, LINE, line.id).state, 'reconciled');
  assert.throws(() => applyRule(rerun, read(rerun, 'account.reconcile.model', s.rule), read(rerun, LINE, line.id)), /already reconciled/);
});

test('Qodo 11.3: a foreign partial whose company remainder survives rounding keeps the rest open', () => {
  const s = coarseCompany(seed());
  // Four journal units book as two company units, so a 50% share leaves one company unit open.
  const line = create(s.db, LINE, { company_id: s.company, journal_id: s.journal, date: '2026-01-03', payment_ref: 'half fee', amount: 4, state: 'to_check' });
  const after = applyRule(line.db, read(line.db, 'account.reconcile.model', s.rule), read(line.db, LINE, line.id));
  const applied = read(after, LINE, line.id);
  assert.equal(applied.state, 'to_check');
  assert.equal(applied.open_amount, 1);
  assert.deepEqual(applied.allocations, [{ payment_move_id: applied.move_id, amount: 1, reconcile_model_id: s.rule }]);
  const bank = read(after, 'account.move', applied.bank_move_id);
  assert.equal(round(bank.line_ids.find((l) => l.account_id === s.bank).debit), 2, 'all four journal units reach the bank');
  const items = read(after, 'account.move', applied.move_id).line_ids;
  assert.ok(isBalanced(items));
  assert.equal(round(items.find((l) => l.account_id === s.fee).credit), 1);
  assert.equal(round(items.find((l) => l.account_id === s.fee).amount_currency), -2, 'the share carries its two journal units');
  assert.equal(round(items.reduce((sum, l) => sum + (Number(l.amount_currency) || 0), 0)), 0, 'the entry balances in journal currency too');
});
