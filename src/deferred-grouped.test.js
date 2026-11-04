import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { menusFor } from './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, updateSettings, write } from './orm.js';
import { models } from './registry.js';
import { accountId, journalId, journalItems } from './models/ledger.js';
import { analyticBalance } from './models/analyticplus.js';
import { generateGroupedEntries, postDueEntries } from './models/deferred.js';
import { seed } from './seed.js';

const button = (model, label, db, id) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('company computation basis controls invoice, bill and manual deferral boards across years', () => {
  const expected = {
    days: [27.42, 50, 22.58],
    months: [28.08, 49.55, 22.37],
    full_months: [33.34, 33.33, 33.33],
  };
  for (const [method, amounts] of Object.entries(expected)) {
    let db = seed();
    db = write(db, 'res.company', 1, { deferred_amount_computation_method: method, deferred_generation_method: 'manual', deferred_revenue_account_id: accountId(db, '212000'), deferred_expense_account_id: accountId(db, '132000') });
    for (const [move_type, code] of [['out_invoice', '410000'], ['in_invoice', '600000']]) {
      const move = create(db, 'account.move', { move_type, partner_id: 2, invoice_date: '2026-11-01', invoice_line_ids: [{ name: 'Contract', qty: 1, price_unit: 100, tax: 0, account_id: accountId(db, code), deferred_start_date: '2026-11-14', deferred_end_date: '2027-01-14' }] });
      db = button('account.move', 'Confirm', move.db, move.id);
      const board = search(db, 'account.deferral').find((d) => d.source_move_id === move.id).board;
      assert.deepEqual(board.map((line) => line.amount), amounts, `${method} ${move_type}`);
      assert.equal(board.reduce((sum, line) => sum + Math.round(line.amount * 100), 0), 10000);
    }
    const manual = create(db, 'account.deferral', { name: 'Contract', amount: 100, start_date: '2026-11-14', end_date: '2027-01-14', months: 3, company_id: 1 });
    db = button('account.deferral', 'Compute', manual.db, manual.id);
    assert.deepEqual(read(db, 'account.deferral', manual.id).board.map((line) => line.amount), amounts, `${method} manual`);
    const byMonths = create(db, 'account.deferral', { name: 'Duration', amount: 100, start_date: '2026-11-14', months: 3, company_id: 1 });
    db = button('account.deferral', 'Compute', byMonths.db, byMonths.id);
    const board = read(db, 'account.deferral', byMonths.id).board;
    assert.deepEqual(board.map((line) => line.date), ['2026-11-30', '2026-12-31', '2027-01-31']);
    assert.equal(board.reduce((sum, line) => sum + Math.round(line.amount * 100), 0), 10000);
    if (method === 'full_months') assert.deepEqual(board.map((line) => line.amount), amounts);
  }
});

