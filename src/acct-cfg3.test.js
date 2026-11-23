import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { applyDiff, diffDb } from './sync.js';
import { createCompany, setCompanies } from './models/company.js';

test('Domestic taxes have no fiscal position or include the company domestic position', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { country: 'Egypt' });
  const fpDomestic = create(db, 'account.fiscal.position', { name: 'Domestic Egypt', country: 'Egypt', company_id: 1 });
  db = fpDomestic.db;
  const fpExport = create(db, 'account.fiscal.position', { name: 'Export Europe', country: 'France', company_id: 1 });
  db = fpExport.db;

  const filter = models['account.tax'].filters.flat().find((f) => f.id === 'domestic');
  assert.equal(filter.fn({ company_id: 1, fiscal_position_ids: [] }, db), true);
  assert.equal(filter.fn({ company_id: 1, fiscal_position_ids: [fpDomestic.id, fpExport.id] }, db), true);
  assert.equal(filter.fn({ company_id: 1, fiscal_position_ids: [fpExport.id] }, db), false);

  // Persisting an explicit domestic_fiscal_position_id on res.company is respected
  const dbWithExplicit = write(db, 'res.company', 1, { domestic_fiscal_position_id: fpExport.id });
  assert.equal(filter.fn({ company_id: 1, fiscal_position_ids: [fpExport.id] }, dbWithExplicit), true);
});

test('ledger group names are globally unique, including through sync', () => {
  let db = seed();
  const first = create(db, 'account.journal.group', { name: 'IFRS', company_id: 1 });
  db = first.db;
  assert.throws(() => create(db, 'account.journal.group', { name: 'IFRS', company_id: 1 }), /A Ledger group name must be unique\./);
  const second = create(db, 'account.journal.group', { name: 'Local', company_id: 1 });
  const raw = diffDb(db, second.db);
  raw.upserts['account.journal.group'][0].name = 'IFRS';
  assert.throws(() => applyDiff(db, raw, { isAdmin: true }), /A Ledger group name must be unique\./);
});

test('unrelated edits to legacy duplicate ledger groups succeed while name changes enforce uniqueness', () => {
  let db = seed();
  const g1 = create(db, 'account.journal.group', { name: 'IFRS', company_id: 1 });
  db = g1.db;
  // Simulate a legacy database that already contains duplicate ledger group names
  const g2Id = (db.seq['account.journal.group'] ?? 1) + 1;
  db = {
    ...db,
    seq: { ...db.seq, 'account.journal.group': g2Id },
    records: {
      ...db.records,
      'account.journal.group': [
        ...(db.records['account.journal.group'] ?? []),
        { id: g2Id, name: 'IFRS', sequence: 10, company_id: 1, journal_ids: [] },
      ],
    },
  };

  // Unrelated edit to sequence on g2 must succeed
  const updatedSeq = write(db, 'account.journal.group', g2Id, { sequence: 20 });
  assert.equal(read(updatedSeq, 'account.journal.group', g2Id).sequence, 20);

  // Unrelated edit to journal_ids on g1 must succeed
  const saleJ = search(db, 'account.journal').find((j) => j.code === 'INV');
  const updatedJ = write(updatedSeq, 'account.journal.group', g1.id, { journal_ids: [saleJ.id] });
  assert.deepEqual(read(updatedJ, 'account.journal.group', g1.id).journal_ids, [saleJ.id]);

  // Creating a new duplicate group still fails
  assert.throws(() => create(updatedJ, 'account.journal.group', { name: 'IFRS', company_id: 1 }), /A Ledger group name must be unique\./);

  // Renaming an existing group to an existing name fails
  const g3 = create(updatedJ, 'account.journal.group', { name: 'Local', company_id: 1 });
  assert.throws(() => write(g3.db, 'account.journal.group', g3.id, { name: 'IFRS' }), /A Ledger group name must be unique\./);
});

test('shared taxes without company_id resolve domestic position using the active company', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { country: 'Egypt' });
  const fpCo1 = create(db, 'account.fiscal.position', { name: 'Egypt Domestic', country: 'Egypt', company_id: 1 });
  db = fpCo1.db;

  const co2 = createCompany(db, { name: 'UAE Branch', country: 'UAE' });
  db = co2.db;
  const fpCo2 = create(db, 'account.fiscal.position', { name: 'UAE Domestic', country: 'UAE', company_id: co2.id });
  db = fpCo2.db;

  const sharedTaxCo1Fp = { name: 'Shared Tax Egypt FP', company_id: null, fiscal_position_ids: [fpCo1.id] };
  const sharedTaxCo2Fp = { name: 'Shared Tax UAE FP', company_id: null, fiscal_position_ids: [fpCo2.id] };
  const filter = models['account.tax'].filters.flat().find((f) => f.id === 'domestic');

  // When Company 1 is active
  const dbCo1Active = setCompanies(db, { current: 1, allowed: [1, co2.id] });
  assert.equal(filter.fn(sharedTaxCo1Fp, dbCo1Active), true, 'shared tax with co1 domestic fp is domestic when co1 is active');
  assert.equal(filter.fn(sharedTaxCo2Fp, dbCo1Active), false, 'shared tax with co2 domestic fp is not domestic when co1 is active');

  // When Company 2 is active
  const dbCo2Active = setCompanies(db, { current: co2.id, allowed: [1, co2.id] });
  assert.equal(filter.fn(sharedTaxCo1Fp, dbCo2Active), false, 'shared tax with co1 domestic fp is not domestic when co2 is active');
  assert.equal(filter.fn(sharedTaxCo2Fp, dbCo2Active), true, 'shared tax with co2 domestic fp is domestic when co2 is active');
});
