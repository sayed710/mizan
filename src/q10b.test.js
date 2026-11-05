import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { closeFiscalYear, reopenFiscalYear } from './models/closing.js';
import { confirmAsset, postDepreciation } from './models/assets.js';
import { postMove } from './models/accounting.js';
import { approveSheet, createSheet, postSheet, submitSheet } from './models/expenseplus.js';
import { openSession, payCart, startSession } from './models/pos.js';

test('Qodo 1: mandatory analytic plans do not block fiscal closing, reopening, or unallocated depreciation', () => {
  let db = seed();

  // Create a mandatory analytic plan
  const plan = create(db, 'account.analytic.plan', {
    name: 'Mandatory General Plan',
    default_applicability: 'mandatory',
  });
  db = plan.db;

  const analyticAcc = create(db, 'account.analytic.account', {
    name: 'Core Operations',
    plan_id: plan.id,
  });
  db = analyticAcc.db;

  // 1. Fiscal year closing & reopening
  const year = create(db, 'account.fiscal.year', {
    name: 'FY2025',
    company_id: 1,
    date_from: '2025-01-01',
    date_to: '2025-12-31',
  });
  db = year.db;

  // Post an invoice in 2025 with analytic distribution so invoice posting succeeds
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2025-06-01',
    invoice_line_ids: [{
      product_id: 1,
      qty: 1,
      price_unit: 500,
      tax: 0,
      analytic_distribution: { [analyticAcc.id]: 100 },
    }],
  });
  db = postMove(inv.db, inv.id);

  // Close fiscal year should succeed without mandatory plan error
  assert.doesNotThrow(() => {
    db = closeFiscalYear(db, year.id);
  }, 'Fiscal closing should not be blocked by mandatory analytic plans');

  const closedYear = read(db, 'account.fiscal.year', year.id);
  assert.equal(closedYear.state, 'closed');

  // Reopen fiscal year should also succeed
  assert.doesNotThrow(() => {
    db = reopenFiscalYear(db, year.id);
  }, 'Fiscal reopening should not be blocked by mandatory analytic plans');

  const reopenedYear = read(db, 'account.fiscal.year', year.id);
  assert.equal(reopenedYear.state, 'open');

  // 2. Unallocated depreciation on an asset without analytic distribution
  const asset = create(db, 'account.asset', {
    name: 'Unallocated Test Asset',
    company_id: 1,
    original_value: 1200,
    salvage_value: 0,
    acquisition_date: '2026-01-01',
    method: 'linear',
    method_number: 12,
    method_period: '1',
    account_asset_id: search(db, 'account.account').find((a) => a.code === '151000').id,
    account_depreciation_id: search(db, 'account.account').find((a) => a.code === '152000').id,
    account_depreciation_expense_id: search(db, 'account.account').find((a) => a.code === '680000').id,
  });
  db = confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id));

  // Depreciation posting must succeed even without asset analytic distribution
  assert.doesNotThrow(() => {
    db = postDepreciation(db, read(db, 'account.asset', asset.id), '2026-02-01');
  }, 'Depreciation posting without asset allocation should not be blocked by mandatory plans');

  const updatedAsset = read(db, 'account.asset', asset.id);
  const postedLines = (updatedAsset.depreciation_ids ?? []).filter((l) => l.posted);
  assert.ok(postedLines.length > 0, 'Depreciation lines should be posted');
});

