import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write, setActiveCompany } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { ensureMainWarehouse } from './models/warehouse.js';
import { orderpointModels, getOnHand, getForecast, computeQtyToOrder, orderOrderpoints, snoozeOrderpoint, automateOrderpoint } from './models/orderpoint.js';
import { replenish } from './models/routes.js';
import { runScheduledJobs } from './models/scheduler.js';
import { migrate } from './migrations.js';

// Register orderpoint models in case not yet registered
Object.assign(models, orderpointModels);

const setupBase = () => {
  let db = ensureMainWarehouse(seed());
  const wh = search(db, 'stock.warehouse').find((w) => w.code === 'WH');
  return { db, wh, stockLocId: wh.lot_stock_id };
};

test('forecast math calculates on-hand from location and children, plus incoming receipts and MOs minus outgoing deliveries', () => {
  const { db: base, wh, stockLocId } = setupBase();
  // Create a child location under WH/Stock
  const childRes = create(base, 'stock.location', { name: 'WH/Stock/Shelf 1', parent_id: stockLocId, usage: 'internal' });
  let db = childRes.db;
  const childLocId = childRes.id;

  // Create test product
  const prodRes = create(db, 'product', { name: 'Test Widget', type: 'goods', cost: 10, list_price: 20 });
  db = prodRes.db;
  const prodId = prodRes.id;

  // Add on-hand: 6 units at stockLocId and 4 units at childLocId = 10 on-hand total
  db = create(db, 'stock.quant', { product_id: prodId, location_id: stockLocId, quantity: 6, company_id: 1 }).db;
  db = create(db, 'stock.quant', { product_id: prodId, location_id: childLocId, quantity: 4, company_id: 1 }).db;

  // Create reordering rule at stockLocId
  const opRes = create(db, 'stock.warehouse.orderpoint', {
    product_id: prodId,
    warehouse_id: wh.id,
    location_id: stockLocId,
    product_min_qty: 15,
    product_max_qty: 30,
    trigger: 'auto',
    route_id: 'buy',
  });
  db = opRes.db;
  const opId = opRes.id;
  let op = read(db, 'stock.warehouse.orderpoint', opId);

  // Initial check: on-hand = 10, forecast = 10
  assert.equal(getOnHand(db, op), 10);
  assert.equal(getForecast(db, op), 10);

  // Add incoming confirmed receipt (state: 'ready', picking_type: 'incoming') for 5 units
  db = create(db, 'stock.picking', {
    picking_type: 'incoming',
    state: 'ready',
    warehouse_id: wh.id,
    location_dest_id: stockLocId,
    move_ids: [{ product_id: prodId, qty: 5 }],
  }).db;

  // Add incoming confirmed MO (state: 'confirmed') for 8 units
  db = create(db, 'mrp.production', {
    product_id: prodId,
    product_qty: 8,
    state: 'confirmed',
  }).db;

  // Add outgoing reserved delivery (state: 'ready', picking_type: 'outgoing') for 4 units
  db = create(db, 'stock.picking', {
    picking_type: 'outgoing',
    state: 'ready',
    warehouse_id: wh.id,
    location_id: stockLocId,
    move_ids: [{ product_id: prodId, qty: 4 }],
  }).db;

  // Add outgoing confirmed delivery waiting stock (state: 'waiting', picking_type: 'outgoing') for 2 units
  db = create(db, 'stock.picking', {
    picking_type: 'outgoing',
    state: 'waiting',
    warehouse_id: wh.id,
    location_id: stockLocId,
    move_ids: [{ product_id: prodId, qty: 2 }],
  }).db;

  op = read(db, 'stock.warehouse.orderpoint', opId);
  assert.equal(getOnHand(db, op), 10);
  // Forecast = 10 (on hand) + 5 (receipt) + 8 (MO) - 4 (delivery ready) - 2 (delivery waiting) = 17
  assert.equal(getForecast(db, op), 17);
});

