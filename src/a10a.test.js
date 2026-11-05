import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { configureRevaluationLoss } from './test-support/revaluation-accounts.js';
import { models } from './registry.js';
import { accountId, isBalanced, journalId, journalItems, postEntry } from './models/ledger.js';
import { analyticBalance, budgetReport } from './models/analyticplus.js';
import { postAutoPostMoves, postMove } from './models/accounting.js';
import { foreignBalanceReport, foreignBankBalances, revalueForeignBalances, unrealizedExchange } from './models/closing.js';
import { runScheduledJobs } from './models/scheduler.js';
import { applyDiff, diffDb } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const press = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('Area 1: resetting or cancelling historical deferred invoices and bills reverses recognition on period dates and grouped snapshots without date mocking', () => {
  // 1a. Historical on_validation invoice & bill reset/cancel reverses each recognition entry on its period date
  for (const [moveType, recCode, defCode] of [
    ['out_invoice', '410000', '212000'],
    ['in_invoice', '600000', '132000'],
  ]) {
    let db = write(seed(), 'res.company', 1, {
      deferred_generation_method: 'on_validation',
      deferred_amount_computation_method: 'full_months',
      deferred_revenue_account_id: accountId(seed(), '212000'),
      deferred_expense_account_id: accountId(seed(), '132000'),
    });
    const analytic = create(db, 'account.analytic.account', { name: 'Deferred Project' });
    db = analytic.db;
    const doc = create(db, 'account.move', {
      move_type: moveType,
      partner_id: 2,
      invoice_date: '2025-01-01',
      invoice_line_ids: [{
        name: 'Annual Contract',
        qty: 1,
        price_unit: 200,
        tax: 0,
        account_id: accountId(db, recCode),
        deferred_start_date: '2025-01-01',
        deferred_end_date: '2025-02-28',
        analytic_distribution: { [analytic.id]: 100 },
      }],
    });
    db = press(doc.db, 'account.move', doc.id, 'Confirm');
    db = press(db, 'account.move', doc.id, 'Reset to Draft');
    db = press(db, 'account.move', doc.id, 'Cancel');

    const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === doc.id);
    assert.equal(schedule.state, 'cancel');
    for (const row of schedule.board) {
      const original = read(db, 'account.move', row.move_id);
      const reversal = read(db, 'account.move', row.reversal_move_id);
      assert.equal(reversal.reversed_entry_id, original.id);
      assert.equal(reversal.invoice_date, original.invoice_date);
      const periodNet = journalItems(db, { from: row.date, to: row.date, company_id: 1 })
        .filter((l) => [accountId(db, recCode), accountId(db, defCode)].includes(l.account_id))
        .reduce((s, l) => s + l.debit - l.credit, 0);
      assert.equal(periodNet, 0);
      assert.equal(analyticBalance(db, analytic.id, { from: row.date, to: row.date }).balance, 0);
    }
  }

  // 1b. Historical grouped deferral entries (dated in 2025, prior to today) are reversed when source document is reset
  let db = write(seed(), 'res.company', 1, {
    deferred_generation_method: 'manual_grouped',
    deferred_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(seed(), '212000'),
    deferred_expense_account_id: accountId(seed(), '132000'),
  });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2025-01-01',
    invoice_line_ids: [{
      name: 'Historical Grouped Contract',
      qty: 1,
      price_unit: 120,
      tax: 0,
      account_id: accountId(db, '410000'),
      deferred_start_date: '2025-01-01',
      deferred_end_date: '2025-02-28',
    }],
  });
  db = press(inv.db, 'account.move', inv.id, 'Confirm');
  const generate = models['account.deferral'].actions.generateGroupedEntries;
  db = generate(db, { date: '2025-01-31', company_id: 1, kind: 'revenue' });
  db = press(db, 'account.move', inv.id, 'Reset to Draft');
  const netAt = (date) => journalItems(db, { from: date, to: date, company_id: 1 })
    .filter((l) => l.account_id === accountId(db, '410000'))
    .reduce((s, l) => s + l.debit - l.credit, 0);
  assert.equal(netAt('2025-01-31'), 0);
  assert.equal(netAt('2025-02-01'), 0);
});

