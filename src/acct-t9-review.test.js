import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, setActiveCompany, write } from './orm.js';
import { seed } from './seed.js';
import { invoiceTaxTotals } from './models/ledger.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { cartTotals } from './models/shop.js';
import { publicCart, publicOrder } from '../server/api.js';

const groupAmounts = (totals) => totals.subtotals.flatMap((s) => s.groups.map((g) => [g.name, g.amount]));
const breakdownTax = (totals) => groupAmounts(totals).reduce((s, [, amount]) => Math.round((s + amount) * 100) / 100, 0);

const invoice = (db, lines, extra = {}) => {
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_line_ids: lines, ...extra });
  return { db: inv.db, move: read(inv.db, 'account.move', inv.id) };
};

test('tax breakdown matches the stored tax under global rounding for rate-only lines of different rates', () => {
  const db = write(seed(), 'res.company', 1, { tax_calculation_rounding_method: 'round_globally' });
  const taxAcc = search(db, 'account.account').find((a) => a.code === '251000').id;
  // Lines from before taxes had records keep only a rate, so their 0.5% and 1.5% taxes share one grouping key.
  const { move } = invoice(db, [
    { product_id: 1, qty: 1, price_unit: 1, tax: 0.5, tax_account_id: taxAcc },
    { product_id: 1, qty: 1, price_unit: 1, tax: 1.5, tax_account_id: taxAcc },
  ]);
  const totals = invoiceTaxTotals(db, move);
  assert.equal(breakdownTax(totals), move.amount_tax);
  assert.equal(totals.tax, move.amount_tax);
});

test('a zero-net reverse-charge tax shows no tax in the breakdown when biggest-tax cash rounding is set', () => {
  let db = seed();
  const [accIn, accOut] = search(db, 'account.account').filter((a) => ['251000', '250100'].includes(a.code)).map((a) => a.id);
  const tagIn = create(db, 'account.account.tag', { name: '+RC', applicability: 'taxes' });
  const tagOut = create(tagIn.db, 'account.account.tag', { name: '-RC', applicability: 'taxes' });
  db = tagOut.db;
  const rows = [
    { repartition_type: 'base', factor_percent: 100, account_id: null, tag_ids: [] },
    { repartition_type: 'tax', factor_percent: 100, account_id: accIn, tag_ids: [tagIn.id] },
    { repartition_type: 'tax', factor_percent: -100, account_id: accOut, tag_ids: [tagOut.id] },
  ];
  const tax = create(db, 'account.tax', { name: 'Reverse Charge 15%', type_tax_use: 'sale', amount: 15, invoice_repartition_line_ids: rows, refund_repartition_line_ids: rows });
  const rounding = create(tax.db, 'account.cash.rounding', { name: '0.05 biggest tax', rounding: 0.05, rounding_method: 'HALF-UP', strategy: 'biggest_tax' });
  db = rounding.db;
  const { move } = invoice(db, [{ product_id: 1, qty: 1, price_unit: 10.03, ...taxSnapshot(read(db, 'account.tax', tax.id)) }], { invoice_cash_rounding_id: rounding.id });
  assert.equal(move.amount_tax, 0);
  const totals = invoiceTaxTotals(db, move);
  assert.deepEqual(groupAmounts(totals), []);
  assert.equal(totals.tax, 0);
});

test('lines keeping an older tax group snapshot are shown under that group, not merged into the new one', () => {
  let db = seed();
  const taxAcc = search(db, 'account.account').find((a) => a.code === '251000').id;
  const oldGroup = create(db, 'account.tax.group', { name: 'Old VAT', sequence: 10 });
  const newGroup = create(oldGroup.db, 'account.tax.group', { name: 'New VAT', sequence: 20 });
  const tax = create(newGroup.db, 'account.tax', { name: 'VAT 10%', type_tax_use: 'sale', amount: 10, tax_group_id: oldGroup.id, ...defaultTaxRepartitionLines(taxAcc) });
  db = tax.db;
  const before = taxSnapshot(read(db, 'account.tax', tax.id));
  db = write(db, 'account.tax', tax.id, { tax_group_id: newGroup.id });
  const after = taxSnapshot(read(db, 'account.tax', tax.id));
  const { move } = invoice(db, [
    { product_id: 1, qty: 1, price_unit: 100, ...before },
    { product_id: 1, qty: 1, price_unit: 200, ...after },
  ]);
  assert.deepEqual(groupAmounts(invoiceTaxTotals(db, move)), [['Old VAT', 10], ['New VAT', 20]]);
});

test('a country group made in one company can be chosen from another company', () => {
  const db = seed();
  setActiveCompany(2);
  let made;
  try {
    made = create(db, 'res.country.group', { name: 'GCC', country_ids: ['Saudi Arabia', 'United Arab Emirates'] });
  } finally {
    setActiveCompany(null);
  }
  setActiveCompany(1);
  try {
    assert.ok(search(made.db, 'res.country.group').some((g) => g.id === made.id));
  } finally {
    setActiveCompany(null);
  }
});

test('website cart and checkout apply a state-scoped fiscal position from the buyer state and keep the state', () => {
  let db = seed();
  const saleTax = db.records['account.tax'].find((t) => t.type_tax_use === 'sale' && Number(t.amount) === 14 && !t.price_include);
  const fp = create(db, 'account.fiscal.position', { name: 'Alexandria Zone', auto_apply: true, sequence: 1, country: 'Egypt', state_ids: ['Alexandria'] });
  const mapped = create(fp.db, 'account.tax', { name: 'Alexandria 0%', amount_type: 'percent', amount: 0, type_tax_use: 'sale', fiscal_position_ids: [fp.id], original_tax_ids: [saleTax.id] });
  db = write(mapped.db, 'product', 1, { tax_id: saleTax.id });
  const lines = [{ product_id: 1, qty: 1 }];
  assert.equal(cartTotals(db, lines, { partnerCountry: 'Egypt', partnerState: 'Alexandria' }).orderLines[0].tax_id, mapped.id);
  assert.equal(cartTotals(db, lines, { partnerCountry: 'Egypt', partnerState: 'Giza' }).orderLines[0].tax_id, saleTax.id);
  const preview = publicCart(db, { lines, country: 'Egypt', state: 'Alexandria' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.tax, 0);
  const buyer = { name: 'Alex Buyer', email: 'alex@example.com', street: '1 Corniche', city: 'Alexandria', state: 'Alexandria', country: 'Egypt' };
  const order = publicOrder(db, { ...buyer, lines, carrier_id: 1, provider_code: 'wire' });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const sale = search(order.db, 'sale.order').find((o) => o.name === order.body.order);
  assert.equal(sale.order_line.find((l) => l.product_id === 1).tax_id, mapped.id);
  assert.equal(read(order.db, 'res.partner', sale.partner_id).state, 'Alexandria');
  assert.equal(sale.fiscal_position_id, fp.id, 'the order keeps the position so its invoice maps accounts too');
});