test('ordering brings forecast to max, rounding up to vendor minimum and packaging, and manual qty overrides', () => {
  const { db: base, wh, stockLocId } = setupBase();
  const vendor = search(base, 'res.partner').find((p) => p.is_company) ?? { id: 2 };

  // Product with forecast = 5, min = 20, max = 50
  const prodRes = create(base, 'product', { name: 'Gadget', type: 'goods', cost: 10, vendor_id: vendor.id });
  let db = prodRes.db;
  const prodId = prodRes.id;
  db = create(db, 'stock.quant', { product_id: prodId, location_id: stockLocId, quantity: 5, company_id: 1 }).db;

  const opRes = create(db, 'stock.warehouse.orderpoint', {
    product_id: prodId,
    warehouse_id: wh.id,
    location_id: stockLocId,
    product_min_qty: 20,
    product_max_qty: 50,
    trigger: 'auto',
    route_id: 'buy',
  });
  db = opRes.db;
  let op = read(db, 'stock.warehouse.orderpoint', opRes.id);

  // Without vendor min or packaging: target 50 - 5 = 45
  assert.equal(computeQtyToOrder(db, op), 45);

  // With vendor minimum quantity of 60
  db = create(db, 'product.supplierinfo', { partner_id: vendor.id, product_id: prodId, min_qty: 60, price: 9 }).db;
  op = read(db, 'stock.warehouse.orderpoint', opRes.id);
  assert.equal(computeQtyToOrder(db, op), 60);

  // With packaging of 24 units: 60 rounded up to next multiple of 24 is 72 (3 * 24)
  db = create(db, 'product.packaging', { name: 'Box of 24', product_id: prodId, qty: 24 }).db;
  op = read(db, 'stock.warehouse.orderpoint', opRes.id);
  assert.equal(computeQtyToOrder(db, op), 72);

  // Manual override: qty_to_order_manual set to 15 overrides computed
  db = write(db, 'stock.warehouse.orderpoint', op.id, { qty_to_order_manual: 15 });
  op = read(db, 'stock.warehouse.orderpoint', op.id);
  assert.equal(op.qty_to_order, 15);
});

test('Buy route creates a draft RFQ or extends/merges into an existing draft RFQ with supplierinfo pricing', () => {
  const { db: base, wh, stockLocId } = setupBase();
  const vendor = search(base, 'res.partner').find((p) => p.is_company) ?? { id: 2 };

  const p1 = create(base, 'product', { name: 'Component 1', type: 'goods', cost: 10, vendor_id: vendor.id });
  const p2 = create(p1.db, 'product', { name: 'Component 2', type: 'goods', cost: 20, vendor_id: vendor.id });
  let db = p2.db;

  // Supplierinfo for p1 with special price 8.5
  db = create(db, 'product.supplierinfo', { partner_id: vendor.id, product_id: p1.id, min_qty: 0, price: 8.5 }).db;

  const op1 = create(db, 'stock.warehouse.orderpoint', {
    product_id: p1.id, warehouse_id: wh.id, location_id: stockLocId,
    product_min_qty: 10, product_max_qty: 25, trigger: 'manual', route_id: 'buy',
  });
  const op2 = create(op1.db, 'stock.warehouse.orderpoint', {
    product_id: p2.id, warehouse_id: wh.id, location_id: stockLocId,
    product_min_qty: 5, product_max_qty: 15, trigger: 'manual', route_id: 'buy',
  });
  db = op2.db;

  // Replenish op1: creates a draft RFQ
  db = orderOrderpoints(db, [op1.id]);
  const rfqs = search(db, 'purchase.order').filter((p) => p.origin === 'Replenishment' && p.partner_id === vendor.id);
  assert.equal(rfqs.length, 1);
  const rfq = rfqs[0];
  assert.equal(rfq.state, 'draft');
  assert.equal(rfq.order_line.length, 1);
  assert.equal(rfq.order_line[0].product_id, p1.id);
  assert.equal(rfq.order_line[0].qty, 25);
  assert.equal(rfq.order_line[0].price_unit, 8.5);

  // Replenish op2: extends/merges into the existing draft RFQ for the same vendor
  db = orderOrderpoints(db, [op2.id]);
  const rfqsAfter = search(db, 'purchase.order').filter((p) => p.origin === 'Replenishment' && p.partner_id === vendor.id);
  assert.equal(rfqsAfter.length, 1);
  const updatedRfq = rfqsAfter[0];
  assert.equal(updatedRfq.order_line.length, 2);
  const line2 = updatedRfq.order_line.find((l) => l.product_id === p2.id);
  assert.ok(line2);
  assert.equal(line2.qty, 15);
  assert.equal(line2.price_unit, 20); // fall back to p2.cost
});

