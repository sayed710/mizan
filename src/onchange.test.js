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
  assert.deepEqual(models['sale.order'].onchange({ partner_id: gulf.id }, 'partner_id', db), { pricelist_id: gulf.pricelist_id, payment_term_id: gulf.property_payment_term_id ?? null, partner_invoice_id: gulf.id, partner_shipping_id: gulf.id, fiscal_position_id: null });
  assert.deepEqual(models['crm.lead'].onchange({ partner_id: gulf.id, email: '', phone: '' }, 'partner_id', db), { email: gulf.email, phone: gulf.phone });
});

test('a lead converts to an opportunity with a new customer, then quotes and links back', async () => {
  const { create, read, search } = await import('./orm.js');
  const { convertLead } = await import('./models/crm.js');
  const db0 = seed();
  const { db, id } = create(db0, 'crm.lead', { name: 'Office fit-out', type: 'lead', partner_name: 'Nile Offices', email: 'buy@nile.example' });
  const converted = convertLead(db, read(db, 'crm.lead', id));
  const lead = read(converted, 'crm.lead', id);
  assert.equal(lead.type, 'opportunity');
  assert.equal(read(converted, 'res.partner', lead.partner_id).name, 'Nile Offices');
  const quote = models['crm.lead'].form.buttons.find((b) => b.label === 'New Quotation').run(converted, lead);
  assert.ok(search(quote.db, 'sale.order').some((o) => o.opportunity_id === id && o.partner_id === lead.partner_id));
});

test('a task blocked by an open task cannot be closed until the blocker is done', async () => {
  const { create, write } = await import('./orm.js');
  const db0 = seed();
  const { db: a, id: blocker } = create(db0, 'project.task', { name: 'Pour foundation' });
  const { db, id } = create(a, 'project.task', { name: 'Build walls', depend_on: [{ task_id: blocker }] });
  assert.throws(() => write(db, 'project.task', id, { stage_id: 'done' }), /Blocked by: Pour foundation/);
  const unblocked = write(db, 'project.task', blocker, { stage_id: 'done' });
  assert.equal(write(unblocked, 'project.task', id, { stage_id: 'done' }).records['project.task'].find((t) => t.id === id).stage_id, 'done');
});
