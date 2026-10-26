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
