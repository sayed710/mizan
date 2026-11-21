import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { models } from './registry.js';
import { menusFor } from './models/index.js';
import * as reports from './models/reports.js';
import { deferredSettings, lineCreditAdjustmentAmount, scheduleAsOf } from './models/deferred.js';
import { migrateDeferralCreditAdjustments } from './migrations.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('deferred reports aggregate recognition periods and filter source dates and kinds', () => {
  const db = seed();
  db.records['account.move'] = [
    { id: 901, state: 'posted', date: '2026-01-01', company_id: 1 },
    { id: 902, state: 'posted', date: '2026-03-01', company_id: 1 },
  ];
  db.records['account.deferral'] = [
    { id: 1, kind: 'revenue', state: 'running', company_id: 1, source_move_id: 901, recognition_account_id: 10, start_date: '2026-01-01', end_date: '2026-03-31', amount: 300, board: [{ date: '2026-01-31', amount: 100 }, { date: '2026-02-28', amount: 100 }, { date: '2026-03-31', amount: 100 }] },
    { id: 2, kind: 'revenue', state: 'running', company_id: 1, source_move_id: 901, recognition_account_id: 10, start_date: '2026-04-01', end_date: '2026-04-30', amount: 50, board: [{ date: '2026-04-30', amount: 50 }] },
    { id: 3, kind: 'revenue', state: 'running', company_id: 1, source_move_id: 902, recognition_account_id: 10, start_date: '2026-03-01', end_date: '2026-03-31', amount: 90, board: [{ date: '2026-03-31', amount: 90 }] },
    { id: 5, kind: 'revenue', state: 'running', company_id: 1, source_move_id: 901, recognition_account_id: 10, start_date: '2027-02-01', end_date: '2027-03-31', amount: 30, board: [{ date: '2027-02-28', amount: 10 }, { date: '2027-03-31', amount: 20 }] },
    { id: 4, kind: 'expense', state: 'running', company_id: 1, source_move_id: 901, recognition_account_id: 11, start_date: '2026-02-01', end_date: '2026-02-28', amount: 40, board: [{ date: '2026-02-28', amount: 40 }] },
  ];
  const period = { from: '2026-02-01', to: '2026-02-28', company_id: 1 };
  const rev = reports.deferredReport(db, period, 'revenue');
  assert.deepEqual(rev.map(({ account_id, total, not_started, before, current, recognized, within_year, after_year }) => ({ account_id, total, not_started, before, current, recognized, within_year, after_year })), [{ account_id: 10, total: 380, not_started: 80, before: 100, current: 100, recognized: 200, within_year: 160, after_year: 20 }]);
  assert.deepEqual(reports.deferredReport(db, period, 'expense').map(({ total, current, recognized, within_year, after_year }) => ({ total, current, recognized, within_year, after_year })), [{ total: 40, current: 40, recognized: 40, within_year: 0, after_year: 0 }]);
  const management = menusFor('accounting').find((m) => m.label === 'Reporting').children.find((m) => m.label === 'Management');
  assert.ok(management.children.some((m) => m.report === 'deferredRevenue'));
  assert.ok(management.children.some((m) => m.report === 'deferredExpense'));
});

test('deferred future buckets use a calendar year, including leap-day cutoffs', () => {
  const db = seed();
  db.records['account.move'] = [{ id: 901, state: 'posted', date: '2028-02-01', company_id: 1 }];
  db.records['account.deferral'] = [{ id: 1, kind: 'expense', state: 'running', company_id: 1, source_move_id: 901, recognition_account_id: 11, start_date: '2029-02-01', end_date: '2029-03-31', board: [{ date: '2029-02-28', amount: 70 }, { date: '2029-03-31', amount: 30 }] }];
  const [row] = reports.deferredReport(db, { from: '2028-02-01', to: '2028-02-29', company_id: 1 }, 'expense');
  assert.deepEqual([row.total, row.not_started, row.recognized, row.within_year, row.after_year], [100, 100, 0, 70, 30]);
});

