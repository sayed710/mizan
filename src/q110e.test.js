import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './registry.js';
import { seed } from './seed.js';
import { accountId, journalItems } from './models/ledger.js';
import { analyticBalance } from './models/analyticplus.js';
import { cleanRecord } from './validate.js';

test('computing a manual schedule keeps months consistent with its explicit date range', () => {
  const compute = models['account.deferral'].form.buttons.find((button) => button.label === 'Compute');
  let db = write(seed(), 'res.company', 1, { deferred_amount_computation_method: 'full_months' });
  for (const [end_date, months, dates] of [
    ['2027-01-14', 12, ['2026-11-30', '2026-12-31', '2027-01-31']],
    ['2026-11-20', 0, ['2026-11-30']],
  ]) {
    const created = create(db, 'account.deferral', { name: 'Date range', amount: 120, start_date: '2026-11-14', end_date, months, company_id: 1 });
    db = compute.run(created.db, read(created.db, 'account.deferral', created.id)).db;
    const schedule = read(db, 'account.deferral', created.id);
    assert.equal(schedule.months, dates.length);
    assert.equal(cleanRecord('account.deferral', schedule).months, dates.length);
    assert.deepEqual(schedule.board.map((line) => line.date), dates);
    assert.equal(schedule.board.reduce((sum, line) => sum + Math.round(line.amount * 100), 0), 12000);
  }
  const duration = create(db, 'account.deferral', { name: 'Duration', amount: 120, start_date: '2028-01-15', months: 3, company_id: 1 });
  db = compute.run(duration.db, read(duration.db, 'account.deferral', duration.id)).db;
  const schedule = read(db, 'account.deferral', duration.id);
  assert.equal(schedule.months, 3);
  assert.deepEqual(schedule.board.map((line) => line.date), ['2028-01-31', '2028-02-29', '2028-03-31']);
  const invalid = create(db, 'account.deferral', { name: 'Invalid', amount: 120, start_date: '2028-01-15', months: 0, company_id: 1 });
  assert.throws(() => compute.run(invalid.db, read(invalid.db, 'account.deferral', invalid.id)), /at least 1/);
  assert.equal(read(invalid.db, 'account.deferral', invalid.id).state, 'draft');
});

test('grouped generation on consecutive days ignores the prior reversal and remains idempotent', () => {
  let db = write(seed(), 'res.company', 1, { deferred_generation_method: 'manual_grouped' });
  const schedule = create(db, 'account.deferral', {
    name: 'Contract', kind: 'revenue', company_id: 1, state: 'running',
    deferred_account_id: accountId(db, '212000'), recognition_account_id: accountId(db, '410000'),
    board: [
      { date: '2026-01-31', amount: 100, posted: false, move_id: null },
      { date: '2026-02-01', amount: 50, posted: false, move_id: null },
    ],
  });
  const generate = models['account.deferral'].actions.generateGroupedEntries;
  db = generate(schedule.db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });
  const first = search(db, 'account.move').find((move) => move.is_deferred_grouped && !move.reversed_entry_id);
  assert.ok(first);
  assert.equal(read(db, 'account.move', first.reversal_move_id).deferral_date, '2026-02-01');
  db = generate(db, { company_id: 1, kind: 'revenue', date: '2026-02-01' });
  const originals = search(db, 'account.move').filter((move) => move.is_deferred_grouped && !move.reversed_entry_id);
  assert.equal(originals.length, 2);
  const second = originals.find((move) => move.deferral_date === '2026-02-01');
  assert.ok(second);
  assert.equal(second.line_ids.reduce((sum, line) => sum + line.debit, 0), 150);
  assert.equal(read(db, 'account.move', second.reversal_move_id).deferral_date, '2026-02-02');
  db = generate(db, { company_id: 1, kind: 'revenue', date: '2026-02-01' });
  assert.equal(search(db, 'account.move').filter((move) => move.is_deferred_grouped).length, 4);
});

test('grouped snapshots record their schedule lines and block individual posting while remaining cumulative', () => {
  let db = write(seed(), 'res.company', 1, { deferred_generation_method: 'manual_grouped' });
  const first = create(db, 'account.deferral', {
    name: 'First', kind: 'revenue', company_id: 1, state: 'running',
    deferred_account_id: accountId(db, '212000'), recognition_account_id: accountId(db, '410000'),
    board: [
      { date: '2026-01-31', amount: 100, posted: false, move_id: null },
      { date: '2026-02-28', amount: 50, posted: false, move_id: null },
    ],
  });
  const second = create(first.db, 'account.deferral', {
    name: 'Second', kind: 'revenue', company_id: 1, state: 'running',
    deferred_account_id: accountId(db, '212000'), recognition_account_id: accountId(db, '410000'),
    board: [{ date: '2026-02-28', amount: 25, posted: false, move_id: null }],
  });
  const actions = models['account.deferral'].actions;
  assert.throws(() => actions.postDueEntries(second.db, read(second.db, 'account.deferral', first.id), '2026-01-31'), /grouped/i);
  db = actions.generateGroupedEntries(second.db, { company_id: 1, kind: 'revenue', date: '2026-01-31' });
  const january = search(db, 'account.move').find((m) => m.is_deferred_grouped && !m.reversed_entry_id);
  assert.deepEqual(january.deferred_contributions, [{ schedule_id: first.id, board_lines: [{ index: 0, date: '2026-01-31', amount: 100 }], deferred_line_index: 0, recognition_line_index: 1 }]);
  assert.deepEqual(cleanRecord('account.move', january).deferred_contributions, january.deferred_contributions);
  assert.deepEqual(read(db, 'account.move', january.reversal_move_id).deferred_contributions, january.deferred_contributions);
  const button = models['account.deferral'].form.buttons.find((b) => b.label === 'Post Due Entries');
  assert.throws(() => button.run(db, read(db, 'account.deferral', first.id)), /grouped/i);
  assert.equal(read(db, 'account.deferral', first.id).board[0].posted, false);
  db = actions.generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2026-02-28' });
  const february = search(db, 'account.move').find((m) => m.is_deferred_grouped && !m.reversed_entry_id && m.deferral_date === '2026-02-28');
  assert.equal(february.line_ids.reduce((sum, line) => sum + line.debit, 0), 175);
  assert.deepEqual(february.deferred_contributions, [
    { schedule_id: first.id, board_lines: [{ index: 0, date: '2026-01-31', amount: 100 }, { index: 1, date: '2026-02-28', amount: 50 }], deferred_line_index: 0, recognition_line_index: 1 },
    { schedule_id: second.id, board_lines: [{ index: 0, date: '2026-02-28', amount: 25 }], deferred_line_index: 0, recognition_line_index: 2 },
  ]);
  assert.equal(read(db, 'account.move', february.reversal_move_id).line_ids.reduce((sum, line) => sum + line.credit, 0), 175);
});

