import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './orm.js';
import { modelsForApps } from './models/index.js';
import { applyDiff } from './sync.js';
import { seed } from './seed.js';

const upsert = (model, rec) => ({ upserts: { [model]: [rec] }, deletes: {}, messages: [], removedMessages: [], seq: {}, settings: null });

test('values of the wrong type are rejected instead of stored', () => {
  const db = seed();
  for (const bad of [{ name: {} }, { name: 'x', expected_revenue: 'lots' }, { name: 'x', stage_id: 'hacked' }, { name: 'x', tag_ids: 'x' }, { name: 'x', date_deadline: 'tomorrow' }, { name: 'x', partner_id: '1' }]) {
    assert.throws(() => applyDiff(db, upsert('crm.lead', { id: 1, ...bad })), /Invalid value|required/, JSON.stringify(bad));
  }
});

test('one2many lines keep only declared sub-fields with valid types', () => {
  const db = seed();
  assert.throws(() => applyDiff(db, upsert('sale.order', { id: 1, partner_id: 1, order_line: 'x' })), /Invalid value/);
  const ok = applyDiff(db, upsert('sale.order', { id: 1, partner_id: 1, state: 'draft', order_line: [{ product_id: 1, qty: 2, price_unit: 10, tax: 14, evil: '<x>' }] }));
  assert.deepEqual(read(ok, 'sale.order', 1).order_line, [{ product_id: 1, qty: 2, price_unit: 10, tax: 14 }]);
});

test('messages and favorites are sanitized', () => {
  const db = seed();
  const next = applyDiff(db, {
    upserts: {}, deletes: {}, removedMessages: [], seq: {},
    messages: [{ id: 'a', model: 'crm.lead', res_id: 1, body: 'hi', date: 5 }, { id: 'b', model: 'crm.lead', res_id: 'x', body: 'bad' }],
    settings: { favorites: { 'crm.lead': [{ name: 'Mine', search: { terms: [{}], filters: ['mine'], groupBy: ['nope', 'stage_id'] } }], evil: [] } },
  });
  assert.equal(next.messages.at(-1).date, '5');
  assert.ok(!next.messages.some((m) => m.id === 'b'));
  assert.deepEqual(next.settings.favorites, { 'crm.lead': [{ name: 'Mine', search: { terms: [], filters: ['mine'], groupBy: ['stage_id'], archived: false, rel: null } }] });
});

test('users limited to apps cannot write other models', () => {
  const allowed = modelsForApps(['crm']);
  assert.ok(allowed.has('crm.lead') && allowed.has('res.partner'));
  assert.ok(!allowed.has('hr.payslip'));
  const db = seed();
  assert.throws(() => applyDiff(db, upsert('hr.payslip', { id: 99, employee_id: 1 }), { allowed }), /No access/);
  assert.equal(applyDiff(db, upsert('crm.lead', { id: 1, name: 'Renamed' }), { allowed }).records['crm.lead'].find((r) => r.id === 1).name, 'Renamed');
});
