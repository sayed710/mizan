// Uninstalling an app stops its scheduled jobs and closes its models to the REST API, not only its home icon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, search, updateSettings } from './orm.js';
import { uninstalledModels } from './models/index.js';
import { runScheduledJobs } from './models/scheduler.js';
import { addDays, today } from './models/common.js';
import { seed } from './seed.js';
import { handleApi } from '../server/api.js';

const staleQuote = (db) => create(db, 'sale.order', { partner_id: 3, validity_date: addDays(today(), -3), order_line: [{ product_id: 1, qty: 1, price_unit: 10, tax: 0 }] });

test('models only an uninstalled app uses are listed; shared ones are not', () => {
  assert.equal(uninstalledModels([]).size, 0);
  const off = uninstalledModels(['fleet']);
  assert.ok(off.has('fleet.vehicle'));
  assert.ok(!off.has('res.partner'));
  assert.ok(!off.has('sale.order'));
});

test('scheduled jobs of uninstalled apps do not run', () => {
  const { db, id } = staleQuote(seed());
  const notified = (d) => search(runScheduledJobs(d), 'sale.order').find((o) => o.id === id).expiry_notified_for;
  assert.ok(notified(db));
  assert.equal(notified(updateSettings(db, { uninstalled: ['sales'] })), undefined);
});

test('the REST API refuses models of uninstalled apps', () => {
  const db = updateSettings(seed(), { uninstalled: ['fleet'] });
  const call = (model, d = db) => handleApi({ method: 'GET', path: `/api/v1/${model}`, query: new URLSearchParams(), body: null, db: d, user: { name: 'k', isAdmin: true } });
  assert.equal(call('fleet.vehicle').status, 404);
  assert.equal(call('fleet.vehicle', seed()).status, 200);
  assert.equal(call('res.partner').status, 200);
});
