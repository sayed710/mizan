import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, postNote } from './orm.js';
import { applyDiff } from './sync.js';
import { restrictRecords } from './models/company.js';

test('company-two users can use seeded configuration while company-one documents remain hidden', () => {
  const db = seed();
  const shared = restrictRecords(db, new Set([2])).records;
  for (const model of ['account.tax', 'uom.uom', 'account.payment.term', 'account.fiscal.position', 'crm.team', 'hr.payroll.structure', 'product.public.category']) {
    assert.ok(db.records[model]?.length, `${model} is seeded`);
    assert.deepEqual(shared[model], db.records[model], model);
  }
  assert.equal(shared['sale.order'].length, 0);
  assert.equal(shared['hr.employee'].length, 0);
});

test('limited users may delete chatter with a visible record, never chatter on a hidden record', () => {
  const own = create(seed(), 'crm.lead', { name: 'Own record', company_id: 2 });
  const hidden = create(own.db, 'crm.lead', { name: 'Hidden record', company_id: 1 });
  const db = postNote(postNote(hidden.db, 'crm.lead', own.id, 'Visible'), 'crm.lead', hidden.id, 'Hidden');
  const messages = db.messages.filter((m) => m.model === 'crm.lead' && [own.id, hidden.id].includes(m.res_id));
  const out = applyDiff(db, { deletes: { 'crm.lead': [own.id] }, removedMessages: messages.map((m) => m.id) }, { companies: new Set([2]) });
  assert.ok(!out.messages.some((m) => m.model === 'crm.lead' && m.res_id === own.id));
  assert.ok(out.messages.some((m) => m.model === 'crm.lead' && m.res_id === hidden.id));
});