test('Area 1: credit notes and vendor refunds with deferred dates create offsetting deferral schedules and reverse cleanly', () => {
  let db = write(seed(), 'res.company', 1, {
    deferred_generation_method: 'on_validation',
    deferred_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(seed(), '212000'),
    deferred_expense_account_id: accountId(seed(), '132000'),
  });
  const analytic = create(db, 'account.analytic.account', { name: 'Refund Deferral Analytic' });
  db = analytic.db;
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Subscription',
      qty: 1,
      price_unit: 100,
      tax: 0,
      account_id: accountId(db, '410000'),
      deferred_start_date: '2026-01-01',
      deferred_end_date: '2026-02-28',
      analytic_distribution: { [analytic.id]: 100 },
    }],
  });
  db = press(inv.db, 'account.move', inv.id, 'Confirm');
  const cnBtn = models['account.move'].form.buttons.find((b) => b.label === 'Credit Note');
  const cnCreated = cnBtn.run(db, read(db, 'account.move', inv.id));
  const cnId = Number(cnCreated.go.split('/').at(-1));
  db = write(cnCreated.db, 'account.move', cnId, { invoice_date: '2026-01-15', invoice_date_due: '2026-01-15' });
  db = press(db, 'account.move', cnId, 'Confirm');

  const cnSchedule = search(db, 'account.deferral').find((d) => d.source_move_id === cnId);
  assert.ok(cnSchedule, 'Credit note creates a deferral schedule');
  assert.equal(cnSchedule.amount, -100);
  assert.deepEqual(cnSchedule.board.map((b) => b.amount), [-50, -50]);
  assert.ok(cnSchedule.board.every((b) => b.posted && isBalanced(read(db, 'account.move', b.move_id).line_ids)));

  // Net deferred revenue (212000), income (410000), and analytic balance across the period are 0 after full credit note
  const balance = (code) => journalItems(db, { from: '2026-01-01', to: '2026-02-28', company_id: 1 })
    .filter((l) => l.account_id === accountId(db, code))
    .reduce((s, l) => s + l.debit - l.credit, 0);
  assert.equal(balance('212000'), 0);
  assert.equal(balance('410000'), 0);
  assert.equal(analyticBalance(db, analytic.id, { from: '2026-01-01', to: '2026-02-28' }).balance, 0);
});

