import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { salesModels } from './models/sales.js';
import { confirmBatch, validateBatch, packageContents } from './models/batch.js';

const validatePicking = salesModels['stock.picking'].form.buttons.find((b) => b.label === 'Validate');

test('batch confirm and validate moves stock identically to individual transfer validation', () => {
  let dbBatch = seed();
  let dbSingle = seed();

  let p1;
  let p2;
  ({ db: dbBatch, id: p1 } = create(dbBatch, 'stock.picking', {
    picking_type: 'outgoing',
    state: 'ready',
    partner_id: 1,
    move_ids: [{ product_id: 7, qty: 2 }],
  }));
  ({ db: dbBatch, id: p2 } = create(dbBatch, 'stock.picking', {
    picking_type: 'outgoing',
    state: 'ready',
    partner_id: 1,
    move_ids: [{ product_id: 7, qty: 3 }],
  }));
  let batchId;
  ({ db: dbBatch, id: batchId } = create(dbBatch, 'stock.picking.batch', {
    state: 'draft',
    picking_lines: [{ picking_id: p1 }, { picking_id: p2 }],
  }));

  dbBatch = confirmBatch(dbBatch, read(dbBatch, 'stock.picking.batch', batchId));
  const confirmed = read(dbBatch, 'stock.picking.batch', batchId);
  assert.equal(confirmed.state, 'in_progress');
  assert.match(confirmed.name, /^BATCH\/\d{5}$/);

  dbBatch = validateBatch(dbBatch, confirmed);
  assert.equal(read(dbBatch, 'stock.picking.batch', batchId).state, 'done');
  assert.equal(read(dbBatch, 'stock.picking', p1).state, 'done');
  assert.equal(read(dbBatch, 'stock.picking', p2).state, 'done');

  let s1;
  let s2;
  ({ db: dbSingle, id: s1 } = create(dbSingle, 'stock.picking', {
    picking_type: 'outgoing',
    state: 'ready',
    partner_id: 1,
    move_ids: [{ product_id: 7, qty: 2 }],
  }));
  ({ db: dbSingle, id: s2 } = create(dbSingle, 'stock.picking', {
    picking_type: 'outgoing',
    state: 'ready',
    partner_id: 1,
    move_ids: [{ product_id: 7, qty: 3 }],
  }));
  dbSingle = validatePicking.run(dbSingle, read(dbSingle, 'stock.picking', s1)).db;
  dbSingle = validatePicking.run(dbSingle, read(dbSingle, 'stock.picking', s2)).db;

  assert.equal(
    read(dbBatch, 'product', 7).qty_available,
    read(dbSingle, 'product', 7).qty_available
  );
});

test('empty batch throws on confirm', () => {
  let db = seed();
  let batchId;
  ({ db, id: batchId } = create(db, 'stock.picking.batch', {
    state: 'draft',
    picking_lines: [],
  }));
  assert.throws(() => confirmBatch(db, read(db, 'stock.picking.batch', batchId)), /at least one/i);
});

test('mixed incoming and outgoing transfers throw on confirm', () => {
  let db = seed();
  let pOut;
  let pIn;
  ({ db, id: pOut } = create(db, 'stock.picking', {
    picking_type: 'outgoing',
    state: 'ready',
    partner_id: 1,
    move_ids: [{ product_id: 7, qty: 1 }],
  }));
  ({ db, id: pIn } = create(db, 'stock.picking', {
    picking_type: 'incoming',
    state: 'ready',
    partner_id: 1,
    move_ids: [{ product_id: 7, qty: 1 }],
  }));
  let batchId;
  ({ db, id: batchId } = create(db, 'stock.picking.batch', {
    state: 'draft',
    picking_lines: [{ picking_id: pOut }, { picking_id: pIn }],
  }));
  assert.throws(() => confirmBatch(db, read(db, 'stock.picking.batch', batchId)), /mix/i);
});

test('done transfer in batch is rejected on confirm', () => {
  let db = seed();
  let p1;
  ({ db, id: p1 } = create(db, 'stock.picking', {
    picking_type: 'outgoing',
    state: 'done',
    partner_id: 1,
    move_ids: [{ product_id: 7, qty: 1 }],
  }));
  let batchId;
  ({ db, id: batchId } = create(db, 'stock.picking.batch', {
    state: 'draft',
    picking_lines: [{ picking_id: p1 }],
  }));
  assert.throws(() => confirmBatch(db, read(db, 'stock.picking.batch', batchId)), /already done/i);
});

test('transfer in two non-cancelled batches is rejected on confirm', () => {
  let db = seed();
  let p1;
  ({ db, id: p1 } = create(db, 'stock.picking', {
    picking_type: 'outgoing',
    state: 'ready',
    partner_id: 1,
    move_ids: [{ product_id: 7, qty: 1 }],
  }));
  let b1;
  let b2;
  ({ db, id: b1 } = create(db, 'stock.picking.batch', {
    state: 'draft',
    picking_lines: [{ picking_id: p1 }],
  }));
  db = confirmBatch(db, read(db, 'stock.picking.batch', b1));

  ({ db, id: b2 } = create(db, 'stock.picking.batch', {
    state: 'draft',
    picking_lines: [{ picking_id: p1 }],
  }));
  assert.throws(() => confirmBatch(db, read(db, 'stock.picking.batch', b2)), /another/i);

  db = write(db, 'stock.picking.batch', b1, { state: 'cancel' });
  db = confirmBatch(db, read(db, 'stock.picking.batch', b2));
  assert.equal(read(db, 'stock.picking.batch', b2).state, 'in_progress');
});

test('packageContents merges duplicate products', () => {
  let db = seed();
  let pkgId;
  ({ db, id: pkgId } = create(db, 'stock.quant.package', {
    name: 'PACK0000001',
    package_type: 'box',
    weight: 4.5,
    content: [
      { product_id: 7, qty: 2 },
      { product_id: 8, qty: 1 },
      { product_id: 7, qty: 3.5 },
    ],
  }));
  assert.deepEqual(packageContents(db, pkgId), [
    { product_id: 7, qty: 5.5 },
    { product_id: 8, qty: 1 },
  ]);
});