test('manually & grouped deferred generation posts grouped entries, next-day reversals, respects locks, idempotency, reset consistency, and company isolation', () => {
  // 1. Verify third option on res.company field deferred_generation_method
  const methodField = models['res.company'].fields.deferred_generation_method;
  assert.ok(methodField.options.some(([key, label]) => key === 'manual_grouped' && label === 'Manually & Grouped'));

  let db = seed();
  const analytic1 = create(db, 'account.analytic.account', { name: 'Alpha Deferral Project' });
  const analytic2 = create(analytic1.db, 'account.analytic.account', { name: 'Beta Deferral Project' });
  db = write(analytic2.db, 'res.company', 1, {
    deferred_generation_method: 'manual_grouped',
    deferred_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(analytic2.db, '212000'),
    deferred_expense_account_id: accountId(analytic2.db, '132000'),
  });

  // Verify menu action exists on Deferred Revenues and Deferred Expenses
  const menus = menusFor('accounting');
  const review = menus.find((m) => m.label === 'Review');
  const regEntries = review.children.find((m) => m.label === 'Regularization Entries');
  const revMenu = regEntries.children.find((m) => m.key === 'deferred-revenues');
  const expMenu = regEntries.children.find((m) => m.key === 'deferred-expenses');
  assert.ok(revMenu, 'Deferred Revenues menu exists');
  assert.ok(expMenu, 'Deferred Expenses menu exists');
  assert.equal(revMenu.model, 'account.deferral');
  assert.equal(expMenu.model, 'account.deferral');
  assert.ok(models['account.deferral'].listActions.some((a) => a.label === 'Generate Entries'), 'account.deferral offers Generate Entries list action');

  // In manual_grouped mode, posting does not create per-line recognition entries
  const miscJournalId = journalId(db, 'MISC');
  const initialMiscCount = search(db, 'account.move').filter((m) => m.journal_id === miscJournalId).length;

  // Post two invoices and one bill deferred across three months (2026-01-01 to 2026-03-31)
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Service Alpha', qty: 1, price_unit: 300, tax: 0,
      account_id: accountId(db, '410000'),
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
      analytic_distribution: { [analytic1.id]: 100 },
    }],
  });
  db = button('account.move', 'Confirm', inv1.db, inv1.id);

  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Service Beta', qty: 1, price_unit: 150, tax: 0,
      account_id: accountId(db, '410000'),
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
      analytic_distribution: { [analytic2.id]: 100 },
    }],
  });
  db = button('account.move', 'Confirm', inv2.db, inv2.id);

  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 1, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'License Alpha', qty: 1, price_unit: 90, tax: 0,
      account_id: accountId(db, '600000'),
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
      analytic_distribution: { [analytic1.id]: 100 },
    }],
  });
  db = button('account.move', 'Confirm', bill1.db, bill1.id);

  // In manual_grouped mode, posting does not create per-line recognition entries
  const miscAfter = search(db, 'account.move').filter((m) => m.journal_id === miscJournalId).length;
  assert.equal(miscAfter, initialMiscCount, 'No recognition entries created on validation in manual_grouped mode');

  // Verify schedules were created in running state with unposted boards
  const schedules = search(db, 'account.deferral');
  assert.equal(schedules.filter((s) => s.state === 'running').length, 3);
  assert.ok(schedules.every((s) => (s.board ?? []).every((l) => !l.posted && !l.move_id)));

  // Generate at Month 1 end (2026-01-31)
  db = generateGroupedEntries(db, { date: '2026-01-31', kind: 'revenue' });
  db = generateGroupedEntries(db, { date: '2026-01-31', kind: 'expense' });

  // Verify ONE grouped entry per kind + exact reversal dated next day
  const m1Moves = search(db, 'account.move').filter((m) => m.is_deferred_grouped);
  // Exactly 2 grouped entries (1 rev, 1 exp) + 2 reversals = 4 moves
  assert.equal(m1Moves.length, 4);

  const revGroupM1 = m1Moves.find((m) => m.invoice_date === '2026-01-31' && m.deferral_kind === 'revenue');
  assert.ok(revGroupM1, 'Revenue grouped entry exists for month 1');
  assert.equal(revGroupM1.company_id, 1);
  const revReversalM1 = read(db, 'account.move', revGroupM1.reversal_move_id);
  assert.ok(revReversalM1, 'Revenue reversal exists');
  assert.equal(revReversalM1.invoice_date, '2026-02-01');
  assert.equal(revReversalM1.reversed_entry_id, revGroupM1.id);

  // Check lines of revGroupM1: Debit deferred revenue 150 (100 + 50), Credit income 100 (line 1) + 50 (line 2)
  const revAccId = accountId(db, '212000');
  const incAccId = accountId(db, '410000');
  const revDebits = revGroupM1.line_ids.filter((l) => l.account_id === revAccId);
  assert.equal(revDebits.reduce((s, l) => s + l.debit, 0), 150);
  const incCredits = revGroupM1.line_ids.filter((l) => l.account_id === incAccId);
  assert.equal(incCredits.reduce((s, l) => s + l.credit, 0), 150);
  assert.deepEqual(incCredits.find((l) => l.credit === 100)?.analytic_distribution, { [analytic1.id]: 100 });
  assert.deepEqual(incCredits.find((l) => l.credit === 50)?.analytic_distribution, { [analytic2.id]: 100 });

  // Check reversal is exact opposite
  const revRevCredits = revReversalM1.line_ids.filter((l) => l.account_id === revAccId);
  assert.equal(revRevCredits.reduce((s, l) => s + l.credit, 0), 150);
  const revRevDebits = revReversalM1.line_ids.filter((l) => l.account_id === incAccId);
  assert.equal(revRevDebits.reduce((s, l) => s + l.debit, 0), 150);

  // Check expense grouped entry and reversal for month 1
  const expGroupM1 = m1Moves.find((m) => m.invoice_date === '2026-01-31' && m.deferral_kind === 'expense');
  assert.ok(expGroupM1, 'Expense grouped entry exists for month 1');
  const expReversalM1 = read(db, 'account.move', expGroupM1.reversal_move_id);
  assert.equal(expReversalM1.invoice_date, '2026-02-01');

  const expAccId = accountId(db, '600000');
  const defExpAccId = accountId(db, '132000');
  assert.equal(expGroupM1.line_ids.find((l) => l.account_id === expAccId)?.debit, 30);
  assert.equal(expGroupM1.line_ids.find((l) => l.account_id === defExpAccId)?.credit, 30);
  assert.deepEqual(expGroupM1.line_ids.find((l) => l.account_id === expAccId)?.analytic_distribution, { [analytic1.id]: 100 });

  // Check account balances at month 1 end (2026-01-31)
  const itemsM1 = journalItems(db, { to: '2026-01-31', company_id: 1 });
  const balance = (items, acc) => items.filter((l) => l.account_id === acc).reduce((s, l) => s + l.debit - l.credit, 0);
  assert.equal(balance(itemsM1, incAccId), -150); // Net recognized revenue = $150 credit
  assert.equal(balance(itemsM1, revAccId), -300); // Remaining deferred = $300 credit
  assert.equal(balance(itemsM1, expAccId), 30);   // Net recognized expense = $30 debit
  assert.equal(balance(itemsM1, defExpAccId), 60); // Remaining deferred = $60 debit

  // Check analytic balance at month 1 end
  assert.equal(analyticBalance(db, analytic1.id, { to: '2026-01-31' }).balance, 70); // 100 revenue - 30 expense
  assert.equal(analyticBalance(db, analytic2.id, { to: '2026-01-31' }).balance, 50); // 50 revenue

  // Idempotency: running it twice for the same date must not duplicate
  const countBeforeSecondRun = search(db, 'account.move').length;
  db = generateGroupedEntries(db, { date: '2026-01-31', kind: 'revenue' });
  db = generateGroupedEntries(db, { date: '2026-01-31', kind: 'expense' });
  assert.equal(search(db, 'account.move').length, countBeforeSecondRun, 'Running twice does not duplicate');

  // Lock rejection: respecting company lock date and settings lock date
  const lockedDb = write(db, 'res.company', 1, { hard_lock_date: '2026-02-28' });
  assert.throws(() => generateGroupedEntries(lockedDb, { date: '2026-02-28', kind: 'revenue' }), /lock/i, 'Rejects when period is locked');
  assert.throws(() => generateGroupedEntries(lockedDb, { date: '2026-02-28', kind: 'expense' }), /lock/i, 'Rejects when period is locked');

  const settingsLocked = updateSettings(db, { lock_date: '2026-02-28' });
  assert.throws(() => generateGroupedEntries(settingsLocked, { date: '2026-02-28', kind: 'revenue' }), /lock/i, 'Rejects when settings lock date set');

  // Resetting a source invoice keeps later generations consistent
  db = button('account.move', 'Reset to Draft', db, inv2.id);
  assert.equal(read(db, 'account.deferral', schedules.find((s) => s.source_move_id === inv2.id).id).state, 'cancel');

  // Generate at Month 2 end (2026-02-28)
  db = generateGroupedEntries(db, { date: '2026-02-28', kind: 'revenue' });
  db = generateGroupedEntries(db, { date: '2026-02-28', kind: 'expense' });

  // Month 2 revenue grouped entry should ONLY include Invoice 1 (Invoice 2 was reset)
  const m2Moves = search(db, 'account.move').filter((m) => m.is_deferred_grouped);
  assert.equal(m2Moves.length, 8); // 4 from month 1 + 4 from month 2
  const revGroupM2 = m2Moves.find((m) => m.invoice_date === '2026-02-28' && m.deferral_kind === 'revenue');
  assert.ok(revGroupM2);
  // Recognized to date for Inv 1 across month 1 and month 2 is 100 + 100 = 200
  assert.equal(revGroupM2.line_ids.find((l) => l.account_id === revAccId)?.debit, 200);
  assert.equal(revGroupM2.line_ids.find((l) => l.account_id === incAccId)?.credit, 200);
  assert.deepEqual(revGroupM2.line_ids.find((l) => l.account_id === incAccId)?.analytic_distribution, { [analytic1.id]: 100 });

  // Reversal for month 2 dated 2026-03-01
  const revReversalM2 = read(db, 'account.move', revGroupM2.reversal_move_id);
  assert.equal(revReversalM2.invoice_date, '2026-03-01');

  // Month 2 expense grouped entry: recognized to date for bill 1 is 30 + 30 = 60
  const expGroupM2 = m2Moves.find((m) => m.invoice_date === '2026-02-28' && m.deferral_kind === 'expense');
  assert.equal(expGroupM2.line_ids.find((l) => l.account_id === expAccId)?.debit, 60);
  assert.equal(expGroupM2.line_ids.find((l) => l.account_id === defExpAccId)?.credit, 60);

  // Check balances at Month 2 end (2026-02-28)
  const itemsM2 = journalItems(db, { to: '2026-02-28', company_id: 1 });
  assert.equal(balance(itemsM2, incAccId), -200);  // Inv 1 months 1+2 = $200 (Inv 2 was reversed to 0)
  assert.equal(balance(itemsM2, revAccId), -100);  // Remaining deferred Inv 1 = $100
  assert.equal(balance(itemsM2, expAccId), 60);    // Bill 1 months 1+2 = $60
  assert.equal(balance(itemsM2, defExpAccId), 30); // Remaining deferred Bill 1 = $30

  // Check analytic balance at month 2 end
  assert.equal(analyticBalance(db, analytic1.id, { to: '2026-02-28' }).balance, 140); // 200 revenue - 60 expense
  assert.equal(analyticBalance(db, analytic2.id, { to: '2026-02-28' }).balance, 0);   // 0 because inv 2 was reset and its month 1 recognition was reversed

  // Company isolation: create Company 2 with its own accounts and deferred invoice
  const { db: withCo2, id: co2 } = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch Co2' });
  db = withCo2;
  const co2Inc = create(db, 'account.account', { code: '410000', name: 'Income Co2', account_type: 'income', company_id: co2 });
  const co2Def = create(co2Inc.db, 'account.account', { code: '212000', name: 'Def Rev Co2', account_type: 'liability_current', company_id: co2 });
  const co2Rec = create(co2Def.db, 'account.account', { code: '121000', name: 'AR Co2', account_type: 'asset_receivable', company_id: co2 });
  const co2InvJnl = create(co2Rec.db, 'account.journal', { code: 'INV', name: 'Invoices Co2', type: 'sale', company_id: co2, default_account_id: co2Inc.id, invoice_sequence_prefix: 'DEFG-CO2-INV/', invoice_sequence_next_number: 1 });
  const co2MiscJnl = create(co2InvJnl.db, 'account.journal', { code: 'MISC', name: 'Misc Co2', type: 'general', company_id: co2 });
  db = write(co2MiscJnl.db, 'res.company', co2, {
    default_sale_journal_id: co2InvJnl.id,
    deferred_generation_method: 'manual_grouped',
    deferred_amount_computation_method: 'full_months',
    deferred_revenue_account_id: co2Def.id,
  });

  const invCo2 = create(db, 'account.move', {
    company_id: co2, move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Co2 Contract', qty: 1, price_unit: 600, tax: 0,
      account_id: co2Inc.id,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  db = button('account.move', 'Confirm', invCo2.db, invCo2.id);

  // Generate for Company 2 at Month 1 end
  db = generateGroupedEntries(db, { date: '2026-01-31', kind: 'revenue', company_id: co2 });

  // Verify Company 2 entry is isolated to Company 2
  const co2Moves = search(db, 'account.move').filter((m) => m.company_id === co2 && m.journal_id === co2MiscJnl.id);
  assert.equal(co2Moves.length, 2); // 1 grouped entry + 1 reversal
  const co2Group = co2Moves.find((m) => m.invoice_date === '2026-01-31');
  assert.ok(co2Group);
  assert.equal(co2Group.line_ids.find((l) => l.account_id === co2Def.id)?.debit, 200);
  assert.equal(co2Group.line_ids.find((l) => l.account_id === co2Inc.id)?.credit, 200);

  // Company 1 entries are untouched
  const co1Items = journalItems(db, { to: '2026-02-28', company_id: 1 });
  assert.equal(balance(co1Items, incAccId), -200);
  assert.equal(balance(co1Items, revAccId), -100);
});