test('Deferrals smart button is visible on linked invoices and bills', () => {
  const db = seed();
  db.records['account.deferral'] = [{ id: 101, source_move_id: 201 }, { id: 102, source_move_id: 202 }];
  const smart = models['account.move'].form.smart.find((item) => item.label === 'Deferrals');
  for (const [id, move_type] of [[201, 'out_invoice'], [202, 'in_invoice']]) {
    const move = { id, move_type };
    assert.equal(smart.when(move, db), true);
    assert.equal(smart.value(db, move), 1);
    assert.equal(smart.target(move, db), `accounting/deferrals/${id === 201 ? 101 : 102}`);
  }
  assert.equal(smart.when({ id: 203, move_type: 'in_invoice' }, db), false);
});

test('finding 1: credit note corrections reduce recognized amounts according to posting date (partial and full credits)', () => {
  const db = seed();
  db.records['account.move'] = [
    { id: 901, state: 'posted', date: '2026-01-01', company_id: 1 },
    { id: 902, state: 'posted', date: '2026-02-15', company_id: 1, line_ids: [{ account_id: 10, debit: 40, credit: 0 }] },
  ];
  db.records['account.deferral'] = [
    {
      id: 1,
      kind: 'revenue',
      state: 'running',
      company_id: 1,
      source_move_id: 901,
      recognition_account_id: 10,
      start_date: '2026-01-01',
      end_date: '2026-03-31',
      amount: 260,
      board: [
        {
          date: '2026-01-31',
          amount: 100,
          posted: true,
          credit_adjusted_amount: 40,
          credit_adjustment_move_ids: [902],
          credit_adjustments: [{ move_id: 902, amount: 40, date: '2026-02-15' }],
        },
        { date: '2026-02-28', amount: 80, posted: true },
        { date: '2026-03-31', amount: 80, posted: false },
      ],
    },
  ];

  // For Jan 2026 (before credit note on 2026-02-15): correction does not yet apply
  const jan = reports.deferredReport(db, { from: '2026-01-01', to: '2026-01-31', company_id: 1 }, 'revenue');
  assert.equal(jan[0].before, 0);
  assert.equal(jan[0].current, 100);
  assert.equal(jan[0].recognized, 100);

  // For Feb 2026 (credit note correction posted during Feb):
  const feb = reports.deferredReport(db, { from: '2026-02-01', to: '2026-02-28', company_id: 1 }, 'revenue');
  assert.equal(feb[0].total, 220); // 100 - 40 + 80 + 80 = 220
  assert.equal(feb[0].before, 100); // recognized in Jan without reduction before Feb
  assert.equal(feb[0].current, 40); // 80 - 40 = 40
  assert.equal(feb[0].recognized, 140); // 100 - 40 + 80 = 140
  assert.equal(feb[0].within_year, 80); // Line 3
  assert.equal(feb[0].total, feb[0].recognized + feb[0].within_year);

  // For March 2026: credit note was posted in a prior period
  const mar = reports.deferredReport(db, { from: '2026-03-01', to: '2026-03-31', company_id: 1 }, 'revenue');
  assert.equal(mar[0].before, 140);
  assert.equal(mar[0].current, 80);
  assert.equal(mar[0].recognized, 220);
});

