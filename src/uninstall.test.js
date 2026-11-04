// Uninstalling an app stops its scheduled jobs and closes its models to the REST API, not only its home icon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, updateSettings, write } from './orm.js';
import { apps, findLeaf, targetOf, uninstalledModels } from './models/index.js';
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

test('the API catalog excludes uninstalled models and keeps permission filtering', () => {
  const db = updateSettings(seed(), { uninstalled: ['fleet'] });
  const catalog = (allowed = null) => handleApi({ method: 'GET', path: '/api/v1/models', db, allowed }).body.map((m) => m.model);
  assert.ok(!catalog().includes('fleet.vehicle'));
  assert.ok(catalog().includes('res.partner'));
  assert.deepEqual(catalog(new Set(['fleet.vehicle', 'res.partner'])), ['res.partner']);
});

test('shared record links choose an installed app', () => {
  const first = targetOf('res.partner').split('/')[1];
  const target = targetOf('res.partner', [first]);
  const [, appId, menu] = target.split('/');
  assert.notEqual(appId, first);
  assert.equal(findLeaf(apps.find((a) => a.id === appId), menu).model, 'res.partner');
  assert.equal(targetOf('fleet.vehicle', ['fleet']), '#/');
});

test('signature and blanket expiry jobs respect their own app installation', () => {
  const sign = create(seed(), 'sign.request', { name: 'Expired NDA', partner_id: 4, state: 'sent', deadline: '2026-01-10', sent_date: '2026-01-01' });
  const blanket = create(sign.db, 'purchase.requisition', { name: 'BO/1', type: 'blanket', partner_id: 2, date_end: '2026-01-31' });
  const db = write(blanket.db, 'purchase.requisition', blanket.id, { state: 'ongoing' });
  for (const app of ['sign', 'purchase']) {
    const out = runScheduledJobs(updateSettings(db, { uninstalled: [app] }), '2026-02-01');
    assert.equal(read(out, 'sign.request', sign.id).state, app === 'sign' ? 'sent' : 'expired');
    assert.equal(read(out, 'purchase.requisition', blanket.id).state, app === 'purchase' ? 'ongoing' : 'done');
  }
});
