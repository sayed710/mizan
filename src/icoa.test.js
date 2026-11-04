import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { createCompany } from './models/company.js';
import { postMove, accountingModels } from './models/accounting.js';
import { salesModels } from './models/sales.js';

const setup = () => {
  const db = seed();
  return createCompany(db, { name: 'Other', currency_id: db.records['res.company'][0].currency_id });
};

test('manual posting rejects foreign company accounts', () => {
  const company = setup();
  const account = create(company.db, 'account.account', { name: 'Foreign', code: 'X999', account_type: 'expense', company_id: company.id });
  const move = create(account.db, 'account.move', { move_type: 'entry', company_id: 1, line_ids: [{ account_id: account.id, debit: 10 }, { account_id: account.id, credit: 10 }] });
  assert.throws(() => postMove(move.db, move.id), /account.*another company/i);
  assert.notEqual(read(move.db, 'account.move', move.id).state, 'posted');
});

test('invoice rejects foreign account even when a local account has the same code', () => {
  const company = setup();
  const local = create(company.db, 'account.account', { name: 'Local', code: 'X998', account_type: 'income', company_id: 1 });
  const foreign = create(local.db, 'account.account', { name: 'Foreign', code: 'X998', account_type: 'income', company_id: company.id });
  const move = create(foreign.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 10, account_id: foreign.id }] });
  assert.throws(() => postMove(move.db, move.id), /account.*company/i);
});

test('invoice rejects foreign taxes on selection and posting', () => {
  const company = setup();
  const tax = create(company.db, 'account.tax', { name: 'Foreign tax', amount: 10, company_id: company.id });
  const lineField = accountingModels['account.move'].fields.invoice_line_ids;
  assert.throws(() => lineField.onchange({ tax_id: tax.id }, 'tax_id', tax.db, { company_id: 1 }), /tax.*another company/i);
  const move = create(tax.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 10, tax_id: tax.id, tax: 10 }] });
  assert.throws(() => postMove(move.db, move.id), /tax.*another company/i);
});

test('product tax selection rejects a foreign tax', () => {
  const company = setup();
  const tax = create(company.db, 'account.tax', { name: 'Foreign', amount: 10, company_id: company.id });
  const product = create(tax.db, 'product', { name: 'Taxed product', list_price: 100, tax_id: tax.id });
  const field = accountingModels['account.move'].fields.invoice_line_ids;
  assert.throws(() => field.onchange({ product_id: product.id, qty: 1 }, 'product_id', product.db, { company_id: 1, move_type: 'out_invoice' }), /tax.*another company/i);
});

test('mapped product tax retains its source for posting validation', () => {
  const company = setup();
  const source = create(company.db, 'account.tax', { name: 'Source', amount: 10, company_id: null });
  const dest = create(source.db, 'account.tax', { name: 'Destination', amount: 5, company_id: null });
  const fp = create(dest.db, 'account.fiscal.position', { name: 'Mapping', company_id: 1, tax_ids: [{ tax_src_id: source.id, tax_dest_id: dest.id }] });
  const product = create(fp.db, 'product', { name: 'Taxed product', list_price: 100, tax_id: source.id });
  const field = accountingModels['account.move'].fields.invoice_line_ids;
  const line = field.onchange({ product_id: product.id, qty: 1 }, 'product_id', product.db, { company_id: 1, move_type: 'out_invoice', fiscal_position_id: fp.id });
  assert.equal(line.tax_id, dest.id);
  assert.equal(line.tax_source_id, source.id);
  const move = create(product.db, 'account.move', { company_id: 1, move_type: 'out_invoice', partner_id: 1, fiscal_position_id: fp.id, invoice_line_ids: [line] });
  const changed = write(move.db, 'account.tax', source.id, { company_id: company.id });
  assert.throws(() => postMove(changed, move.id), /tax.*another company/i);
  const foreignDest = write(move.db, 'account.tax', dest.id, { company_id: company.id });
  assert.throws(() => field.onchange({ product_id: product.id, qty: 1 }, 'product_id', foreignDest, { company_id: 1, move_type: 'out_invoice', fiscal_position_id: fp.id }), /tax.*another company/i);
});