test('Area 2: currency revaluation revalues open foreign credit notes/refunds and date-only bank moves, linking next-day reversal', () => {
  const currency = create(configureRevaluationLoss(seed()), 'res.currency', {
    name: 'CHFFX',
    rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }],
  });
  let db = currency.db;
  // Standalone open foreign credit note (100 CHFFX booked at rate 2 = 50 USD; at 2026-02-28 rate 1 = 100 USD -> difference -50)
  const creditNote = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Rebate', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(creditNote.db, creditNote.id);

  // Standalone open foreign vendor refund (80 CHFFX booked at rate 2 = 40 USD; at 2026-02-28 rate 1 = 80 USD -> difference -40)
  const vendorRefund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: 2,
    currency_id: currency.id,
    invoice_date: '2026-01-12',
    invoice_line_ids: [{ name: 'Supplier Rebate', qty: 1, price_unit: 80, tax: 0 }],
  });
  db = postMove(vendorRefund.db, vendorRefund.id);

  // Future bank entry carrying only `date` (no `invoice_date`) must not leak into earlier cutoff
  const bankAcc = accountId(db, '101401');
  db = create(db, 'account.move', {
    name: 'MISC/2026/888',
    move_type: 'entry',
    state: 'posted',
    journal_id: journalId(db, 'MISC'),
    date: '2026-03-15',
    line_ids: [
      { account_id: bankAcc, debit: 200, credit: 0, currency_id: currency.id, amount_currency: 200 },
      { account_id: accountId(db, '301000'), debit: 0, credit: 200 },
    ],
  }).db;

  assert.equal(foreignBankBalances(db, '2026-02-28').length, 0);
  const openFx = unrealizedExchange(db, '2026-02-28');
  const cnRow = openFx.find((r) => r.invoice_id === creditNote.id);
  const vrRow = openFx.find((r) => r.invoice_id === vendorRefund.id);
  assert.deepEqual([cnRow.residual, cnRow.booked, cnRow.value, cnRow.difference], [-100, -50, -100, -50]);
  assert.deepEqual([vrRow.residual, vrRow.booked, vrRow.value, vrRow.difference], [-80, -40, -80, -40]);
  assert.equal(foreignBalanceReport(db, '2026-02-28').length, 2);

  const revalued = revalueForeignBalances(db, '2026-02-28');
  const entry = search(revalued, 'account.move').find((m) => m.revaluation_date === '2026-02-28');
  assert.ok(entry);
  const reversal = read(revalued, 'account.move', entry.reversal_move_id);
  assert.ok(reversal);
  assert.equal(reversal.invoice_date, '2026-03-01');
  assert.equal(reversal.reversed_entry_id, entry.id);
  assert.ok(isBalanced(entry.line_ids) && isBalanced(reversal.line_ids));
  // Credit note in stronger foreign currency increases receivable credit -> credit 121000 by 50 (loss 50)
  // Vendor refund in stronger foreign currency increases payable debit -> debit 211000 by 40 (gain 40)
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(revalued, '121000'))?.credit, 50);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(revalued, '211000'))?.debit, 40);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(revalued, '450100'))?.credit, 40);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(revalued, '650100'))?.debit, 50);
});

