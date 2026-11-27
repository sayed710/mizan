import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const { create, read, search, updateSettings, write } = await import('./orm.js');
const { seed } = await import('./seed.js');
const { postEntry } = await import('./models/ledger.js');
const { createCompany } = await import('./models/company.js');
const { rateAt, toCompany } = await import('./models/currency.js');
const { applyDiff, diffDb } = await import('./sync.js');
  const { migrate } = await import('./migrations.js');
const { validateCompanySettingWrite } = await import('./views/Settings.jsx');
await import('./models/index.js');

test('a company-2 move is blocked by company 2\'s lock and not by company 1\'s', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Company Two' });
  db = c2.db;
  const c2Id = c2.id;

  // Scenario 1: Company 2 has a lock_date, Company 1 has no lock_date.
  db = write(db, 'res.company', c2Id, { lock_date: '2026-03-31' });

  const c2Accounts = search(db, 'account.account').filter((a) => a.company_id === c2Id);
  const c2Cash = c2Accounts.find((a) => a.account_type === 'asset_cash') || search(db, 'account.account').find((a) => a.code === '101401');
  const c2Income = c2Accounts.find((a) => a.account_type === 'income') || search(db, 'account.account').find((a) => a.code === '400000');

  // Company 2 move dated inside Company 2 lock is blocked.
  assert.throws(
    () => postEntry(db, {
      company: c2Id,
      journal: 'MISC',
      date: '2026-03-15',
      lines: [{ account: c2Cash.id, debit: 100 }, { account: c2Income.id, credit: 100 }],
    }),
    /The period up to 2026-03-31 is locked/i,
  );

  // Company 1 move on the same date succeeds because Company 1 is not locked.
  const c1Posted = postEntry(db, {
    company: 1,
    journal: 'MISC',
    date: '2026-03-15',
    lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
  });
  assert.equal(read(c1Posted.db, 'account.move', c1Posted.id).state, 'posted');
  db = c1Posted.db;

  // Scenario 2: Company 1 has a lock_date, Company 2's lock is cleared.
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31' });
  db = write(db, 'res.company', c2Id, { lock_date: null });

  // Company 2 move on 2026-03-15 is NOT blocked by Company 1's lock.
  const c2Posted = postEntry(db, {
    company: c2Id,
    journal: 'MISC',
    date: '2026-03-15',
    lines: [{ account: c2Cash.id, debit: 100 }, { account: c2Income.id, credit: 100 }],
  });
  assert.equal(read(c2Posted.db, 'account.move', c2Posted.id).state, 'posted');
  db = c2Posted.db;

  // Company 1 move on 2026-03-15 IS blocked by Company 1's lock.
  assert.throws(
    () => postEntry(db, {
      company: 1,
      journal: 'MISC',
      date: '2026-03-15',
      lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
    }),
    /The period up to 2026-03-31 is locked/i,
  );

  // Diff-verifiable sync check: draft move in Company 2 posted into Company 2's locked period fails applyDiff.
  db = write(db, 'res.company', c2Id, { lock_date: '2026-03-31' });
  const draftC2 = create(db, 'account.move', {
    company_id: c2Id,
    move_type: 'entry',
    state: 'draft',
    date: '2026-03-15',
    line_ids: [{ account_id: c2Cash.id, debit: 50, credit: 0 }, { account_id: c2Income.id, debit: 0, credit: 50 }],
  });
  db = draftC2.db;
  const postedAttempt = {
    ...read(db, 'account.move', draftC2.id),
    state: 'posted',
    name: 'MISC/2026/0888',
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === draftC2.id ? postedAttempt : m) } }), { isAdmin: true }),
    /period up to 2026-03-31 is locked/i,
  );
});

