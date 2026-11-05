import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { createCompany, restrictRecords } from './models/company.js';
import { applyDiff } from './sync.js';

test('company-restricted users cannot read or change foreign accounting configuration', () => {
  let db = createCompany(seed(), { name: 'Branch', currency_id: seed().records['res.company'][0].currency_id }).db;
  const branchTax = create(db, 'account.tax', { name: 'Branch Tax', amount: 15, company_id: 2, type_tax_use: 'sale' });
  db = branchTax.db;
  const branchFp = create(db, 'account.fiscal.position', { name: 'Branch Fiscal Pos', company_id: 2 });
  db = branchFp.db;
  const branchTerm = create(db, 'account.payment.term', { name: 'Branch Term', company_id: 2 });
  db = branchTerm.db;
  const sharedTax = create(db, 'account.tax', { name: 'Shared Tax', amount: 5, company_id: null, type_tax_use: 'sale' });
  db = sharedTax.db;

  const onlyMain = new Set([1]);
  const restricted = restrictRecords(db, onlyMain).records;

  // Cannot read Company 2 configuration
  assert.ok(!restricted['account.tax'].some((t) => t.id === branchTax.id));
  assert.ok(!restricted['account.fiscal.position'].some((f) => f.id === branchFp.id));
  assert.ok(!restricted['account.payment.term'].some((p) => p.id === branchTerm.id));
  // Shared configuration is readable
  assert.ok(restricted['account.tax'].some((t) => t.id === sharedTax.id));

  // Cannot modify Company 2 configuration through applyDiff
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.tax': [{ id: branchTax.id, name: 'Hacked Tax', company_id: 2, amount: 20 }] } }, { companies: onlyMain }),
    /No access to this company's account\.tax records/
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.fiscal.position': [{ id: branchFp.id, name: 'Hacked FP', company_id: 2 }] } }, { companies: onlyMain }),
    /No access to this company's account\.fiscal\.position records/
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.payment.term': [{ id: branchTerm.id, name: 'Hacked Term', company_id: 2 }] } }, { companies: onlyMain }),
    /No access to this company's account\.payment\.term records/
  );

  // Cannot delete Company 2 configuration through applyDiff
  assert.throws(
    () => applyDiff(db, { deletes: { 'account.tax': [branchTax.id] } }, { companies: onlyMain }),
    /No access to this company's account\.tax records/
  );
  assert.throws(
    () => applyDiff(db, { deletes: { 'account.fiscal.position': [branchFp.id] } }, { companies: onlyMain }),
    /No access to this company's account\.fiscal\.position records/
  );
  assert.throws(
    () => applyDiff(db, { deletes: { 'account.payment.term': [branchTerm.id] } }, { companies: onlyMain }),
    /No access to this company's account\.payment\.term records/
  );

  // Company 1 configuration is neither readable nor changeable by a Company 2 user
  const branchUser = new Set([2]);
  const legacyTax = create(db, 'account.tax', { name: 'Legacy Tax', company_id: 1, amount: 10, type_tax_use: 'sale' });
  db = legacyTax.db;
  assert.ok(!restrictRecords(db, branchUser).records['account.tax'].some((t) => t.id === legacyTax.id));
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.tax': [{ id: legacyTax.id, name: 'Hacked Legacy', company_id: 1 }] } }, { companies: branchUser }),
    /No access to this company's account\.tax records/
  );
  assert.throws(
    () => applyDiff(db, { deletes: { 'account.tax': [legacyTax.id] } }, { companies: branchUser }),
    /No access to this company's account\.tax records/
  );

  // User with access to Company 2 can read and update Company 2 configuration
  const branchTaxRec = read(db, 'account.tax', branchTax.id);
  const updated = applyDiff(db, { upserts: { 'account.tax': [{ ...branchTaxRec, name: 'Branch Tax Updated', company_id: 2, amount: 16 }] } }, { companies: branchUser });
  assert.equal(read(updated, 'account.tax', branchTax.id).name, 'Branch Tax Updated');
});
