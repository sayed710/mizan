import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { find, setupDom } from './test-support/dom.js';
import { invoiceJournalDefaults } from './test-support/accounting-company.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { createCompany } from './models/company.js';
import { postMove } from './models/accounting.js';
import { accountId, isIncomeOrExpenseAccount, journalItems, profitAndLoss } from './models/ledger.js';
import { computeBoard, deferralBoard, generateGroupedEntries, postCompanyDeferrals, postDueEntries } from './models/deferred.js';
import { SCHEMA_VERSION, migrate } from './migrations.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

async function renderSettings(setupDb) {
  const { makeEl } = setupDom();
  const prevConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { Settings } = await import('./views/Settings.jsx');
  await initStore();
  const initialDb = setupDb ? setupDb(seed()) : seed();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    await commit(initialDb);
    root.render(React.createElement(Settings));
  });
  return {
    React,
    host,
    getDb,
    control: (id) => find(host, (n) => props(n)?.id === id),
    cleanup: async () => {
      await React.act(async () => root.unmount());
      globalThis.confirm = prevConfirm;
    },
  };
}

test('account.account is_deferred and deferred_account_id enforce dates, override company account, and hide by account_type only', () => {
  const base = seed();
  const revAccModel = models['account.account'];
  assert.equal(revAccModel.fields.is_deferred.label, 'Deferred');
  assert.equal(revAccModel.fields.deferred_account_id.label, 'Deferred Account');

  const incomeAcc = { id: 901, account_type: 'income', name: 'Consulting', company_id: 1 };
  const expenseAcc = { id: 902, account_type: 'expense_direct_cost', name: 'COGS', company_id: 1 };
  // Even if an asset account is named "Deferred Revenue", visibility depends solely on account_type.
  const assetNamedRevenue = { id: 903, account_type: 'asset_current', name: 'Deferred Revenue', company_id: 1 };
  assert.equal(isIncomeOrExpenseAccount(incomeAcc), true);
  assert.equal(isIncomeOrExpenseAccount(expenseAcc), true);
  assert.equal(isIncomeOrExpenseAccount(assetNamedRevenue), false);
  assert.equal(revAccModel.fields.is_deferred.hideWhen(incomeAcc), false);
  assert.equal(revAccModel.fields.deferred_account_id.hideWhen(expenseAcc), false);
  assert.equal(revAccModel.fields.is_deferred.hideWhen(assetNamedRevenue), true);
  assert.equal(revAccModel.fields.deferred_account_id.hideWhen(assetNamedRevenue), true);

  // Account-level custom deferred liability & income accounts.
  const customDefRev = create(base, 'account.account', { code: '212900', name: 'Custom Deferred Revenue', account_type: 'liability_current', company_id: 1 });
  const revAcc = create(customDefRev.db, 'account.account', {
    code: '410900', name: 'Mandatory Deferred Service', account_type: 'income', company_id: 1,
    is_deferred: true, deferred_account_id: customDefRev.id,
  });
  const coDefRevId = accountId(revAcc.db, '212000');

  // Posting without deferred dates fails because account.is_deferred is true.
  const invMissingDates = create(revAcc.db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Subscription', qty: 1, price_unit: 120, tax: 0, account_id: revAcc.id }],
  });
  assert.throws(() => postMove(invMissingDates.db, invMissingDates.id), /deferred start and end dates/i);

  // Providing start and end dates succeeds and routes to account.deferred_account_id instead of company default.
  const invWithDates = create(revAcc.db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Subscription', qty: 1, price_unit: 120, tax: 0, account_id: revAcc.id,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-02-28',
    }],
  });
  const postedDb = postMove(invWithDates.db, invWithDates.id);
  const postedMove = read(postedDb, 'account.move', invWithDates.id);
  assert.ok(postedMove.line_ids.some((l) => l.account_id === customDefRev.id && l.credit === 120));
  assert.equal(postedMove.line_ids.some((l) => l.account_id === coDefRevId), false);

  const schedule = search(postedDb, 'account.deferral').find((d) => d.source_move_id === invWithDates.id);
  assert.equal(schedule.deferred_account_id, customDefRev.id);

  // Company ownership & self-deferral validation on account.account.
  const otherCo = createCompany(postedDb, { name: 'Other Co', ...invoiceJournalDefaults(postedDb) });
  const otherDef = create(otherCo.db, 'account.account', { code: '212777', name: 'Other Def', account_type: 'liability_current', company_id: otherCo.id });
  assert.throws(() => write(otherDef.db, 'account.account', revAcc.id, { deferred_account_id: revAcc.id }), /itself/);
  assert.throws(() => write(otherDef.db, 'account.account', revAcc.id, { deferred_account_id: otherDef.id }), /belong to the account company/);
});

