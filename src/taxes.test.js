import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { amounts } from './models/common.js';
import { accountId, isBalanced, journalItems } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { mapTax, productTax, taxSnapshot } from './models/taxes.js';
import { taxesByTax } from './models/finance.js';
import { seed } from './seed.js';

const taxNamed = (db, name, use = 'sale') => search(db, 'account.tax').find((t) => t.name === name && t.type_tax_use === use);
const line = (db, name, vals) => ({ product_id: 1, qty: 1, price_unit: 114, discount: 0, ...taxSnapshot(taxNamed(db, name)), ...vals });
const invoice = (db, lines, vals = {}) => {
  const { db: next, id } = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_line_ids: lines, ...vals });
  return { db: postMove(next, id), id };
};
const balanceOf = (db, code) => journalItems(db).filter((l) => l.account_id === accountId(db, code)).reduce((s, l) => s + l.credit - l.debit, 0);

test('a price-included tax is taken out of the price; a fixed tax is charged per unit', () => {
  const db = seed();
  assert.deepEqual(amounts([line(db, 'VAT 14% Included')]), { untaxed: 100, tax: 14, total: 114 });
  const stamp = amounts([line(db, 'Stamp Duty', { qty: 3, price_unit: 10 })]);
  assert.equal(stamp.tax, 15);
  assert.equal(stamp.total, 45);
});

test('posting books each tax on its account and the entry balances', () => {
  const { db, id } = invoice(seed(), [line(seed(), 'VAT 14% Included'), line(seed(), 'VAT 14%', { price_unit: 50 })]);
  const move = read(db, 'account.move', id);
  assert.ok(isBalanced(move.line_ids));
  const vat = move.line_ids.filter((l) => l.account_id === accountId(db, '251000'));
  // One line per tax, each naming it, so the tax return reads them from the ledger.
  assert.deepEqual(vat.map((l) => [l.tax_name, l.credit]).sort(), [['VAT 14% Included', 14], ['VAT 14%', 7]]);
  assert.equal(move.line_ids.find((l) => l.account_id === accountId(db, '121000')).debit, 171);
});

test('cash-basis tax waits on the transition account and is released as the invoice is paid', () => {
  const base = seed();
  const before = balanceOf(base, '251000');
  const { db, id } = invoice(base, [line(base, 'VAT 14% (Cash Basis)', { price_unit: 1000 })]);
  assert.equal(balanceOf(db, '251100'), 140);
  assert.equal(balanceOf(db, '251000'), before);
  const half = payMove(db, id, 570, '2026-03-10');
  assert.equal(balanceOf(half, '251100'), 70);
  assert.equal(balanceOf(half, '251000') - before, 70);
  const full = payMove(half, id, 570, '2026-03-20');
  assert.equal(balanceOf(full, '251100'), 0);
  assert.equal(Math.round((balanceOf(full, '251000') - before) * 100) / 100, 140);
});

test('the export fiscal position zero-rates product taxes and remaps accounts', () => {
  const db0 = seed();
  const exportFp = search(db0, 'account.fiscal.position').find((f) => f.name === 'Export');
  const vat = taxNamed(db0, 'VAT 14%');
  assert.equal(mapTax(db0, exportFp.id, vat.id), taxNamed(db0, '0% Exports').id);
  assert.equal(mapTax(db0, exportFp.id, taxNamed(db0, 'Stamp Duty').id), taxNamed(db0, 'Stamp Duty').id);
  // A product carrying only a 14% rate resolves to the VAT 14% record, then the fiscal position applies.
  const product = read(db0, 'product', 1);
  assert.equal(productTax(db0, product, 'sale', null).tax_id, vat.id);
  assert.equal(productTax(db0, product, 'sale', exportFp.id).tax, 0);
  const remapped = write(db0, 'account.fiscal.position', exportFp.id, { account_ids: [{ account_src_id: accountId(db0, '400000'), account_dest_id: accountId(db0, '450000') }] });
  const { db, id } = invoice(remapped, [line(remapped, '0% Exports', { price_unit: 200 })], { fiscal_position_id: exportFp.id });
  const lines = read(db, 'account.move', id).line_ids;
  assert.equal(lines.find((l) => l.credit).account_id, accountId(db, '450000'));
  assert.equal(lines.length, 2);
});

test('the line onchange applies the fiscal position to the product tax and a picked tax as is', () => {
  const db = seed();
  const lineDef = models['account.move'].fields.invoice_line_ids;
  const exportFp = search(db, 'account.fiscal.position').find((f) => f.name === 'Export');
  assert.equal(lineDef.onchange({ product_id: 1, qty: 1 }, 'product_id', db, { fiscal_position_id: exportFp.id }).tax, 0);
  const stamp = taxNamed(db, 'Stamp Duty');
  assert.equal(lineDef.onchange({ product_id: 1, tax_id: stamp.id }, 'tax_id', db, {}).tax_type, 'fixed');
  const fp = write(db, 'res.partner', 1, { property_account_position_id: exportFp.id });
  assert.equal(models['account.move'].onchange({ partner_id: 1 }, 'partner_id', fp).fiscal_position_id, exportFp.id);
});

test('the tax return lists base and tax per tax, refunds negative', () => {
  const base = seed();
  const { db } = invoice(base, [line(base, 'VAT 14%', { price_unit: 200 }), line(base, 'Stamp Duty', { qty: 2, price_unit: 10 })], { invoice_date: '2031-01-10' });
  const refund = create(db, 'account.move', { move_type: 'out_refund', partner_id: 1, invoice_date: '2031-01-12', invoice_line_ids: [line(db, 'VAT 14%', { price_unit: 50 })] });
  const rows = taxesByTax(postMove(refund.db, refund.id), { from: '2031-01-01', to: '2031-01-31' });
  assert.deepEqual(rows.find((r) => r.name === 'VAT 14%'), { side: 'sale', name: 'VAT 14%', base: 150, tax: 21 });
  assert.deepEqual(rows.find((r) => r.name === 'Stamp Duty'), { side: 'sale', name: 'Stamp Duty', base: 20, tax: 10 });
});