test('Qodo 2: automatic analytic allocations are persisted on business entries and expenses, not lost', () => {
  let db = seed();

  const plan = create(db, 'account.analytic.plan', {
    name: 'Cost Plan',
    default_applicability: 'optional',
  });
  db = plan.db;

  const analyticAcc = create(db, 'account.analytic.account', {
    name: 'Marketing Dept',
    plan_id: plan.id,
  });
  db = analyticAcc.db;

  const expenseAcc = search(db, 'account.account').find((a) => a.code === '600000');
  const bankAcc = search(db, 'account.account').find((a) => a.code === '101401');

  // Distribution model matching expense account 600000
  db = create(db, 'account.analytic.distribution.model', {
    account_prefix: '600000',
    company_id: 1,
    analytic_distribution: { [analyticAcc.id]: 100 },
  }).db;

  // 1. Direct postEntry of ordinary business entry without explicit distribution
  const entry = postEntry(db, {
    journal: 'MISC',
    date: '2026-03-01',
    company: 1,
    lines: [
      { account: expenseAcc.id, debit: 250 },
      { account: bankAcc.id, credit: 250 },
    ],
  });
  db = entry.db;

  const postedMove = read(db, 'account.move', entry.id);
  const expLine = postedMove.line_ids.find((l) => l.account_id === expenseAcc.id);
  assert.ok(expLine.analytic_distribution, 'Model distribution must be persisted on business line');
  assert.deepEqual(expLine.analytic_distribution, { [analyticAcc.id]: 100 });

  // postAnalytic must have created an analytic line for this move
  const analyticLines = search(db, 'account.analytic.line').filter((l) => l.move_id === entry.id);
  assert.equal(analyticLines.length, 1, 'Analytic line should be created from model distribution');
  assert.equal(analyticLines[0].account_id, analyticAcc.id);
  assert.equal(analyticLines[0].amount, -250);

  // 2. Business expense with product-specific distribution model
  const productAnalytic = create(db, 'account.analytic.account', {
    name: 'Product Analytic',
    plan_id: plan.id,
  });
  db = productAnalytic.db;

  const expenseProduct = read(db, 'product', 1);
  db = create(db, 'account.analytic.distribution.model', {
    product_id: expenseProduct.id,
    sequence: 1,
    company_id: 1,
    analytic_distribution: { [productAnalytic.id]: 100 },
  }).db;

  const expense = create(db, 'hr.expense', {
    name: 'Team Lunch',
    employee_id: 1,
    product_id: expenseProduct.id,
    total_amount: 100,
    tax: 0,
    payment_mode: 'company_account',
  });
  const report = createSheet(expense.db, [expense.id], { name: 'Lunch Report' });
  db = submitSheet(report.db, report.id);
  db = approveSheet(db, report.id, read(db, 'hr.expense.sheet', report.id).manager_id || 1);
  db = postSheet(db, report.id, '2026-03-02');

  const postedSheet = read(db, 'hr.expense.sheet', report.id);
  const expenseMove = read(db, 'account.move', postedSheet.move_id);
  const sheetDebitLine = expenseMove.line_ids.find((l) => (l.debit ?? 0) > 0);
  assert.ok(sheetDebitLine.analytic_distribution, 'Expense line must carry product-matched distribution');
  assert.deepEqual(sheetDebitLine.analytic_distribution, { [productAnalytic.id]: 100 });

  const sheetAnalyticLines = search(db, 'account.analytic.line').filter((l) => l.move_id === expenseMove.id);
  assert.equal(sheetAnalyticLines.length, 1, 'Analytic line should be created for expense sheet');
  assert.equal(sheetAnalyticLines[0].account_id, productAnalytic.id);

  // 3. Business expense with explicit allocation preserves explicit allocation over model
  const explicitExpenseAcc = create(db, 'account.analytic.account', {
    name: 'Explicit Expense Analytic',
    plan_id: plan.id,
  });
  db = explicitExpenseAcc.db;

  const explicitExp = create(db, 'hr.expense', {
    name: 'Travel Ticket',
    employee_id: 1,
    product_id: expenseProduct.id,
    total_amount: 80,
    tax: 0,
    payment_mode: 'company_account',
    analytic_distribution: { [explicitExpenseAcc.id]: 100 },
  });
  const expReport = createSheet(explicitExp.db, [explicitExp.id], { name: 'Travel Report' });
  db = submitSheet(expReport.db, expReport.id);
  db = approveSheet(db, expReport.id, read(db, 'hr.expense.sheet', expReport.id).manager_id || 1);
  db = postSheet(db, expReport.id, '2026-03-03');

  const postedTravelSheet = read(db, 'hr.expense.sheet', expReport.id);
  const travelMove = read(db, 'account.move', postedTravelSheet.move_id);
  const travelDebitLine = travelMove.line_ids.find((l) => (l.debit ?? 0) > 0);
  assert.deepEqual(travelDebitLine.analytic_distribution, { [explicitExpenseAcc.id]: 100 }, 'Explicit distribution on expense must be preserved over product model');

  // 4. Business journal entry with explicit allocation preserves explicit allocation over model
  const explicitEntry = postEntry(db, {
    journal: 'MISC',
    date: '2026-03-04',
    company: 1,
    lines: [
      { account: expenseAcc.id, debit: 75, analytic_distribution: { [explicitExpenseAcc.id]: 100 } },
      { account: bankAcc.id, credit: 75 },
    ],
  });
  const explicitEntryMove = read(explicitEntry.db, 'account.move', explicitEntry.id);
  const explicitLine = explicitEntryMove.line_ids.find((l) => l.account_id === expenseAcc.id);
  assert.deepEqual(explicitLine.analytic_distribution, { [explicitExpenseAcc.id]: 100 }, 'Explicit allocation on journal entry must be preserved');

  // 5. System-generated entry should NOT receive default distribution
  const sysEntry = postEntry(db, {
    journal: 'MISC',
    date: '2026-03-05',
    company: 1,
    system_generated: true,
    lines: [
      { account: expenseAcc.id, debit: 50 },
      { account: bankAcc.id, credit: 50 },
    ],
  });
  const sysMove = read(sysEntry.db, 'account.move', sysEntry.id);
  const sysLine = sysMove.line_ids.find((l) => l.account_id === expenseAcc.id);
  assert.equal(sysLine.analytic_distribution, undefined, 'System entry should not receive default model distribution');

  // 6. Ordinary journal entries still validate mandatory plans when unallocated
  const mandatoryPlan = create(db, 'account.analytic.plan', {
    name: 'Mandatory Audit Plan',
    default_applicability: 'mandatory',
  });
  db = mandatoryPlan.db;

  const unallocatedExpenseAcc = search(db, 'account.account').find((a) => a.code === '610000')
    || create(db, 'account.account', { name: 'Unallocated Expense', code: '699999', account_type: 'expense', company_id: 1 });
  db = unallocatedExpenseAcc.db ?? db;
  const unaccId = unallocatedExpenseAcc.id;

  assert.throws(() => {
    postEntry(db, {
      journal: 'MISC',
      date: '2026-03-06',
      company: 1,
      lines: [
        { account: unaccId, debit: 100 },
        { account: bankAcc.id, credit: 100 },
      ],
    });
  }, /mandatory analytic plan/i, 'Ordinary business entry without allocation or model must fail mandatory plan validation');
});

