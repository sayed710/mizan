import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, updateSettings } from './orm.js';
import { models } from './models/index.js';
import { cleanCustomField, technicalName } from './models/studio.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';

test('technical names are prefixed and sanitized', () => {
  assert.equal(technicalName('Delivery Zone!'), 'x_delivery_zone');
  assert.equal(cleanCustomField({ model: 'nope', label: 'X', type: 'char' }), null);
  assert.equal(cleanCustomField({ model: 'crm.lead', label: 'X', type: 'script' }), null);
  const zone = cleanCustomField({ model: 'crm.lead', label: 'Zone', type: 'selection', options: 'North, South' });
  assert.deepEqual(zone.options, [['north', 'North'], ['south', 'South']]);
  assert.deepEqual(cleanCustomField(zone).options, zone.options); // idempotent on stored definitions
});

test('an admin-added custom field is installed and its values survive server validation', () => {
  const base = seed();
  const withField = updateSettings(base, { customFields: [{ model: 'crm.lead', label: 'Delivery Zone', type: 'char', inList: true }] });
  let server = applyDiff(base, diffDb(base, withField), { isAdmin: true });
  assert.equal(models['crm.lead'].fields.x_delivery_zone.label, 'Delivery Zone');
  assert.ok(models['crm.lead'].list.includes('x_delivery_zone'));
  const { db: edited, id } = create(server, 'crm.lead', { name: 'Zoned lead', x_delivery_zone: 'Nasr City' });
  server = applyDiff(server, diffDb(server, edited), { isAdmin: false });
  assert.equal(read(server, 'crm.lead', id).x_delivery_zone, 'Nasr City');
});

test('non-admins cannot change company, installed apps or Studio fields', () => {
  const base = seed();
  const hacked = updateSettings(base, { company: 'Hacked', uninstalled: ['accounting'], customFields: [{ model: 'crm.lead', label: 'Evil', type: 'char' }], favorites: { 'crm.lead': [] } });
  const server = applyDiff(base, diffDb(base, hacked), { isAdmin: false });
  assert.equal(server.settings.company, base.settings.company);
  assert.equal(server.settings.uninstalled, base.settings.uninstalled);
  assert.equal(server.settings.customFields, base.settings.customFields);
  assert.deepEqual(server.settings.favorites, { 'crm.lead': [] });
});
