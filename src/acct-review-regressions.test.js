import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { postMove, payMove } from './models/accounting.js';
import { postPayment, reversePayment } from './models/pay.js';
import { agedBalance } from './models/finance.js';
import { cashFlow } from './models/reports.js';

const line = (price, account_id) => ({ product_id: 5, qty: 1, price_unit: price, tax: 0, ...(account_id ? { account_id } : {}) });
const post = (db, vals) => { const m = create(db, 'account.move', vals); return { db: postMove(m.db, m.id), id: m.id }; };

test('aged balances include unapplied refunds and advances at dated cutoffs on both partner sides', () => {
  for (const [invoice, refund, kind, side, direction, partner] of [['out_invoice', 'out_refund', 'receivable', 'customer', 'inbound', 1], ['in_invoice', 'in_refund', 'payable', 'supplier', 'outbound', 2]]) {
    let db = seed();
    const inv = post(db, { move_type: invoice, partner_id: partner, invoice_date: '2026-01-01', invoice_date_due: '2026-01-01', invoice_line_ids: [line(100)] }); db = payMove(inv.db, inv.id, 60, '2026-01-10');
    const note = post(db, { move_type: refund, partner_id: partner, reversed_entry_id: inv.id, invoice_date: '2026-01-20', invoice_date_due: '2026-01-20', invoice_line_ids: [line(100)] }); db = note.db;
    const total = (date) => agedBalance(db, kind, date).rows.find((r) => r.partner_id === partner)?.total ?? 0;
    assert.equal(total('2026-01-15'), 40);
    assert.equal(total('2026-01-21'), -60);
    const advance = create(db, 'account.payment', { partner_id: partner, partner_type: side, payment_type: direction, amount: 25, date: '2026-01-25' });
    db = postPayment(advance.db, read(advance.db, 'account.payment', advance.id));
    assert.equal(total('2026-01-24'), -60);
    assert.equal(total('2026-01-26'), -85);
    db = reversePayment(db, read(db, 'account.payment', advance.id), '2026-01-30');
    assert.equal(total('2026-01-26'), -85);
    assert.equal(total('2026-01-30'), -60);
  }
});

test('cash flow attributes bill and invoice settlements to underlying mixed activities', () => {
  let db = seed(); const asset = accountId(db, '151000'); const expense = accountId(db, '600000');
  const bill = post(db, { move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-01-01', invoice_line_ids: [line(60, asset), line(40, expense)] }); db = bill.db;
  db = payMove(db, bill.id, 50, '2026-01-10');
  let flow = cashFlow(db, { from: '2026-01-10', to: '2026-01-10' });
  assert.equal(flow.investing, -30); assert.equal(flow.operating, -20);
  const payment = db.records['account.payment'].find((p) => p.invoice_id === bill.id);
  db = reversePayment(db, payment, '2026-01-15');
  flow = cashFlow(db, { from: '2026-01-15', to: '2026-01-15' });
  assert.equal(flow.investing, 30); assert.equal(flow.operating, 20);
  const assetBill = post(db, { move_type: 'in_invoice', partner_id: 2, invoice_date: '2026-01-16', invoice_line_ids: [line(80, asset)] }); db = payMove(assetBill.db, assetBill.id, 80, '2026-01-17');
  flow = cashFlow(db, { from: '2026-01-17', to: '2026-01-17' });
  assert.equal(flow.investing, -80); assert.equal(flow.operating, 0);
  const sale = post(db, { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-11', invoice_line_ids: [line(100, asset)] }); db = sale.db;
  db = payMove(db, sale.id, 100, '2026-01-12');
  flow = cashFlow(db, { from: '2026-01-12', to: '2026-01-12' });
  assert.equal(flow.investing, 100); assert.equal(flow.operating, 0);
});
