import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { apps, models } from './models/index.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

test('SMS longer than 160 characters is rejected; valid SMS counts subscribed recipients', () => {
  const db = seed();
  const sms = search(db, 'sms.campaign')[0];
  assert.equal(read(run(db, 'sms.campaign', sms.id, 'Send').db, 'sms.campaign', sms.id).sent, 2);
  const long = write(db, 'sms.campaign', sms.id, { body: 'x'.repeat(161) });
  assert.throws(() => run(long, 'sms.campaign', sms.id, 'Send'), /longer than 160/);
});

test('ESG emissions convert quantity × factor into tonnes CO2e', () => {
  const db = seed();
  const diesel = search(db, 'esg.emission').find((e) => e.source === 'diesel');
  assert.equal(diesel.co2e, Math.round(380 * 2.68 / 10) / 100);
});

test('every app menu points to a registered model or a known page type', () => {
  const pages = new Set(['dashboard', 'settings', 'pos', 'discuss', 'report', 'barcode', 'shopfloor', 'overview', 'website', 'appstore', 'kiosk', 'surveytake', 'studio', 'kitchen', 'captable']);
  for (const app of apps) {
    for (const leaf of app.menus.flatMap((m) => m.children ?? [m])) {
      assert.ok(leaf.model ? models[leaf.model] : pages.has(leaf.type), `${app.id}/${leaf.key}`);
    }
  }
  assert.ok(apps.length >= 55);
});

test('kitchen state flows on POS orders', () => {
  const { db, id } = create(seed(), 'pos.order', { lines: [{ product_id: 10, qty: 1, price_unit: 2.5, tax: 14 }] });
  assert.equal(read(write(db, 'pos.order', id, { kitchen_state: 'ready' }), 'pos.order', id).kitchen_state, 'ready');
});

test('cap table nets transfers and recycle rules find stale records', async () => {
  const { capTable, staleRecords } = await import('./models/apps4.js');
  const db = seed();
  const table = Object.fromEntries(capTable(db).map((r) => [r.partner_id, r.shares]));
  assert.deepEqual(table, { 1: 60000, 4: 20000, 6: 20000 });
  assert.equal(capTable(db).reduce((s, r) => s + r.pct, 0), 100);
  assert.equal(staleRecords(db, { res_model: 'crm.lead', date_field: 'create_date', days: 30 }).length > 0, true);
  assert.deepEqual(staleRecords(db, { res_model: 'nope', date_field: 'x', days: 1 }), []);
});
