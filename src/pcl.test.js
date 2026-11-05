import { test } from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, updateSettings, write } from './orm.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { taxLockFor } from './models/finance.js';
import { createCompany } from './models/company.js';
import { reviewReturn, submitReturn, resetReturnToDraft } from './models/taxreturn.js';
import { applyDiff } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';

test('pcl: lock dates live on res.company and isolate between companies', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Subsidiary Two' });
  db = c2.db;
  const company2Id = c2.id;

  // Lock Company 1 up to 2026-03-31; Company 2 has no lock_date.
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31' });

  // Posting in Company 1 on 2026-03-15 fails due to company 1 lock.
  assert.throws(
    () => postEntry(db, {
      company: 1,
      journal: 'MISC',
      date: '2026-03-15',
      lines: [{ account: '101401', debit: 50 }, { account: '400000', credit: 50 }],
    }),
    /The period up to 2026-03-31 is locked/i,
  );

  // Posting in Company 2 on 2026-03-15 succeeds.
  const comp2Accounts = search(db, 'account.account').filter((a) => a.company_id === company2Id);
  const comp2Bank = comp2Accounts.find((a) => a.account_type === 'asset_cash') || search(db, 'account.account').find((a) => a.code === '101401');
  const comp2Income = comp2Accounts.find((a) => a.account_type === 'income') || search(db, 'account.account').find((a) => a.code === '400000');

  const postedC2 = postEntry(db, {
    company: company2Id,
    journal: 'MISC',
    date: '2026-03-15',
    lines: [{ account: comp2Bank.id, debit: 50 }, { account: comp2Income.id, credit: 50 }],
  });
  assert.equal(read(postedC2.db, 'account.move', postedC2.id).state, 'posted');

  // Posting in Company 1 after lock date succeeds.
  const postedC1 = postEntry(db, {
    company: 1,
    journal: 'MISC',
    date: '2026-04-15',
    lines: [{ account: '101401', debit: 50 }, { account: '400000', credit: 50 }],
  });
  assert.equal(read(postedC1.db, 'account.move', postedC1.id).state, 'posted');
});

test('pcl: sale and purchase lock dates apply per side and per company', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Subsidiary SalePurchase' });
  db = c2.db;
  const company2Id = c2.id;

  const saleJournalC2 = create(db, 'account.journal', { name: 'C2 Sales', code: 'C2S', type: 'sale', company_id: company2Id });
  db = saleJournalC2.db;
  const purchJournalC2 = create(db, 'account.journal', { name: 'C2 Purchases', code: 'C2P', type: 'purchase', company_id: company2Id });
  db = purchJournalC2.db;

  // Set sale_lock_date on company 1 and purchase_lock_date on company 2.
  db = write(db, 'res.company', 1, { sale_lock_date: '2026-03-31' });
  db = write(db, 'res.company', company2Id, { purchase_lock_date: '2026-03-31' });

  const saleJournalC1 = read(db, 'res.company', 1).default_sale_journal_id;
  const purchJournalC1 = read(db, 'res.company', 1).default_purchase_journal_id;

  // Company 1: sale invoice on 2026-03-15 is locked; purchase bill is allowed.
  assert.throws(
    () => postEntry(db, {
      company: 1,
      journal_id: saleJournalC1,
      date: '2026-03-15',
      lines: [{ account: '121000', debit: 100 }, { account: '400000', credit: 100 }],
    }),
    /locked/i,
  );
  assert.ok(postEntry(db, {
    company: 1,
    journal_id: purchJournalC1,
    date: '2026-03-15',
    lines: [{ account: '600000', debit: 100 }, { account: '211000', credit: 100 }],
  }).id);

  // Company 2: purchase bill on 2026-03-15 is locked; sale invoice is allowed.
  const c2Receivable = read(db, 'res.company', company2Id).account_default_receivable_id;
  const c2Payable = read(db, 'res.company', company2Id).account_default_payable_id;
  const c2Income = search(db, 'account.account').find((a) => a.company_id === company2Id && a.account_type === 'income')?.id || '400000';
  const c2Expense = search(db, 'account.account').find((a) => a.company_id === company2Id && a.account_type === 'expense')?.id || '600000';

  assert.throws(
    () => postEntry(db, {
      company: company2Id,
      journal_id: purchJournalC2.id,
      date: '2026-03-15',
      lines: [{ account: c2Expense, debit: 100 }, { account: c2Payable, credit: 100 }],
    }),
    /locked/i,
  );
  assert.ok(postEntry(db, {
    company: company2Id,
    journal_id: saleJournalC2.id,
    date: '2026-03-15',
    lines: [{ account: c2Receivable, debit: 100 }, { account: c2Income, credit: 100 }],
  }).id);
});

