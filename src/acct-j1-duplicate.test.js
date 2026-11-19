import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import './models/index.js';
import { duplicateValues } from './duplicate.js';
import { today } from './models/common.js';

test('1. Duplicating an entry does not copy recurrence: auto_post and auto_post_until are excluded', () => {
  let db = seed();
  const entry = create(db, 'account.move', {
    move_type: 'entry',
    ref: 'Recurring Payroll',
    narration: 'Monthly payroll accrual',
    date: '2026-05-01',
    auto_post: 'monthly',
    auto_post_until: '2026-12-31',
    line_ids: [
      { account_id: 1, debit: 500, credit: 0 },
      { account_id: 2, debit: 0, credit: 500 },
    ],
  });
  const postedDb = write(entry.db, 'account.move', entry.id, { name: 'MISC/2026/0001', state: 'posted' });

  const original = read(postedDb, 'account.move', entry.id);
  assert.equal(original.state, 'posted');
  assert.equal(original.auto_post, 'monthly');
  assert.equal(original.auto_post_until, '2026-12-31');

  const dupVals = duplicateValues('account.move', original, postedDb);
  assert.equal(dupVals.auto_post, undefined, 'auto_post must not be copied by duplicateValues');
  assert.equal(dupVals.auto_post_until, undefined, 'auto_post_until must not be copied by duplicateValues');
  assert.equal(dupVals.auto_post_origin_id, undefined, 'auto_post_origin_id must not be copied by duplicateValues');

  const copy = create(postedDb, 'account.move', dupVals);
  const copyRec = read(copy.db, 'account.move', copy.id);
  assert.equal(copyRec.state, 'draft');
  assert.equal(copyRec.auto_post, 'no', 'copy defaults to non-recurring draft');
  assert.equal(copyRec.auto_post_until, undefined);
  assert.equal(copyRec.auto_post_origin_id, undefined);
  assert.equal(copyRec.ref, 'Recurring Payroll');
  assert.equal(copyRec.narration, 'Monthly payroll accrual');
});

test('1b. Duplicating entries with other auto_post intervals (at_date, quarterly, yearly) excludes recurrence', () => {
  let db = seed();
  for (const interval of ['at_date', 'quarterly', 'yearly']) {
    const entry = create(db, 'account.move', {
      move_type: 'entry',
      ref: `Ref ${interval}`,
      date: '2026-05-01',
      auto_post: interval,
      auto_post_until: '2026-12-31',
      line_ids: [
        { account_id: 1, debit: 200, credit: 0 },
        { account_id: 2, debit: 0, credit: 200 },
      ],
    });
    const original = read(entry.db, 'account.move', entry.id);
    const dupVals = duplicateValues('account.move', original, entry.db);
    assert.equal(dupVals.auto_post, undefined, `auto_post (${interval}) must not be copied`);
    assert.equal(dupVals.auto_post_until, undefined, `auto_post_until must not be copied for ${interval}`);
    const copy = create(entry.db, 'account.move', dupVals);
    const copyRec = read(copy.db, 'account.move', copy.id);
    assert.equal(copyRec.auto_post, 'no');
    assert.equal(copyRec.auto_post_until, undefined);
  }
});

test('2. Duplicating an entry whose date falls in a locked period defaults accounting date to today', () => {
  let db = seed();
  // Set lock date on company 1 to 2025-01-31
  db = write(db, 'res.company', 1, { lock_date: '2025-01-31' });

  // 2a. Original entry date strictly before lock date -> defaults to today()
  const lockedEntry = create(db, 'account.move', {
    move_type: 'entry',
    date: '2025-01-15',
    company_id: 1,
    line_ids: [
      { account_id: 1, debit: 100, credit: 0 },
      { account_id: 2, debit: 0, credit: 100 },
    ],
  });
  const lockedRec = read(lockedEntry.db, 'account.move', lockedEntry.id);
  const dupLocked = duplicateValues('account.move', lockedRec, lockedEntry.db);
  assert.equal(dupLocked.date, today(), 'Accounting date defaults to today when original date is locked');
  const createdLocked = create(lockedEntry.db, 'account.move', dupLocked);
  const lockedCopy = read(createdLocked.db, 'account.move', createdLocked.id);
  assert.equal(lockedCopy.date, today(), 'Created copy accounting date is today');
  assert.equal(lockedCopy.invoice_date, today(), 'Created copy invoice_date follows today for entries');

  // 2b. Original entry date exactly on lock date -> defaults to today()
  const exactLockEntry = create(db, 'account.move', {
    move_type: 'entry',
    date: '2025-01-31',
    company_id: 1,
    line_ids: [
      { account_id: 1, debit: 100, credit: 0 },
      { account_id: 2, debit: 0, credit: 100 },
    ],
  });
  const exactLockRec = read(exactLockEntry.db, 'account.move', exactLockEntry.id);
  const dupExact = duplicateValues('account.move', exactLockRec, exactLockEntry.db);
  assert.equal(dupExact.date, today(), 'Accounting date defaults to today when original date is on lock date');

  // 2c. Original entry date after lock date -> keeps original date
  const openEntry = create(db, 'account.move', {
    move_type: 'entry',
    date: '2025-02-15',
    company_id: 1,
    line_ids: [
      { account_id: 1, debit: 100, credit: 0 },
      { account_id: 2, debit: 0, credit: 100 },
    ],
  });
  const openRec = read(openEntry.db, 'account.move', openEntry.id);
  const dupOpen = duplicateValues('account.move', openRec, openEntry.db);
  assert.equal(dupOpen.date, '2025-02-15', 'Accounting date keeps original date when not locked');

  // 2d. Company has no lock date -> keeps original date
  db = write(db, 'res.company', 1, { lock_date: null });
  const unlockedEntry = create(db, 'account.move', {
    move_type: 'entry',
    date: '2025-01-15',
    company_id: 1,
    line_ids: [
      { account_id: 1, debit: 100, credit: 0 },
      { account_id: 2, debit: 0, credit: 100 },
    ],
  });
  const unlockedRec = read(unlockedEntry.db, 'account.move', unlockedEntry.id);
  const dupUnlocked = duplicateValues('account.move', unlockedRec, unlockedEntry.db);
  assert.equal(dupUnlocked.date, '2025-01-15', 'Accounting date keeps original date when no lock date set');
});

