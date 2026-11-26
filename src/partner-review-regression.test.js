import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { migrate } from './migrations.js';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { ensurePartnerIndustries, partnerCustomerInvoices } from './models/crm.js';

test('upgrade seeds missing industries and backfills legacy addresses without losing text', () => {
  let db = seed();
  const state = db.records['res.country.state'][0];
  const country = db.records['res.country'].find(c => c.id === state.country_id);
  db = { ...db, schema_version: 78, records: { ...db.records, 'res.partner.industry': [], 'res.partner': [...db.records['res.partner'], { id: 99999, name: 'Legacy', country: country.name, state: state.name }] } };
  const upgraded = migrate(db);
  assert.equal(upgraded.records['res.partner.industry'].length, 21);
  assert.equal(ensurePartnerIndustries(upgraded).records['res.partner.industry'].length, 21);
  const p = read(upgraded, 'res.partner', 99999);
  assert.equal(p.country_id, country.id);
  assert.equal(p.state_id, state.id);
  assert.equal(p.country, country.name);
  assert.ok(search(upgraded, 'res.partner').some(r => r.id === p.id && r.country_id === country.id));
});

test('clearing country clears state on write and onchange; invalid address types are rejected', () => {
  let db = seed();
  const state = db.records['res.country.state'][0];
  const made = create(db, 'res.partner', { name: 'Address test', country_id: state.country_id, state_id: state.id });
  db = write(made.db, 'res.partner', made.id, { country_id: null });
  assert.equal(read(db, 'res.partner', made.id).state_id, null);
  assert.equal(read(db, 'res.partner', made.id).state, '');
  const changed = models['res.partner'].onchange({ country_id: null, state_id: state.id, state: state.name }, 'country_id', db);
  assert.equal(changed.state_id, null);
  assert.equal(changed.state, '');
  assert.throws(() => write(db, 'res.partner', made.id, { type: 'invalid' }), /Address Type/);
  assert.throws(() => write(db, 'res.partner', made.id, { child_ids: [{ type: 'invalid' }] }), /Address Type/);
});

test('mixed invoice and refund links include child moves for customers and vendors', () => {
  let db = seed();
  const parent = create(db, 'res.partner', { name: 'Parent' });
  const child = create(parent.db, 'res.partner', { name: 'Child', parent_id: parent.id });
  db = child.db;
  const ids = [];
  for (const [type, partner] of [['out_invoice', parent.id], ['out_refund', child.id], ['in_invoice', parent.id], ['in_refund', child.id]]) {
    const result = create(db, 'account.move', { move_type: type, partner_id: partner });
    db = result.db; ids.push(result.id);
  }
  const record = read(db, 'res.partner', parent.id);
  for (const [label, expected] of [['Invoiced', ids.slice(0, 2)], ['Vendor Bills', ids.slice(2)]]) {
    const target = models['res.partner'].form.smart.find(s => s.label === label).target(record, db);
    assert.equal(target, `accounting/entries?view=list&rel=id:${expected.join(',')}`);
  }
  assert.equal(partnerCustomerInvoices(db, record).length, 2);
});

test('partner list reuses indexes across many contacts and moves', () => {
  const base = seed();
  let partnerScans = 0;
  let moveScans = 0;
  const partners = Array.from({ length: 300 }, (_, i) => ({ id: 10000 + i, name: `Contact ${i}`, active: true }));
  const moves = partners.map((p, i) => ({ id: 20000 + i, partner_id: p.id, move_type: 'out_invoice', state: 'draft', active: true }));
  const trackedPartners = new Proxy(partners, { get(target, key, receiver) { if (key === Symbol.iterator) partnerScans++; return Reflect.get(target, key, receiver); } });
  const trackedMoves = new Proxy(moves, { get(target, key, receiver) { if (key === 'length') moveScans++; return Reflect.get(target, key, receiver); } });
  const db = { ...base, records: { ...base.records, 'res.partner': trackedPartners, 'account.move': trackedMoves } };
  const fields = models['res.partner'].fields;
  for (const p of partners) {
    assert.equal(fields.account_move_count.compute(p, db), 1);
    assert.equal(fields.supplier_invoice_count.compute(p, db), 0);
    fields.child_ids.compute(p, db);
    fields.complete_name.compute(p, db);
  }
  assert.ok(partnerScans <= 2, `partner scans: ${partnerScans}`);
  assert.ok(moveScans <= 305, `move length reads: ${moveScans}`);
});