test('Manufacture route creates a draft manufacturing order from BoM', () => {
  const { db: base, wh, stockLocId } = setupBase();
  const raw = create(base, 'product', { name: 'Wood Planks', type: 'goods', cost: 5, qty_available: 50 });
  const table = create(raw.db, 'product', { name: 'Wood Table', type: 'goods', cost: 50, route: 'mto_make' });
  const bom = create(table.db, 'mrp.bom', { name: 'Table BoM', product_id: table.id, product_qty: 1, components: [{ product_id: raw.id, qty: 4 }] });
  let db = bom.db;

  const op = create(db, 'stock.warehouse.orderpoint', {
    product_id: table.id, warehouse_id: wh.id, location_id: stockLocId,
    product_min_qty: 5, product_max_qty: 12, trigger: 'manual', route_id: 'manufacture',
  });
  db = op.db;

  db = orderOrderpoints(db, [op.id]);
  const mos = search(db, 'mrp.production').filter((m) => m.origin === 'Replenishment' && m.product_id === table.id);
  assert.equal(mos.length, 1);
  const mo = mos[0];
  assert.equal(mo.state, 'draft');
  assert.equal(mo.bom_id, bom.id);
  assert.equal(mo.product_qty, 12);
});

test('scheduler runs auto trigger automatically and ignores manual trigger', () => {
  const { db: base, wh, stockLocId } = setupBase();
  const vendor = search(base, 'res.partner').find((p) => p.is_company) ?? { id: 2 };

  const pAuto = create(base, 'product', { name: 'Auto Prod', type: 'goods', cost: 10, vendor_id: vendor.id });
  const pManual = create(pAuto.db, 'product', { name: 'Manual Prod', type: 'goods', cost: 10, vendor_id: vendor.id });
  let db = pManual.db;

  const opAuto = create(db, 'stock.warehouse.orderpoint', {
    product_id: pAuto.id, warehouse_id: wh.id, location_id: stockLocId,
    product_min_qty: 10, product_max_qty: 20, trigger: 'auto', route_id: 'buy',
  });
  const opManual = create(opAuto.db, 'stock.warehouse.orderpoint', {
    product_id: pManual.id, warehouse_id: wh.id, location_id: stockLocId,
    product_min_qty: 10, product_max_qty: 20, trigger: 'manual', route_id: 'buy',
  });
  db = opManual.db;

  // Run scheduled jobs
  db = runScheduledJobs(db);

  // Auto product has draft RFQ line
  const rfqs = search(db, 'purchase.order').filter((p) => p.origin === 'Replenishment');
  const lines = rfqs.flatMap((p) => p.order_line ?? []);
  assert.ok(lines.some((l) => l.product_id === pAuto.id && l.qty === 20));
  // Manual product was NOT ordered by scheduler
  assert.ok(!lines.some((l) => l.product_id === pManual.id));
});

test('snooze delays rule until snoozed_until date, and automate switches to auto', () => {
  const { db: base, wh, stockLocId } = setupBase();
  const vendor = search(base, 'res.partner').find((p) => p.is_company) ?? { id: 2 };
  const prod = create(base, 'product', { name: 'Snooze Prod', type: 'goods', cost: 10, vendor_id: vendor.id });
  let db = prod.db;

  const op = create(db, 'stock.warehouse.orderpoint', {
    product_id: prod.id, warehouse_id: wh.id, location_id: stockLocId,
    product_min_qty: 10, product_max_qty: 20, trigger: 'auto', route_id: 'buy',
  });
  db = op.db;

  // Snooze for 1 week from '2026-10-28' -> '2026-11-04'
  db = snoozeOrderpoint(db, [op.id], '1_week', '2026-10-28');
  assert.equal(read(db, 'stock.warehouse.orderpoint', op.id).snoozed_until, '2026-11-04');

  // Scheduler on 2026-10-30 does not trigger snoozed rule
  let dbScheduled = runScheduledJobs(db, '2026-10-30');
  let rfqs = search(dbScheduled, 'purchase.order').filter((p) => p.origin === 'Replenishment');
  assert.ok(!rfqs.flatMap((p) => p.order_line ?? []).some((l) => l.product_id === prod.id));

  // Scheduler on 2026-11-05 (after snooze) triggers it
  dbScheduled = runScheduledJobs(db, '2026-11-05');
  rfqs = search(dbScheduled, 'purchase.order').filter((p) => p.origin === 'Replenishment');
  assert.ok(rfqs.flatMap((p) => p.order_line ?? []).some((l) => l.product_id === prod.id));

  // Automate switches manual to auto
  let dbManual = write(db, 'stock.warehouse.orderpoint', op.id, { trigger: 'manual' });
  assert.equal(read(dbManual, 'stock.warehouse.orderpoint', op.id).trigger, 'manual');
  dbManual = automateOrderpoint(dbManual, [op.id]);
  assert.equal(read(dbManual, 'stock.warehouse.orderpoint', op.id).trigger, 'auto');
});

