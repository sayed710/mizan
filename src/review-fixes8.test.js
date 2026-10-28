// Regressions for review round 8 (valuation wiring, fiscal closing, timesheets).
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { accountId, invoiceLines, postEntry, profitAndLoss } from './models/ledger.js';
import { closeFiscalYear, reopenFiscalYear } from './models/closing.js';
import { adjustQuantity, receive } from './models/valuation.js';

test('the registered product model keeps costing method and valuation, so goods bills clear 110200', () => {
  assert.ok(models.product.fields.cost_method && models.product.fields.valuation && models.product.fields.is_published);
  assert.equal(models.product.defaults(1).valuation, 'real_time');
  const db = seed();
  const goods = search(db, 'product').find((p) => p.type === 'goods');
  const legacy = write(db, 'product', goods.id, { valuation: undefined });
  const lines = invoiceLines(legacy, { move_type: 'in_invoice', partner_id: 1, invoice_date: '2026-10-01', invoice_line_ids: [{ product_id: goods.id, qty: 1, price_unit: 10, tax: 0 }] });
  assert.ok(lines.some((l) => l.account_id === accountId(legacy, '110200') && Number(l.debit) === 10));
});

const year = (db, y) => create(db, 'account.fiscal.year', { name: `FY ${y}`, date_from: `${y}-01-01`, date_to: `${y}-12-31` });
const sale = (db, date, amount) => postEntry(db, { journal: 'MISC', date, lines: [{ account: '101401', debit: amount }, { account: '400000', credit: amount }] }).db;

test('closed years still report their result and reopening keeps the earlier lock', () => {
  let db = sale(sale(seed(), '2023-05-01', 500), '2024-05-01', 1000);
  const y23 = year(db, 2023);
  const y24 = year(y23.db, 2024);
  db = closeFiscalYear(closeFiscalYear(y24.db, y23.id), y24.id);
  const p23 = { from: '2023-01-01', to: '2023-12-31' };
  const p24 = { from: '2024-01-01', to: '2024-12-31' };
  assert.deepEqual([profitAndLoss(db, p23).revenue, profitAndLoss(db, p24).revenue], [500, 1000]);
  assert.equal(profitAndLoss(db, p24).net, 1000);
  assert.equal(db.settings.lock_date, '2024-12-31');
  const reopened = reopenFiscalYear(db, y24.id);
  assert.equal(reopened.settings.lock_date, '2023-12-31');
  assert.equal(profitAndLoss(reopened, p24).net, 1000);
});

test('Update Quantity and rentals keep stock valuation usable', () => {
  let db = seed();
  const goods = search(db, 'product').find((p) => p.type === 'goods');
  const update = models.product.form.buttons.find((b) => b.label === 'Update Quantity');
  const before = Number(read(db, 'product', goods.id).qty_available);
  globalThis.prompt = () => String(before + 2);
  try {
    db = update.run(db, read(db, 'product', goods.id)).db;
  } finally {
    delete globalThis.prompt;
  }
  assert.equal(read(db, 'product', goods.id).qty_available, before + 2);
  assert.doesNotThrow(() => receive(db, goods.id, 1, 10, { date: '2026-12-01' }));
  assert.equal(read(adjustQuantity(db, goods.id, 0), 'product', goods.id).qty_available, 0);
  const rental = create(db, 'sale.rental', { product_id: goods.id, partner_id: 1, qty: 2, state: 'reserved' });
  const pickup = models['sale.rental'].form.buttons.find((b) => b.label === 'Pickup');
  const picked = pickup.run(rental.db, read(rental.db, 'sale.rental', rental.id)).db;
  assert.equal(read(picked, 'product', goods.id).qty_rented, 2);
  assert.doesNotThrow(() => receive(picked, goods.id, 1, 10, { date: '2026-12-01' }));
});

test('posting a vendor bill refuses billing more than was received unless forced', async () => {
  const { postMove } = await import('./models/accounting.js');
  let db = seed();
  const goods = search(db, 'product').find((p) => p.type === 'goods');
  const po = create(db, 'purchase.order', { partner_id: 7, state: 'purchase', order_line: [{ product_id: goods.id, qty: 5, qty_delivered: 3, price_unit: 10, tax: 0 }] });
  const bill = (force) => create(po.db, 'account.move', { move_type: 'in_invoice', partner_id: 7, purchase_id: po.id, invoice_date: '2026-10-26', force_post: force, invoice_line_ids: [{ product_id: goods.id, qty: 5, price_unit: 10, tax: 0 }] });
  const strict = bill(false);
  assert.throws(() => postMove(strict.db, strict.id), /exceeds received/);
  const forced = bill(true);
  assert.equal(read(postMove(forced.db, forced.id), 'account.move', forced.id).state, 'posted');
});