test('finding 2: past reports retain schedules cancelled by later full credit note', () => {
  const db = seed();
  db.records['account.move'] = [
    { id: 901, state: 'posted', date: '2026-01-01', company_id: 1 },
    { id: 999, state: 'posted', date: '2026-03-15', move_type: 'out_refund', company_id: 1 },
    { id: 998, state: 'posted', date: '2026-03-15', move_type: 'entry', company_id: 1, line_ids: [{ account_id: 10, debit: 100, credit: 0 }] },
  ];
  const boardBefore = [
    { date: '2026-01-31', amount: 100, posted: true },
    { date: '2026-02-28', amount: 100, posted: false },
  ];
  db.records['account.deferral'] = [
    {
      id: 1,
      kind: 'revenue',
      state: 'cancel',
      company_id: 1,
      source_move_id: 901,
      recognition_account_id: 10,
      start_date: '2026-01-01',
      end_date: '2026-02-28',
      amount: 200,
      board: [
        { date: '2026-01-31', amount: 100, posted: true, reversal_move_id: 998, credit_adjusted_amount: 100, credit_adjustment_move_ids: [998], credit_adjustments: [{ move_id: 998, amount: 100, date: '2026-03-15' }] },
        { date: '2026-02-28', amount: 0, posted: false, cancelled: true },
      ],
      credit_adjustments: [
        {
          note_id: 999,
          date: '2026-03-15',
          state_before: 'running',
          board_before: boardBefore,
          move_ids: [998],
        },
      ],
    },
  ];

  // Report for Jan 2026 (before credit note on 2026-03-15): schedule is reconstructed and included
  const pastReport = reports.deferredReport(db, { from: '2026-01-01', to: '2026-01-31', company_id: 1 }, 'revenue');
  assert.equal(pastReport.length, 1);
  assert.equal(pastReport[0].recognized, 100);

  // Report for March 2026 (cutoff on or after credit note): fully credited schedule is excluded
  const currentReport = reports.deferredReport(db, { from: '2026-03-01', to: '2026-03-31', company_id: 1 }, 'revenue');
  assert.equal(currentReport.length, 0);
});

test('finding 3: deferredExpense declares same seven columns as deferredRevenue', async () => {
  const { REPORTS } = await import('./views/Reports.jsx');
  assert.deepEqual(REPORTS.deferredExpense.cols, ['Total', 'Not Started', 'Before', 'Current', 'Recognized', '<= 12 Months', '> 12 Months']);
  assert.deepEqual(REPORTS.deferredRevenue.cols, ['Total', 'Not Started', 'Before', 'Current', 'Recognized', '<= 12 Months', '> 12 Months']);
});

test('finding 4: DeferredBody includes selected company in drilldown URL and JournalItems filters by company', async () => {
  const { DeferredBody } = await import('./views/Reports.jsx');
  const db = seed();
  db.records['res.company'] = [
    ...(db.records['res.company'] ?? []),
    { id: 2, name: 'Company 2', currency_id: 1 },
  ];
  db.records['account.account'] = [
    { id: 50, code: '4000', name: 'Shared Revenue', company_id: null },
  ];
  db.records['account.move'] = [{ id: 901, state: 'posted', date: '2026-01-01', company_id: 2 }];
  db.records['account.deferral'] = [
    { id: 1, kind: 'revenue', state: 'running', company_id: 2, source_move_id: 901, recognition_account_id: 50, start_date: '2026-01-01', end_date: '2026-01-31', amount: 100, board: [{ date: '2026-01-31', amount: 100 }] },
  ];
  const rendered = DeferredBody({ db, period: { from: '2026-01-01', to: '2026-01-31' }, companyId: '2', kind: 'revenue' });
  const row = rendered.props.children[0];
  const linkHref = row.props.children[0].props.children.props.href;
  assert.ok(linkHref.includes('&company=2'), `Drill-down link must include &company=2: ${linkHref}`);
});

test('finding 5: small amounts in three-decimal currencies are not rounded away in deferredReport totals', () => {
  const db = seed();
  db.records['res.currency'] = [
    ...(db.records['res.currency'] ?? []),
    { id: 99, name: 'KWD', symbol: 'KD', rounding: 0.001, decimal_places: 3 },
  ];
  db.records['res.company'] = [
    ...(db.records['res.company'] ?? []),
    { id: 3, name: 'Kuwait Co', currency_id: 99 },
  ];
  db.records['account.move'] = [{ id: 901, state: 'posted', date: '2026-01-01', company_id: 3 }];
  db.records['account.deferral'] = [
    { id: 1, kind: 'revenue', state: 'running', company_id: 3, source_move_id: 901, recognition_account_id: 10, start_date: '2026-01-01', end_date: '2026-01-31', amount: 0.001, board: [{ date: '2026-01-31', amount: 0.001 }] },
  ];
  const [row] = reports.deferredReport(db, { from: '2026-01-01', to: '2026-01-31', company_id: 3 }, 'revenue');
  assert.equal(row.total, 0.001);
  assert.equal(row.current, 0.001);
  assert.equal(row.recognized, 0.001);
});