test('pcl: tax_lock_date isolates per company and guards only taxable moves', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Subsidiary TaxLock' });
  db = c2.db;
  const company2Id = c2.id;

  db = write(db, 'res.company', 1, { tax_lock_date: '2026-03-31' });

  // In Company 1: taxable entry on 2026-03-15 is locked.
  assert.throws(
    () => postEntry(db, {
      company: 1,
      journal: 'MISC',
      date: '2026-03-15',
      lines: [{ account: '101401', debit: 114 }, { account: '251000', credit: 14, tax_name: 'VAT' }, { account: '400000', credit: 100 }],
    }),
    /locked/i,
  );

  // In Company 1: non-taxable entry on 2026-03-15 is NOT locked.
  assert.ok(postEntry(db, {
    company: 1,
    journal: 'MISC',
    date: '2026-03-15',
    lines: [{ account: '101401', debit: 50 }, { account: '400000', credit: 50 }],
  }).id);

  // In Company 2: taxable entry on 2026-03-15 is allowed because Company 2 has no tax_lock_date.
  const comp2Accounts = search(db, 'account.account').filter((a) => a.company_id === company2Id);
  const comp2Bank = comp2Accounts.find((a) => a.account_type === 'asset_cash') || search(db, 'account.account').find((a) => a.code === '101401');
  const comp2Tax = comp2Accounts.find((a) => a.code === '251000') || search(db, 'account.account').find((a) => a.code === '251000');
  const comp2Income = comp2Accounts.find((a) => a.account_type === 'income') || search(db, 'account.account').find((a) => a.code === '400000');

  assert.ok(postEntry(db, {
    company: company2Id,
    journal: 'MISC',
    date: '2026-03-15',
    lines: [{ account: comp2Bank.id, debit: 114 }, { account: comp2Tax.id, credit: 14, tax_name: 'VAT' }, { account: comp2Income.id, credit: 100 }],
  }).id);
});

test('pcl: tax return submit and reset update tax_lock_date on res.company', () => {
  let db = seed();
  const type = search(db, 'account.return.type')[0];
  const made = create(db, 'account.return', {
    name: 'Q1 Return',
    type_id: type.id,
    company_id: 1,
    date_from: '2026-01-01',
    date_to: '2026-03-31',
  });
  db = made.db;

  // Review return first
  const reviewedDb = reviewReturn(db, made.id);

  // Submit sets tax_lock_date on res.company 1
  const submittedDb = submitReturn(reviewedDb, made.id);
  assert.equal(read(submittedDb, 'res.company', 1).tax_lock_date, '2026-03-31');

  // Resetting to draft clears tax_lock_date on res.company 1
  const resetDb = resetReturnToDraft(submittedDb, made.id);
  assert.equal(read(resetDb, 'res.company', 1).tax_lock_date, null);
});

test('pcl: accounting settings isolation (audit_trail, three_way_matching) on res.company', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Audit C2' });
  db = c2.db;
  const company2Id = c2.id;

  // Company 1 has audit_trail: true; Company 2 has audit_trail: false.
  db = write(db, 'res.company', 1, { audit_trail: true });
  db = write(db, 'res.company', company2Id, { audit_trail: false });

  assert.equal(read(db, 'res.company', 1).audit_trail, true);
  assert.equal(read(db, 'res.company', company2Id).audit_trail, false);

  // CompanyGuard prevents disabling audit_trail on company 1.
  assert.throws(
    () => write(db, 'res.company', 1, { audit_trail: false }),
    /The audit trail cannot be disabled once enabled/i,
  );

  // Company 2 can still toggle its own settings freely.
  const toggledC2 = write(db, 'res.company', company2Id, { three_way_matching: true });
  assert.equal(read(toggledC2, 'res.company', company2Id).three_way_matching, true);
  assert.ok(!read(toggledC2, 'res.company', 1).three_way_matching);
});

