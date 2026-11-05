import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { postMove } from './models/accounting.js';
import { postEntry, profitAndLoss, balanceSheet, filterByAnalytic, analyticMoveItems, hasAnalyticAllocation } from './models/ledger.js';
import { balanceAnalyticColumns, pnlAnalyticColumns } from './views/reportCompare.js';
import { trialBalance, cashFlow } from './models/reports.js';
import { closeFiscalYear } from './models/closing.js';
import { postDepreciation } from './models/assets.js';

function makeLedgerFixture(db) {
  const accounts = {};
  const journals = {};
  let current = db;
  const operatingTag = create(current, 'account.account.tag', {
    name: 'Q11B Operating Activities', applicability: 'accounts', cash_flow_activity: 'operating',
  });
  current = operatingTag.db;
  const addAccount = (key, code, name, account_type, extra = {}) => {
    const made = create(current, 'account.account', { code, name, account_type, company_id: 1, ...extra });
    current = made.db;
    accounts[key] = made.id;
  };
  const addJournal = (key, code, name, type, extra = {}) => {
    const made = create(current, 'account.journal', { code, name, type, company_id: 1, ...extra });
    current = made.db;
    journals[key] = made.id;
  };

  addAccount('expense', '990001', 'Q11B Operating Expense', 'expense', { tag_ids: [operatingTag.id] });
  addAccount('cash', '990002', 'Q11B Cash', 'asset_cash', { tag_ids: [operatingTag.id] });
  addAccount('fixed', '990003', 'Q11B Fixed Asset', 'asset_fixed');
  addAccount('depreciation', '990004', 'Q11B Accumulated Depreciation', 'asset_fixed');
  addAccount('income', '990005', 'Q11B Income', 'income');
  addAccount('receivable', '990006', 'Q11B Receivable', 'asset_receivable');
  addAccount('payable', '990007', 'Q11B Payable', 'liability_payable');

  addJournal('general', 'Q11B', 'Q11B General Journal', 'general');
  addJournal('sale', 'Q11S', 'Q11B Sales Journal', 'sale', {
    default_account_id: accounts.income,
    invoice_sequence_prefix: 'Q11B/S/', invoice_sequence_next_number: 1,
    refund_sequence_prefix: 'Q11B/S/R', refund_sequence_next_number: 1,
  });
  addJournal('purchase', 'Q11P', 'Q11B Purchase Journal', 'purchase', {
    default_account_id: accounts.expense,
    invoice_sequence_prefix: 'Q11B/P/', invoice_sequence_next_number: 1,
    refund_sequence_prefix: 'Q11B/P/R', refund_sequence_next_number: 1,
  });

  const partner = create(current, 'res.partner', {
    name: 'Q11B Test Partner', company_id: 1,
    property_account_receivable_id: accounts.receivable,
    property_account_payable_id: accounts.payable,
  });
  current = partner.db;
  return { db: current, accounts, journals, partnerId: partner.id };
}

