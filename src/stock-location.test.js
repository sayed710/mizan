import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { defaultStockLocationId } from './models/stock-location.js';
import { ensureQuants } from './models/quant.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('default stock lookup is read-only, company-scoped and preserves missing warehouse handling', () => {
  const company = createCompany(seed(), { name: 'Branch' });
  let db = company.db;
  let other, stock, warehouse;
  ({ db, id: other } = create(db, 'stock.location', { name: 'Other company', usage: 'internal', company_id: company.id }));
  ({ db, id: stock } = create(db, 'stock.location', { name: 'Chosen stock', usage: 'internal', company_id: 1 }));
  warehouse = db.records['stock.warehouse'].find((w) => (w.company_id ?? 1) === 1 && w.lot_stock_id).id;
  db = write(db, 'stock.warehouse', warehouse, { lot_stock_id: stock });
  const before = structuredClone(db);
  assert.equal(defaultStockLocationId(db, 1), stock);
  assert.equal(defaultStockLocationId(db, 2), other);
  assert.equal(defaultStockLocationId(db, 999), undefined);
  assert.deepEqual(db, before);
  const broken = { ...db, records: { ...db.records, 'stock.warehouse': db.records['stock.warehouse'].map((w) => w.id === warehouse ? { ...w, lot_stock_id: 999999 } : w) } };
  assert.equal(defaultStockLocationId(broken, 1), 999999);
  assert.equal(defaultStockLocationId(broken, 1, { requireExisting: true }), db.records['stock.location'].find((l) => l.usage === 'internal' && (l.company_id ?? 1) === 1).id);
});

test('warehouse default is shared by stock initialization, reservation and scrap actions', () => {
  let db = seed();
  let stock, product, warehouse, picking, scrap;
  ({ db, id: stock } = create(db, 'stock.location', { name: 'Chosen warehouse stock', usage: 'internal', company_id: 1 }));
  warehouse = db.records['stock.warehouse'].find((w) => (w.company_id ?? 1) === 1 && w.lot_stock_id).id;
  db = write(db, 'stock.warehouse', warehouse, { lot_stock_id: stock });
  ({ db, id: product } = create(db, 'product', { name: 'Default location item', type: 'goods', qty_available: 5, cost: 10 }));
  db = ensureQuants(db, [product]);
  assert.equal(search(db, 'stock.quant').find((q) => q.product_id === product).location_id, stock);
  ({ db, id: picking } = create(db, 'stock.picking', { picking_type: 'outgoing', state: 'draft', move_ids: [{ product_id: product, qty: 2 }] }));
  db = run(db, 'stock.picking', picking, 'Mark as Todo');
  assert.equal(read(db, 'stock.picking', picking).state, 'ready');
  ({ db, id: scrap } = create(db, 'stock.scrap', { product_id: product, scrap_qty: 1 }));
  db = run(db, 'stock.scrap', scrap, 'Validate');
  assert.equal(read(db, 'stock.picking', read(db, 'stock.scrap', scrap).scrap_picking_id).location_id, stock);
  assert.equal(search(db, 'stock.quant').find((q) => q.product_id === product).quantity, 4);
});