test('changing invoice company recomputes fiscal position and remaps product taxes', () => {
  const company = setup();
  const partner = create(company.db, 'res.partner', { name: 'Customer', country: 'ZZ' });
  const source = create(partner.db, 'account.tax', { name: 'Source', amount: 10, company_id: null });
  const dest = create(source.db, 'account.tax', { name: 'Destination', amount: 5, company_id: null });
  const fp1 = create(dest.db, 'account.fiscal.position', { name: 'First', auto_apply: true, country: 'ZZ', company_id: 1 });
  const fp2 = create(fp1.db, 'account.fiscal.position', { name: 'Second', auto_apply: true, country: 'ZZ', company_id: company.id, tax_ids: [{ tax_src_id: source.id, tax_dest_id: dest.id }] });
  const product = create(fp2.db, 'product', { name: 'Product', list_price: 100, tax_id: source.id });
  const result = accountingModels['account.move'].onchange({ partner_id: partner.id, company_id: company.id, move_type: 'out_invoice', fiscal_position_id: fp1.id, invoice_line_ids: [{ product_id: product.id, qty: 2, price_unit: 77, discount: 3 }] }, 'company_id', product.db);
  assert.equal(result.fiscal_position_id, fp2.id);
  assert.equal(result.invoice_line_ids[0].tax_id, dest.id);
  assert.equal(result.invoice_line_ids[0].tax_source_id, source.id);
  assert.equal(result.invoice_line_ids[0].price_unit, 77);
});

test('group tax selection rejects a foreign component', () => {
  const company = setup();
  const child = create(company.db, 'account.tax', { name: 'Foreign child', amount: 10, company_id: company.id });
  const group = create(child.db, 'account.tax', { name: 'Group', amount_type: 'group', children_tax_ids: [child.id], company_id: null });
  const field = accountingModels['account.move'].fields.invoice_line_ids;
  assert.throws(() => field.onchange({ tax_id: group.id }, 'tax_id', group.db, { company_id: 1 }), /tax.*another company/i);
  assert.throws(() => field.onchange({ tax_ids: [group.id] }, 'tax_ids', group.db, { company_id: 1 }), /tax.*another company/i);
});

test('changing sales order company selects its position and remaps taxes', () => {
  const company = setup();
  const partner = create(company.db, 'res.partner', { name: 'Customer', country: 'ZZ' });
  const source = create(partner.db, 'account.tax', { name: 'Source', amount: 10, company_id: null });
  const dest = create(source.db, 'account.tax', { name: 'Destination', amount: 5, company_id: null });
  const fp = create(dest.db, 'account.fiscal.position', { name: 'Second', auto_apply: true, country: 'ZZ', company_id: company.id, tax_ids: [{ tax_src_id: source.id, tax_dest_id: dest.id }] });
  const product = create(fp.db, 'product', { name: 'Product', list_price: 100, tax_id: source.id });
  const result = salesModels['sale.order'].onchange({ partner_id: partner.id, company_id: company.id, order_line: [{ product_id: product.id, qty: 1, price_unit: 77 }] }, 'company_id', product.db);
  assert.equal(result.fiscal_position_id, fp.id);
  assert.equal(result.order_line[0].tax_id, dest.id);
  assert.equal(result.order_line[0].tax_source_id, source.id);
  assert.equal(result.order_line[0].price_unit, 77);
});

test('invoice fiscal position default filters company before ranking', () => {
  const company = setup();
  const partner = create(company.db, 'res.partner', { name: 'Customer', country: 'ZZ' });
  const foreign = create(partner.db, 'account.fiscal.position', { name: 'Foreign', auto_apply: true, country: 'ZZ', sequence: 1, company_id: company.id });
  const local = create(foreign.db, 'account.fiscal.position', { name: 'Local', auto_apply: true, country: 'ZZ', sequence: 10, company_id: 1 });
  const result = accountingModels['account.move'].onchange({ partner_id: partner.id, company_id: 1, move_type: 'out_invoice' }, 'partner_id', local.db);
  assert.equal(result.fiscal_position_id, local.id);
});
