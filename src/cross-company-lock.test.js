import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { models } from './models/index.js';
import { postEntry } from './models/ledger.js';
import { applyDiff, diffDb } from './sync.js';
import { saveFormRecord } from './views/formSave.js';

function fixture(lockedCompany) {
  let db = seed();
  const company = create(db, 'res.company', { name: 'Second company' }); db = company.db;
  const partner = db.records['res.partner'][0].id;
  const entries = {};
  for (const companyId of [1, company.id]) {
    const entry = postEntry(db, { journal: 'BNK1', company: companyId, date: '2026-01-15', ref: 'Payment', lines: [
      { account: '101401', debit: 100, partner_id: partner }, { account: '121000', credit: 100, partner_id: partner },
    ] });
    db = entry.db; entries[companyId] = entry.id;
  }
  db = write(db, 'res.company', lockedCompany === 1 ? 1 : company.id, { hard_lock_date: '2026-12-31' });
  return { db, company: company.id, partner, entries };
}

const payment = (companyId, partner, move) => ({ name: 'PAY/2026/0099', company_id: companyId, date: '2026-01-15', state: 'posted', partner_id: partner, amount: 100, move_id: move, payment_type: 'inbound', partner_type: 'customer' });
const bankLine = (companyId, partner, move) => ({ company_id: companyId, date: '2026-01-15', payment_ref: 'Bank item', amount: 100, state: 'reconciled', partner_id: partner, move_id: move });

test('payment and bank transaction creation use only the existing record company lock in forms and server diffs', () => {
  for (const locked of [1, 2]) {
    const { db, company, partner, entries } = fixture(locked);
    const lockedId = locked === 1 ? 1 : company;
    const openId = locked === 1 ? company : 1;
    for (const [model, values] of [['account.payment', payment], ['account.bank.statement.line', bankLine]]) {
      assert.ok(models[model].form, `${model} has a public form`);
      const allowed = saveFormRecord(db, model, null, values(openId, partner, entries[openId]));
      const synced = applyDiff(db, diffDb(db, allowed.db), { isAdmin: true });
      assert.equal(read(synced, model, allowed.id).company_id, openId, model);
      assert.throws(() => write(synced, model, allowed.id, { company_id: lockedId }), /period.*locked/i, `${model} cannot move into a locked company`);
      const moved = { ...synced, records: { ...synced.records, [model]: synced.records[model].map((r) => r.id === allowed.id ? { ...r, company_id: lockedId } : r) } };
      assert.throws(() => applyDiff(synced, diffDb(synced, moved), { isAdmin: true }), /period.*locked/i, model);
      assert.throws(() => saveFormRecord(db, model, null, values(lockedId, partner, entries[lockedId])), /period.*locked/i, model);
      const raw = { ...read(allowed.db, model, allowed.id), ...values(lockedId, partner, entries[lockedId]) };
      assert.throws(() => applyDiff(db, { upserts: { [model]: [raw] }, deletes: {} }, { isAdmin: true }), /period.*locked/i, model);
    }
  }
});

test('journal entry guard compares each existing company record with its own lock date', () => {
  let { db, company } = fixture(1);
  const accounts = db.records['account.account'];
  const lines = [{ account_id: accounts.find((a) => a.code === '101401').id, debit: 100, credit: 0 }, { account_id: accounts.find((a) => a.code === '400000').id, debit: 0, credit: 100 }];
  const draft = create(db, 'account.move', { move_type: 'entry', state: 'draft', company_id: 1, invoice_date: '2027-01-01', line_ids: lines }); db = draft.db;
  const next = write(db, 'account.move', draft.id, { company_id: company, invoice_date: '2026-01-15', state: 'posted', name: 'MISC/2026/0099' });
  const saved = applyDiff(db, diffDb(db, next), { isAdmin: true });
  assert.equal(read(saved, 'account.move', draft.id).company_id, company);
  assert.equal(read(saved, 'account.move', draft.id).state, 'posted');
});
