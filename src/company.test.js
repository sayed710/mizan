import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { create, emptyDb, read, search, setActiveCompany, write } from './orm.js';
import { models } from './models/index.js';
import { accountingModels } from './models/accounting.js';
import { salesModels } from './models/sales.js';
import { profitAndLoss } from './models/ledger.js';
import { companyModels, companyFilter, createCompany, createForCompany, currentCompany, ensureMainCompany, interCompanyRules, setCompanies, withCompany } from './models/company.js';
import { seed } from './seed.js';

after(() => setActiveCompany(null));

test('records belong to the active company; shared master data stays visible', () => {
  const db0 = seed();
  setActiveCompany(2);
  const { db, id } = create(db0, 'crm.lead', { name: 'Branch lead' });
  assert.equal(read(db, 'crm.lead', id).company_id, 2);
  assert.deepEqual(search(db, 'crm.lead').map((l) => l.id), [id]);
  assert.equal(search(db, 'res.partner').length, search(db0, 'res.partner').length);
  assert.equal(profitAndLoss(db, {}).revenue, 0);
  assert.ok(read(db, 'crm.lead', 1));
  setActiveCompany(1);
  assert.ok(!search(db, 'crm.lead').some((l) => l.id === id));
  setActiveCompany(null);
  assert.equal(search(db, 'crm.lead').length, search(db0, 'crm.lead').length + 1);
});

const companies = () => {
  const main = ensureMainCompany(seed());
  return createCompany(main, { name: 'Buyer Co', currency_id: read(main, 'res.company', 1).currency_id, intercompany_rule: 'sale_purchase' }).db;
};

test('main company initialization preserves seed IDs, creates its contact and currency, and is idempotent', () => {
  const before = seed();
  const snapshot = structuredClone(before);
  const db = ensureMainCompany(before);
  const company = read(db, 'res.company', 1);
  assert.equal(company.name, 'Mizan Demo Co');
  assert.equal(company.active, true);
  assert.equal(company.intercompany_rule, 'none');
  assert.equal(read(db, 'res.partner', company.partner_id).name, company.name);
  assert.equal(read(db, 'res.partner', company.partner_id).company_id, null);
  assert.equal(read(db, 'res.currency', company.currency_id).name, before.settings.currency);
  assert.deepEqual(read(db, 'res.partner', 1), read(before, 'res.partner', 1));
  assert.strictEqual(ensureMainCompany(db), db);
  assert.deepEqual(before, snapshot);
  assert.strictEqual(models['res.company'], companyModels['res.company']);
  assert.ok(search(before, 'sale.order').length > 0);
  assert.ok(search(before, 'account.move').length > 0);
});

test('company wrapper preserves fields, defaults, forms and existing guards without changing its input', () => {
  const base = { ...salesModels, ...accountingModels, ...companyModels };
  const wrapped = withCompany(base);
  assert.notStrictEqual(wrapped, base);
  assert.equal(base['sale.order'].fields.company_id, undefined);
  for (const model of ['sale.order', 'account.move']) {
    assert.strictEqual(wrapped[model].form, base[model].form);
    for (const [key, field] of Object.entries(base[model].fields)) assert.strictEqual(wrapped[model].fields[key], field);
    const { company_id, ...defaults } = wrapped[model].defaults(9);
    assert.equal(company_id, 1);
    assert.deepEqual(defaults, base[model].defaults(9));
  }
  const guarded = withCompany({ 'sale.order': { fields: {}, defaults: () => ({ state: 'draft' }), guard: () => 'Original refusal' } });
  assert.equal(guarded['sale.order'].guard(emptyDb(), null, { company_id: 1 }), 'Original refusal');
  assert.strictEqual(wrapped['res.company'], base['res.company']);
});

test('database-local document defaults follow the selected company and products can remain shared', () => {
  const original = companies();
  const allowed = [1, 2];
  const db = setCompanies(original, { current: 2, allowed });
  assert.equal(currentCompany(original), 1);
  assert.equal(currentCompany(db), 2);
  assert.notStrictEqual(db.settings.allowed_company_ids, allowed);
  for (const model of ['sale.order', 'purchase.order', 'account.move', 'account.payment', 'account.journal', 'stock.picking', 'hr.employee', 'project.project', 'crm.lead', 'helpdesk.ticket']) {
    if (!models[model]) continue;
    const vals = Object.fromEntries(Object.entries({ name: 'New document', code: 'NEW', partner_id: 1 }).filter(([k]) => models[model].fields[k]));
    const result = createForCompany(db, model, vals);
    assert.equal(read(result.db, model, result.id).company_id, 2, model);
  }
  const owned = createForCompany(db, 'product', { name: 'Company product' });
  assert.equal(read(owned.db, 'product', owned.id).company_id, 2);
  const product = createForCompany(db, 'product', { name: 'Shared product', company_id: null });
  assert.equal(read(product.db, 'product', product.id).company_id, null);
  const explicit = createForCompany(db, 'sale.order', { partner_id: 1, company_id: 1 });
  assert.equal(read(explicit.db, 'sale.order', explicit.id).company_id, 1);
  assert.equal(models['sale.order'].defaults(99, db).company_id, 2);
  assert.throws(() => setCompanies(db, { current: 2, allowed: [1] }), /including the current/);
  assert.throws(() => setCompanies(db, { current: 3, allowed: [3] }), /existing active/);
  assert.throws(() => setCompanies(write(db, 'res.company', 2, { active: false }), { current: 2, allowed: [2] }), /existing active/);
});