test('Area 3: auto_post at_date and monthly/quarterly/yearly recurrence until end date generate each next entry once', () => {
  let db = seed();
  // 1. at_date draft entry stays draft before its date, posts on its date, and does not spawn a recurring copy
  const atDateMove = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-02-10',
    auto_post: 'at_date',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 150, tax: 0 }],
  });
  db = atDateMove.db;
  db = runScheduledJobs(db, '2026-02-01');
  assert.equal(read(db, 'account.move', atDateMove.id).state, 'draft');
  db = runScheduledJobs(db, '2026-02-10');
  assert.equal(read(db, 'account.move', atDateMove.id).state, 'posted');
  assert.equal(search(db, 'account.move').filter((m) => m.auto_post_origin_id === atDateMove.id).length, 0);

  // 2. Monthly recurring journal entry until 2026-03-31 (3 occurrences: Jan 31, Feb 28, Mar 31)
  const monthlyEntry = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: journalId(db, 'MISC'),
    invoice_date: '2026-01-31',
    date: '2026-01-31',
    ref: 'Monthly Rent Accrual',
    auto_post: 'monthly',
    auto_post_until: '2026-03-31',
    line_ids: [
      { account_id: accountId(db, '600000'), name: 'Rent', debit: 500, credit: 0 },
      { account_id: accountId(db, '101401'), name: 'Bank', debit: 0, credit: 500 },
    ],
  });
  db = monthlyEntry.db;

  // Run on 2026-01-31: posts Jan 31, creates Feb 28 in draft; running again on 2026-01-31 is idempotent
  db = runScheduledJobs(db, '2026-01-31');
  db = runScheduledJobs(db, '2026-01-31');
  assert.equal(read(db, 'account.move', monthlyEntry.id).state, 'posted');
  let series = search(db, 'account.move').filter((m) => m.id === monthlyEntry.id || m.auto_post_origin_id === monthlyEntry.id);
  assert.equal(series.length, 2);
  const febMove = series.find((m) => m.id !== monthlyEntry.id);
  assert.equal(febMove.state, 'draft');
  assert.equal(febMove.invoice_date, '2026-02-28');

  // Resetting Jan 31 to draft and confirming again via button must NOT create a duplicate Feb 28 entry
  db = press(db, 'account.move', monthlyEntry.id, 'Reset to Draft');
  db = press(db, 'account.move', monthlyEntry.id, 'Confirm');
  series = search(db, 'account.move').filter((m) => m.id === monthlyEntry.id || m.auto_post_origin_id === monthlyEntry.id);
  assert.equal(series.length, 2);

  // Advance to 2026-04-30: posts Feb 28 and Mar 31, and stops at auto_post_until (2026-03-31) without creating Apr 30
  db = postAutoPostMoves(db, '2026-04-30');
  series = search(db, 'account.move').filter((m) => m.id === monthlyEntry.id || m.auto_post_origin_id === monthlyEntry.id);
  assert.deepEqual(series.map((m) => [m.invoice_date, m.state]), [
    ['2026-01-31', 'posted'],
    ['2026-02-28', 'posted'],
    ['2026-03-31', 'posted'],
  ]);

  // 3. Quarterly and Yearly recurrence on invoices (shifting deferred dates, preserving non-workflow fields & surviving sync)
  const quarterlyInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_date_due: '2026-01-15',
    invoice_origin: 'SO-REC-001',
    narration: 'Quarterly retainer terms',
    exclude_from_followup: true,
    invoice_user_id: 1,
    auto_post: 'quarterly',
    auto_post_until: '2026-07-01',
    invoice_line_ids: [{
      product_id: 5,
      qty: 1,
      price_unit: 300,
      tax: 0,
      deferred_start_date: '2026-01-01',
      deferred_end_date: '2026-03-31',
    }],
  });
  const syncedQuarter = applyDiff(db, diffDb(db, quarterlyInv.db), { isAdmin: true });
  db = postAutoPostMoves(write(syncedQuarter, 'account.move', quarterlyInv.id, { invoice_user_id: 1 }), '2026-01-01');
  const nextQuarterDraft = search(db, 'account.move').find((m) => m.auto_post_origin_id === quarterlyInv.id);
  assert.equal(nextQuarterDraft.state, 'draft');
  assert.equal(nextQuarterDraft.narration, 'Quarterly retainer terms');
  assert.equal(nextQuarterDraft.invoice_origin, 'SO-REC-001');
  assert.equal(nextQuarterDraft.exclude_from_followup, true);
  assert.equal(nextQuarterDraft.invoice_user_id, 1);
  db = postAutoPostMoves(db, '2026-12-31');
  const qSeries = search(db, 'account.move').filter((m) => m.id === quarterlyInv.id || m.auto_post_origin_id === quarterlyInv.id);
  assert.deepEqual(qSeries.map((m) => [m.invoice_date, m.invoice_date_due, m.state, m.invoice_line_ids[0].deferred_start_date, m.invoice_line_ids[0].deferred_end_date]), [
    ['2026-01-01', '2026-01-15', 'posted', '2026-01-01', '2026-03-31'],
    ['2026-04-01', '2026-04-15', 'posted', '2026-04-01', '2026-06-30'],
    ['2026-07-01', '2026-07-15', 'posted', '2026-07-01', '2026-09-30'],
  ]);

  const yearlyBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    auto_post: 'yearly',
    auto_post_until: '2027-01-01',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 1200, tax: 0 }],
  });
  db = press(yearlyBill.db, 'account.move', yearlyBill.id, 'Confirm');
  const ySeriesAfterConfirm = search(db, 'account.move').filter((m) => m.id === yearlyBill.id || m.auto_post_origin_id === yearlyBill.id);
  assert.deepEqual(ySeriesAfterConfirm.map((m) => [m.invoice_date, m.state]), [
    ['2026-01-01', 'posted'],
    ['2027-01-01', 'draft'],
  ]);
  db = postAutoPostMoves(db, '2027-12-31');
  const ySeriesFinal = search(db, 'account.move').filter((m) => m.id === yearlyBill.id || m.auto_post_origin_id === yearlyBill.id);
  assert.deepEqual(ySeriesFinal.map((m) => [m.invoice_date, m.state]), [
    ['2026-01-01', 'posted'],
    ['2027-01-01', 'posted'],
  ]);
});

