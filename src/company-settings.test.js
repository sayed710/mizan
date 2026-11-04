import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
import { read, search, write } from './orm.js';
import { createCompany, renameCompany } from './models/company.js';
import { seed } from './seed.js';
import { publicSite } from '../server/api.js';

test('renaming the company in settings renames the company record that documents and the navbar read', () => {
  const db = seed();
  const renamed = renameCompany(db, 1, 'Renamed Trading LLC');
  assert.equal(read(renamed, 'res.company', 1).name, 'Renamed Trading LLC');
  assert.equal(renamed.settings.company, 'Renamed Trading LLC');
  assert.throws(() => renameCompany(db, 1, ''), /required/);
});

test('company rename updates its automatic vendor contact but preserves a customized contact name', () => {
  const company = createCompany(seed(), { name: 'Original Seller' });
  const contactId = read(company.db, 'res.company', company.id).partner_id;
  const renamed = renameCompany(company.db, company.id, 'Renamed Seller');
  assert.equal(read(renamed, 'res.partner', contactId).name, 'Renamed Seller');
  const customized = write(company.db, 'res.partner', contactId, { name: 'Independent Vendor Name' });
  assert.equal(read(renameCompany(customized, company.id, 'Another Seller Name'), 'res.partner', contactId).name, 'Independent Vendor Name');
});

test('public site data and customer document content resolve company currency and website company', () => {
  const db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const dbEur = write(db, 'res.company', 1, { currency_id: eur.id });
  const site = publicSite(dbEur);
  assert.equal(site.currency, 'EUR');
  assert.equal(site.company, read(dbEur, 'res.company', 1).name);
});

test('in fallback mode without res.company records, company branding and settings stay in sync', async () => {
  const { currentCompany } = await import('./store.js');
  const base = seed();
  const noComp = { ...base, records: { ...base.records, 'res.company': [] }, settings: { ...base.settings, company: 'Legacy Fallback', companies: [{ id: 1, name: 'Legacy Fallback', currency: 'USD' }] } };
  assert.equal(currentCompany(noComp).name, 'Legacy Fallback');
  const updatedCompanies = (noComp.settings?.companies ?? []).map((c) => (c.id === 1 ? { ...c, name: 'Renamed Fallback', currency: 'EUR' } : c));
  const updated = { ...noComp, settings: { ...noComp.settings, company: 'Renamed Fallback', currency: 'EUR', companies: updatedCompanies } };
  assert.equal(currentCompany(updated).name, 'Renamed Fallback');
  assert.equal(currentCompany(updated).currency, 'EUR');
});