test('res.company splits revenue and expense deferred settings independently and validates company ownership', () => {
  const base = seed();
  const journal2 = create(base, 'account.journal', { name: 'Rev Deferred Misc', code: 'DEFR', type: 'general', company_id: 1 });
  const journal3 = create(journal2.db, 'account.journal', { name: 'Exp Deferred Misc', code: 'DEFE', type: 'general', company_id: 1 });
  const otherCo = createCompany(journal3.db, { name: 'Second Co', ...invoiceJournalDefaults(journal3.db) });
  const otherJournal = create(otherCo.db, 'account.journal', { name: 'Second Misc', code: 'SMISC', type: 'general', company_id: otherCo.id });
  const otherDef = create(otherJournal.db, 'account.account', { code: '212888', name: 'Second Def', account_type: 'liability_current', company_id: otherCo.id });
  const saleJournal = create(otherDef.db, 'account.journal', { name: 'Not General', code: 'SNG', type: 'sale', company_id: 1, default_account_id: accountId(otherDef.db, '410000') });

  // Validation rejects cross-company journal, wrong-type journal, and cross-company deferred account.
  assert.throws(() => write(saleJournal.db, 'res.company', 1, { deferred_revenue_journal_id: otherJournal.id }), /belonging to this company/);
  assert.throws(() => write(saleJournal.db, 'res.company', 1, { deferred_expense_journal_id: saleJournal.id }), /general journal/);
  assert.throws(() => write(saleJournal.db, 'res.company', 1, { deferred_revenue_account_id: otherDef.id }), /belonging to this company/);

  // Configure Revenue = Manually & Grouped (Monthly), Expense = On bill validation (Full Months).
  let db = write(saleJournal.db, 'res.company', 1, {
    deferred_revenue_journal_id: journal2.id,
    deferred_expense_journal_id: journal3.id,
    generate_deferred_revenue_entries_method: 'manual',
    generate_deferred_expense_entries_method: 'on_validation',
    deferred_revenue_amount_computation_method: 'month',
    deferred_expense_amount_computation_method: 'full_months',
    deferred_revenue_periodicity: 'month',
    deferred_expense_periodicity: 'month',
  });

  const revInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Manual Grouped Revenue', qty: 1, price_unit: 300, tax: 0,
      account_id: accountId(db, '410000'), deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  db = postMove(revInv.db, revInv.id);
  const expBill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Auto Validated Expense', qty: 1, price_unit: 300, tax: 0,
      account_id: accountId(db, '600000'), deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  db = postMove(expBill.db, expBill.id);

  // Revenue stays unposted (manual grouped), while Expense auto-posted on validation into its own journal.
  const revSched = search(db, 'account.deferral').find((d) => d.source_move_id === revInv.id);
  const expSched = search(db, 'account.deferral').find((d) => d.source_move_id === expBill.id);
  assert.equal(revSched.board.every((l) => !l.posted), true);
  assert.equal(expSched.board.every((l) => l.posted && l.move_id), true);
  assert.equal(read(db, 'account.move', expSched.board[0].move_id).journal_id, journal3.id);
  assert.equal(read(db, 'account.move', expSched.board[0].move_id).deferred_entry_type, 'expense');

  // Generating grouped revenue uses journal2 and tags deferred_entry_type = 'revenue'.
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });
  const revGroup = search(db, 'account.move').find((m) => m.is_deferred_grouped && !m.reversed_entry_id && m.deferral_kind === 'revenue');
  assert.equal(revGroup.journal_id, journal2.id);
  assert.equal(revGroup.deferred_entry_type, 'revenue');
  assert.equal(read(db, 'account.move', revGroup.reversal_move_id).deferred_entry_type, 'revenue');
  // Calling postCompanyDeferrals only groups revenue and leaves already-done expense untouched.
  db = postCompanyDeferrals(db, 1, '2026-01-31');
  assert.equal(search(db, 'account.move').filter((m) => m.is_deferred_grouped && m.deferral_kind === 'expense').length, 0);
});