test('public model and menu paths invoke grouped deferral generation consistently', () => {
  let db = seed();
  db = write(db, 'res.company', 1, {
    deferred_generation_method: 'manual_grouped',
    deferred_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(db, '212000'),
    deferred_expense_account_id: accountId(db, '132000'),
  });

  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Maintenance', qty: 1, price_unit: 120, tax: 0,
      account_id: accountId(db, '410000'),
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  db = button('account.move', 'Confirm', invoice.db, invoice.id);

  const menus = menusFor('accounting');
  const review = menus.find((m) => m.label === 'Review');
  const regEntries = review.children.find((m) => m.label === 'Regularization Entries');
  const revMenu = regEntries.children.find((m) => m.key === 'deferred-revenues');
  assert.equal(revMenu.model, 'account.deferral');
  assert.equal(revMenu.actions, undefined);
  assert.equal(revMenu.action, undefined);

  // 1. Through model function generateGroupedEntries
  let viaModelFunc = generateGroupedEntries(db, { date: '2026-01-31', kind: 'revenue' });
  assert.equal(search(viaModelFunc, 'account.move').filter((m) => m.is_deferred_grouped).length, 2);

  // 2. Through models['account.deferral'].actions.generateGroupedEntries
  const deferralActions = models['account.deferral'].actions;
  assert.ok(deferralActions.generateGroupedEntries);
  assert.equal(deferralActions.generateEntries, undefined);
  assert.equal(deferralActions['Generate Entries'], undefined);
  let viaModelAction = deferralActions.generateGroupedEntries(db, { date: '2026-01-31', kind: 'revenue' });
  assert.equal(search(viaModelAction, 'account.move').filter((m) => m.is_deferred_grouped).length, 2);

  // 3. Through models['account.deferral'].listActions
  const modelListAction = models['account.deferral'].listActions.find((a) => a.label === 'Generate Entries');
  assert.ok(modelListAction);
  assert.equal(modelListAction.noSelection, true);
  assert.deepEqual(modelListAction.ask?.label, 'Period End Date');
  assert.equal(typeof modelListAction.ask?.default, 'function');
  let viaModelListAction = modelListAction.run(db, null, '2026-01-31');
  assert.equal(search(viaModelListAction, 'account.move').filter((m) => m.is_deferred_grouped).length, 2);

  // 4. Through res.company button Generate Company Deferrals in manual_grouped mode
  const companyBtn = models['res.company'].form.buttons.find((b) => b.label === 'Generate Company Deferrals');
  assert.ok(companyBtn);
  let viaCompanyBtn = companyBtn.run(db, read(db, 'res.company', 1), { date: '2026-01-31' }).db;
  assert.equal(search(viaCompanyBtn, 'account.move').filter((m) => m.is_deferred_grouped).length, 2);
});

