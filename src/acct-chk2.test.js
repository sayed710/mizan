import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { postPayment, printCheck, voidCheck } from './models/pay.js';
import { models } from './models/index.js';

test('check void confirmation, reprint numbering and statement reconciliation guard', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const line = bank.outbound_payment_method_line_ids.find((l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing');
  const made = create(db, 'account.payment', { payment_type: 'outbound', partner_type: 'supplier', partner_id: search(db, 'res.partner')[0].id, amount: 100, journal_id: bank.id, payment_method_line_id: line.id });
  db = postPayment(made.db, read(made.db, 'account.payment', made.id));
  db = printCheck(db, made.id);
  const payment = read(db, 'account.payment', made.id);
  const buttons = models['account.payment'].form.buttons;
  assert.ok(buttons.find((b) => b.label === 'Void Check').wizard);
  const reprint = buttons.find((b) => b.label === 'Reprint Check' && b.wizard);
  assert.ok(reprint.wizard(db, payment).fields.find((f) => f.name === 'next_check_number').default > payment.check_number);
  const voided = voidCheck(db, payment.id);
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, voided), { isAdmin: true }));
  const matched = { ...db, records: { ...db.records, 'account.bank.statement.line': [...(db.records['account.bank.statement.line'] ?? []), { id: 999999, state: 'reconciled', payment_id: payment.id }] } };
  assert.throws(() => voidCheck(matched, payment.id), /reconciled with a statement/);
  assert.throws(() => applyDiff(matched, diffDb(db, voided), { isAdmin: true }), /reconciled with a statement/);
});
