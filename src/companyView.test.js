import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { createCompany, ensureMainCompany, setCompanies } from './models/company.js';
import { actionRecords, companyViewDb, relationCandidates, viewRecords } from './companyView.js';
import { journalCards } from './models/finance.js';
import { applyDiff, diffDb } from './sync.js';

const fixture = () => {
  const main = ensureMainCompany(seed());
  let db = createCompany(main, { name: 'Branch', currency_id: read(main, 'res.company', 1).currency_id }).db;
  for (const company_id of [1, 2, null, false, '']) {
    db = create(db, 'product', { name: `Product ${company_id}`, company_id }).db;
  }
  return db;
};

test('view records keep shared and allowed companies, computed values and archive semantics immutably', () => {
  const db = setCompanies(fixture(), { current: 2, allowed: [2] });
  const snapshot = structuredClone(db);
  const records = viewRecords(db, 'product');
  assert.ok(records.some((r) => r.company_id === 2));
  assert.ok(records.some((r) => r.company_id === null));
  assert.ok(records.some((r) => r.company_id === false));
  assert.ok(records.some((r) => r.company_id === ''));
  assert.ok(records.every((r) => r.company_id !== 1));
  const id = records.find((r) => r.company_id === 2).id;
  const archived = write(db, 'product', id, { active: false });
  assert.ok(!viewRecords(archived, 'product').some((r) => r.id === id));
  assert.ok(viewRecords(archived, 'product', { includeArchived: true }).some((r) => r.id === id));
  const sale = create(db, 'sale.order', { company_id: 2, partner_id: 1, order_line: [{ product_id: 1, qty: 3, price_unit: 42 }] });
  assert.equal(viewRecords(sale.db, 'sale.order').find((r) => r.id === sale.id).amount_total, read(sale.db, 'sale.order', sale.id).amount_total);
  assert.ok(viewRecords(sale.db, 'sale.order').find((r) => r.id === sale.id).amount_total > 0);
  assert.deepEqual(db, snapshot);
});

test('company selection refreshes action records and counts while retaining domain and parent filters', () => {
  let db = fixture();
  for (const company_id of [1, 2]) db = create(db, 'crm.lead', { name: 'Scoped lead', company_id, partner_id: 1 }).db;
  const leaf = { model: 'crm.lead', domain: (r) => r.name === 'Scoped lead' };
  const rel = { field: 'partner_id', id: 1 };
  const main = setCompanies(db, { current: 1, allowed: [1] });
  const branch = setCompanies(db, { current: 2, allowed: [2] });
  const both = setCompanies(db, { current: 1, allowed: [1, 2] });
  assert.deepEqual(actionRecords(main, leaf, rel).map((r) => r.company_id), [1]);
  assert.deepEqual(actionRecords(branch, leaf, rel).map((r) => r.company_id), [2]);
  assert.equal(actionRecords(both, leaf, rel).length, 2);
  assert.equal(actionRecords(both, leaf, { ...rel, id: 99999 }).length, 0);
  const id = actionRecords(branch, leaf, rel)[0].id;
  const archived = write(branch, 'crm.lead', id, { active: false });
  assert.equal(actionRecords(archived, leaf, rel).length, 0);
  assert.deepEqual(actionRecords(archived, leaf, rel, true).map((r) => r.id), [id]);
  assert.equal(viewRecords(both, 'crm.lead').length, viewRecords(main, 'crm.lead').length + 1);
});

test('related candidates retain only the current foreign or archived value without duplicates', () => {
  const db = setCompanies(fixture(), { current: 1, allowed: [1] });
  const foreign = search(db, 'product').find((r) => r.company_id === 2);
  const candidates = relationCandidates(db, 'product', String(foreign.id));
  assert.ok(candidates.some((r) => r.id === foreign.id));
  assert.equal(candidates.filter((r) => r.company_id === 2).length, 1);
  const local = candidates.find((r) => r.company_id === 1);
  assert.equal(relationCandidates(db, 'product', local.id).filter((r) => r.id === local.id).length, 1);
  const archived = write(db, 'product', foreign.id, { active: false });
  assert.ok(relationCandidates(archived, 'product', foreign.id).some((r) => r.id === foreign.id));
  for (const value of [null, undefined, '', 99999]) {
    assert.deepEqual(relationCandidates(db, 'product', value), viewRecords(db, 'product'));
  }
});

test('dashboard snapshot filters every model without changing the source database', () => {
  let db = fixture();
  const journal = create(db, 'account.journal', { name: 'Shared sales', code: 'TEST', type: 'sale', company_id: null });
  db = journal.db;
  for (const company_id of [1, 2]) db = create(db, 'account.move', { company_id, journal_id: journal.id, move_type: 'out_invoice' }).db;
  db = setCompanies(db, { current: 2, allowed: [2] });
  const snapshot = structuredClone(db);
  const scoped = companyViewDb(db);
  for (const model of Object.keys(db.records)) {
    assert.deepEqual(search(scoped, model), viewRecords(db, model));
  }
  assert.ok(journalCards(scoped).every((c) => c.journal.company_id !== 1));
  assert.equal(journalCards(db).find((c) => c.journal.id === journal.id).draft, 2);
  assert.equal(journalCards(scoped).find((c) => c.journal.id === journal.id).draft, 1);
  assert.deepEqual(db, snapshot);
  assert.strictEqual(scoped.settings, db.settings);
});

test('uninitialized settings default to company one and models without company ownership remain visible', () => {
  const db = fixture();
  assert.ok(viewRecords(db, 'product').every((r) => r.company_id !== 2));
  assert.deepEqual(viewRecords(db, 'res.currency'), search(db, 'res.currency'));
});

test('company selection survives server synchronization and rejects invalid companies', () => {
  const db = fixture();
  const selected = setCompanies(db, { current: 2, allowed: [1, 2] });
  const synced = applyDiff(db, diffDb(db, selected), { isAdmin: false });
  assert.equal(synced.settings.current_company_id, 2);
  assert.deepEqual(synced.settings.allowed_company_ids, [1, 2]);
  assert.deepEqual(viewRecords(synced, 'product'), viewRecords(selected, 'product'));
  assert.throws(() => applyDiff(db, { settings: { current_company_id: 99999, allowed_company_ids: [99999] } }), /existing active companies/);
  assert.throws(() => applyDiff(db, { settings: { current_company_id: 2, allowed_company_ids: [1] } }), /including the current/);
});
