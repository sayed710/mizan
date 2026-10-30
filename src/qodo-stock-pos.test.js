import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { create, read, write } from './orm.js';
import { startSession, payOrder, priceLines } from './models/pos.js';
import { runPosting } from '../server/posting.js';
import { runOperation } from './operations.js';
import { freeQty, pickingAvailability, validatePicking } from './models/picking.js';
import { confirmMo, produce } from './models/more.js';
import { countProduct } from './models/valuation.js';

const session = () => startSession(seed()).db;

test('both POS payment endpoints reject invalid cart quantities and discounts', () => {
  const db = session();
  for (const values of [{ qty: -1 }, { qty: 0 }, { qty: Infinity }, { discount: -1 }, { discount: 101 }, { discount: Infinity }, { discount: 'invalid' }]) {
    const line = { product_id: 1, qty: 1, discount: 0, ...values };
    assert.throws(() => runPosting(db, null, '/api/pos/pay', { method: 'cash', lines: [line] }), /quantity|discount/i, JSON.stringify(values));
    assert.throws(() => runOperation(db, 'pos.pay', { method: 'cash', cart: [line] }), /quantity|discount/i, JSON.stringify(values));
  }
});

test('a free POS order still processes stock without an empty sale entry', () => {
  const db = write(session(), 'product', 1, { valuation: 'manual_periodic' });
  const before = read(db, 'product', 1).qty_available;
  const out = payOrder(db, { lines: priceLines(db, [{ product_id: 1, qty: 1, discount: 100 }]), method: 'cash' });
  assert.equal(read(out.db, 'pos.order', out.id).amount_total, 0);
  assert.equal(read(out.db, 'product', 1).qty_available, before - 1);
  assert.ok(!out.db.records['account.move'].some((m) => m.ref === read(out.db, 'pos.order', out.id).name));
});

test('partial POS refunds are explicitly rejected before stock or money is reversed', () => {
  const db = session();
  const lines = priceLines(db, [{ product_id: 1, qty: 2 }]);
  const sale = payOrder(db, { lines, method: 'cash' });
  assert.throws(() => payOrder(sale.db, { lines: [{ ...lines[0], qty: 1 }], method: 'cash', refund_of: sale.id }), /full.*refund|partial refund/i);
});

test('POS refuses to post when the receivable counterpart cannot be resolved', () => {
  const db = session();
  const broken = { ...db, records: { ...db.records, 'account.account': db.records['account.account'].filter((a) => a.code !== '121000') } };
  assert.throws(() => payOrder(broken, { lines: priceLines(broken, [{ product_id: 1, qty: 1 }]), method: 'cash' }), /receivable|counterpart/i);
});

const stock = () => create(seed(), 'product', { name: 'Qodo stock', type: 'goods', qty_available: 10, cost: 5 });

test('delivery availability aggregates duplicate product demands', () => {
  const p = stock();
  const picking = { picking_type: 'outgoing', move_ids: [{ product_id: p.id, qty: 6 }, { product_id: p.id, qty: 6 }] };
  assert.equal(pickingAvailability(p.db, picking), 'partial');
});

test('delivery validation aggregates duplicate done quantities before consuming stock', () => {
  const p = stock();
  const picking = create(p.db, 'stock.picking', { picking_type: 'outgoing', state: 'waiting', move_ids: [{ product_id: p.id, qty: 6 }, { product_id: p.id, qty: 6 }] });
  assert.throws(() => validatePicking(picking.db, read(picking.db, 'stock.picking', picking.id), { apply: () => { throw new Error('must not consume stock'); } }), /reserved for other operations/);
});

function manufacturing() {
  const p = stock();
  const finished = create(p.db, 'product', { name: 'Qodo finished', type: 'goods', qty_available: 0, cost: 10 });
  const bom = create(finished.db, 'mrp.bom', { name: 'Qodo BoM', product_id: finished.id, product_qty: 1, components: [{ product_id: p.id, qty: 1 }] });
  const first = create(bom.db, 'mrp.production', { product_id: finished.id, bom_id: bom.id, product_qty: 8 });
  const ready = confirmMo(first.db, read(first.db, 'mrp.production', first.id));
  return { db: ready, productId: p.id, bomId: bom.id, finishedId: finished.id, moId: first.id };
}

test('starting manufacturing keeps its available component reservation', () => {
  const m = manufacturing();
  const started = write(m.db, 'mrp.production', m.moId, { state: 'progress' });
  assert.equal(freeQty(started, m.productId), 2);
});

test('waiting manufacturing cannot consume components reserved by another order', () => {
  const m = manufacturing();
  const second = create(m.db, 'mrp.production', { product_id: m.finishedId, bom_id: m.bomId, product_qty: 5 });
  const waiting = confirmMo(second.db, read(second.db, 'mrp.production', second.id));
  assert.equal(read(waiting, 'mrp.production', second.id).components_availability, 'waiting');
  assert.throws(() => produce(waiting, read(waiting, 'mrp.production', second.id)), /Not enough.*stock/);
});

test('counting shared stock in another company does not duplicate opening layers', () => {
  const p = stock();
  const company = createCompany(p.db, { name: 'Company two' });
  const first = countProduct(company.db, { productId: p.id, counted: 11, observed: 10, company: 1 });
  const second = countProduct(first, { productId: p.id, counted: 12, observed: 11, company: company.id });
  const layers = second.records['stock.valuation.layer'].filter((l) => l.product_id === p.id);
  assert.equal(layers.filter((l) => l.opening).length, 1);
  assert.equal(layers.reduce((s, l) => s + l.quantity, 0), 12);
});