test('migration 51 splits legacy shared deferred settings per kind and backfills deferred_entry_type structurally', () => {
  assert.equal(SCHEMA_VERSION, 53);

  const base = seed();
  // Simulate a schema_version 49 database with legacy settings and a pre-51 grouped deferral move.
  const preGrouped = write(
    generateGroupedEntries(
      write(base, 'res.company', 1, { deferred_generation_method: 'manual_grouped', deferred_amount_computation_method: 'days' }),
      { company_id: 1, date: '2026-01-31' },
    ),
    'res.company',
    1,
    { deferred_generation_method: 'manual_grouped', deferred_amount_computation_method: 'months' },
  );
  // Also create a second company with legacy 'manual' individual posting and a third with 'on_validation'.
  const coManual = createCompany(preGrouped, { name: 'Legacy Manual', ...invoiceJournalDefaults(preGrouped), deferred_generation_method: 'manual', deferred_amount_computation_method: 'full_months' });
  const coAuto = createCompany(coManual.db, { name: 'Legacy Auto', ...invoiceJournalDefaults(coManual.db), deferred_generation_method: 'on_validation', deferred_amount_computation_method: 'days' });

  const oldDb = {
    ...coAuto.db,
    schema_version: 49,
    records: {
      ...coAuto.db.records,
      'res.company': (coAuto.db.records['res.company'] ?? []).map((c) => {
        const cleaned = { ...c };
        delete cleaned.generate_deferred_revenue_entries_method;
        delete cleaned.generate_deferred_expense_entries_method;
        delete cleaned.deferred_revenue_amount_computation_method;
        delete cleaned.deferred_expense_amount_computation_method;
        delete cleaned.deferred_revenue_periodicity;
        delete cleaned.deferred_expense_periodicity;
        delete cleaned.deferred_revenue_journal_id;
        delete cleaned.deferred_expense_journal_id;
        return cleaned;
      }),
    },
  };

  const upgraded = migrate(oldDb);
  assert.equal(upgraded.schema_version, 53);

  const c1 = read(upgraded, 'res.company', 1);
  assert.equal(c1.generate_deferred_revenue_entries_method, 'manual');
  assert.equal(c1.generate_deferred_expense_entries_method, 'manual');
  assert.equal(c1.deferred_revenue_amount_computation_method, 'month');
  assert.equal(c1.deferred_expense_amount_computation_method, 'month');
  assert.equal(c1.deferred_revenue_periodicity, 'month');
  assert.equal(c1.deferred_expense_periodicity, 'month');
  assert.equal(c1.deferred_revenue_journal_id, c1.default_general_journal_id);
  assert.equal(c1.deferred_expense_journal_id, c1.default_general_journal_id);

  // Legacy 'manual' individual mode remains non-validation, non-grouped and uses postDueEntries.
  const c2 = read(upgraded, 'res.company', coManual.id);
  assert.equal(c2.generate_deferred_revenue_entries_method, null);
  assert.equal(c2.deferred_revenue_amount_computation_method, 'full_months');

  const c3 = read(upgraded, 'res.company', coAuto.id);
  assert.equal(c3.generate_deferred_revenue_entries_method, 'on_validation');
  assert.equal(c3.generate_deferred_expense_entries_method, 'on_validation');
  assert.equal(c3.deferred_revenue_amount_computation_method, 'day');

  // Verify deferred_entry_type backfill when migrating an old posted schedule entry without deferred_entry_type.
  const legacySchedDb = create(upgraded, 'account.deferral', {
    name: 'Legacy Board', kind: 'expense', company_id: coManual.id, state: 'running',
    deferred_account_id: accountId(upgraded, '132000', coManual.id), recognition_account_id: accountId(upgraded, '600000', coManual.id) ?? accountId(upgraded, '620000', coManual.id),
    start_date: '2026-01-01', end_date: '2026-01-31', months: 1,
    board: [{ date: '2026-01-31', amount: 50, posted: false, move_id: null }],
  });
  const postedLegacy = postDueEntries(legacySchedDb.db, read(legacySchedDb.db, 'account.deferral', legacySchedDb.id), '2026-01-31');
  const moveId = read(postedLegacy, 'account.deferral', legacySchedDb.id).board[0].move_id;
  const stripped = {
    ...postedLegacy,
    schema_version: 50,
    records: {
      ...postedLegacy.records,
      'account.move': postedLegacy.records['account.move'].map((m) => (m.id === moveId ? { ...m, deferred_entry_type: undefined } : m)),
    },
  };
  const backfilled = migrate(stripped);
  assert.equal(read(backfilled, 'account.move', moveId).deferred_entry_type, 'expense');
});

