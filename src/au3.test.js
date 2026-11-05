import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { applyRule, autoReconcile, ruleMatches, suggestRule } from './models/reconcile.js';
import { isBalanced } from './models/ledger.js';

test('Finding 2: Multi-company rule isolation in bank reconciliation models', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Company 2', currency_id: 1 });
  db = c2.db;

  const acc1 = create(db, 'account.account', { code: '600001', name: 'Fees C1', account_type: 'expense', company_id: 1 });
  db = acc1.db;
  const acc2 = create(db, 'account.account', { code: '600002', name: 'Fees C2', account_type: 'expense', company_id: c2.id });
  db = acc2.db;
  const bankAcc2 = create(db, 'account.account', { code: '101002', name: 'Bank C2', account_type: 'asset_cash', company_id: c2.id });
  db = bankAcc2.db;
  const j2 = create(db, 'account.journal', { name: 'Bank C2', code: 'BNK2', type: 'bank', company_id: c2.id, default_account_id: bankAcc2.id, suspense_account_id: bankAcc2.id });
  db = j2.db;

  const rule1 = create(db, 'account.reconcile.model', {
    name: 'Company 1 Bank Fees', company_id: 1, sequence: 10, auto_reconcile: true,
    rule_type: 'writeoff_suggestion', match_label: 'contains', match_label_param: 'Bank Fees',
    line_ids: [{ account_id: acc1.id, amount_type: 'percentage', amount: 100 }],
  });
  db = rule1.db;

  const rule2 = create(db, 'account.reconcile.model', {
    name: 'Company 2 Bank Fees', company_id: c2.id, sequence: 20, auto_reconcile: true,
    rule_type: 'writeoff_suggestion', match_label: 'contains', match_label_param: 'Bank Fees',
    line_ids: [{ account_id: acc2.id, amount_type: 'percentage', amount: 100 }],
  });
  db = rule2.db;

  const stLine = create(db, 'account.bank.statement.line', {
    payment_ref: 'Monthly Bank Fees', name: 'Monthly Bank Fees',
    company_id: c2.id, journal_id: j2.id, amount: -15, date: '2025-01-31', state: 'to_check',
  });
  db = stLine.db;
  const line = read(db, 'account.bank.statement.line', stLine.id);

  assert.equal(ruleMatches(read(db, 'account.reconcile.model', rule1.id), line), false);
  assert.equal(ruleMatches(read(db, 'account.reconcile.model', rule2.id), line), true);
  assert.equal(suggestRule(db, line)?.name, 'Company 2 Bank Fees');

  const afterAuto = autoReconcile(db);
  const updated = read(afterAuto, 'account.bank.statement.line', line.id);
  assert.equal(updated.state, 'reconciled');
  assert.ok(updated.move_id);

  const move = read(afterAuto, 'account.move', updated.move_id);
  assert.equal(move.company_id, c2.id);
  assert.ok(isBalanced(move.line_ids));
  const expenseLine = move.line_ids.find((l) => l.account_id === acc2.id);
  assert.ok(expenseLine);
  assert.equal(expenseLine.debit, 15);
});

