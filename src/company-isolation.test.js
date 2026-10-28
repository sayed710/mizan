import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, write } from './orm.js';
import { seed } from './seed.js';
import { createCompany, visibleTo } from './models/company.js';
import { applyDiff, diffDb } from './sync.js';

// Two companies with one lead each.
const twoCompanies = () => {
  let db = createCompany(seed(), { name: 'Branch', currency_id: seed().records['res.company'][0].currency_id }).db;
  const branchLead = create(db, 'crm.lead', { name: 'Branch lead', company_id: 2 });
  return { db: branchLead.db, branchLead: branchLead.id };
};
const onlyMain = { companies: new Set([1]), isAdmin: false, author: 'Clerk' };

test('records are visible to users of their company, shared records to everyone', () => {
  const only1 = new Set([1]);
  assert.ok(visibleTo(only1, 'crm.lead', { company_id: 1 }));
  assert.ok(!visibleTo(only1, 'crm.lead', { company_id: 2 }));
  assert.ok(visibleTo(only1, 'res.partner', { company_id: null }));
  assert.ok(visibleTo(only1, 'res.company', { id: 1 }));
  assert.ok(!visibleTo(only1, 'res.company', { id: 2 }));
  assert.ok(visibleTo(null, 'crm.lead', { company_id: 2 }));
});

test('a user limited to one company cannot change, create in or delete from another', () => {
  const { db, branchLead } = twoCompanies();
  const edit = write(db, 'crm.lead', branchLead, { name: 'Hijacked' });
  assert.throws(() => applyDiff(db, diffDb(db, edit), onlyMain), /No access to this company/);
  // Moving the record into their own company counts as touching the other company's record.
  const moved = write(db, 'crm.lead', branchLead, { company_id: 1 });
  assert.throws(() => applyDiff(db, diffDb(db, moved), onlyMain), /No access to this company/);
  const created = create(db, 'crm.lead', { name: 'Planted', company_id: 2 }).db;
  assert.throws(() => applyDiff(db, diffDb(db, created), onlyMain), /No access to this company/);
  const deleted = { ...db, records: { ...db.records, 'crm.lead': db.records['crm.lead'].filter((l) => l.id !== branchLead) } };
  assert.throws(() => applyDiff(db, diffDb(db, deleted), onlyMain), /No access to this company/);
  // Their own company still works.
  const own = create(db, 'crm.lead', { name: 'Mine', company_id: 1 });
  assert.equal(applyDiff(db, diffDb(db, own.db), onlyMain).records['crm.lead'].find((l) => l.id === own.id).name, 'Mine');
});

test("a user limited to one company cannot add or remove chatter on another company's records", () => {
  const { db, branchLead } = twoCompanies();
  const note = { id: 'n-other', model: 'crm.lead', res_id: branchLead, body: 'x', kind: 'note', author: 'a', date: '' };
  const withNote = { ...db, messages: [...db.messages, note] };
  assert.ok(!applyDiff(db, diffDb(db, withNote), onlyMain).messages.some((m) => m.id === 'n-other'));
  const stored = applyDiff(db, diffDb(db, withNote));
  const removed = applyDiff(stored, { upserts: {}, deletes: {}, messages: [], removedMessages: ['n-other'] }, onlyMain);
  assert.ok(removed.messages.some((m) => m.id === 'n-other'));
});

test('records without a company belong to company 1, group reports and other companies\' contacts stay hidden', () => {
  const { db } = twoCompanies();
  const only2 = new Set([2]);
  assert.ok(!visibleTo(only2, 'crm.lead', { id: 9 }), 'a legacy lead with no company is company 1');
  assert.ok(visibleTo(new Set([1]), 'crm.lead', { id: 9 }));
  assert.ok(visibleTo(only2, 'res.currency', { id: 1 }), 'shared master data stays shared');
  assert.ok(!visibleTo(only2, 'consolidation.period', { id: 1, company_id: 2 }));
  assert.ok(visibleTo(null, 'consolidation.period', { id: 1 }));
  const mainContact = db.records['res.company'].find((c) => c.id === 1).partner_id;
  const branchContact = db.records['res.company'].find((c) => c.id === 2).partner_id;
  assert.ok(!visibleTo(only2, 'res.partner', { id: mainContact, company_id: null }, db));
  assert.ok(visibleTo(only2, 'res.partner', { id: branchContact, company_id: null }, db));
  assert.ok(visibleTo(only2, 'res.partner', { id: 9999, company_id: null }, db), 'ordinary shared partners stay visible');
});

test('chatter cannot be planted on a record that does not exist yet', () => {
  const { db } = twoCompanies();
  const orphan = { id: 'n-orphan', model: 'crm.lead', res_id: 424242, body: 'x', kind: 'note', author: 'a', date: '' };
  const out = applyDiff(db, diffDb(db, { ...db, messages: [...db.messages, orphan] }), { companies: new Set([2]), isAdmin: false, author: 'Clerk' });
  assert.ok(!out.messages.some((m) => m.id === 'n-orphan'));
  const lead = create(db, 'crm.lead', { name: 'New', company_id: 2 });
  const withBoth = { ...lead.db, messages: [...lead.db.messages, { ...orphan, id: 'n-new', res_id: lead.id }] };
  assert.ok(applyDiff(db, diffDb(db, withBoth), { companies: new Set([2]), isAdmin: false, author: 'Clerk' }).messages.some((m) => m.id === 'n-new'));
});

test('REST search only matches names the API user can see, and new records go to their company', async () => {
  const { handleApi } = await import('../server/api.js');
  const { db } = twoCompanies();
  const hidden = create(db, 'res.partner', { name: 'Zebra Hidden Contact', company_id: 1 });
  // Stored directly: the guard refuses new links across companies, but old data can contain them.
  const lead = { db: { ...hidden.db, records: { ...hidden.db.records, 'crm.lead': [...(hidden.db.records['crm.lead'] ?? []), { id: 800, name: 'Visible lead', partner_id: hidden.id, company_id: 2 }] } } };
  const user = { name: 'api', isAdmin: false };
  const only2 = new Set([2]);
  const found = handleApi({ method: 'GET', path: '/api/v1/crm.lead', query: new URLSearchParams('q=Zebra'), db: lead.db, user, companies: only2 });
  assert.equal(found.body.total, 0, 'a hidden related name cannot be probed');
  const made = handleApi({ method: 'POST', path: '/api/v1/crm.lead', query: new URLSearchParams(), body: { name: 'Via REST' }, db: lead.db, user, companies: only2, company: 2 });
  assert.equal(made.status, 201);
  assert.equal(made.body.company_id, 2);
});