test('pcl: updateSettings throws user-readable error when lock dates are passed', () => {
  const db = seed();
  for (const field of ['lock_date', 'sale_lock_date', 'purchase_lock_date', 'tax_lock_date', 'tax_lock_dates', 'hard_lock_date']) {
    assert.throws(
      () => updateSettings(db, { [field]: '2026-12-31' }),
      /Accounting lock dates must be set on the company/i,
      `Expected updateSettings to throw for ${field}`,
    );
  }
});

test('pcl: sync security - non-admin cannot alter lock dates or audit trail on res.company', () => {
  const db = seed();
  const comp = read(db, 'res.company', 1);

  for (const field of ['lock_date', 'sale_lock_date', 'purchase_lock_date', 'tax_lock_date', 'hard_lock_date', 'audit_trail']) {
    const val = field === 'audit_trail' ? true : '2026-12-31';
    assert.throws(
      () => applyDiff(db, { upserts: { 'res.company': [{ ...comp, [field]: val }] } }, { isAdmin: false }),
      /Only administrators can change lock dates or the audit trail/i,
      `Expected non-admin sync to be rejected for ${field}`,
    );
  }

  // Admin can update lock date.
  const adminSync = applyDiff(db, { upserts: { 'res.company': [{ ...comp, lock_date: '2026-12-31' }] } }, { isAdmin: true });
  assert.equal(read(adminSync, 'res.company', 1).lock_date, '2026-12-31');

  // Hard lock date cannot move backward even by admin.
  const withHardLock = write(db, 'res.company', 1, { hard_lock_date: '2026-06-30' });
  const compHard = read(withHardLock, 'res.company', 1);
  assert.throws(
    () => applyDiff(withHardLock, { upserts: { 'res.company': [{ ...compHard, hard_lock_date: '2026-05-31' }] } }, { isAdmin: true }),
    /The hard lock date cannot be moved back or removed/i,
  );
});

test('pcl: migration 34 migrates legacy global settings to res.company with unplaced preservation', () => {
  const db = seed();
  const c2 = createCompany(db, { name: 'Migrated Co 2' });
  const legacyDb = {
    ...c2.db,
    schema_version: 33,
    settings: {
      ...c2.db.settings,
      lock_date: '2025-06-30',
      sale_lock_date: '2025-05-31',
      purchase_lock_date: '2025-04-30',
      hard_lock_date: '2025-03-31',
      tax_lock_dates: {
        1: '2025-02-28',
        [c2.id]: '2025-01-31',
        9999: '2025-01-15', // unknown company
      },
      three_way_matching: true,
      audit_trail: true,
      invoice_qr: 'zatca',
      company_vat: 'TAX-VAT-1234',
      company_iban: 'IBAN-9876',
    },
  };

  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.equal(migrated.schema_version, 34);

  // Company 1 has migrated values
  const comp1 = read(migrated, 'res.company', 1);
  assert.equal(comp1.lock_date, '2025-06-30');
  assert.equal(comp1.sale_lock_date, '2025-05-31');
  assert.equal(comp1.purchase_lock_date, '2025-04-30');
  assert.equal(comp1.hard_lock_date, '2025-03-31');
  assert.equal(comp1.tax_lock_date, '2025-02-28');
  assert.equal(comp1.three_way_matching, true);
  assert.equal(comp1.audit_trail, true);
  assert.equal(comp1.invoice_qr, 'zatca');
  assert.equal(comp1.vat, 'TAX-VAT-1234');
  assert.equal(comp1.company_iban, 'IBAN-9876');

  // Company 2 has migrated values
  const comp2 = read(migrated, 'res.company', c2.id);
  assert.equal(comp2.lock_date, '2025-06-30');
  assert.equal(comp2.tax_lock_date, '2025-01-31');
  assert.equal(comp2.three_way_matching, true);
  assert.equal(comp2.audit_trail, true);

  // Unplaced tax lock dates for unknown company 9999 are preserved in settings
  assert.deepEqual(migrated.settings.unplaced_tax_lock_dates, { 9999: '2025-01-15' });

  // A chatter note was logged on company 1 for unplaced lock dates
  const notes = (migrated.messages || []).filter((m) => m.model === 'res.company' && m.res_id === 1);
  assert.ok(notes.some((m) => m.body.includes('9999')));

  // Legacy keys were cleaned from settings
  assert.equal(migrated.settings.lock_date, undefined);
  assert.equal(migrated.settings.tax_lock_dates, undefined);
  assert.equal(migrated.settings.sale_lock_date, undefined);
  assert.equal(migrated.settings.purchase_lock_date, undefined);
  assert.equal(migrated.settings.hard_lock_date, undefined);

  // Migration is idempotent
  const twice = migrate(migrated);
  assert.equal(twice.schema_version, 34);
  assert.equal(read(twice, 'res.company', 1).lock_date, '2025-06-30');
  assert.equal(read(twice, 'res.company', 1).tax_lock_date, '2025-02-28');
});