test('Finding 3: Reconciliation model write-off with withholding tax balances correctly', () => {
  let db = seed();
  const taxAcc = create(db, 'account.account', { code: '445500', name: 'Tax Withholding', account_type: 'liability_current', company_id: 1 });
  db = taxAcc.db;

  const tax = create(db, 'account.tax', {
    name: '5% Withholding', amount: -5, amount_type: 'percent', type_tax_use: 'purchase',
    company_id: 1, invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base' },
      { factor_percent: 100, repartition_type: 'tax', account_id: taxAcc.id },
    ],
  });
  db = tax.db;

  const expAcc = create(db, 'account.account', { code: '600000', name: 'Services', account_type: 'expense', company_id: 1 });
  db = expAcc.db;

  const rule = create(db, 'account.reconcile.model', {
    name: 'Withholding Service', company_id: 1, sequence: 10, rule_type: 'writeoff_button', match_nature: 'both',
    line_ids: [{ account_id: expAcc.id, amount_type: 'percentage', amount: 100, tax_ids: [tax.id] }],
  });
  db = rule.db;

  const j = search(db, 'account.journal').find((x) => x.type === 'bank');

  // Scenario 3a: Outgoing payment of 95 (amount = -95) with 5% withholding tax
  const stLinePaid = create(db, 'account.bank.statement.line', {
    payment_ref: 'Payment with withholding', name: 'Payment with withholding',
    company_id: 1, journal_id: j.id, amount: -95, date: '2025-01-31', state: 'to_check',
  });
  db = stLinePaid.db;

  const appliedPaid = applyRule(db, read(db, 'account.reconcile.model', rule.id), read(db, 'account.bank.statement.line', stLinePaid.id));
  const reconciledPaid = read(appliedPaid, 'account.bank.statement.line', stLinePaid.id);
  assert.equal(reconciledPaid.state, 'reconciled');

  const movePaid = read(appliedPaid, 'account.move', reconciledPaid.move_id);
  assert.ok(isBalanced(movePaid.line_ids));

  const bankLinePaid = movePaid.line_ids.find((l) => l.account_id === j.default_account_id);
  const expenseLinePaid = movePaid.line_ids.find((l) => l.account_id === expAcc.id);
  const taxLinePaid = movePaid.line_ids.find((l) => l.account_id === taxAcc.id);

  assert.equal(bankLinePaid.credit, 95);
  assert.equal(bankLinePaid.debit, 0);
  assert.equal(expenseLinePaid.debit, 100);
  assert.equal(expenseLinePaid.credit, 0);
  assert.equal(taxLinePaid.credit, 5);
  assert.equal(taxLinePaid.debit, 0);

  // Scenario 3b: Incoming payment of 95 (amount = 95) with 5% withholding tax
  const stLineRecv = create(appliedPaid, 'account.bank.statement.line', {
    payment_ref: 'Receipt with withholding', name: 'Receipt with withholding',
    company_id: 1, journal_id: j.id, amount: 95, date: '2025-01-31', state: 'to_check',
  });
  db = stLineRecv.db;

  const appliedRecv = applyRule(db, read(db, 'account.reconcile.model', rule.id), read(db, 'account.bank.statement.line', stLineRecv.id));
  const reconciledRecv = read(appliedRecv, 'account.bank.statement.line', stLineRecv.id);
  assert.equal(reconciledRecv.state, 'reconciled');

  const moveRecv = read(appliedRecv, 'account.move', reconciledRecv.move_id);
  assert.ok(isBalanced(moveRecv.line_ids));

  const bankLineRecv = moveRecv.line_ids.find((l) => l.account_id === j.default_account_id);
  const expenseLineRecv = moveRecv.line_ids.find((l) => l.account_id === expAcc.id);
  const taxLineRecv = moveRecv.line_ids.find((l) => l.account_id === taxAcc.id);

  assert.equal(bankLineRecv.debit, 95);
  assert.equal(bankLineRecv.credit, 0);
  assert.equal(expenseLineRecv.credit, 100);
  assert.equal(expenseLineRecv.debit, 0);
  assert.equal(taxLineRecv.debit, 5);
  assert.equal(taxLineRecv.credit, 0);
});

test('Finding 2 & 3: Direct applyRule cross-company rejection and global rule matching', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Company 2', currency_id: 1 });
  db = c2.db;

  const acc1 = create(db, 'account.account', { code: '600001', name: 'Fees C1', account_type: 'expense', company_id: 1 });
  db = acc1.db;
  const acc2 = create(db, 'account.account', { code: '600002', name: 'Fees C2', account_type: 'expense', company_id: c2.id });
  db = acc2.db;
  const bankAcc2 = create(db, 'account.account', { code: '101002', name: 'Bank C2', account_type: 'asset_cash', company_id: c2.id });
  db = bankAcc2.db;
  const j2 = create(db, 'account.journal', { name: 'Bank C2', code: 'BNK2', type: 'bank', company_id: c2.id, default_account_id: bankAcc2.id, suspense_account_id: bankAcc2.id });
  db = j2.db;

  const ruleC1 = create(db, 'account.reconcile.model', {
    name: 'C1 Model', company_id: 1, rule_type: 'writeoff_button',
    line_ids: [{ account_id: acc1.id, amount_type: 'percentage', amount: 100 }],
  });
  db = ruleC1.db;

  const stLineC2 = create(db, 'account.bank.statement.line', {
    payment_ref: 'Test Bank Line C2', name: 'Test Bank Line C2',
    company_id: c2.id, journal_id: j2.id, amount: -50, date: '2025-01-31', state: 'to_check',
  });
  db = stLineC2.db;

  // Cross-company applyRule must throw clear error
  assert.throws(
    () => applyRule(db, read(db, 'account.reconcile.model', ruleC1.id), read(db, 'account.bank.statement.line', stLineC2.id)),
    /Reconciliation model belongs to another company/,
  );

  // Global rule (company_id: null) can match C2 line
  const globalAcc = create(db, 'account.account', { code: '600099', name: 'Global Fees', account_type: 'expense' });
  db = globalAcc.db;
  const ruleGlobal = create(db, 'account.reconcile.model', {
    name: 'Global Rule', company_id: null, rule_type: 'writeoff_suggestion', sequence: 50,
    match_label: 'contains', match_label_param: 'Global',
    line_ids: [{ account_id: globalAcc.id, amount_type: 'percentage', amount: 100 }],
  });
  db = ruleGlobal.db;

  const stLineGlobal = create(db, 'account.bank.statement.line', {
    payment_ref: 'Global Subscription Fee', name: 'Global Subscription Fee',
    company_id: c2.id, journal_id: j2.id, amount: -20, date: '2025-01-31', state: 'to_check',
  });
  db = stLineGlobal.db;

  const matched = suggestRule(db, read(db, 'account.bank.statement.line', stLineGlobal.id));
  assert.equal(matched?.name, 'Global Rule');
});

