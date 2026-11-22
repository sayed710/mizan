import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { trialBalance } from './models/reports.js';

test('COA-1 computes carry-forward and applies it at the fiscal boundary', () => {
  const field = models['account.account'].fields.include_initial_balance;
  assert.equal(field.readonly, true);
  for (const type of ['income', 'income_other', 'expense', 'expense_depreciation', 'expense_direct_cost', 'off_balance']) assert.equal(field.compute({ account_type: type }), false);
  for (const type of ['asset_cash', 'expense_other', 'equity']) assert.equal(field.compute({ account_type: type }), true);
  const db = seed();
  const income = create(db, 'account.account', { code: '987650', name: 'Test income', account_type: 'income' });
  const account = read(income.db, 'account.account', income.id);
  const next = { ...income.db, records: { ...income.db.records, 'account.move': [
    { id: 99990, state: 'posted', move_type: 'entry', date: '2025-12-01', company_id: 1, line_ids: [{ account_id: income.id, debit: 0, credit: 10 }] },
    { id: 99991, state: 'posted', move_type: 'entry', date: '2026-01-10', company_id: 1, line_ids: [{ account_id: income.id, debit: 0, credit: 7 }] },
  ] } };
  assert.equal(trialBalance(next, { from: '2026-02-01', to: '2026-02-28', company_id: 1 }).rows.find((r) => r.account.id === account.id).initial, -7);
});

test('COA-1 prior-year results open on the earnings account and keep the opening column balanced', () => {
  const db = seed();
  const income = create(db, 'account.account', { code: '987653', name: 'Prior income', account_type: 'income' });
  const earningsId = read(income.db, 'res.company', 1).current_year_earnings_account_id;
  const cash = search(income.db, 'account.account').find((a) => a.account_type === 'asset_cash');
  const next = { ...income.db, records: { ...income.db.records, 'account.move': [
    { id: 99992, state: 'posted', move_type: 'entry', date: '2025-06-01', company_id: 1, line_ids: [{ account_id: cash.id, debit: 25, credit: 0 }, { account_id: income.id, debit: 0, credit: 25 }] },
  ] } };
  const trial = trialBalance(next, { from: '2026-02-01', to: '2026-02-28', company_id: 1 });
  assert.equal(trial.rows.find((r) => r.account.id === income.id), undefined);
  assert.equal(trial.rows.find((r) => r.account.id === earningsId).initial, -25);
  assert.equal(trial.totals.initial, 0);
});

test('COA-2 restricts non trade and resets it when changing type', () => {
  const model = models['account.account'];
  assert.equal(model.fields.non_trade.hideWhen({ account_type: 'expense' }), true);
  assert.equal(model.fields.non_trade.hideWhen({ account_type: 'asset_receivable' }), false);
  assert.equal(model.fields.non_trade.hideWhen({ account_type: 'liability_payable' }), false);
  const made = create(seed(), 'account.account', { code: '987651', name: 'Non trade', account_type: 'asset_receivable', non_trade: true });
  const changed = write(made.db, 'account.account', made.id, { account_type: 'expense' });
  assert.equal(read(changed, 'account.account', made.id).non_trade, false);
  const raw = { ...made.db, records: { ...made.db.records, 'account.account': made.db.records['account.account'].map((a) => a.id === made.id ? { ...a, account_type: 'expense', non_trade: true } : a) } };
  assert.throws(() => applyDiff(made.db, diffDb(made.db, raw), { isAdmin: true }), /Non Trade/);
});

test('COA-3 internal notes are editable on the account form', () => {
  const model = models['account.account'];
  assert.equal(model.fields.note.type, 'text');
  assert.ok(model.form.tabs.some((tab) => tab.groups?.some((group) => group.includes('note'))));
  const made = create(seed(), 'account.account', { code: '987652', name: 'Notes', account_type: 'expense', note: 'Internal note' });
  assert.equal(read(made.db, 'account.account', made.id).note, 'Internal note');
});
