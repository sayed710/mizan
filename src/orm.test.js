import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, write, unlink, search, read, matches, messagesOf } from './orm.js';
import { seed } from './seed.js';

test('create assigns sequence and defaults', () => {
  const { db, id } = create(seed(), 'sale.order', { partner_id: 1 });
  const so = read(db, 'sale.order', id);
  assert.equal(so.name, 'S00003');
  assert.equal(so.state, 'draft');
  assert.equal(so.amount_total, 0);
});

test('required fields are enforced', () => {
  assert.throws(() => create(seed(), 'crm.lead', { name: '' }), /Opportunity is required/);
});

test('computed total from order lines', () => {
  const so = read(seed(), 'sale.order', 1);
  assert.equal(so.amount_total, 40 * 210 + 8 * 45);
});

test('stage change writes a tracking message and does not mutate input', () => {
  const db0 = seed();
  const db1 = write(db0, 'crm.lead', 1, { stage_id: 'qualified' });
  assert.equal(read(db0, 'crm.lead', 1).stage_id, 'new');
  assert.equal(read(db1, 'crm.lead', 1).stage_id, 'qualified');
  assert.match(messagesOf(db1, 'crm.lead', 1)[0].body, /Stage: New → Qualified/);
});

test('archived records are hidden, unlink removes', () => {
  let db = write(seed(), 'crm.lead', 2, { active: false });
  assert.ok(!search(db, 'crm.lead').some((r) => r.id === 2));
  db = unlink(db, 'crm.lead', [1]);
  assert.equal(read(db, 'crm.lead', 1), undefined);
});

test('text search matches related partner names and tags', () => {
  const db = seed();
  const lead = read(db, 'crm.lead', 1);
  assert.ok(matches(db, 'crm.lead', lead, ['nile']));
  assert.ok(matches(db, 'crm.lead', lead, ['product']));
  assert.ok(!matches(db, 'crm.lead', lead, ['zzz']));
});