test('Qodo 3: system_generated cannot be client-originated or used to bypass mandatory plans', () => {
  let db = seed();

  const plan = create(db, 'account.analytic.plan', {
    name: 'Mandatory Plan Q3',
    default_applicability: 'mandatory',
  });
  db = plan.db;
  const fixture = makeLedgerFixture(db);
  db = fixture.db;
  const { accounts, journals, partnerId } = fixture;

  // 1. Client sync diff cannot set system_generated on new move (entry or invoice)
  const forgedNewEntry = {
    move_type: 'entry',
    state: 'draft',
    date: '2026-03-01',
    journal_id: journals.general,
    company_id: 1,
    system_generated: true,
    line_ids: [
      { account_id: accounts.expense, debit: 100 },
      { account_id: accounts.cash, credit: 100 },
    ],
  };
  assert.throws(() => {
    applyDiff(db, { upserts: { 'account.move': [{ ...forgedNewEntry, id: 99991 }] }, deletes: {} }, { isAdmin: true });
  }, /system[ -]generated/i, 'Sync diff cannot set system_generated on new entry');

  assert.throws(() => {
    applyDiff(db, { upserts: { 'account.move': [{
      ...forgedNewEntry, id: 99993, state: 'posted', name: 'Q11B/2026/99993',
    }] }, deletes: {} }, { isAdmin: true });
  }, /system[ -]generated/i, 'Sync diff cannot post an unproven system_generated entry');

  const forgedNewInvoice = {
    move_type: 'out_invoice',
    state: 'draft',
    company_id: 1,
    journal_id: journals.sale,
    partner_id: partnerId,
    invoice_date: '2026-03-01',
    system_generated: true,
    invoice_line_ids: [{ account_id: accounts.income, qty: 1, price_unit: 100, tax: 0 }],
  };
  assert.throws(() => {
    applyDiff(db, { upserts: { 'account.move': [{ ...forgedNewInvoice, id: 99992 }] }, deletes: {} }, { isAdmin: true });
  }, /system[ -]generated/i, 'Sync diff cannot set system_generated on new invoice');

  // 2. Client sync diff cannot change system_generated on existing moves
  const draftMove = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    date: '2026-03-01',
    journal_id: journals.general,
    company_id: 1,
    line_ids: [
      { account_id: accounts.expense, debit: 100 },
      { account_id: accounts.cash, credit: 100 },
    ],
  });
  db = draftMove.db;

  assert.throws(() => {
    applyDiff(db, diffDb(db, {
      ...db,
      records: {
        ...db.records,
        'account.move': db.records['account.move'].map((m) => m.id === draftMove.id ? { ...m, system_generated: true } : m),
      },
    }), { isAdmin: true });
  }, /system[ -]generated/i, 'Sync diff cannot modify system_generated on existing entry');

  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: journals.sale,
    partner_id: partnerId,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ account_id: accounts.income, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = draftInv.db;

  assert.throws(() => {
    applyDiff(db, diffDb(db, {
      ...db,
      records: {
        ...db.records,
        'account.move': db.records['account.move'].map((m) => m.id === draftInv.id ? { ...m, system_generated: true } : m),
      },
    }), { isAdmin: true });
  }, /system[ -]generated/i, 'Sync diff cannot modify system_generated on existing invoice');

  // 3. ORM write and create guards prevent setting system_generated on draft moves
  assert.throws(() => {
    write(db, 'account.move', draftMove.id, { system_generated: true });
  }, /system[ -]generated/i, 'ORM write cannot set system_generated on entry');

  assert.throws(() => {
    write(db, 'account.move', draftInv.id, { system_generated: true });
  }, /system[ -]generated/i, 'ORM write cannot set system_generated on invoice');

  assert.throws(() => {
    create(db, 'account.move', {
      move_type: 'entry',
      state: 'draft',
      journal_id: journals.general,
      company_id: 1,
      system_generated: true,
      line_ids: [
        { account_id: accounts.expense, debit: 100 },
        { account_id: accounts.cash, credit: 100 },
      ],
    });
  }, /system[ -]generated/i, 'ORM create cannot set system_generated on draft entry');

  assert.throws(() => {
    create(db, 'account.move', {
      move_type: 'out_invoice',
      company_id: 1,
      journal_id: journals.sale,
      partner_id: partnerId,
      system_generated: true,
      invoice_line_ids: [{ account_id: accounts.income, qty: 1, price_unit: 100, tax: 0 }],
    });
  }, /system[ -]generated/i, 'ORM create cannot set system_generated on draft invoice');

  // 4. Even if an unposted move has system_generated stored directly, postMove does not skip validation
  const tamperedEntryDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => m.id === draftMove.id ? { ...m, system_generated: true } : m),
    },
  };
  assert.throws(() => {
    postMove(tamperedEntryDb, draftMove.id);
  }, /mandatory analytic plan/i, 'postMove on entry must not skip validation based on stored flag');

  const tamperedInvDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => m.id === draftInv.id ? { ...m, system_generated: true } : m),
    },
  };
  assert.throws(() => {
    postMove(tamperedInvDb, draftInv.id);
  }, /mandatory analytic plan/i, 'postMove on invoice must not skip validation based on stored flag');

  const analyticAccount = create(db, 'account.analytic.account', {
    name: 'Q11B Default Allocation', plan_id: plan.id, company_id: 1,
  });
  db = analyticAccount.db;
  db = create(db, 'account.analytic.distribution.model', {
    company_id: 1, account_prefix: '990005', analytic_distribution: { [analyticAccount.id]: 100 },
  }).db;
  const defaultedInvoice = create(db, 'account.move', {
    move_type: 'out_invoice', state: 'draft', company_id: 1, journal_id: journals.sale,
    partner_id: partnerId, invoice_date: '2026-03-01',
    invoice_line_ids: [{ account_id: accounts.income, qty: 1, price_unit: 100, tax: 0 }],
  });
  const flaggedInvoiceDb = {
    ...defaultedInvoice.db,
    records: {
      ...defaultedInvoice.db.records,
      'account.move': defaultedInvoice.db.records['account.move'].map((move) => (
        move.id === defaultedInvoice.id ? { ...move, system_generated: true } : move
      )),
    },
  };
  const postedDefaultedInvoice = postMove(flaggedInvoiceDb, defaultedInvoice.id);
  assert.deepEqual(
    read(postedDefaultedInvoice, 'account.move', defaultedInvoice.id).invoice_line_ids[0].analytic_distribution,
    { [analyticAccount.id]: 100 },
    'A stored system_generated flag does not suppress configured analytic defaults during invoice posting',
  );

  // 5. Genuine system-generated workflows (postEntry, asset depreciation, fiscal closing) bypass mandatory plans
  const sysEntry = postEntry(db, {
    journal: journals.general,
    journal_id: journals.general,
    date: '2026-03-01',
    company: 1,
    system_generated: true,
    lines: [
      { account_id: accounts.expense, debit: 100 },
      { account_id: accounts.cash, credit: 100 },
    ],
  });
  assert.ok(sysEntry.id, 'Genuine system_generated entry bypasses mandatory check in postEntry');

  // Test asset depreciation workflow with mandatory plan
  const asset = create(db, 'account.asset', {
    name: 'Depreciating Vehicle',
    original_value: 1200,
    acquisition_date: '2026-01-01',
    method_number: 12,
    method_period: '1',
    account_asset_id: accounts.fixed,
    account_depreciation_id: accounts.depreciation,
    account_depreciation_expense_id: accounts.expense,
    journal_id: journals.general,
    depreciation_ids: [
      { date: '2026-01-31', amount: 100, posted: false },
      { date: '2026-02-28', amount: 100, posted: false },
    ],
    state: 'open',
  });
  const depreciated = postDepreciation(asset.db, read(asset.db, 'account.asset', asset.id), '2026-02-28');
  assert.ok(depreciated, 'Asset depreciation genuine generated entry posts without mandatory plan error');
  const depreciationDiff = diffDb(asset.db, depreciated);
  depreciationDiff.upserts['account.move'] = depreciationDiff.upserts['account.move'].map((move) => (
    Object.fromEntries(Object.entries(move).filter(([field]) => field !== 'system_generated'))
  ));
  const syncedDepreciation = applyDiff(asset.db, depreciationDiff, { isAdmin: true });
  const postedAsset = read(syncedDepreciation, 'account.asset', asset.id);
  assert.ok(postedAsset.depreciation_ids.every((line) => read(syncedDepreciation, 'account.move', line.move_id).system_generated),
    'Sync derives system-generated markers for each validated asset depreciation entry');

  // Test fiscal year closing workflow with mandatory plan
  const fiscalYear = create(db, 'account.fiscal.year', {
    name: 'FY2025',
    date_from: '2025-01-01',
    date_to: '2025-12-31',
    company_id: 1,
  });
  const closed = closeFiscalYear(fiscalYear.db, fiscalYear.id);
  assert.equal(read(closed, 'account.fiscal.year', fiscalYear.id).state, 'closed', 'Fiscal closing genuine generated entry bypasses mandatory plan');
});

