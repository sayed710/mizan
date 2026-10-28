import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search, updateSettings, write } from './orm.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { isBalanced, profitAndLoss } from './models/ledger.js';
import { workedHours } from './models/apps2.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

test('a credit note reverses the invoice in the books', () => {
  const db0 = seed();
  const inv = search(db0, 'account.move').find((m) => m.move_type === 'out_invoice' && m.state === 'posted');
  const before = profitAndLoss(db0, {}).revenue;
  const { db: withRefund } = run(db0, 'account.move', inv.id, 'Credit Note');
  const refund = search(withRefund, 'account.move').find((m) => m.move_type === 'out_refund');
  const posted = read(postMove(withRefund, refund.id), 'account.move', refund.id);
  assert.match(posted.name, /^RINV\//);
  assert.ok(isBalanced(posted.line_ids));
  assert.equal(profitAndLoss(postMove(withRefund, refund.id), {}).revenue, Math.round((before - inv.amount_untaxed) * 100) / 100);
});

test('quality measure within tolerance passes', () => {
  const db = seed();
  const qc = search(db, 'quality.check').find((q) => q.test_type === 'measure');
  assert.equal(read(run(db, 'quality.check', qc.id, 'Validate Measure').db, 'quality.check', qc.id).result, 'pass');
});

test('ending a repair consumes the parts', () => {
  let db = seed();
  const ro = search(db, 'repair.order')[0];
  const before = read(db, 'product', 9).qty_available;
  db = write(db, 'repair.order', ro.id, models['repair.order'].form.buttons.find((b) => b.label === 'Start Repair').vals);
  db = run(db, 'repair.order', ro.id, 'End Repair').db;
  assert.equal(read(db, 'product', 9).qty_available, before - 1);
});

test('attendance hours and uninstalled apps survive sync', () => {
  assert.equal(workedHours({ check_in: '08:55', check_out: '17:05' }), 8.17);
  const base = seed();
  const next = updateSettings(base, { uninstalled: ['fleet', 'lunch'] });
  assert.deepEqual(applyDiff(base, diffDb(base, next), { isAdmin: true }).settings.uninstalled, ['fleet', 'lunch']);
});
