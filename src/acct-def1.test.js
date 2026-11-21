import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { models } from './registry.js';
import { menusFor } from './models/index.js';
import * as reports from './models/reports.js';

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