test('Area 4: budgets support account_id and analytic_account_id lines, compute actuals from posted entries and achievement %, and render in the budget report', async () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Marketing Campaign' });
  db = analytic.db;
  const revAccId = accountId(db, '400000');
  const expAccId = accountId(db, '600000');

  // Post a customer invoice on 400000 WITHOUT analytic distribution (pure GL account actual)
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Direct Sales', qty: 1, price_unit: 500, tax: 0, account_id: revAccId }],
  });
  db = postMove(inv.db, inv.id);

  // Post a vendor bill on 600000 WITH analytic distribution
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ name: 'Ad Spend', qty: 1, price_unit: 150, tax: 0, account_id: expAccId, analytic_distribution: { [analytic.id]: 100 } }],
  });
  db = postMove(bill.db, bill.id);

  // Post a manual journal entry on 600000 WITHOUT analytic distribution
  db = postEntry(db, {
    journal: 'MISC',
    date: '2026-01-20',
    ref: 'Print Flyers',
    lines: [
      { account_id: expAccId, debit: 50, credit: 0, name: 'Flyers' },
      { account_id: accountId(db, '101401'), debit: 0, credit: 50, name: 'Cash' },
    ],
  }).db;

  // Draft bill must be excluded from actuals
  db = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-01-25',
    invoice_line_ids: [{ name: 'Unposted Bill', qty: 1, price_unit: 900, tax: 0, account_id: expAccId, analytic_distribution: { [analytic.id]: 100 } }],
  }).db;

  const budget = create(db, 'account.budget', {
    name: 'Q1 2026 Master Budget',
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-01-31',
    lines: [
      { account_id: revAccId, date_from: '2026-01-01', date_to: '2026-01-31', planned: 1000 },
      { account_id: expAccId, date_from: '2026-01-01', date_to: '2026-01-31', planned: -400 },
      { account_id: expAccId, analytic_account_id: analytic.id, date_from: '2026-01-01', date_to: '2026-01-31', planned: -300 },
    ],
  });
  db = press(budget.db, 'account.budget', budget.id, 'Confirm');
  db = applyDiff(budget.db, diffDb(budget.db, db), { isAdmin: true });

  const cancelledBudget = create(db, 'account.budget', {
    name: 'Cancelled Budget',
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-01-31',
    lines: [{ account_id: revAccId, planned: 500 }],
  });
  db = press(cancelledBudget.db, 'account.budget', cancelledBudget.id, 'Cancel');

  const rows = budgetReport(db, budget.id, '2026-01-31');
  assert.equal(rows.length, 3);
  // Line 1: Revenue 400000 (GL only) -> practical 500, planned 1000, theoretical 1000, variance -500, achievement 50%
  assert.deepEqual([rows[0].planned, rows[0].practical, rows[0].theoretical, rows[0].variance, rows[0].achievement], [1000, 500, 1000, -500, 50]);
  // Line 2: Expense 600000 (GL only: -150 bill + -50 entry = -200) -> practical -200, planned -400, achievement 50%
  assert.deepEqual([rows[1].planned, rows[1].practical, rows[1].theoretical, rows[1].variance, rows[1].achievement], [-400, -200, -400, 200, 50]);
  // Line 3: Expense 600000 + Analytic Marketing Campaign -> practical -150, planned -300, achievement 50%
  assert.deepEqual([rows[2].planned, rows[2].practical, rows[2].theoretical, rows[2].variance, rows[2].achievement], [-300, -150, -300, 150, 50]);

  const { initStore, commit } = await import('./store.js');
  await initStore();
  await commit(db);
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Reports } = await import('./views/Reports.jsx');
  const html = renderToStaticMarkup(React.createElement(Reports, {
    leaf: { label: 'Budget Report', report: 'budget' },
    initialPeriod: 'all',
  }));
  assert.match(html, /Q1 2026 Master Budget/);
  assert.match(html, /400000/);
  assert.match(html, /Marketing Campaign · 600000/);
  assert.match(html, /50%/);
  assert.doesNotMatch(html, /Cancelled Budget/);
});
