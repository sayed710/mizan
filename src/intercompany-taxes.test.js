import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, setActiveCompany, write } from './orm.js';
import { models } from './models/index.js';
import { createCompany, ensureMainCompany, interCompanyRules } from './models/company.js';
import { lineTaxOf, lineUntaxed } from './models/taxes.js';
import { seed } from './seed.js';

after(() => setActiveCompany(null));

const setup = () => {
  const main = ensureMainCompany(seed());
  const db = createCompany(main, { name: 'Buyer Co', currency_id: read(main, 'res.company', 1).currency_id, intercompany_rule: 'sale_purchase' }).db;
  const saleTax = search(db, 'account.tax').find((t) => t.type_tax_use === 'sale' && Number(t.amount) === 14 && !t.price_include);
  const purchaseTax = search(db, 'account.tax').find((t) => t.type_tax_use === 'purchase' && Number(t.amount) === 14 && !t.price_include);
  const withTaxes = write(db, 'product', 2, { company_id: null, tax_id: saleTax.id, supplier_tax_id: purchaseTax.id });
  return { db: withTaxes, saleTax, purchaseTax };
};

const sold = (db, line) => {
  const sale = create(db, 'sale.order', { company_id: 1, partner_id: read(db, 'res.company', 2).partner_id, order_line: [line] });
  const confirmed = write(sale.db, 'sale.order', sale.id, { state: 'sale' });
  const out = interCompanyRules(confirmed, sale.id);
  return read(out, 'purchase.order', read(out, 'sale.order', sale.id).auto_purchase_id);
};

test('the buyer gets its own purchase tax, not the seller\'s output VAT', () => {
  const { db, saleTax, purchaseTax } = setup();
  const line = { product_id: 2, qty: 3, price_unit: 100, discount: 0, tax_id: saleTax.id, tax: 14, tax_type: 'percent', tax_include: false, tax_account_id: saleTax.account_id, tax_cash_basis: false, tax_name: saleTax.name };
  const po = sold(db, line);
  const [l] = po.order_line;
  assert.equal(l.tax_id, purchaseTax.id);
  assert.equal(l.tax_account_id, purchaseTax.account_id);
  assert.notEqual(l.tax_account_id, saleTax.account_id);
  assert.equal(l.price_unit, 100);
  assert.equal(lineTaxOf(l), 42);
});

test('a price including the seller\'s VAT is bought at its net price', () => {
  const { db, purchaseTax } = setup();
  const included = search(db, 'account.tax').find((t) => t.type_tax_use === 'sale' && t.price_include) ?? null;
  const line = { product_id: 2, qty: 1, price_unit: 114, discount: 0, tax_id: included?.id ?? null, tax: 14, tax_type: 'percent', tax_include: true, tax_account_id: null, tax_cash_basis: false, tax_name: 'VAT 14% incl.' };
  const [l] = sold(db, line).order_line;
  assert.equal(l.tax_id, purchaseTax.id);
  assert.equal(l.price_unit, 100);
  assert.equal(lineTaxOf(l), 14);
});

test('a failing inter-company rule is reported on the sales order instead of swallowed', () => {
  const { db } = setup();
  const noContact = write(db, 'res.company', 1, { partner_id: null });
  const sale = create(noContact, 'sale.order', { company_id: 1, partner_id: read(db, 'res.company', 2).partner_id, order_line: [{ product_id: 2, qty: 1, price_unit: 10 }] });
  const confirm = models['sale.order'].form.buttons.find((b) => b.label === 'Confirm');
  const out = confirm.run(sale.db, read(sale.db, 'sale.order', sale.id)).db;
  assert.equal(read(out, 'sale.order', sale.id).state, 'sale');
  assert.ok(out.messages.some((m) => m.model === 'sale.order' && m.res_id === sale.id && /Inter-company purchase not created/.test(m.body)));
});

test('a fixed price-included purchase tax is added back to the bought price, discount included', () => {
  const { db } = setup();
  const fixed = create(db, 'account.tax', { name: 'Fixed levy', amount_type: 'fixed', amount: 5, type_tax_use: 'purchase', price_include: true });
  const withFixed = write(fixed.db, 'product', 2, { supplier_tax_id: fixed.id });
  const line = { product_id: 2, qty: 2, price_unit: 100, discount: 0, tax: 0, tax_type: 'percent', tax_include: false };
  const [l] = sold(withFixed, line).order_line;
  assert.equal(l.price_unit, 105);
  assert.equal(lineTaxOf(l), 10);
  assert.equal(Math.round(lineUntaxed(l) * 100) / 100, 200); // the untaxed value is what was sold
  const [d] = sold(withFixed, { ...line, discount: 50 }).order_line;
  assert.equal(Math.round(lineUntaxed(d) * 100) / 100, 100);
});

test('the seller contact\'s fiscal position stays on the purchase, so editing a line keeps the mapped tax', () => {
  const { db, saleTax, purchaseTax } = setup();
  const other = create(db, 'account.tax', { name: 'Mapped purchase tax', amount_type: 'percent', amount: 7, type_tax_use: 'purchase' });
  const fp = create(other.db, 'account.fiscal.position', { name: 'Seller position', tax_ids: [{ tax_src_id: purchaseTax.id, tax_dest_id: other.id }] });
  const seller = read(fp.db, 'res.company', 1).partner_id;
  const mapped = write(fp.db, 'res.partner', seller, { property_account_position_id: fp.id });
  const line = { product_id: 2, qty: 1, price_unit: 100, discount: 0, tax_id: saleTax.id, tax: 14, tax_type: 'percent', tax_include: false };
  const po = sold(mapped, line);
  assert.equal(po.fiscal_position_id, fp.id);
  assert.equal(po.order_line[0].tax_id, other.id);
  const edited = models['purchase.order'].fields.order_line.onchange({ ...po.order_line[0], product_id: 2 }, 'product_id', mapped, po);
  assert.equal(edited.tax_id, other.id);
});