test('yearly periodicity builds yearly deferral boards and yearly grouped entries', () => {
  let db = write(seed(), 'res.company', 1, {
    generate_deferred_revenue_entries_method: 'manual',
    deferred_revenue_amount_computation_method: 'month',
    deferred_revenue_periodicity: 'year',
  });

  // 2-year manual schedule and pure deferralBoard helper.
  assert.deepEqual(deferralBoard(1200, '2026-01-01', 2, null, 'year'), [
    { date: '2026-12-31', amount: 600 },
    { date: '2027-12-31', amount: 600 },
  ]);
  const manual = create(db, 'account.deferral', {
    name: 'Yearly License', kind: 'revenue', amount: 1200, start_date: '2026-01-01', months: 2, company_id: 1,
    deferred_account_id: accountId(db, '212000'), recognition_account_id: accountId(db, '410000'),
  });
  db = computeBoard(manual.db, read(manual.db, 'account.deferral', manual.id));
  assert.deepEqual(
    read(db, 'account.deferral', manual.id).board.map((l) => [l.date, l.amount]),
    [['2026-12-31', 600], ['2027-12-31', 600]],
  );

  // Invoice spanning two calendar years produces a 2-line yearly board and generates yearly grouped entry.
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Two-Year Hosting', qty: 1, price_unit: 2400, tax: 0,
      account_id: accountId(db, '410000'),
      deferred_start_date: '2026-01-01', deferred_end_date: '2027-12-31',
    }],
  });
  db = postMove(inv.db, inv.id);
  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === inv.id);
  assert.deepEqual(
    sched.board.map((l) => [l.date, l.amount]),
    [['2026-12-31', 1200], ['2027-12-31', 1200]],
  );

  // Generating grouped entry at year end recognizes Year 1 across both schedules (1200 + 600).
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-12-31' });
  const yearlyGroup = search(db, 'account.move').find((m) => m.is_deferred_grouped && !m.reversed_entry_id && m.deferral_date === '2026-12-31');
  assert.ok(yearlyGroup);
  assert.equal(yearlyGroup.deferred_entry_type, 'revenue');
  assert.equal(yearlyGroup.line_ids.find((l) => l.account_id === accountId(db, '212000')).debit, 1800);
});

