// AUD11 regression: a reconciliation model whose counterpart lines do not cover the whole open amount
// books those counterparts and leaves the remainder open on the statement line, like Odoo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { accountId, balances, isBalanced, journalItems } from './models/ledger.js';
import { trialBalance } from './models/reports.js';
import { applyRule } from './models/reconcile.js';
import { round } from './money.js';

const LINE = 'account.bank.statement.line';
const button = (db, id, label) => models[LINE].form.buttons.find((b) => b.label === label).run(db, read(db, LINE, id)).db;
const bankJournal = (db) => search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
const feeId = (db) => accountId(db, '690000');
const bankId = (db) => accountId(db, '101401');
const suspenseId = (db) => accountId(db, '101404');
const ledgerBalance = (db, id) => round(balances(db, journalItems(db, { company_id: 1 })).find((b) => b.account?.id === id)?.balance ?? 0);
const balanced = (db, label) => {
  assert.equal(round(trialBalance(db, { company_id: 1 }).totals.end), 0, `${label}: trial balance does not close`);
};

/** A 100.00 statement line for a 95.00 invoice, then the counterpart rule of the given type and amount. */
const partialWriteOff = (amountType, amount) => {
  const invoice = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 95, tax: 0 }] });
  const posted = postMove(invoice.db, invoice.id);
  const line = create(posted, LINE, { journal_id: bankJournal(posted).id, date: '2026-01-03', payment_ref: 'small fee', amount: 100, move_id: invoice.id, partner_id: 3 });
  const rule = create(line.db, 'account.reconcile.model', { name: 'Partial fee', rule_type: 'writeoff_button', line_ids: [{ account_id: feeId(line.db), label: 'Bank fee', amount_type: amountType, amount }] });
  return { db: applyRule(rule.db, read(rule.db, 'account.reconcile.model', rule.id), read(rule.db, LINE, line.id)), line: line.id, invoice: invoice.id };
};

for (const [amountType, amount] of [['fixed', 5], ['percentage', 5]]) test(`B4: a ${amountType} write-off of ${amount} books its counterparts and leaves the rest open on the statement line`, () => {
  const before = seed();
  const base = { bank: ledgerBalance(before, bankId(before)), fee: ledgerBalance(before, feeId(before)) };
  const x = partialWriteOff(amountType, amount);
  const line = read(x.db, LINE, x.line);
  assert.equal(line.state, 'to_check');
  assert.equal(line.open_amount, 95);
  assert.ok(line.bank_move_id && line.bank_move_id !== line.move_id, 'the bank movement is booked once, separately from the write-off entry');
  assert.deepEqual(line.allocations, [{ payment_move_id: line.move_id, amount }]);
  const writeoff = read(x.db, 'account.move', line.move_id);
  assert.ok(isBalanced(writeoff.line_ids));
  assert.equal(writeoff.line_ids.filter((l) => l.account_id === suspenseId(x.db)).reduce((sum, l) => sum + l.debit - l.credit, 0), amount);
  assert.equal(writeoff.line_ids.filter((l) => l.account_id === feeId(x.db)).reduce((sum, l) => sum + l.debit - l.credit, 0), -amount);
  const bank = read(x.db, 'account.move', line.bank_move_id);
  assert.equal(bank.line_ids.filter((l) => l.account_id === bankId(x.db))[0].debit, 100);
  assert.equal(bank.line_ids.filter((l) => l.account_id === suspenseId(x.db))[0].credit, 100);
  assert.equal(read(x.db, 'account.move', x.invoice).amount_residual, 95, 'the write-off does not settle the invoice');
  balanced(x.db, `B4 ${amountType} applied`);
  assert.equal(round(ledgerBalance(x.db, bankId(x.db)) - base.bank), 100);
  assert.equal(round(ledgerBalance(x.db, feeId(x.db)) - base.fee), -amount);
});

for (const [amountType, amount] of [['fixed', 5], ['percentage', 5]]) test(`B4: unreconciling a partial ${amountType} write-off restores the line`, () => {
  const before = seed();
  const base = { bank: ledgerBalance(before, bankId(before)), fee: ledgerBalance(before, feeId(before)) };
  const x = partialWriteOff(amountType, amount);
  const writeoffMoveId = read(x.db, LINE, x.line).move_id;
  const after = button(x.db, x.line, 'Unreconcile');
  const line = read(after, LINE, x.line);
  assert.equal(line.state, 'to_check');
  assert.equal(line.move_id, null);
  assert.equal(line.bank_move_id, null);
  assert.equal(line.open_amount, null);
  assert.deepEqual(line.allocations, []);
  assert.ok(search(after, 'account.move').some((m) => m.reversed_entry_id === writeoffMoveId), 'the write-off entry is reversed');
  assert.equal(read(after, 'account.move', x.invoice).amount_residual, 95);
  balanced(after, `B4 ${amountType} unreconciled`);
  assert.equal(round(ledgerBalance(after, bankId(after)) - base.bank), 0);
  assert.equal(round(ledgerBalance(after, feeId(after)) - base.fee), 0);
});

for (const [amountType, amount] of [['fixed', 5], ['percentage', 5]]) test(`B4: matching the rest to the invoice reconciles a line left open by a ${amountType} write-off`, () => {
  const before = seed();
  const base = { bank: ledgerBalance(before, bankId(before)), fee: ledgerBalance(before, feeId(before)) };
  const x = partialWriteOff(amountType, amount);
  let db = write(x.db, LINE, x.line, { move_id: x.invoice });
  db = button(db, x.line, 'Match');
  const line = read(db, LINE, x.line);
  assert.equal(line.state, 'reconciled');
  assert.equal(line.open_amount, 0);
  assert.equal(read(db, 'account.move', x.invoice).amount_residual, 0);
  assert.equal(round((line.allocations ?? []).reduce((sum, allocation) => sum + allocation.amount, 0)), 100);
  assert.equal((line.allocations ?? []).filter((a) => a.invoice_id).length, 1);
  balanced(db, `B4 ${amountType} matched`);
  assert.equal(round(ledgerBalance(db, bankId(db)) - base.bank), 100);
  assert.equal(round(ledgerBalance(db, feeId(db)) - base.fee), -amount);
});
