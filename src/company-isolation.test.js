import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, write } from './orm.js';
import { seed } from './seed.js';
import { createCompany, restrictRecords, visibleTo } from './models/company.js';
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

test('nested per-company arrays: restricted user sees only allowed lines, preserves hidden lines, and cannot write foreign lines', () => {
  const { db } = twoCompanies();
  const only1 = { companies: new Set([1]), isAdmin: false, author: 'Clerk' };

  // Setup partner with followup_lines in company 1 and company 2
  const p = create(db, 'res.partner', {
    name: 'Shared Partner Multi Lines',
    followup_lines: [
      { company_id: 1, followup_level_delay: 15, followup_date: '2026-01-01' },
      { company_id: 2, followup_level_delay: 30, followup_date: '2026-01-02' },
    ],
  });
  let currentDb = p.db;

  // 1. restrictRecords filters foreign followup_lines in restricted snapshots
  const { records: snapshot } = restrictRecords(currentDb, new Set([1]));
  const partnerInSnapshot = snapshot['res.partner'].find((x) => x.id === p.id);
  assert.equal(partnerInSnapshot.followup_lines.length, 1);
  assert.equal(partnerInSnapshot.followup_lines[0].company_id, 1);

  // 2. Normal write from restricted client preserves hidden foreign followup_lines
  const clientDb = { ...currentDb, records: snapshot };
  const renamed = {
    ...clientDb,
    records: {
      ...clientDb.records,
      'res.partner': clientDb.records['res.partner'].map((x) => (x.id === p.id ? { ...x, name: 'Renamed Partner' } : x)),
    },
  };
  const diffRename = diffDb(clientDb, renamed);
  const applied = applyDiff(currentDb, diffRename, only1);
  const updatedPartner = applied.records['res.partner'].find((x) => x.id === p.id);
  assert.equal(updatedPartner.name, 'Renamed Partner');
  assert.equal(updatedPartner.followup_lines.length, 2);
  assert.ok(updatedPartner.followup_lines.some((l) => l.company_id === 1));
  assert.ok(updatedPartner.followup_lines.some((l) => l.company_id === 2));

  // 3. Writing foreign followup_lines is rejected
  const foreignLineDiff = {
    upserts: {
      'res.partner': [{
        id: p.id,
        followup_lines: [{ company_id: 2, followup_level_delay: 45 }],
      }],
    },
    deletes: {},
  };
  assert.throws(() => applyDiff(currentDb, foreignLineDiff, only1), /No access to this company/);

  // 4. Writing foreign secure_chain_heads on account.journal is rejected
  const foreignHeadDiff = {
    upserts: {
      'account.journal': [{
        id: 1,
        secure_chain_heads: [{ company_id: 2, count: 1, last_hash: 'h' }],
      }],
    },
    deletes: {},
  };
  assert.throws(() => applyDiff(currentDb, foreignHeadDiff, only1), /No access to this company/);
});

test('restricted snapshot and write cannot touch another company\'s progress', () => {
  const { db } = twoCompanies();
  const only1 = { companies: new Set([1]), isAdmin: false, author: 'Clerk' };

  const p = create(db, 'res.partner', {
    name: 'Shared Customer Isolated Progress',
    followup_lines: [
      { company_id: 1, followup_level_delay: 15, followup_date: '2026-01-01' },
      { company_id: 2, followup_level_delay: 30, followup_date: '2026-01-02' },
    ],
  });
  const currentDb = p.db;

  // 1. Restricted snapshot contains only allowed company progress and no scalar bypass fields
  const { records: snapshot } = restrictRecords(currentDb, new Set([1]));
  const partnerInSnapshot = snapshot['res.partner'].find((x) => x.id === p.id);
  assert.equal(partnerInSnapshot.followup_lines.length, 1);
  assert.equal(partnerInSnapshot.followup_lines[0].company_id, 1);
  assert.equal(partnerInSnapshot.followup_lines[0].followup_level_delay, 15);
  assert.equal(partnerInSnapshot.followup_level_delay, undefined);
  assert.equal(partnerInSnapshot.followup_date, undefined);
  assert.equal(partnerInSnapshot.followup_level, undefined);

  // 2. Restricted write updates company 1 progress but cannot touch company 2 progress
  const clientDb = { ...currentDb, records: snapshot };
  const updatedBy1 = {
    ...clientDb,
    records: {
      ...clientDb.records,
      'res.partner': clientDb.records['res.partner'].map((x) => (x.id === p.id ? {
        ...x,
        phone: '+20 111 222 3333',
        followup_lines: [{ company_id: 1, followup_level_delay: 45, followup_date: '2026-02-01' }],
      } : x)),
    },
  };
  const diff1 = diffDb(clientDb, updatedBy1);
  const applied = applyDiff(currentDb, diff1, only1);
  const resultPartner = applied.records['res.partner'].find((x) => x.id === p.id);
  assert.equal(resultPartner.phone, '+20 111 222 3333');
  assert.equal(resultPartner.followup_lines.length, 2);
  const c1Prog = resultPartner.followup_lines.find((l) => l.company_id === 1);
  const c2Prog = resultPartner.followup_lines.find((l) => l.company_id === 2);
  assert.equal(c1Prog.followup_level_delay, 45);
  assert.equal(c1Prog.followup_date, '2026-02-01');
  assert.equal(c2Prog.followup_level_delay, 30, 'company 2 progress remains untouched');
  assert.equal(c2Prog.followup_date, '2026-01-02', 'company 2 date remains untouched');

  // 3. Foreign line modification is rejected
  const badDiff = {
    upserts: {
      'res.partner': [{
        id: p.id,
        followup_lines: [{ company_id: 2, followup_level_delay: 0 }],
      }],
    },
    deletes: {},
  };
  assert.throws(() => applyDiff(currentDb, badDiff, only1), /No access to this company/);
});