test('schedule with one month posted by postDueEntries, then grouped generation for a later date recognizes only remaining months', () => {
  let db = seed();
  db = write(db, 'res.company', 1, {
    deferred_generation_method: 'manual',
    deferred_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(db, '212000'),
  });

  // Post invoice with 300 over 3 months (Jan, Feb, Mar 2026) -> 100/month
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Cloud Subscription', qty: 1, price_unit: 300, tax: 0,
      account_id: accountId(db, '410000'),
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  db = button('account.move', 'Confirm', invoice.db, invoice.id);

  const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === invoice.id);
  assert.ok(schedule);
  assert.equal(schedule.board.length, 3);

  // Post month 1 individually using postDueEntries up to 2026-01-31
  db = postDueEntries(db, schedule, '2026-01-31');

  const updatedSchedule = read(db, 'account.deferral', schedule.id);
  assert.equal(updatedSchedule.board[0].posted, true);
  assert.ok(updatedSchedule.board[0].move_id);
  assert.equal(updatedSchedule.board[1].posted, false);
  assert.equal(updatedSchedule.board[2].posted, false);

  // Verify month 1 was posted individually
  const individualMove = read(db, 'account.move', updatedSchedule.board[0].move_id);
  assert.ok(individualMove);
  assert.equal(individualMove.is_deferred_grouped, undefined);
  assert.equal(individualMove.line_ids.find((l) => l.account_id === accountId(db, '410000'))?.credit, 100);

  // Switch to grouped generation after the individual posting.
  db = write(db, 'res.company', 1, { deferred_generation_method: 'manual_grouped' });
  // Now run grouped generation for a later date: 2026-02-28 (month 2)
  db = generateGroupedEntries(db, { date: '2026-02-28', kind: 'revenue' });

  // Grouped entry for 2026-02-28 must recognize ONLY month 2 (100), not month 1 + month 2 (200)
  const groupedMove = search(db, 'account.move').find((m) => m.is_deferred_grouped && m.deferral_date === '2026-02-28' && m.deferral_kind === 'revenue');
  assert.ok(groupedMove);
  const revAccId = accountId(db, '212000');
  const incAccId = accountId(db, '410000');
  assert.equal(groupedMove.line_ids.find((l) => l.account_id === revAccId)?.debit, 100);
  assert.equal(groupedMove.line_ids.find((l) => l.account_id === incAccId)?.credit, 100);

  // Next-day reversal reverses exactly 100
  const reversalMove = read(db, 'account.move', groupedMove.reversal_move_id);
  assert.ok(reversalMove);
  assert.equal(reversalMove.line_ids.find((l) => l.account_id === revAccId)?.credit, 100);
  assert.equal(reversalMove.line_ids.find((l) => l.account_id === incAccId)?.debit, 100);

  // Check balances at 2026-02-28:
  // Income 410000 has 100 (individual Jan) + 100 (grouped Feb) = 200 credit
  const items = journalItems(db, { to: '2026-02-28', company_id: 1 });
  const incBalance = items.filter((l) => l.account_id === incAccId).reduce((s, l) => s + l.debit - l.credit, 0);
  assert.equal(incBalance, -200);
});