test('settings edit only the current company', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Subsidiary Branch' });
  db = c2.db;
  const c2Id = c2.id;

  // Set active company to Company 2.
  db = updateSettings(db, { current_company_id: c2Id, allowed_company_ids: [1, c2Id] });

  const comp2 = read(db, 'res.company', c2Id);
  const comp1Before = read(db, 'res.company', 1);

  // Validate and write settings for Company 2.
  const newVals = {
    lock_date: '2026-04-30',
    sale_lock_date: '2026-05-31',
    purchase_lock_date: '2026-06-30',
    tax_lock_date: '2026-07-31',
    tax_calculation_rounding_method: 'round_globally',
    vat: 'VAT-COMP2-999',
    three_way_matching: true,
  };
  assert.equal(validateCompanySettingWrite(db, comp2, newVals), null);

  db = write(db, 'res.company', c2Id, newVals);

  // Company 2 has the updated settings.
  const comp2After = read(db, 'res.company', c2Id);
  assert.equal(comp2After.lock_date, '2026-04-30');
  assert.equal(comp2After.sale_lock_date, '2026-05-31');
  assert.equal(comp2After.purchase_lock_date, '2026-06-30');
  assert.equal(comp2After.tax_lock_date, '2026-07-31');
  assert.equal(comp2After.tax_calculation_rounding_method, 'round_globally');
  assert.equal(comp2After.vat, 'VAT-COMP2-999');
  assert.equal(comp2After.three_way_matching, true);

  // Company 1 remains completely untouched.
  const comp1After = read(db, 'res.company', 1);
  assert.equal(comp1After.lock_date, comp1Before.lock_date);
  assert.equal(comp1After.sale_lock_date, comp1Before.sale_lock_date);
  assert.equal(comp1After.purchase_lock_date, comp1Before.purchase_lock_date);
  assert.equal(comp1After.tax_lock_date, comp1Before.tax_lock_date);
  assert.equal(comp1After.tax_calculation_rounding_method, comp1Before.tax_calculation_rounding_method);
  assert.equal(comp1After.vat, comp1Before.vat);
  assert.equal(comp1After.three_way_matching, comp1Before.three_way_matching);

  // updateSettings rejects writing accounting locks into db.settings.
  assert.throws(
    () => updateSettings(db, { lock_date: '2026-12-31' }),
    /Accounting lock dates must be set on the company/i,
  );
});

test('a company-specific rate wins over the shared one for that company only', () => {
  let db = seed();
  const baseCurrencyId = db.settings.base_currency_id;
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');

  const c2 = createCompany(db, { name: 'Company Two', currency_id: baseCurrencyId });
  db = c2.db;
  const c2Id = c2.id;

  const c3 = createCompany(db, { name: 'Company Three', currency_id: baseCurrencyId });
  db = c3.db;
  const c3Id = c3.id;

  // Configure rates for EUR:
  // - Shared (company_id: null): 1.0
  // - Company 1 specific (company_id: 1): 1.25
  // - Company 3 specific (company_id: c3Id): 2.0
  // Company 2 has no company-specific rate.
  const rateRows = [
    { date: '2026-01-01', rate: 1.0, company_id: null },
    { date: '2026-01-01', rate: 1.25, company_id: 1 },
    { date: '2026-01-01', rate: 2.0, company_id: c3Id },
  ];
  db = {
    ...db,
    records: {
      ...db.records,
      'res.currency': db.records['res.currency'].map((c) => (c.id === eur.id ? { ...c, rate_ids: rateRows } : c)),
    },
  };

  // Company 1 uses company 1's specific rate (1.25).
  assert.equal(rateAt(db, eur.id, '2026-01-15', 1), 1.25);
  assert.equal(toCompany(db, eur.id, 125, '2026-01-15', 1), 100);

  // Company 2 has no specific rate, so it falls back to the shared rate (1.0).
  assert.equal(rateAt(db, eur.id, '2026-01-15', c2Id), 1.0);
  assert.equal(toCompany(db, eur.id, 125, '2026-01-15', c2Id), 125);

  // Company 3 uses its own specific rate (2.0).
  assert.equal(rateAt(db, eur.id, '2026-01-15', c3Id), 2.0);
  assert.equal(toCompany(db, eur.id, 200, '2026-01-15', c3Id), 100);

  // A later shared rate does not override earlier company-specific rate for Company 1.
  const rateRowsWithLaterShared = [
    ...rateRows,
    { date: '2026-02-01', rate: 1.1, company_id: null }, // shared rate updated later
  ];
  const dbLater = {
    ...db,
    records: {
      ...db.records,
      'res.currency': db.records['res.currency'].map((c) => (c.id === eur.id ? { ...c, rate_ids: rateRowsWithLaterShared } : c)),
    },
  };
  // As of 2026-02-15:
  // Company 1 still prefers its own company-1 rate on or before 2026-02-15 (1.25).
  assert.equal(rateAt(dbLater, eur.id, '2026-02-15', 1), 1.25);
  // Company 2 picks up the newer shared rate (1.1).
  assert.equal(rateAt(dbLater, eur.id, '2026-02-15', c2Id), 1.1);
});

