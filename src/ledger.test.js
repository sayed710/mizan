import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { balanceSheet, isBalanced, journalItems, profitAndLoss } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { seed } from './seed.js';

const round = (n) => Math.round(n * 100) / 100;

test('every posted move is balanced', () => {
  const db = seed();
  const posted = search(db, 'account.move').filter((m) => m.state === 'posted');
  assert.ok(posted.length >= 5);
  for (const m of posted) assert.ok(isBalanced(m.line_ids), `${m.name} unbalanced`);
});

test('balance sheet balances: assets = liabilities + equity', () => {
  const b = balanceSheet(seed());
  assert.equal(round(b.totalAssets), round(b.totalLiabilities + b.totalEquity));
});

test('P&L revenue equals untaxed posted customer invoices', () => {
  const db = seed();
  const invoiced = search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'out_invoice')
    .reduce((s, m) => s + m.amount_untaxed, 0);
  const p = profitAndLoss(db, {});
  assert.equal(p.revenue, round(invoiced));
  assert.equal(p.net, round(p.revenue - p.cost - p.expense + p.otherIncome - p.otherExpense));
});

test('unbalanced manual entries cannot be posted', () => {
  const db0 = seed();
  const { db, id } = create(db0, 'account.move', {
    move_type: 'entry', line_ids: [{ account_id: 1, debit: 100, credit: 0 }, { account_id: 2, debit: 0, credit: 90 }],
  });
  assert.throws(() => postMove(db, id), /not balanced/);
});

test('payments move money from receivable to bank', () => {
  const db = seed();
  const bank = read(db, 'account.account', 1);
  const bankBalance = journalItems(db).filter((l) => l.account_id === bank.id).reduce((s, l) => s + l.debit - l.credit, 0);
  const paid = search(db, 'account.move').filter((m) => m.move_type === 'out_invoice').reduce((s, m) => s + (m.amount_paid || 0), 0);
  assert.equal(bank.code, '101401');
  assert.equal(round(bankBalance), round(150000 + paid)); // opening capital + customer payments
});
