import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { models } from './models/index.js';
import { applyDiff } from './sync.js';
import { accountId, invoiceLines, isBalanced, postEntry } from './models/ledger.js';
import { seed } from './seed.js';

const confirm = (db, id) => models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.move', id)).db;

test('a negative bucket on an invoice moves to the other side instead of a negative amount', () => {
  const db = seed();
  const other = accountId(db, '450000');
  const lines = invoiceLines(db, { move_type: 'out_invoice', partner_id: 3, invoice_line_ids: [
    { product_id: 1, qty: 1, price_unit: 100, tax: 0 },
    { product_id: 1, qty: 1, price_unit: -150, tax: 0, account_id: other },
    { product_id: 1, qty: 1, price_unit: 200, tax: 0 },
  ] });
  assert.ok(isBalanced(lines));
  assert.ok(lines.every((l) => l.debit >= 0 && l.credit >= 0));
  assert.equal(lines.find((l) => l.account_id === other).debit, 150);
});

test('an invoice or bill with a total of zero or less cannot be confirmed', () => {
  for (const move_type of ['out_invoice', 'in_invoice']) {
    const { db, id } = create(seed(), 'account.move', { move_type, partner_id: 3, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: -114, tax: 0 }] });
    assert.throws(() => confirm(db, id), /total must be positive/);
    assert.equal(read(db, 'account.move', id).payment_state, 'not_paid');
  }
});

test('journal entries never post negative debits or credits', () => {
  const db = seed();
  const { db: next, id } = create(db, 'account.move', { move_type: 'entry', line_ids: [
    { account_id: accountId(db, '101401'), debit: -50, credit: 0 }, { account_id: accountId(db, '400000'), debit: 0, credit: -50 },
  ] });
  assert.throws(() => confirm(next, id), /cannot be negative/);
  const posted = postEntry(db, { journal: 'MISC', lines: [{ account: '101401', debit: -20 }, { account: '400000', credit: -20 }] });
  assert.deepEqual(read(posted.db, 'account.move', posted.id).line_ids.map((l) => [l.debit, l.credit]), [[0, 20], [20, 0]]);
  const forged = { ...read(next, 'account.move', id), state: 'posted', name: 'MISC/FORGED' };
  assert.throws(() => applyDiff(next, { upserts: { 'account.move': [forged] } }), /cannot be negative/);
});