test('grouped generation rejects non-grouped companies through model and list actions', () => {
  let db = write(seed(), 'res.company', 1, { deferred_generation_method: 'manual' });
  const schedule = create(db, 'account.deferral', {
    name: 'Contract', kind: 'revenue', company_id: 1, state: 'running',
    deferred_account_id: accountId(db, '212000'), recognition_account_id: accountId(db, '410000'),
    board: [{ date: '2026-01-31', amount: 100, posted: false, move_id: null }],
  });
  db = schedule.db;
  const generate = models['account.deferral'].actions.generateGroupedEntries;
  const listAction = models['account.deferral'].listActions.find((action) => action.label === 'Generate Entries');
  const originalMoves = search(db, 'account.move').length;
  for (const method of ['manual', 'on_validation']) {
    const current = write(db, 'res.company', 1, { deferred_generation_method: method });
    assert.throws(() => generate(current, { date: '2026-01-31', company_id: 1 }), /grouped/i);
    assert.throws(() => listAction.run(current, [], '2026-01-31'), /grouped/i);
    assert.equal(search(current, 'account.move').length, originalMoves);
    assert.equal(read(current, 'account.deferral', schedule.id).board[0].posted, false);
  }
  assert.throws(() => generate(db, { date: '2026-01-31', company_id: 999999 }), /company|grouped/i);
  db = write(db, 'res.company', 1, { deferred_generation_method: 'manual_grouped' });
  db = listAction.run(db, [], '2026-01-31');
  assert.equal(search(db, 'account.move').filter((m) => m.is_deferred_grouped).length, 2);
});

for (const [moveType, accountCode, sign] of [['out_invoice', '410000', -1], ['in_invoice', '600000', 1]]) {
  test(`reset removes only its grouped ${moveType} recognition on snapshot and reversal dates`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-31T12:00:00') });
    let db = write(seed(), 'res.company', 1, {
      deferred_generation_method: 'manual_grouped', deferred_amount_computation_method: 'full_months',
      deferred_revenue_account_id: accountId(seed(), '212000'), deferred_expense_account_id: accountId(seed(), '132000'),
    });
    const analyticA = create(db, 'account.analytic.account', { name: 'Project A' });
    const analyticB = create(analyticA.db, 'account.analytic.account', { name: 'Project B' });
    db = analyticB.db;
    const button = (label, id) => { db = models['account.move'].form.buttons.find((b) => b.label === label).run(db, read(db, 'account.move', id)).db; };
    const invoices = [];
    for (const [amount, analytic] of [[200, analyticA.id], [100, analyticB.id]]) {
      const invoice = create(db, 'account.move', {
        move_type: moveType, partner_id: 2, invoice_date: '2026-01-01',
        invoice_line_ids: [{ name: 'Contract', qty: 1, price_unit: amount, tax: 0, account_id: accountId(db, accountCode), deferred_start_date: '2026-01-01', deferred_end_date: '2026-02-28', analytic_distribution: { [analytic]: 100 } }],
      });
      db = invoice.db;
      invoices.push(invoice.id);
      button('Confirm', invoice.id);
    }
    const generate = models['account.deferral'].actions.generateGroupedEntries;
    db = generate(db, { date: '2026-01-31', company_id: 1 });
    db = generate(db, { date: '2026-02-28', company_id: 1 });
    button('Reset to Draft', invoices[0]);
    const balance = (date) => journalItems(db, { from: date, to: date, company_id: 1 })
      .filter((line) => line.account_id === accountId(db, accountCode))
      .reduce((sum, line) => sum + line.debit - line.credit, 0);
    assert.equal(balance('2026-01-31'), sign * 50);
    assert.equal(balance('2026-02-01'), -sign * 50);
    assert.equal(balance('2026-02-28'), sign * 100);
    assert.equal(balance('2026-03-01'), -sign * 100);
    for (const date of ['2026-01-31', '2026-02-01', '2026-02-28', '2026-03-01']) {
      assert.equal(analyticBalance(db, analyticA.id, { from: date, to: date }).balance, 0);
    }
    assert.equal(analyticBalance(db, analyticB.id, { from: '2026-01-31', to: '2026-01-31' }).balance, -sign * 50);
    assert.equal(read(db, 'account.deferral', search(db, 'account.deferral').find((d) => d.source_move_id === invoices[0]).id).state, 'cancel');
  });
}