test('Qodo 10: analytic balance columns include untagged receivables and balance', () => {
  let db = seed();
  const fixture = makeLedgerFixture(db);
  db = fixture.db;
  const { accounts, journals, partnerId } = fixture;

  const plan = create(db, 'account.analytic.plan', {
    name: 'Balance Plan',
    default_applicability: 'optional',
  });
  db = plan.db;

  const analyticA = create(db, 'account.analytic.account', {
    name: 'Analytic A',
    plan_id: plan.id,
  });
  db = analyticA.db;

  const analyticB = create(db, 'account.analytic.account', {
    name: 'Analytic B',
    plan_id: plan.id,
  });
  db = analyticB.db;

  // 1. Single income line allocated 100% to Analytic A, untagged receivable
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: journals.sale,
    partner_id: partnerId,
    invoice_date: '2026-04-01',
    invoice_line_ids: [
      { account_id: accounts.income, qty: 1, price_unit: 100, tax: 0, analytic_distribution: { [analyticA.id]: 100 } },
    ],
  });
  db = postMove(inv.db, inv.id);
  const postedInvoice = read(db, 'account.move', inv.id);
  const receivableLine = postedInvoice.line_ids.find((line) => read(db, 'account.account', line.account_id)?.account_type === 'asset_receivable');
  assert.ok(receivableLine, 'Posted invoice has a receivable line');
  assert.equal(hasAnalyticAllocation(receivableLine), false, 'Receivable source line remains untagged');

  const group = {
    id: 1,
    name: 'Analytic Accounts Group',
    company_id: 1,
    rule_ids: [{ field: 'analytic', ids: `${analyticA.id},${analyticB.id}` }],
  };

  const period = { from: '2026-01-01', to: '2026-12-31' };
  const cols = balanceAnalyticColumns(db, group, period);

  const colAIndex = cols.headers.findIndex((h) => h === 'Analytic A');
  const colBIndex = cols.headers.findIndex((h) => h === 'Analytic B');
  const colOthersIndex = cols.headers.findIndex((h) => h === 'Others');
  assert.ok(colAIndex >= 0, 'Analytic A column must exist');
  assert.ok(colBIndex >= 0, 'Analytic B column must exist');

  const totalAssetsRow = cols.totals.find((t) => t.label === 'Total Assets');
  const liabEquityRow = cols.totals.find((t) => t.label === 'Liabilities + Equity');
  assert.ok(totalAssetsRow, 'Total Assets row must exist');
  assert.ok(liabEquityRow, 'Liabilities + Equity row must exist');

  // Column A must include the 100 receivable and 100 equity, and balance
  assert.equal(totalAssetsRow.values[colAIndex], 100, 'Analytic A column must include the 100 receivable');
  assert.equal(liabEquityRow.values[colAIndex], 100, 'Analytic A column must have 100 liabilities + equity');
  assert.equal(totalAssetsRow.values[colAIndex], liabEquityRow.values[colAIndex], 'Analytic A column must balance');

  // Column B must be 0 and balance
  assert.equal(totalAssetsRow.values[colBIndex], 0, 'Analytic B column assets must be 0');
  assert.equal(liabEquityRow.values[colBIndex], 0, 'Analytic B column equity must be 0');
  assert.equal(totalAssetsRow.values[colBIndex], liabEquityRow.values[colBIndex], 'Analytic B column must balance');

  // Others column must balance
  if (colOthersIndex >= 0) {
    assert.equal(totalAssetsRow.values[colOthersIndex], liabEquityRow.values[colOthersIndex], 'Others column must balance');
  }

  // 2. Invoice with multiple lines split across accounts (A: 60, B: 40)
  const splitInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: journals.sale,
    partner_id: partnerId,
    invoice_date: '2026-04-02',
    invoice_line_ids: [
      { account_id: accounts.income, qty: 1, price_unit: 60, tax: 0, analytic_distribution: { [analyticA.id]: 100 } },
      { account_id: accounts.income, qty: 1, price_unit: 40, tax: 0, analytic_distribution: { [analyticB.id]: 100 } },
    ],
  });
  db = postMove(splitInv.db, splitInv.id);

  const splitCols = balanceAnalyticColumns(db, group, period);
  const splitTotalAssets = splitCols.totals.find((t) => t.label === 'Total Assets');
  const splitLiabEquity = splitCols.totals.find((t) => t.label === 'Liabilities + Equity');

  // Total for A: 100 + 60 = 160
  assert.equal(splitTotalAssets.values[colAIndex], 160, 'Analytic A total assets must be 160');
  assert.equal(splitLiabEquity.values[colAIndex], 160, 'Analytic A total liabilities + equity must be 160');
  assert.equal(splitTotalAssets.values[colAIndex], splitLiabEquity.values[colAIndex], 'Analytic A column balances after split invoice');

  // Total for B: 40
  assert.equal(splitTotalAssets.values[colBIndex], 40, 'Analytic B total assets must be 40');
  assert.equal(splitLiabEquity.values[colBIndex], 40, 'Analytic B total liabilities + equity must be 40');
  assert.equal(splitTotalAssets.values[colBIndex], splitLiabEquity.values[colBIndex], 'Analytic B column balances after split invoice');

  // 3. Vendor bill with allocated expense and untagged payable
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    company_id: 1,
    journal_id: journals.purchase,
    partner_id: partnerId,
    invoice_date: '2026-04-03',
    invoice_line_ids: [
      { account_id: accounts.expense, qty: 1, price_unit: 50, tax: 0, analytic_distribution: { [analyticA.id]: 100 } },
    ],
  });
  db = postMove(bill.db, bill.id);

  const billCols = balanceAnalyticColumns(db, group, period);
  const billTotalAssets = billCols.totals.find((t) => t.label === 'Total Assets');
  const billLiabEquity = billCols.totals.find((t) => t.label === 'Liabilities + Equity');
  assert.equal(billTotalAssets.values[colAIndex], billLiabEquity.values[colAIndex], 'Vendor bill column balances in Analytic A');

  // 4. balanceAnalyticColumns with analyticAccountIds filter also balances
  const filteredCols = balanceAnalyticColumns(db, group, period, { analyticAccountIds: [analyticA.id] });
  const fTotalAssets = filteredCols.totals.find((t) => t.label === 'Total Assets');
  const fLiabEquity = filteredCols.totals.find((t) => t.label === 'Liabilities + Equity');
  for (let i = 0; i < filteredCols.headers.length; i++) {
    assert.equal(fTotalAssets.values[i], fLiabEquity.values[i], `Column ${filteredCols.headers[i]} balances with analyticAccountIds filter`);
  }
});