test('Qodo 9: checkout retains explicit analytic distribution and reflects it in retry fingerprint', () => {
  let db = seed();
  if (!openSession(db)) {
    db = startSession(db, 100).db;
  }

  const plan = create(db, 'account.analytic.plan', {
    name: 'POS Plan',
    default_applicability: 'optional',
  });
  db = plan.db;

  const modelAnalytic = create(db, 'account.analytic.account', {
    name: 'Model Account',
    plan_id: plan.id,
  });
  db = modelAnalytic.db;

  const explicitAnalytic = create(db, 'account.analytic.account', {
    name: 'Explicit Account',
    plan_id: plan.id,
  });
  db = explicitAnalytic.db;

  const p = read(db, 'product', 1);

  // Distribution model giving 100% to modelAnalytic
  db = create(db, 'account.analytic.distribution.model', {
    product_id: p.id,
    company_id: 1,
    analytic_distribution: { [modelAnalytic.id]: 100 },
  }).db;

  // 1. Checkout with explicit analytic distribution differing from model
  const explicitDist = { [explicitAnalytic.id]: 100 };
  const paid = payCart(db, {
    cart: [{ product_id: p.id, qty: 1, analytic_distribution: explicitDist }],
    method: 'cash',
    request_key: 'req-pos-explicit-analytic-1',
  });
  db = paid.db;

  const order = read(db, 'pos.order', paid.id);
  assert.ok(order.lines[0].analytic_distribution, 'Order line must retain explicit analytic distribution');
  assert.deepEqual(order.lines[0].analytic_distribution, explicitDist, 'Explicit allocation must be used, not model');

  // Verify journal entry lines and analytic lines use explicit allocation
  const posEntry = read(db, 'account.move', order.accounting_entries[0].move_id);
  assert.ok(posEntry, 'POS sale entry must exist');
  const incomeLine = posEntry.line_ids.find((l) => l.name === 'Sales');
  assert.deepEqual(incomeLine.analytic_distribution, explicitDist, 'Sales entry line must have explicit allocation');

  const analyticLines = search(db, 'account.analytic.line').filter((l) => l.move_id === posEntry.id);
  assert.equal(analyticLines.length, 1);
  assert.equal(analyticLines[0].account_id, explicitAnalytic.id, 'Analytic line must be for explicit account, not model');

  // 2. Retry fingerprint test: same request_key with changed analytic_distribution must be rejected
  const otherAnalytic = create(db, 'account.analytic.account', {
    name: 'Other Account',
    plan_id: plan.id,
  });
  db = otherAnalytic.db;

  assert.throws(() => {
    payCart(db, {
      cart: [{ product_id: p.id, qty: 1, analytic_distribution: { [otherAnalytic.id]: 100 } }],
      method: 'cash',
      request_key: 'req-pos-explicit-analytic-1',
    });
  }, /different payment/, 'Retry with changed analytic distribution must be rejected by request fingerprint');

  // 3. Validation test: invalid distribution must throw error
  assert.throws(() => {
    payCart(db, {
      cart: [{ product_id: p.id, qty: 1, analytic_distribution: { 999999: 100 } }],
      method: 'cash',
      request_key: 'req-pos-invalid-analytic',
    });
  }, /Analytic account not found/, 'Invalid analytic account must be rejected during cart normalization');
});
