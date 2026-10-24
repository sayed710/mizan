import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

test('moving a lead to another stage updates its probability (also outside the form)', () => {
  const db = write(seed(), 'crm.lead', 1, { stage_id: 'proposition' });
  assert.equal(read(db, 'crm.lead', 1).probability, 60);
  const won = write(db, 'crm.lead', 1, { stage_id: 'won', probability: 95 }); // explicit value wins
  assert.equal(read(won, 'crm.lead', 1).probability, 95);
});

test('choosing a customer fills the quotation pricelist and the lead contact details', () => {
  const db = seed();
  const gulf = db.records['res.partner'].find((p) => p.name === 'Gulf Interiors');
  assert.ok(gulf.pricelist_id);
  assert.deepEqual(models['sale.order'].onchange({ partner_id: gulf.id }, 'partner_id', db), { pricelist_id: gulf.pricelist_id });
  assert.deepEqual(models['crm.lead'].onchange({ partner_id: gulf.id, email: '', phone: '' }, 'partner_id', db), { email: gulf.email, phone: gulf.phone });
});
