import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { payOrder, startSession } from './models/pos.js';

test('refund clears the tender accounts the sale posted to after the payment method accounts change', () => {
  const opened = startSession(seed()).db;
  const lines = [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }];
  const sale = payOrder(opened, { lines, method: 'cash' });
  const saleOrder = read(sale.db, 'pos.order', sale.id);
  const [recorded] = saleOrder.tender_accounts;
  const saleTender = read(sale.db, 'account.move', saleOrder.accounting_entries[1].move_id);
  assert.ok(saleTender.line_ids.some((l) => l.account_id === recorded.outstanding_account_id && l.debit === 100));
  assert.ok(saleTender.line_ids.some((l) => l.account_id === recorded.receivable_account_id && l.credit === 100));

  // Repoint the payment method to new outstanding and receivable accounts after the sale.
  const outstanding = create(sale.db, 'account.account', { name: 'New Outstanding', code: '101499', account_type: 'asset_current', company_id: 1 });
  const receivable = create(outstanding.db, 'account.account', { name: 'New POS Receivable', code: '121098', account_type: 'asset_receivable', company_id: 1 });
  const methodId = saleOrder.payment_ids[0].payment_method_id;
  const changed = write(receivable.db, 'pos.payment.method', methodId, { outstanding_account_id: outstanding.id, receivable_account_id: receivable.id });

  const refund = payOrder(changed, { lines: saleOrder.lines, method: 'cash', refund_of: saleOrder.id });
  const refundOrder = read(refund.db, 'pos.order', refund.id);
  const refundTender = read(refund.db, 'account.move', refundOrder.accounting_entries[1].move_id);
  const refundSale = read(refund.db, 'account.move', refundOrder.accounting_entries[0].move_id);

  assert.ok(refundTender.line_ids.some((l) => l.account_id === recorded.outstanding_account_id && l.credit === 100));
  assert.ok(refundTender.line_ids.some((l) => l.account_id === recorded.receivable_account_id && l.debit === 100));
  assert.ok(refundSale.line_ids.some((l) => l.account_id === recorded.receivable_account_id && l.credit === 100));
  const used = [...refundTender.line_ids, ...refundSale.line_ids].map((l) => l.account_id);
  assert.equal(used.includes(outstanding.id) || used.includes(receivable.id), false);
  assert.deepEqual(refundOrder.payment_ids.map((p) => Object.keys(p).sort()), [['amount', 'method', 'payment_method_id']]);
});
