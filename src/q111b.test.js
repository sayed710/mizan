import { test } from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { reviewReturn, submitReturn, resetReturnToDraft } from './models/taxreturn.js';
import { postEntry } from './models/ledger.js';
import { applyDiff, diffDb } from './sync.js';

test('non-admin accountant syncs return submission and reset without gaining lock setting access', () => {
  const initial = seed();
  const type = search(initial, 'account.return.type').find((item) => item.company_id === 1 && item.category === 'account_return');
  const created = create(initial, 'account.return', {
    name: 'Quarterly return', type_id: type.id, company_id: 1,
    date_from: '2026-01-01', date_to: '2026-03-31',
  });
  const reviewed = reviewReturn(created.db, created.id);
  const submitted = submitReturn(reviewed, created.id);
  const synced = applyDiff(reviewed, diffDb(reviewed, submitted), { isAdmin: false });
  assert.equal(read(synced, 'account.return', created.id).state, 'submitted');
  assert.equal(read(synced, 'res.company', 1).tax_lock_date, '2026-03-31');

  const reset = resetReturnToDraft(synced, created.id);
  const syncedReset = applyDiff(synced, diffDb(synced, reset), { isAdmin: false });
  assert.equal(read(syncedReset, 'account.return', created.id).state, 'new');
  assert.equal(read(syncedReset, 'res.company', 1).tax_lock_date, null);

  const company = read(syncedReset, 'res.company', 1);
  assert.throws(() => applyDiff(syncedReset, { upserts: { 'res.company': [{ ...company, tax_lock_date: '2026-12-31' }] } }, { isAdmin: false }), /Only administrators/);
  assert.throws(() => applyDiff(syncedReset, { upserts: { 'res.company': [{ ...company, lock_date: '2026-12-31' }] } }, { isAdmin: false }), /Only administrators/);
});

test('a synced ordinary taxable move cannot evade a submitted return lock with a return link', () => {
  const initial = seed();
  const type = search(initial, 'account.return.type').find((item) => item.company_id === 1 && item.category === 'account_return');
  const created = create(initial, 'account.return', {
    name: 'Quarterly return', type_id: type.id, company_id: 1,
    date_from: '2026-01-01', date_to: '2026-03-31',
  });
  const submitted = submitReturn(reviewReturn(created.db, created.id), created.id);
  const lowered = write(submitted, 'res.company', 1, { tax_lock_date: '2025-12-31' });
  const example = postEntry(lowered, { journal_id: read(lowered, 'res.company', 1).default_general_journal_id, company: 1, date: '2026-04-15', lines: [
    { account_id: type.tax_receivable_account_id, debit: 10 }, { account_id: type.tax_payable_account_id, credit: 10, tax_name: 'VAT' },
  ] });
  const move = read(example.db, 'account.move', example.id);
  const forged = { ...move, id: example.db.seq['account.move'] + 1, name: 'TEST/2026/99999', date: '2026-03-15', tax_return_id: created.id };
  assert.throws(() => applyDiff(example.db, { upserts: { 'account.move': [forged] } }, { isAdmin: false }), /period up to 2026-03-31 is locked/i);
});

test('return workflows never lower a stricter administrator tax lock, and non-admins cannot lower it to the return floor', () => {
  const initial = seed();
  const type = search(initial, 'account.return.type').find((item) => item.company_id === 1 && item.category === 'account_return');
  const created = create(initial, 'account.return', {
    name: 'Quarterly return', type_id: type.id, company_id: 1,
    date_from: '2026-01-01', date_to: '2026-03-31',
  });
  const submitted = submitReturn(reviewReturn(created.db, created.id), created.id);
  const adminLocked = applyDiff(submitted, diffDb(submitted, write(submitted, 'res.company', 1, { tax_lock_date: '2026-06-30' })), { isAdmin: true });
  assert.equal(read(adminLocked, 'res.company', 1).tax_lock_date, '2026-06-30');

  const company = read(adminLocked, 'res.company', 1);
  assert.throws(() => applyDiff(adminLocked, { upserts: { 'res.company': [{ ...company, tax_lock_date: '2026-03-31' }] } }, { isAdmin: false }), /Only administrators/);

  assert.throws(() => resetReturnToDraft(adminLocked, created.id), /period up to 2026-06-30 is locked/);
  assert.equal(read(adminLocked, 'res.company', 1).tax_lock_date, '2026-06-30');
});
