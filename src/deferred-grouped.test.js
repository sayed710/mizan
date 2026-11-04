import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './registry.js';
import { accountId } from './models/ledger.js';
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
