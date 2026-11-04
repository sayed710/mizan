import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { cancelOrder } from './models/sales.js';
import { postMove } from './models/accounting.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label && (b.when?.(read(db, model, id)) ?? true)).run(db, read(db, model, id)).db;

const confirmedSale = () => {
  const { db, id } = create(seed(), 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 2, price_unit: 100, tax: 0 }] });
  return { db: run(db, 'sale.order', id, 'Confirm'), id };
};

test('a confirmed sales order cancels with its open delivery and draft invoice (FLOW-017)', () => {
  const { db, id } = confirmedSale();
  const invoiced = run(db, 'sale.order', id, 'Create Invoice');
  const cancelled = run(invoiced, 'sale.order', id, 'Cancel');
  assert.equal(read(cancelled, 'sale.order', id).state, 'cancel');
  assert.deepEqual(search(cancelled, 'stock.picking').filter((p) => p.sale_id === id).map((p) => p.state), ['cancel']);
  assert.deepEqual(search(cancelled, 'account.move').filter((m) => m.sale_id === id).map((m) => m.state), ['cancel']);
});

test('delivered goods and posted invoices must be returned or credited before cancelling', () => {
  const { db, id } = confirmedSale();
  const picking = search(db, 'stock.picking').find((p) => p.sale_id === id);
  const delivered = run(db, 'stock.picking', picking.id, 'Validate');
  assert.throws(() => run(delivered, 'sale.order', id, 'Cancel'), /Return the delivered goods/);

  const invoiced = run(db, 'sale.order', id, 'Create Invoice');
  const inv = search(invoiced, 'account.move').find((m) => m.sale_id === id);
  const posted = run(invoiced, 'account.move', inv.id, 'Confirm');
  assert.throws(() => run(posted, 'sale.order', id, 'Cancel'), /credit note/);
  const credited = run(posted, 'account.move', inv.id, 'Credit Note');
  const refund = search(credited, 'account.move').find((m) => m.move_type === 'out_refund' && m.invoice_origin === read(posted, 'account.move', inv.id).name);
  const refunded = refund.state === 'posted' ? credited : run(credited, 'account.move', refund.id, 'Confirm');
  assert.equal(read(run(refunded, 'sale.order', id, 'Cancel'), 'sale.order', id).state, 'cancel');
});

test('a confirmed purchase order cancels with its open receipt', () => {
  const { db: db0, id } = create(seed(), 'purchase.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 3, price_unit: 40, tax: 0 }] });
  const confirmed = run(db0, 'purchase.order', id, 'Confirm Order');
  const cancelled = run(confirmed, 'purchase.order', id, 'Cancel');
  assert.equal(read(cancelled, 'purchase.order', id).state, 'cancel');
  assert.deepEqual(search(cancelled, 'stock.picking').filter((p) => p.purchase_id === id).map((p) => p.state), ['cancel']);
  const receipt = search(confirmed, 'stock.picking').find((p) => p.purchase_id === id);
  const received = run(confirmed, 'stock.picking', receipt.id, 'Validate');
  assert.throws(() => run(received, 'purchase.order', id, 'Cancel'), /Return the received goods/);
});

const postedDocument = (db, vals) => {
  const made = create(db, 'account.move', { partner_id: 3, move_type: 'out_invoice', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }], ...vals });
  return { db: postMove(made.db, made.id), id: made.id };
};

test('cancellation requires each invoice to have its own matching credit', () => {
  const sale = confirmedSale();
  const a = postedDocument(sale.db, { name: 'INV/CANCEL/A', sale_id: sale.id });
  const b = postedDocument(a.db, { name: 'INV/CANCEL/B', sale_id: sale.id });
  const refund = postedDocument(b.db, { name: 'CN/CANCEL/A', move_type: 'out_refund', invoice_origin: 'INV/CANCEL/A', invoice_line_ids: [{ qty: 1, price_unit: 200, tax: 0 }] });
  assert.throws(() => cancelOrder(refund.db, 'sale.order', read(refund.db, 'sale.order', sale.id)), /credit note/);
});

test('credits in a different currency cannot cover an invoice during cancellation', () => {
  const sale = confirmedSale();
  const currencies = search(sale.db, 'res.currency');
  const a = postedDocument(sale.db, { name: 'INV/CANCEL/FX', sale_id: sale.id, currency_id: currencies[0].id });
  const refund = postedDocument(a.db, { move_type: 'out_refund', invoice_origin: 'INV/CANCEL/FX', currency_id: currencies[1].id });
  assert.throws(() => cancelOrder(refund.db, 'sale.order', read(refund.db, 'sale.order', sale.id)), /credit note/);
});

test('origin-matched vendor bills must be credited before cancelling their purchase', () => {
  const po = create(seed(), 'purchase.order', { partner_id: 3, state: 'purchase', name: 'PO/CANCEL/ORIGIN', order_line: [] });
  const bill = postedDocument(po.db, { move_type: 'in_invoice', invoice_origin: 'PO/CANCEL/ORIGIN', force_post: true });
  assert.throws(() => cancelOrder(bill.db, 'purchase.order', read(bill.db, 'purchase.order', po.id)), /refund/);
});

test('delivered services can be cancelled without inventing a physical stock return', () => {
  const product = create(seed(), 'product', { name: 'Delivered service', type: 'service' });
  const sale = create(product.db, 'sale.order', { partner_id: 3, state: 'sale', order_line: [{ product_id: product.id, qty: 2, qty_delivered: 2, price_unit: 100, tax: 0 }] });
  const next = cancelOrder(sale.db, 'sale.order', read(sale.db, 'sale.order', sale.id));
  assert.equal(read(next, 'sale.order', sale.id).state, 'cancel');
  assert.equal(read(next, 'sale.order', sale.id).order_line[0].qty_delivered, 2, 'retain the actual service history');
});

test('cancelling confirmed orders restores consumed gift, loyalty and coupon balances exactly once', () => {
  for (const type of ['gift_card', 'loyalty', 'coupons']) {
    const program = create(seed(), 'loyalty.program', { name: 'Cancellation rewards', program_type: type });
    const card = create(program.db, 'loyalty.card', { program_id: program.id, code: `CANCEL-${type}`, partner_id: 3, points: 80, state: 'active' });
    const sale = create(card.db, 'sale.order', { partner_id: 3, order_line: [{ product_id: 7, qty: 1, price_unit: 100, tax: 0 }], loyalty_uses: [{ programId: program.id, cardCode: `CANCEL-${type}`, spent: 30, gift: type === 'gift_card' }] });
    const confirmed = run(sale.db, 'sale.order', sale.id, 'Confirm');
    const cancelled = cancelOrder(confirmed, 'sale.order', read(confirmed, 'sale.order', sale.id));
    assert.equal(read(cancelled, 'loyalty.card', card.id).points, 80, type);
    assert.equal(read(cancelled, 'loyalty.card', card.id).state, 'active', type);
    assert.equal(read(cancelled, 'loyalty.program', program.id).usage_count, read(card.db, 'loyalty.program', program.id).usage_count, type);
    assert.equal(cancelOrder(cancelled, 'sale.order', read(cancelled, 'sale.order', sale.id)), cancelled);
  }
});
