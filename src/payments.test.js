import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { isBalanced } from './models/ledger.js';
import { seed } from './seed.js';
import { postBatch, amountInWords } from './models/payments.js';

const button = (model, label) => models[model].form.buttons.find((b) => b.label === label);
const run = (db, model, id, label) => button(model, label).run(db, read(db, model, id)).db;

/** A posted invoice or vendor bill of 1000 + 14% VAT (1140 due); customer 3, vendor 7. */
const invoice = (db, move_type) => {
  const partner_id = move_type === 'in_invoice' ? 7 : 3;
  if (move_type === 'in_invoice' && !search(db, 'res.partner.bank').some((b) => b.partner_id === partner_id)) {
    db = create(db, 'res.partner.bank', { partner_id, account_number: 'TEST-VENDOR-BANK' }).db;
  }
  const { db: withMove, id } = create(db, 'account.move', { move_type, partner_id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, tax: 14 }] });
  return { db: run(withMove, 'account.move', id, 'Confirm'), id };
};

test('an inbound batch fills the open invoices and pays them all in full', () => {
  let db = seed();
  db = invoice(db, 'out_invoice').db;
  db = invoice(db, 'out_invoice').db;
  const open = () => search(db, 'account.move').filter((m) => m.state === 'posted' && m.move_type === 'out_invoice' && m.amount_residual > 0);
  const due = Math.round(open().reduce((s, m) => s + m.amount_residual, 0) * 100) / 100;
  const { db: withBatch, id } = create(db, 'account.batch.payment', { batch_type: 'inbound' });
  db = run(withBatch, 'account.batch.payment', id, 'Add Open Invoices');
  const filled = read(db, 'account.batch.payment', id);
  assert.deepEqual(filled.lines.map((l) => l.move_id).sort(), open().map((m) => m.id).sort());
  filled.lines.forEach((l) => assert.equal(l.amount, read(db, 'account.move', l.move_id).amount_residual));
  assert.equal(filled.amount_total, due);
  db = run(db, 'account.batch.payment', id, 'Validate');
  const batch = read(db, 'account.batch.payment', id);
  assert.equal(batch.state, 'posted');
  assert.equal(batch.name, 'BATCH-IN/00001');
  assert.equal(batch.amount_total, due);
  assert.ok(search(db, 'account.move').filter((m) => m.move_type === 'out_invoice').every((m) => m.state !== 'posted' || m.amount_residual === 0));
  assert.ok(search(db, 'account.move').filter((m) => m.state === 'posted' && (m.ref ?? '').startsWith('Payment ')).every((m) => isBalanced(m.line_ids)));
});

test('an outbound batch numbers checks from the first check number and prints', () => {
  let db = seed();
  const first = invoice(db, 'in_invoice');
  const second = invoice(first.db, 'in_invoice');
  db = second.db;
  const due = (id) => read(db, 'account.move', id).amount_residual;
  const { db: withBatch, id } = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    check_number_start: 5000,
    lines: [{ move_id: first.id, amount: due(first.id) }, { move_id: second.id, amount: due(second.id) }],
  });
  db = run(withBatch, 'account.batch.payment', id, 'Validate');
  const batch = read(db, 'account.batch.payment', id);
  assert.equal(batch.state, 'posted');
  assert.equal(batch.name, 'BATCH-OUT/00001');
  assert.deepEqual(batch.lines.map((l) => l.check_number), [5000, 5001]);
  assert.ok(batch.lines.every((l) => read(db, 'account.move', l.move_id).amount_residual === 0));
  const printed = button('account.batch.payment', 'Print Checks').run(db, batch);
  assert.equal(printed.db, db);
  assert.equal(printed.go, '#/print/account.batch.payment/' + id);
});

test('a line that overpays its invoice is refused', () => {
  const { db, id } = invoice(seed(), 'out_invoice');
  const due = read(db, 'account.move', id).amount_residual;
  const { db: withBatch, id: batchId } = create(db, 'account.batch.payment', { batch_type: 'inbound', lines: [{ move_id: id, amount: due + 100 }] });
  assert.throws(() => postBatch(withBatch, read(withBatch, 'account.batch.payment', batchId)), /amount due/);
});

test('a vendor bill cannot be paid in an inbound batch', () => {
  const { db, id } = invoice(seed(), 'in_invoice');
  const due = read(db, 'account.move', id).amount_residual;
  const { db: withBatch, id: batchId } = create(db, 'account.batch.payment', { batch_type: 'inbound', lines: [{ move_id: id, amount: due }] });
  assert.throws(() => postBatch(withBatch, read(withBatch, 'account.batch.payment', batchId)), /customer invoice/);
});

test('an empty batch cannot be validated', () => {
  const db = seed();
  const { db: withBatch, id } = create(db, 'account.batch.payment', { batch_type: 'inbound' });
  assert.throws(() => postBatch(withBatch, read(withBatch, 'account.batch.payment', id)), /at least one/);
});

test('an outbound batch without a first check number is refused', () => {
  const { db, id } = invoice(seed(), 'in_invoice');
  const due = read(db, 'account.move', id).amount_residual;
  const { db: withBatch, id: batchId } = create(db, 'account.batch.payment', { batch_type: 'outbound', lines: [{ move_id: id, amount: due }] });
  assert.throws(() => postBatch(withBatch, read(withBatch, 'account.batch.payment', batchId)), /first check number/);
});

test('amountInWords writes cheque-style amounts up to 999,999,999.99', () => {
  assert.equal(amountInWords(0), 'Zero Dollars and 00/100');
  assert.equal(amountInWords(7), 'Seven Dollars and 00/100');
  assert.equal(amountInWords(15), 'Fifteen Dollars and 00/100');
  assert.equal(amountInWords(100), 'One Hundred Dollars and 00/100');
  assert.equal(amountInWords(1001.05), 'One Thousand One Dollars and 05/100');
  assert.equal(amountInWords(1234.5), 'One Thousand Two Hundred Thirty-Four Dollars and 50/100');
  assert.equal(amountInWords(999999999.99), 'Nine Hundred Ninety-Nine Million Nine Hundred Ninety-Nine Thousand Nine Hundred Ninety-Nine Dollars and 99/100');
  assert.throws(() => amountInWords(-1), /between 0/);
  assert.throws(() => amountInWords(1000000000), /between 0/);
});