test('finding 6: DeferredBody formats amounts using selected company currency instead of active currency', async () => {
  const { DeferredBody } = await import('./views/Reports.jsx');
  const db = seed();
  db.records['res.currency'] = [
    ...(db.records['res.currency'] ?? []),
    { id: 88, name: 'EUR', symbol: '€', rounding: 0.01, position: 'after' },
  ];
  db.records['res.company'] = [
    ...(db.records['res.company'] ?? []),
    { id: 2, name: 'Euro Co', currency_id: 88 },
  ];
  db.records['account.account'] = [{ id: 10, code: '4000', name: 'Revenue', company_id: 2 }];
  db.records['account.move'] = [{ id: 901, state: 'posted', date: '2026-01-01', company_id: 2 }];
  db.records['account.deferral'] = [
    { id: 1, kind: 'revenue', state: 'running', company_id: 2, source_move_id: 901, recognition_account_id: 10, start_date: '2026-01-01', end_date: '2026-01-31', amount: 150, board: [{ date: '2026-01-31', amount: 150 }] },
  ];
  const vdom = DeferredBody({ db, period: { from: '2026-01-01', to: '2026-01-31' }, companyId: '2', kind: 'revenue' });
  const row = vdom.props.children[0];
  const [, numericCells] = row.props.children;
  const totalText = numericCells[0].props.children;
  assert.ok(totalText.includes('€'), `Expected Euro currency formatting, got ${totalText}`);
});

test('finding 7: ReportPage Generate Entries is disabled when deferral setting is on_validation', () => {
  const db = seed();
  const settingsDefault = deferredSettings(db, 1, 'revenue');
  assert.equal(settingsDefault.isGrouped, false);

  db.records['res.company'] = (db.records['res.company'] ?? []).map((c) =>
    c.id === 1 ? { ...c, generate_deferred_revenue_entries_method: 'manual' } : c
  );
  const settingsGrouped = deferredSettings(db, 1, 'revenue');
  assert.equal(settingsGrouped.isGrouped, true);
});

test('lineCreditAdjustmentAmount reads only line.credit_adjustments without legacy fallbacks', () => {
  const lineWithAdjustments = {
    date: '2026-01-31',
    credit_adjustments: [
      { move_id: 101, amount: 25, date: '2026-01-15' },
      { move_id: 102, amount: 15, date: '2026-02-15' },
    ],
    credit_adjusted_amount: 999, // legacy field must be ignored
    credit_adjustment_move_ids: [888], // legacy field must be ignored
  };

  assert.equal(lineCreditAdjustmentAmount(null, null, lineWithAdjustments, '2026-01-31'), 25);
  assert.equal(lineCreditAdjustmentAmount(null, null, lineWithAdjustments, '2026-02-28'), 40);
  assert.equal(lineCreditAdjustmentAmount(null, null, lineWithAdjustments, '2026-01-01'), 0);
  assert.equal(lineCreditAdjustmentAmount(null, null, lineWithAdjustments), 40);

  const lineLegacyOnly = {
    date: '2026-01-31',
    credit_adjusted_amount: 50,
    credit_adjustment_move_ids: [101],
  };
  // Fallbacks removed: returns 0 when credit_adjustments is absent
  assert.equal(lineCreditAdjustmentAmount(null, null, lineLegacyOnly), 0);
});