test('Qodo 11: selecting accounts from two plans does not double figures and maintains balance', () => {
  let db = seed();

  const plan1 = create(db, 'account.analytic.plan', {
    name: 'Plan 1',
    default_applicability: 'optional',
  });
  db = plan1.db;

  const plan2 = create(db, 'account.analytic.plan', {
    name: 'Plan 2',
    default_applicability: 'optional',
  });
  db = plan2.db;

  const acc1 = create(db, 'account.analytic.account', {
    name: 'Account 1',
    plan_id: plan1.id,
  });
  db = acc1.db;

  const acc2 = create(db, 'account.analytic.account', {
    name: 'Account 2',
    plan_id: plan2.id,
  });
  db = acc2.db;
  const fixture = makeLedgerFixture(db);
  db = fixture.db;
  const { accounts, journals } = fixture;

  // 100% in Plan 1 and 100% in Plan 2 on the same line
  const entry = postEntry(db, {
    journal: journals.general,
    journal_id: journals.general,
    date: '2026-05-01',
    company: 1,
    lines: [
      {
        account_id: accounts.expense,
        debit: 100,
        analytic_distribution: { [acc1.id]: 100, [acc2.id]: 100 },
      },
      { account_id: accounts.cash, credit: 100 },
    ],
  });
  db = entry.db;

  const selectedIds = [acc1.id, acc2.id];

  // 1. filterByAnalytic does not double line amounts
  const move = read(db, 'account.move', entry.id);
  const filtered = filterByAnalytic(move.line_ids, selectedIds);
  const expenseLine = filtered.find((l) => l.account_id === accounts.expense);
  assert.equal(expenseLine.debit, 100, 'filterByAnalytic must not double line debit when accounts from 2 plans are selected');
  const analyticMove = analyticMoveItems(move.line_ids, selectedIds);
  const cashLine = analyticMove.find((line) => line.account_id === accounts.cash);
  assert.equal(cashLine.credit, 100, 'Restored cash counterpart uses the same capped selection share');

  // 2. profitAndLoss does not double expense
  const pnl = profitAndLoss(db, { from: '2026-05-01', to: '2026-05-31' }, { analyticAccountIds: selectedIds });
  assert.equal(pnl.expense, 100, 'P&L expense must be 100, not 200');

  // 3. trialBalance does not double balance
  const tb = trialBalance(db, { from: '2026-05-01', to: '2026-05-31', analyticAccountIds: selectedIds });
  const tbExpense = tb.rows.find((r) => r.account.id === accounts.expense);
  assert.equal(tbExpense.debit, 100, 'Trial balance expense debit must be 100, not 200');

  // 4. analyticMoveItems scales counterparts consistently and balanceSheet balances
  const bs = balanceSheet(db, '2026-05-31', { analyticAccountIds: selectedIds });
  assert.equal(bs.totalAssets, -100, 'Bank balance is -100');
  assert.equal(bs.totalEquity, -100, 'Equity/earnings is -100');
  assert.equal(bs.totalAssets, bs.totalLiabilities + bs.totalEquity, 'Balance sheet must balance');

  // 5. cashFlow balances
  const cf = cashFlow(db, { from: '2026-05-01', to: '2026-05-31', company_id: 1, analyticAccountIds: selectedIds });
  assert.equal(cf.operating, -100, 'Cash flow operating activity must be -100');
  assert.equal(cf.net, -100, 'Cash flow net change must be -100');

  // 6. Horizontal reports with accounts from both plans
  const group = {
    id: 2,
    name: 'Multi Plan Group',
    company_id: 1,
    rule_ids: [{ field: 'analytic', ids: `${acc1.id},${acc2.id}` }],
  };
  const pnlCols = pnlAnalyticColumns(db, group, { from: '2026-05-01', to: '2026-05-31' }, { analyticAccountIds: selectedIds });
  const netIncomeRow = pnlCols.totals.find((t) => t.label === 'Net Income');
  assert.ok(netIncomeRow, 'Net Income row exists in horizontal P&L');
  assert.equal(netIncomeRow.values.reduce((sum, value) => sum + value, 0), -100, 'Horizontal P&L columns sum to the ordinary amount');
  assert.ok(netIncomeRow.values.every((value) => Math.abs(value) <= 50), 'No horizontal P&L column contains a doubled amount');

  const bsCols = balanceAnalyticColumns(db, group, { from: '2026-05-01', to: '2026-05-31' }, { analyticAccountIds: selectedIds });
  const bsTotalAssets = bsCols.totals.find((t) => t.label === 'Total Assets');
  const bsLiabEquity = bsCols.totals.find((t) => t.label === 'Liabilities + Equity');
  for (let i = 0; i < bsCols.headers.length; i++) {
    assert.equal(bsTotalAssets.values[i], bsLiabEquity.values[i], `Horizontal BS column ${bsCols.headers[i]} must balance`);
  }
  assert.equal(bsTotalAssets.values.reduce((sum, value) => sum + value, 0), bs.totalAssets, 'Horizontal balance sheet assets sum to the ordinary report amount');

});
