import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { payCart, refundOrder, startSession } from './models/pos.js';
import { isBalanced } from './models/ledger.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';

for (const reverseCharge of [false, true]) {
  test(`POS refund uses captured refund tax repartition${reverseCharge ? ' for reverse charge' : ''}`, () => {
    let db = startSession(seed(), 0).db;
    const accounts = search(db, 'account.account').filter((a) => !a.company_id || a.company_id === 1);
    const [invoiceAccount, refundAccount, otherAccount, otherRefundAccount] = accounts.slice(0, 4);
    const tags = [];
    for (let i = 0; i < 4; i++) {
      const tag = create(db, 'account.account.tag', { name: `Refund test ${i}`, applicability: 'taxes' });
      db = tag.db; tags.push(tag.id);
    }
    const rows = defaultTaxRepartitionLines(invoiceAccount.id, [tags[0]]);
    rows.refund_repartition_line_ids[1] = { repartition_type: 'tax', factor_percent: 100, account_id: refundAccount.id, tag_ids: [tags[1]] };
    if (reverseCharge) {
      rows.invoice_repartition_line_ids.push({ repartition_type: 'tax', factor_percent: -100, account_id: otherAccount.id, tag_ids: [tags[2]] });
      rows.refund_repartition_line_ids.push({ repartition_type: 'tax', factor_percent: -100, account_id: otherRefundAccount.id, tag_ids: [tags[3]] });
    }
    const tax = create(db, 'account.tax', { name: 'Refund repartition test', type_tax_use: 'sale', amount: 10, amount_type: 'percent', ...rows });
    db = write(tax.db, 'product', 1, { list_price: 100, tax_id: tax.id });
    const sale = payCart(db, { cart: [{ product_id: 1, qty: 1 }], method: 'cash' });
    const order = read(sale.db, 'pos.order', sale.id);
    const originals = order.accounting_entries.map(({ move_id }) => structuredClone(read(sale.db, 'account.move', move_id)));
    db = write(sale.db, 'account.tax', tax.id, { refund_repartition_line_ids: rows.invoice_repartition_line_ids });
    const refund = refundOrder(db, read(db, 'pos.order', sale.id));
    const entry = read(refund.db, 'account.move', read(refund.db, 'pos.order', refund.id).accounting_entries[0].move_id);
    const taxLine = entry.line_ids.find((line) => line.tax_id === tax.id && line.account_id === refundAccount.id);
    assert.ok(taxLine);
    assert.deepEqual(taxLine.tax_tag_ids, [tags[1]]);
    assert.equal(taxLine.debit, 10);
    if (reverseCharge) {
      const negative = entry.line_ids.find((line) => line.tax_id === tax.id && line.account_id === otherRefundAccount.id);
      assert.equal(negative.credit, 10);
      assert.deepEqual(negative.tax_tag_ids, [tags[3]]);
    }
    assert.ok(isBalanced(entry.line_ids));
    for (const original of originals) assert.deepEqual(read(refund.db, 'account.move', original.id), original);
  });
}

test('POS refund refuses a historical tax snapshot without refund rows', () => {
  let db = startSession(seed(), 0).db;
  const account = search(db, 'account.account')[0];
  const tax = create(db, 'account.tax', { name: 'Historical tax', type_tax_use: 'sale', amount: 10, amount_type: 'percent', ...defaultTaxRepartitionLines(account.id) });
  db = write(tax.db, 'product', 1, { list_price: 100, tax_id: tax.id });
  const sale = payCart(db, { cart: [{ product_id: 1, qty: 1 }], method: 'cash' });
  const order = read(sale.db, 'pos.order', sale.id);
  db = write(sale.db, 'pos.order', sale.id, { lines: order.lines.map(({ refund_repartition_line_ids: _rows, ...line }) => line) });
  const before = structuredClone(db);
  assert.throws(() => refundOrder(db, read(db, 'pos.order', sale.id)), /missing.*refund tax/i);
  assert.deepEqual(db, before);
});

test('POS refund rejects incompatible refund factors before changing the order', () => {
  let db = startSession(seed(), 0).db;
  const account = search(db, 'account.account')[0];
  const rows = defaultTaxRepartitionLines(account.id);
  rows.invoice_repartition_line_ids.push({ repartition_type: 'tax', factor_percent: -100, account_id: account.id, tag_ids: [] });
  const tax = create(db, 'account.tax', { name: 'Different factors', type_tax_use: 'sale', amount: 10, amount_type: 'percent', ...rows });
  db = write(tax.db, 'product', 1, { list_price: 100, tax_id: tax.id });
  const sale = payCart(db, { cart: [{ product_id: 1, qty: 1 }], method: 'cash' });
  const before = structuredClone(sale.db);
  assert.throws(() => refundOrder(sale.db, read(sale.db, 'pos.order', sale.id)), /refund.*tax.*(differ|match|incompatible)/i);
  assert.deepEqual(sale.db, before);
});

test('POS refund with mirror tax rows swaps the original entry accounts and amounts', () => {
  const db = startSession(seed(), 0).db;
  const sale = payCart(db, { cart: [{ product_id: 1, qty: 1 }], method: 'cash' });
  const original = read(sale.db, 'pos.order', sale.id);
  const refund = refundOrder(sale.db, original);
  const reversal = read(refund.db, 'pos.order', refund.id);
  const items = (move) => move.line_ids.map(({ account_id, debit, credit }) => [account_id, debit, credit]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  for (let i = 0; i < original.accounting_entries.length; i++) {
    const before = read(sale.db, 'account.move', original.accounting_entries[i].move_id);
    const after = read(refund.db, 'account.move', reversal.accounting_entries[i].move_id);
    assert.deepEqual(items(after), items({ line_ids: before.line_ids.map((line) => ({ ...line, debit: line.credit, credit: line.debit })) }));
  }
});
