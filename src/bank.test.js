import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search, write } from './orm.js';
import { models } from './models/index.js';
import { balanceSheet, isBalanced, journalItems } from './models/ledger.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('a bank line with the exact amount due reconciles the invoice automatically', () => {
  const db0 = seed();
  const line = search(db0, 'account.bank.statement.line').find((l) => l.amount > 0);
  const inv = search(db0, 'account.move').find((m) => m.move_type === 'out_invoice' && m.partner_id === 3);
  const db = run(db0, 'account.bank.statement.line', line.id, 'Reconcile');
  assert.equal(read(db, 'account.bank.statement.line', line.id).state, 'reconciled');
  assert.equal(read(db, 'account.move', inv.id).payment_state, 'paid');
});

test('unmatched lines can be booked to an expense account with a balanced bank entry', () => {
  const db0 = seed();
  const rent = search(db0, 'account.bank.statement.line').find((l) => l.payment_ref.includes('rent'));
  assert.throws(() => run(db0, 'account.bank.statement.line', rent.id, 'Reconcile'), /No open invoice/);
  const db = run(db0, 'account.bank.statement.line', rent.id, 'Book to Account');
  const rentAccount = db.records['account.account'].find((a) => a.code === '630000');
  assert.equal(journalItems(db).filter((l) => l.account_id === rentAccount.id).reduce((s, l) => s + l.debit, 0), 1800);
  for (const m of search(db, 'account.move').filter((x) => x.state === 'posted')) assert.ok(isBalanced(m.line_ids));
  const b = balanceSheet(db);
  assert.equal(Math.round(b.totalAssets * 100), Math.round((b.totalLiabilities + b.totalEquity) * 100));
});

test('manual match pays the chosen bill', () => {
  const db0 = seed();
  const bill = search(db0, 'account.move').find((m) => m.move_type === 'in_invoice' && m.state === 'posted');
  const line = search(db0, 'account.bank.statement.line').find((l) => l.payment_ref === 'Bank charges');
  const db = run(write(db0, 'account.bank.statement.line', line.id, { move_id: bill.id }), 'account.bank.statement.line', line.id, 'Match');
  assert.equal(read(db, 'account.move', bill.id).amount_paid, 12.5);
});
