import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, referenceTo, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

const clerk = { isAdmin: false, author: 'Clerk' };
const without = (db, model, ids) => ({ ...db, records: { ...db.records, [model]: db.records[model].filter((r) => !ids.includes(r.id)) } });

test('a partner still used elsewhere cannot be deleted, on the client or the server (DB-005)', () => {
  const db = seed();
  const used = search(db, 'sale.order')[0].partner_id;
  assert.match(referenceTo(db, 'res.partner', [used]), /\S/);
  assert.throws(() => unlink(db, 'res.partner', [used]), /still used by/);
  assert.throws(() => applyDiff(db, diffDb(db, without(db, 'res.partner', [used])), clerk), /Cannot delete Contacts?: still used by/);
});

test('an unused record deletes, and so does a record removed together with everything pointing at it', () => {
  const made = create(seed(), 'res.partner', { name: 'Walk-in' });
  assert.ok(!read(applyDiff(made.db, diffDb(made.db, unlink(made.db, 'res.partner', [made.id])), clerk), 'res.partner', made.id));
  const lead = create(made.db, 'crm.lead', { name: 'Walk-in deal', partner_id: made.id });
  const both = without(without(lead.db, 'crm.lead', [lead.id]), 'res.partner', [made.id]);
  assert.doesNotThrow(() => applyDiff(lead.db, diffDb(lead.db, both), clerk));
});

test('links to records that do not exist are refused; untouched old links do not block edits', () => {
  const db = seed();
  const lead = search(db, 'crm.lead')[0];
  assert.throws(() => applyDiff(db, diffDb(db, write(db, 'crm.lead', lead.id, { partner_id: 99999 })), clerk), /Customer|Partner|Contact/);
  const order = search(db, 'sale.order')[0];
  const lines = order.order_line.map((l, i) => (i === 0 ? { ...l, product_id: 99999 } : l));
  assert.throws(() => applyDiff(db, diffDb(db, { ...db, records: { ...db.records, 'sale.order': db.records['sale.order'].map((o) => (o.id === order.id ? { ...o, order_line: lines } : o)) } }), clerk), /#99999 does not exist/);
  // A record that already holds a dangling link (older data) can still be edited elsewhere.
  const legacy = { ...db, records: { ...db.records, 'crm.lead': db.records['crm.lead'].map((l) => (l.id === lead.id ? { ...l, partner_id: 88888 } : l)) } };
  assert.doesNotThrow(() => applyDiff(legacy, diffDb(legacy, write(legacy, 'crm.lead', lead.id, { name: 'Renamed' })), clerk));
});