test('Probe 9: re-running Manually & Grouped after new invoices and credit notes posts only the delta and ties P&L', () => {
  let db = write(seed(), 'res.company', 1, {
    generate_deferred_revenue_entries_method: 'manual',
    deferred_revenue_amount_computation_method: 'full_months',
    deferred_revenue_periodicity: 'month',
  });
  const revAcc = accountId(db, '410000');

  // 1. Invoice 1: 300 over Jan-Mar 2026 (100/month), grouped generation for Jan 31.
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Contract 1', qty: 1, price_unit: 300, tax: 0, account_id: revAcc,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  db = postMove(inv1.db, inv1.id);
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });
  assert.equal(profitAndLoss(db, { from: '2026-01-01', to: '2026-01-31', company_id: 1 }).net, 100);

  // 2. Post a second deferred invoice (150 -> 50/mo) and an unlinked deferred credit note (-60 -> -20/mo) in January.
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-01-10',
    invoice_line_ids: [{
      name: 'Contract 2', qty: 1, price_unit: 150, tax: 0, account_id: revAcc,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  db = postMove(inv2.db, inv2.id);

  const cn1 = create(db, 'account.move', {
    move_type: 'out_refund', partner_id: 2, invoice_date: '2026-01-15',
    invoice_line_ids: [{
      name: 'Unlinked Rebate', qty: 1, price_unit: 60, tax: 0, account_id: revAcc,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  db = postMove(cn1.db, cn1.id);

  // Re-run grouped generation for the SAME period end date (2026-01-31): posts ONLY delta (+50 and -20), no error, no double post.
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });
  const janGroups = search(db, 'account.move').filter((m) => m.is_deferred_grouped && !m.reversed_entry_id && m.deferral_date === '2026-01-31');
  assert.equal(janGroups.length, 2);
  const deltaMove = janGroups[1];
  assert.equal(deltaMove.deferred_entry_type, 'revenue');
  assert.equal(read(db, 'account.move', deltaMove.reversal_move_id).deferred_entry_type, 'revenue');
  assert.equal(read(db, 'account.move', deltaMove.reversal_move_id).deferral_date, '2026-02-01');
  // Delta move contains only Contract 2 (+50) and Rebate (-20), never Contract 1.
  const inv1Sched = search(db, 'account.deferral').find((d) => d.source_move_id === inv1.id);
  assert.equal(deltaMove.deferred_contributions.some((c) => c.schedule_id === inv1Sched.id), false);
  assert.equal(profitAndLoss(db, { from: '2026-01-01', to: '2026-01-31', company_id: 1 }).net, 130); // 100 + 50 - 20

  // 3. Re-running a third time for Jan 31 creates no additional entries (idempotent).
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });
  assert.equal(search(db, 'account.move').filter((m) => m.is_deferred_grouped && !m.reversed_entry_id && m.deferral_date === '2026-01-31').length, 2);

  // 4. Now create a linked partial credit note for Inv 1 (50% = -50/mo) and re-run Jan 31: still no double-post and P&L ties!
  const linkedCn = create(db, 'account.move', {
    move_type: 'out_refund', partner_id: 2, date: '2026-01-20', invoice_date: '2026-01-20', reversed_entry_id: inv1.id,
    invoice_line_ids: [{
      name: 'Linked Partial Credit', qty: 1, price_unit: 150, tax: 0,
      account_id: accountId(db, '212000'), source_line_id: read(db, 'account.move', inv1.id).invoice_line_ids[0].line_id,
    }],
  });
  db = postMove(linkedCn.db, linkedCn.id);
  const corrEntry = search(db, 'account.move').find((m) => m.deferred_adjustment_of_id === janGroups[0].id);
  assert.equal(corrEntry.deferred_entry_type, 'revenue');
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });
  assert.equal(search(db, 'account.move').filter((m) => m.is_deferred_grouped && !m.reversed_entry_id && m.deferral_date === '2026-01-31').length, 2);
  // Cumulative January P&L net: Inv1 (50 net of linked CN) + Inv2 (50) - Unlinked CN (20) = 80.
  assert.equal(profitAndLoss(db, { from: '2026-01-01', to: '2026-01-31', company_id: 1 }).net, 80);

  // 5. Resetting Inv2 reverses only Inv2's contribution cleanly without failing sign checks.
  const reset = models['account.move'].form.buttons.find((b) => b.label === 'Reset to Draft');
  db = reset.run(db, read(db, 'account.move', inv2.id)).db;
  assert.equal(profitAndLoss(db, { from: '2026-01-01', to: '2026-01-31', company_id: 1 }).net, 30);

  // 6. Check net Feb cumulative recognition as well.
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-02-28' });
  assert.equal(profitAndLoss(db, { from: '2026-01-01', to: '2026-02-28', company_id: 1 }).net, 60);
  const netBalanceOnFebEnd = journalItems(db, { to: '2026-02-28', company_id: 1 })
    .filter((l) => l.account_id === revAcc)
    .reduce((s, l) => s + l.credit - l.debit, 0);
  assert.equal(netBalanceOnFebEnd, 60);
});

