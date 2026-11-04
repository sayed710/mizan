import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { closeSession, payOrder, refundOrder, startSession } from './models/pos.js';
import { moveValued } from './models/valuation.js';
import { seed } from './seed.js';

const layers = (db, id) => (db.records['stock.valuation.layer'] ?? []).filter((l) => l.product_id === id);
const qty = (db, id) => (db.records['stock.quant'] ?? []).filter((q) => q.product_id === id).reduce((sum, q) => sum + q.quantity, 0);

for (const valuation of ['periodic', 'manual_periodic', 'real_time']) {
  test(`POS inherits ${valuation} category valuation for sale, refund, return, cancellation and close`, () => {
    let db = seed();
    const category = create(db, 'product.category', { name: valuation, property_valuation: valuation });
    const product = create(category.db, 'product', { name: valuation, type: 'goods', categ_id: category.id, cost: 20, sale_ok: true });
    db = product.db;
    assert.equal(read(db, 'product', product.id).valuation, null);
    db = moveValued(db, [{ product_id: product.id, qty: 5, unit_cost: 20 }], 1);
    const initial = layers(db, product.id).length;
    const config = (db.records['pos.config'] ?? [])[0];
    const preset = create(db, 'pos.preset', { name: 'Return', is_return: true, identification: 'none' });
    const salePreset = create(preset.db, 'pos.preset', { name: 'Sale', identification: 'none' });
    db = write(salePreset.db, 'pos.config', config.id, { available_preset_ids: [preset.id, salePreset.id], default_preset_id: salePreset.id });
    const session = startSession(db, 0, config.id); db = session.db;
    const sale = payOrder(db, { lines: [{ product_id: product.id, qty: 2, price_unit: 50, tax: 0 }], method: 'cash' });
    assert.equal(qty(sale.db, product.id), 3);
    assert.equal(layers(sale.db, product.id).length, initial + (valuation === 'real_time' ? 1 : 0));
    const refund = refundOrder(sale.db, read(sale.db, 'pos.order', sale.id));
    assert.equal(qty(refund.db, product.id), 5);
    assert.equal(layers(refund.db, product.id).length, initial + (valuation === 'real_time' ? 2 : 0));
    const returned = payOrder(refund.db, { lines: [{ product_id: product.id, qty: -2, price_unit: 50, tax: 0 }], method: 'cash', preset_id: preset.id });
    assert.equal(qty(returned.db, product.id), 7);
    assert.equal(layers(returned.db, product.id).length, initial + (valuation === 'real_time' ? 3 : 0));
    const cancelled = refundOrder(returned.db, read(returned.db, 'pos.order', returned.id));
    assert.equal(qty(cancelled.db, product.id), 5);
    assert.equal(layers(cancelled.db, product.id).length, initial + (valuation === 'real_time' ? 4 : 0));
    const closed = closeSession(cancelled.db, read(cancelled.db, 'pos.session', session.id), 0);
    assert.equal(layers(closed, product.id).length, initial + (valuation === 'real_time' ? 4 : 0));
  });
}
