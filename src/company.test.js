import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, setActiveCompany } from './orm.js';
import { profitAndLoss } from './models/ledger.js';
import { seed } from './seed.js';

after(() => setActiveCompany(null));

test('records belong to the active company; shared master data stays visible', () => {
  const db0 = seed();
  setActiveCompany(2);
  const { db, id } = create(db0, 'crm.lead', { name: 'Branch lead' });
  assert.equal(read(db, 'crm.lead', id).company_id, 2);
  assert.deepEqual(search(db, 'crm.lead').map((l) => l.id), [id]); // company 1 leads hidden
  assert.equal(search(db, 'res.partner').length, search(db0, 'res.partner').length); // shared
  assert.equal(profitAndLoss(db, {}).revenue, 0); // company 2 has no posted invoices
  assert.ok(read(db, 'crm.lead', 1)); // direct reads still resolve cross-company links
  setActiveCompany(1);
  assert.ok(!search(db, 'crm.lead').some((l) => l.id === id));
  setActiveCompany(null);
  assert.equal(search(db, 'crm.lead').length, search(db0, 'crm.lead').length + 1);
});