test('migration converts legacy product reorder_min/reorder_max into orderpoints on main warehouse', () => {
  let db = ensureMainWarehouse(seed());
  const wh = search(db, 'stock.warehouse').find((w) => w.code === 'WH');
  // Create product with legacy reorder_min and max
  const p = create(db, 'product', { name: 'Legacy Widget', type: 'goods', cost: 10, reorder_min: 12, reorder_max: 30, vendor_id: 2 });
  db = p.db;

  const oldDb = { ...db, schema_version: 4, records: { ...db.records, 'stock.warehouse.orderpoint': [] } };
  const migrated = migrate(oldDb);

  const ops = search(migrated, 'stock.warehouse.orderpoint').filter((o) => o.product_id === p.id);
  assert.equal(ops.length, 1);
  const rule = ops[0];
  assert.equal(rule.location_id, wh.lot_stock_id);
  assert.equal(rule.product_min_qty, 12);
  assert.equal(rule.product_max_qty, 30);
  assert.equal(rule.trigger, 'auto');

  // replenish() continues working through orderpoints
  const afterReplenish = replenish(migrated);
  const rfq = search(afterReplenish, 'purchase.order').find((po) => po.origin === 'Replenishment' && po.partner_id === 2);
  assert.ok(rfq);
  assert.ok(rfq.order_line.some((l) => l.product_id === p.id && l.qty === 30));
});

test('company isolation ensures orderpoints and replenishment respect company boundaries', () => {
  let db = ensureMainWarehouse(seed());
  const wh = search(db, 'stock.warehouse').find((w) => w.code === 'WH');
  const vendor = search(db, 'res.partner').find((p) => p.is_company) ?? { id: 2 };

  // Create products in Company 1 and Company 2
  const p1 = create(db, 'product', { name: 'C1 Widget', type: 'goods', cost: 10, company_id: 1, vendor_id: vendor.id });
  const p2 = create(p1.db, 'product', { name: 'C2 Widget', type: 'goods', cost: 10, company_id: 2, vendor_id: vendor.id });
  db = p2.db;

  // Location and warehouse for Company 2
  const loc2 = create(db, 'stock.location', { name: 'C2 Stock', usage: 'internal', company_id: 2 });
  const wh2 = create(loc2.db, 'stock.warehouse', { name: 'C2 Warehouse', code: 'WH2', lot_stock_id: loc2.id, company_id: 2 });
  db = wh2.db;

  // Orderpoints in Company 1 and Company 2
  const op1 = create(db, 'stock.warehouse.orderpoint', {
    product_id: p1.id, warehouse_id: wh.id, location_id: wh.lot_stock_id,
    product_min_qty: 10, product_max_qty: 20, trigger: 'auto', route_id: 'buy', company_id: 1,
  });
  const op2 = create(op1.db, 'stock.warehouse.orderpoint', {
    product_id: p2.id, warehouse_id: wh2.id, location_id: loc2.id,
    product_min_qty: 10, product_max_qty: 20, trigger: 'auto', route_id: 'buy', company_id: 2,
  });
  db = op2.db;

  // Quants in Company 2 should not affect Company 1 orderpoint
  db = create(db, 'stock.quant', { product_id: p2.id, location_id: loc2.id, quantity: 15, company_id: 2 }).db;
  const ruleC1 = read(db, 'stock.warehouse.orderpoint', op1.id);
  assert.equal(getOnHand(db, ruleC1), 0);
  const ruleC2 = read(db, 'stock.warehouse.orderpoint', op2.id);
  assert.equal(getOnHand(db, ruleC2), 15);

  // Active company filtering
  setActiveCompany(1);
  try {
    const visible = search(db, 'stock.warehouse.orderpoint');
    assert.ok(visible.some((o) => o.id === op1.id));
    assert.ok(!visible.some((o) => o.id === op2.id));
  } finally {
    setActiveCompany(null);
  }
});