test('the migration moves old global locks to company 1', () => {
  const db = seed();
  const legacyDb = {
    ...db,
    schema_version: 34,
    settings: {
      ...db.settings,
      lock_date: '2025-06-30',
      sale_lock_date: '2025-05-31',
      purchase_lock_date: '2025-04-30',
      hard_lock_date: '2025-03-31',
      tax_lock_dates: { 1: '2025-02-28' },
    },
  };

  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, 84);

  // Company 1 received the legacy global locks.
  const comp1 = read(migrated, 'res.company', 1);
  assert.equal(comp1.lock_date, '2025-06-30');
  assert.equal(comp1.sale_lock_date, '2025-05-31');
  assert.equal(comp1.purchase_lock_date, '2025-04-30');
  assert.equal(comp1.hard_lock_date, '2025-03-31');
  assert.equal(comp1.tax_lock_date, '2025-02-28');

  // Legacy lock keys were stripped from settings.
  assert.equal(migrated.settings.lock_date, undefined);
  assert.equal(migrated.settings.sale_lock_date, undefined);
  assert.equal(migrated.settings.purchase_lock_date, undefined);
  assert.equal(migrated.settings.hard_lock_date, undefined);
  assert.equal(migrated.settings.tax_lock_dates, undefined);
});

test('moving a draft entry into another company checks that company\'s closed fiscal year', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Closed-year company' });
  db = c2.db;
  const account = (code) => search(db, 'account.account').find((a) => a.code === code).id;
  const draft = { id: 9301, move_type: 'entry', company_id: 1, journal_id: null, date: '2025-06-01', state: 'draft',
    line_ids: [{ account_id: account('101401'), debit: 10, credit: 0 }, { account_id: account('400000'), debit: 0, credit: 10 }] };
  const year = { id: 9302, name: 'C2 2025', company_id: c2.id, date_from: '2025-01-01', date_to: '2025-12-31', state: 'closed' };
  db = { ...db, records: { ...db.records, 'account.move': [...db.records['account.move'], draft], 'account.fiscal.year': [...(db.records['account.fiscal.year'] ?? []), year] } };
  const after = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => (m.id === draft.id ? { ...m, company_id: c2.id, state: 'posted' } : m)) } };
  assert.throws(() => applyDiff(db, diffDb(db, after), { isAdmin: true }), /locked|closed/i);
});

test('a company rate stored with a text company id still wins for that company', () => {
  const c2 = createCompany(seed(), { name: 'Text id company' });
  const db = c2.db;
  const own = db.records['res.company'].find((c) => c.id === c2.id).currency_id;
  const foreign = db.records['res.currency'].find((c) => c.id !== own);
  const rate_ids = [{ date: '2026-01-01', rate: 2, company_id: null }, { date: '2026-01-01', rate: 5, company_id: String(c2.id) }];
  const next = { ...db, records: { ...db.records, 'res.currency': db.records['res.currency'].map((c) => (c.id === foreign.id ? { ...c, rate_ids } : c)) } };
  assert.notEqual(rateAt(next, foreign.id, '2026-02-01', c2.id), rateAt(next, foreign.id, '2026-02-01', 1));
});