test('2e. Multi-company lock date: entry checks its own company lock date', () => {
  let db = seed();
  // Company 1 has lock date 2025-01-31, create Company 2 with no lock date
  db = write(db, 'res.company', 1, { lock_date: '2025-01-31' });
  const comp2 = create(db, 'res.company', {
    name: 'Branch 2',
    currency_id: read(db, 'res.company', 1).currency_id,
    lock_date: null,
  });
  db = comp2.db;

  const entryC2 = create(db, 'account.move', {
    move_type: 'entry',
    date: '2025-01-15',
    company_id: comp2.id,
    line_ids: [
      { account_id: 1, debit: 100, credit: 0 },
      { account_id: 2, debit: 0, credit: 100 },
    ],
  });
  const recC2 = read(entryC2.db, 'account.move', entryC2.id);
  const dupC2 = duplicateValues('account.move', recC2, entryC2.db);
  assert.equal(dupC2.date, '2025-01-15', 'Company 2 entry keeps date because Company 2 is not locked');

  // Now set lock date on Company 2
  db = write(entryC2.db, 'res.company', comp2.id, { lock_date: '2025-01-31' });
  const dupC2Locked = duplicateValues('account.move', recC2, db);
  assert.equal(dupC2Locked.date, today(), 'Company 2 entry defaults to today when Company 2 is locked');
});

test('2f. Hard lock date and tax lock date also default copy accounting date to today', () => {
  let db = seed();
  // Test hard_lock_date
  db = write(db, 'res.company', 1, { lock_date: null, hard_lock_date: '2025-03-31' });
  const hardLockedEntry = create(db, 'account.move', {
    move_type: 'entry',
    date: '2025-03-15',
    company_id: 1,
    line_ids: [
      { account_id: 1, debit: 100, credit: 0 },
      { account_id: 2, debit: 0, credit: 100 },
    ],
  });
  const hardRec = read(hardLockedEntry.db, 'account.move', hardLockedEntry.id);
  const dupHard = duplicateValues('account.move', hardRec, hardLockedEntry.db);
  assert.equal(dupHard.date, today(), 'Accounting date defaults to today under hard lock date');

  // Entry dated after hard lock date keeps original date
  const openEntry = create(db, 'account.move', {
    move_type: 'entry',
    date: '2025-04-01',
    company_id: 1,
    line_ids: [
      { account_id: 1, debit: 100, credit: 0 },
      { account_id: 2, debit: 0, credit: 100 },
    ],
  });
  const openRec = read(openEntry.db, 'account.move', openEntry.id);
  const dupOpen = duplicateValues('account.move', openRec, openEntry.db);
  assert.equal(dupOpen.date, '2025-04-01', 'Accounting date keeps original date after hard lock date');
});

test('2g. Duplicating an invoice in a locked period defaults accounting date (date) to today', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { lock_date: '2025-01-31' });
  const lockedInvoice = create(db, 'account.move', {
    move_type: 'out_invoice',
    invoice_date: '2025-01-10',
    date: '2025-01-10',
    company_id: 1,
    partner_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  const invRec = read(lockedInvoice.db, 'account.move', lockedInvoice.id);
  const dupInv = duplicateValues('account.move', invRec, lockedInvoice.db);
  assert.equal(dupInv.date, today(), 'Invoice accounting date (date) defaults to today when locked');
});