test('Settings renders Deferred Revenues and Deferred Expenses blocks and saves per-kind configuration', async () => {
  const ctx = await renderSettings();
  try {
    for (const block of ['deferred_revenues', 'deferred_expenses']) {
      assert.ok(find(ctx.host, (n) => props(n)?.['data-block'] === block), `Block ${block} is rendered`);
    }
    for (const id of [
      'deferred_revenue_journal_id', 'deferred_revenue_account_id',
      'generate_deferred_revenue_entries_method', 'deferred_revenue_amount_computation_method', 'deferred_revenue_periodicity',
      'deferred_expense_journal_id', 'deferred_expense_account_id',
      'generate_deferred_expense_entries_method', 'deferred_expense_amount_computation_method', 'deferred_expense_periodicity',
    ]) {
      assert.ok(ctx.control(id), `Setting control #${id} is rendered`);
    }
    await ctx.React.act(async () => props(ctx.control('generate_deferred_revenue_entries_method')).onChange({ target: { value: 'manual' } }));
    await ctx.React.act(async () => props(ctx.control('deferred_revenue_periodicity')).onChange({ target: { value: 'year' } }));
    const saved = read(ctx.getDb(), 'res.company', 1);
    assert.equal(saved.generate_deferred_revenue_entries_method, 'manual');
    assert.equal(saved.deferred_revenue_periodicity, 'year');
    // Expense config remains unchanged.
    assert.equal(saved.generate_deferred_expense_entries_method, 'on_validation');
    assert.equal(saved.deferred_expense_periodicity, 'month');
  } finally {
    await ctx.cleanup();
  }
});

test('Arabic i18n translates every new deferred label, help text, option, and validation message non-identically', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null) };
  try {
    const { t } = await import(`./i18n.js?ar=${Date.now()}`);
    const strings = [
      'Deferred',
      'Check to enable deferred accounting, deferred dates will be required on invoice / bill',
      'Deferred Account',
      'Account automatically used for deferred entries on this account.',
      'Deferred Revenues',
      'Deferred Expenses',
      'Deferred Revenue Journal',
      'Deferred Expense Journal',
      'Deferred Revenue Account',
      'Deferred Expense Account',
      'Generate Revenue Entries',
      'Generate Expense Entries',
      'Revenue Amount Computation',
      'Expense Amount Computation',
      'Revenue Periodicity',
      'Expense Periodicity',
      'Generate Entries',
      'Amount Computation',
      'Periodicity',
      'On invoice validation',
      'On bill validation',
      'Manually & Grouped',
      'By Days',
      'By Months',
      'By Full Months',
      'Monthly',
      'Yearly',
      'Deferred Entry Type',
      'Expense',
      'Revenue',
      'Misc',
      'Select an active deferred account',
      'An account cannot defer to itself',
      'Deferred account must belong to the account company',
      'Select an active general journal belonging to this company',
      'Select an active deferred account belonging to this company',
      'Select a valid deferred entry generation method',
      'Select a valid deferred amount computation method',
      'Select a valid deferred periodicity',
      'Journal used for deferred revenue recognition entries.',
      'Journal used for deferred expense recognition entries.',
    ];
    const i18nSrc = fs.readFileSync('src/i18n.js', 'utf8');
    assert.ok(i18nSrc.includes('Deferred Revenue Journal'));
    for (const s of strings) {
      const arVal = t(s);
      assert.ok(arVal && arVal.trim().length > 0, `Missing Arabic translation for "${s}"`);
      assert.notEqual(arVal, s, `Arabic translation must not be identical to English for "${s}"`);
      assert.match(arVal, /[\u0600-\u06FF]/, `Expected Arabic script for "${s}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