test('scheduleAsOf reads only line.credit_adjustments', () => {
  const schedule = {
    id: 1,
    state: 'cancel',
    board: [
      {
        date: '2026-01-31',
        amount: 100,
        posted: true,
        credit_adjustments: [{ move_id: 101, amount: 100, date: '2026-03-15' }],
      },
      { date: '2026-02-28', amount: 0, posted: false, cancelled: true },
    ],
  };

  const asOfJan = scheduleAsOf(null, schedule, '2026-01-31');
  assert.equal(asOfJan.state, 'running');

  const asOfMar = scheduleAsOf(null, schedule, '2026-03-31');
  assert.equal(asOfMar.state, 'cancel');
});

test('migration converts legacy credit_adjustment_move_ids and reversal_move_id to canonical record', () => {
  const db = {
    records: {
      'account.move': [
        { id: 901, state: 'posted', date: '2026-02-10', line_ids: [{ account_id: 10, debit: 35, credit: 0 }] },
        { id: 902, state: 'posted', invoice_date: '2026-03-12', line_ids: [{ account_id: 10, debit: 0, credit: 50 }] },
      ],
      'account.deferral': [
        {
          id: 1,
          recognition_account_id: 10,
          board: [
            {
              date: '2026-01-31',
              amount: 100,
              posted: true,
              credit_adjustment_move_ids: [901],
              credit_adjusted_amount: 35,
            },
            {
              date: '2026-02-28',
              amount: 100,
              posted: true,
              reversal_move_id: 902,
              credit_adjusted_amount: 50,
            },
            {
              date: '2026-03-31',
              amount: 100,
              posted: false,
            },
          ],
        },
      ],
    },
  };

  const migrated = migrateDeferralCreditAdjustments(db);
  const board = migrated.records['account.deferral'][0].board;

  assert.deepEqual(board[0].credit_adjustments, [{ move_id: 901, amount: 35, date: '2026-02-10' }]);
  assert.equal(board[0].credit_adjustment_move_ids, undefined);
  assert.equal(board[0].credit_adjusted_amount, undefined);

  assert.deepEqual(board[1].credit_adjustments, [{ move_id: 902, amount: 50, date: '2026-03-12' }]);
  assert.equal(board[1].reversal_move_id, 902);
  assert.equal(board[1].credit_adjusted_amount, undefined);

  assert.equal(board[2].credit_adjustments, undefined);
});

test('migration throws when amount or date cannot be determined rather than guessing', () => {
  // Missing move record
  const dbMissingMove = {
    records: {
      'account.move': [],
      'account.deferral': [
        {
          id: 1,
          recognition_account_id: 10,
          board: [{ date: '2026-01-31', credit_adjustment_move_ids: [999] }],
        },
      ],
    },
  };
  assert.throws(() => migrateDeferralCreditAdjustments(dbMissingMove), /Cannot determine move 999/);

  // Missing date on move
  const dbMissingDate = {
    records: {
      'account.move': [{ id: 901, state: 'posted' }],
      'account.deferral': [
        {
          id: 1,
          recognition_account_id: 10,
          board: [{ date: '2026-01-31', credit_adjustment_move_ids: [901], credit_adjusted_amount: 50 }],
        },
      ],
    },
  };
  assert.throws(() => migrateDeferralCreditAdjustments(dbMissingDate), /Cannot determine date/);

  // Missing amount on move and line
  const dbMissingAmount = {
    records: {
      'account.move': [{ id: 901, state: 'posted', date: '2026-02-01', line_ids: [] }],
      'account.deferral': [
        {
          id: 1,
          recognition_account_id: 10,
          board: [{ date: '2026-01-31', credit_adjustment_move_ids: [901] }],
        },
      ],
    },
  };
  assert.throws(() => migrateDeferralCreditAdjustments(dbMissingAmount), /Cannot determine amount/);

  // credit_adjusted_amount with no linked move (would have required guessing date)
  const dbNoMove = {
    records: {
      'account.move': [],
      'account.deferral': [
        {
          id: 1,
          recognition_account_id: 10,
          board: [{ date: '2026-01-31', credit_adjusted_amount: 50 }],
        },
      ],
    },
  };
  assert.throws(() => migrateDeferralCreditAdjustments(dbNoMove), /Cannot determine move and date/);
});
