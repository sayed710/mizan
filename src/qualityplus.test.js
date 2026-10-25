import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, emptyDb, read, search } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import {
  alertFromCheck,
  canValidatePicking,
  checksFor,
  createChecks,
  evaluateMeasure,
  qualityStats,
} from './models/qualityplus.js';

test('control points match transfer operation, products, and deterministic random frequency', () => {
  const db = {
    records: {
      'quality.point': [
        { id: 1, operation: 'receipt', frequency: 'all' },
        { id: 2, operation: 'receipt', product_id: 4, frequency: 'all' },
        { id: 3, operation: 'receipt', product_id: 5, frequency: 'all' },
        { id: 4, operation: 'delivery', frequency: 'all' },
        { id: 5, operation: 'receipt', frequency: 'periodic' },
        { id: 96, operation: 'receipt', frequency: 'random', frequency_pct: 16 },
        { id: 97, operation: 'receipt', frequency: 'random', frequency_pct: 16 },
      ],
    },
  };
  const picking = { id: 1, picking_type: 'incoming', move_ids: [{ product_id: 4 }, { product_id: 6 }] };
  assert.deepEqual(checksFor(db, picking).map((point) => point.id), [1, 2, 5, 96]);
  assert.deepEqual(checksFor(db, { ...picking, picking_type: 'outgoing' }).map((point) => point.id), [4]);
});

test('createChecks creates one pending check per point and product and is idempotent', () => {
  let db = emptyDb();
  db = create(db, 'quality.point', {
    name: 'Visual finish', operation: 'receipt', test_type: 'pass_fail', frequency: 'all',
  }).db;
  db = create(db, 'quality.point', {
    name: 'Desk width', operation: 'receipt', product_id: 2, test_type: 'measure',
    tolerance_min: 120, tolerance_max: 140, frequency: 'all',
  }).db;
  const picking = {
    id: 9,
    picking_type: 'incoming',
    move_ids: [{ product_id: 1, qty: 1 }, { product_id: 2, qty: 1 }, { product_id: 2, qty: 2 }],
  };

  db = createChecks(db, picking);
  const checks = search(db, 'quality.check');
  assert.equal(checks.length, 3);
  assert.ok(checks.every((check) => check.result === 'none'));
  assert.deepEqual(checks.map((check) => [check.point_id, check.product_id]), [[1, 1], [1, 2], [2, 2]]);

  const repeated = createChecks(db, picking);
  assert.equal(search(repeated, 'quality.check').length, 3);
});

test('measure tolerances include both boundaries', () => {
  const point = { tolerance_min: 2.5, tolerance_max: 4.5 };
  assert.equal(evaluateMeasure(point, 2.5), 'pass');
  assert.equal(evaluateMeasure(point, 4.5), 'pass');
  assert.equal(evaluateMeasure(point, 2.49), 'fail');
  assert.equal(evaluateMeasure(point, 4.51), 'fail');
  assert.equal(evaluateMeasure({}, Number.NaN), 'fail');
});

test('a transfer cannot validate while its quality checks are pending or failed', () => {
  const picking = { id: 12 };
  const db = {
    records: {
      'quality.check': [
        { id: 1, picking_id: 12, result: 'none' },
        { id: 2, picking_id: 12, result: 'fail' },
        { id: 3, picking_id: 99, result: 'none' },
      ],
    },
  };
  assert.deepEqual(canValidatePicking(db, picking), { ok: false, pending: 1, failed: 1 });
  assert.deepEqual(canValidatePicking({ records: { 'quality.check': [{ picking_id: 12, result: 'fail' }] } }, picking), {
    ok: true, pending: 0, failed: 1,
  });
  assert.deepEqual(canValidatePicking({ records: { 'quality.check': [{ picking_id: 12, result: 'pass' }] } }, picking), {
    ok: true, pending: 0, failed: 0,
  });
});

test('failed checks create a linked alert once', () => {
  const checkResult = create(emptyDb(), 'quality.check', {
    name: 'QC/FAILED', product_id: 7, picking_id: 12, test_type: 'pass_fail', result: 'fail',
  });
  const check = read(checkResult.db, 'quality.check', checkResult.id);
  const created = alertFromCheck(checkResult.db, check);
  const alert = read(created.db, 'quality.alert', created.id);
  assert.equal(alert.check_id, check.id);
  assert.equal(alert.product_id, 7);
  assert.equal(alert.picking_id, 12);
  assert.equal(alert.stage_id, 'new');

  const repeated = alertFromCheck(created.db, check);
  assert.equal(repeated.id, created.id);
  assert.equal(search(repeated.db, 'quality.alert').length, 1);
});

test('quality stats count checks in an inclusive date range and open alerts', () => {
  const db = {
    records: {
      'quality.check': [
        { id: 1, date: '2026-03-01', result: 'pass' },
        { id: 2, date: '2026-03-31', result: 'fail' },
        { id: 3, date: '2026-03-15', result: 'none' },
        { id: 4, date: '2026-04-01', result: 'pass' },
      ],
      'quality.alert': [{ id: 1, stage_id: 'action' }, { id: 2, stage_id: 'solved' }],
    },
  };
  assert.deepEqual(qualityStats(db, { from: '2026-03-01', to: '2026-03-31' }), {
    checks: 3, passed: 1, failed: 1, passRate: 50, openAlerts: 1,
  });
});

test('the existing seed loads with quality overrides and keeps its measure workflow', () => {
  const db = seed();
  assert.equal(models['quality.point'].label, 'Control Points');
  assert.equal(search(db, 'quality.check').length, 2);
  assert.equal(search(db, 'quality.alert').length, 1);

  const measure = search(db, 'quality.check').find((check) => check.test_type === 'measure');
  const validate = models['quality.check'].form.buttons.find((button) => button.label === 'Validate Measure');
  assert.equal(read(validate.run(db, measure).db, 'quality.check', measure.id).result, 'pass');
});

test('the Measure form button prompts and evaluates the entered value', () => {
  let db = emptyDb();
  const pointResult = create(db, 'quality.point', {
    name: 'Thickness', operation: 'receipt', test_type: 'measure', tolerance_min: 3, tolerance_max: 5,
  });
  db = pointResult.db;
  const checkResult = create(db, 'quality.check', {
    point_id: pointResult.id, product_id: 1, test_type: 'measure', result: 'none', measure: 0,
  });
  db = checkResult.db;
  const originalPrompt = globalThis.prompt;
  try {
    globalThis.prompt = () => '5';
    const button = models['quality.check'].form.buttons.find((item) => item.label === 'Measure');
    const updated = button.run(db, read(db, 'quality.check', checkResult.id)).db;
    assert.equal(read(updated, 'quality.check', checkResult.id).measure, 5);
    assert.equal(read(updated, 'quality.check', checkResult.id).result, 'pass');
  } finally {
    if (originalPrompt === undefined) delete globalThis.prompt;
    else globalThis.prompt = originalPrompt;
  }
});