test('company record rule keeps shared and allowed records without mutating the source', () => {
  const db = setCompanies(companies(), { current: 2, allowed: [2] });
  const records = [{ id: 1 }, { id: 2, company_id: null }, { id: 3, company_id: false }, { id: 4, company_id: '' }, { id: 5, company_id: 1 }, { id: 6, company_id: 2 }];
  assert.deepEqual(companyFilter(db, records).map((r) => r.id), [1, 2, 3, 4, 6]);
  assert.equal(records.length, 6);
  assert.deepEqual(companyFilter(setCompanies(db, { current: 1, allowed: [1, 2] }), records), records);
  assert.deepEqual(companyFilter(emptyDb(), records).map((r) => r.id), [1, 2, 3, 4, 5]);
});

test('check_company rejects foreign partners, products and journals on create and write', () => {
  let db = companies();
  db = write(db, 'res.partner', 1, { company_id: 2 });
  db = write(db, 'product', 1, { company_id: 2 });
  const journal = create(db, 'account.journal', { name: 'Buyer Bank', code: 'B2', company_id: 2 });
  db = journal.db;
  assert.throws(() => create(db, 'sale.order', { partner_id: 1, company_id: 1 }), /Customer.*this company/);
  assert.throws(() => create(db, 'sale.order', { partner_id: 2, company_id: 1, order_line: [{ product_id: 1, qty: 1 }] }), /Product.*this company/);
  assert.throws(() => create(db, 'account.move', { company_id: 1, journal_id: journal.id }), /Journal.*this company/);
  const sale = create(db, 'sale.order', { company_id: 1, partner_id: 2 });
  assert.throws(() => write(sale.db, 'sale.order', sale.id, { partner_id: 1 }), /this company/);
  assert.throws(() => write(sale.db, 'sale.order', sale.id, { order_line: [{ product_id: 1, qty: 1 }] }), /this company/);
  assert.equal(read(sale.db, 'sale.order', sale.id).partner_id, 2);
  assert.doesNotThrow(() => create(db, 'sale.order', { company_id: 2, partner_id: 1, order_line: [{ product_id: 1, qty: 1 }] }));
});

test('confirmed inter-company sale creates one linked draft purchase with the seller as vendor', () => {
  const db = write(companies(), 'product', 2, { company_id: null });
  const lines = [{ product_id: 2, qty: 3, price_unit: 42, discount: 5, tax: 14, qty_delivered: 1, qty_invoiced: 1 }];
  const sale = create(db, 'sale.order', { company_id: 1, partner_id: read(db, 'res.company', 2).partner_id, order_line: lines });
  assert.throws(() => interCompanyRules(sale.db, sale.id), /Confirm/);
  const confirmed = write(sale.db, 'sale.order', sale.id, { state: 'sale' });
  const snapshot = structuredClone(confirmed);
  const after = interCompanyRules(confirmed, sale.id);
  const order = read(after, 'sale.order', sale.id);
  const po = read(after, 'purchase.order', order.auto_purchase_id);
  assert.equal(po.company_id, 2);
  assert.equal(po.partner_id, read(after, 'res.company', 1).partner_id);
  assert.equal(po.auto_sale_id, sale.id);
  assert.equal(po.origin, order.name);
  assert.equal(po.state, 'draft');
  assert.deepEqual(po.order_line, [{ product_id: 2, qty: 3, price_unit: 42, discount: 5, tax: 14 }]);
  assert.strictEqual(interCompanyRules(after, sale.id), after);
  assert.equal(search(after, 'purchase.order').filter((p) => p.auto_sale_id === sale.id).length, 1);
  assert.deepEqual(confirmed, snapshot);
  const disabled = write(confirmed, 'res.company', 2, { intercompany_rule: 'none' });
  assert.strictEqual(interCompanyRules(disabled, sale.id), disabled);
  assert.throws(() => interCompanyRules(db, 99999), /not found/);
});

test('branches inherit their parent currency and reject inconsistent currencies and ancestry cycles', () => {
  const db = companies();
  const parent = read(db, 'res.company', 1);
  const branch = createCompany(db, { name: 'Branch', parent_id: 1, currency_id: 99999 });
  assert.equal(read(branch.db, 'res.company', branch.id).currency_id, parent.currency_id);
  assert.notEqual(read(branch.db, 'res.company', branch.id).partner_id, parent.partner_id);
  const otherCurrency = search(db, 'res.currency').find((c) => c.id !== parent.currency_id);
  assert.throws(() => write(branch.db, 'res.company', branch.id, { currency_id: otherCurrency.id }), /parent company currency/);
  assert.throws(() => write(branch.db, 'res.company', 1, { parent_id: branch.id }), /ancestor/);
  assert.throws(() => write(branch.db, 'res.company', 1, { currency_id: otherCurrency.id }), /Branches must share/);
  assert.throws(() => createCompany(db, { name: 'Bad parent', parent_id: 99999 }), /existing parent/);
  assert.throws(() => createCompany(db, { name: 'Duplicate contact', partner_id: parent.partner_id }), /own contact/);
});

test('confirming a sale to an inter-company customer drafts the linked purchase', () => {
  const db = write(companies(), 'product', 2, { company_id: null });
  const sale = create(db, 'sale.order', { company_id: 1, partner_id: read(db, 'res.company', 2).partner_id, order_line: [{ product_id: 2, qty: 1, price_unit: 10 }] });
  const confirm = models['sale.order'].form.buttons.find((b) => b.label === 'Confirm');
  const after = confirm.run(sale.db, read(sale.db, 'sale.order', sale.id)).db;
  const order = read(after, 'sale.order', sale.id);
  assert.equal(order.state, 'sale');
  assert.equal(read(after, 'purchase.order', order.auto_purchase_id).auto_sale_id, sale.id);
});