test('pcl: tax unit return submit updates tax_lock_date across all member companies', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Unit Member Two' });
  db = c2.db;
  const type = search(db, 'account.return.type')[0];
  const c2Type = create(db, 'account.return.type', {
    name: 'VAT Member',
    company_id: c2.id,
    periodicity: 'monthly',
    tax_payable_account_id: read(db, 'res.company', c2.id).account_default_payable_id,
    tax_receivable_account_id: read(db, 'res.company', c2.id).account_default_receivable_id,
    payment_partner_id: type.payment_partner_id,
  });
  db = c2Type.db;
  const unit = create(db, 'account.tax.unit', {
    name: 'VAT Unit',
    main_company_id: 1,
    company_ids: [1, c2.id],
    member_return_type_ids: [{ company_id: c2.id, type_id: c2Type.id }],
  });
  db = unit.db;
  const made = create(db, 'account.return', {
    name: 'Unit Q1',
    type_id: type.id,
    company_id: 1,
    tax_unit_id: unit.id,
    date_from: '2026-01-01',
    date_to: '2026-03-31',
  });
  db = made.db;
  const reviewed = reviewReturn(db, made.id);
  const submitted = submitReturn(reviewed, made.id);
  assert.equal(read(submitted, 'res.company', 1).tax_lock_date, '2026-03-31');
  assert.equal(read(submitted, 'res.company', c2.id).tax_lock_date, '2026-03-31');

  const reset = resetReturnToDraft(submitted, made.id);
  assert.equal(read(reset, 'res.company', 1).tax_lock_date, null);
  assert.equal(read(reset, 'res.company', c2.id).tax_lock_date, null);
});

test('pcl: settings UI company resolution and writing per-company lock dates and options', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Settings Co 2' });
  db = c2.db;
  // Select company 2
  db = updateSettings(db, { current_company_id: c2.id });
  // Writing settings for current company 2
  db = write(db, 'res.company', c2.id, {
    lock_date: '2026-06-30',
    tax_lock_date: '2026-06-30',
    three_way_matching: true,
  });
  assert.equal(read(db, 'res.company', c2.id).lock_date, '2026-06-30');
  assert.equal(read(db, 'res.company', c2.id).tax_lock_date, '2026-06-30');
  assert.equal(read(db, 'res.company', c2.id).three_way_matching, true);
  // Company 1 remains unchanged
  assert.equal(read(db, 'res.company', 1).lock_date ?? null, null);
  assert.equal(read(db, 'res.company', 1).tax_lock_date ?? null, null);
  assert.ok(!read(db, 'res.company', 1).three_way_matching);
});

test('pcl: lowering the company tax lock below a submitted return keeps that period locked for taxed entries', () => {
  let db = seed();
  const type = search(db, 'account.return.type')[0];
  const made = create(db, 'account.return', { name: 'Q1', type_id: type.id, company_id: 1, date_from: '2026-01-01', date_to: '2026-03-31' });
  db = submitReturn(reviewReturn(made.db, made.id), made.id);
  db = write(db, 'res.company', 1, { tax_lock_date: '2025-12-31' });
  const taxed = { company_id: 1, date: '2026-02-15', line_ids: [{ tax_name: 'VAT 14%', debit: 14, credit: 0 }] };
  assert.equal(taxLockFor(db, taxed), '2026-03-31');
});
