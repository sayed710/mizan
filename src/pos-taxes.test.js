import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { amounts } from './models/common.js';
import { accountId, isBalanced, postEntry } from './models/ledger.js';
import { payOrder, priceLines, refundOrder, startSession } from './models/pos.js';
import { seed } from './seed.js';

const entryOf = (db, orderId) => {
  const ids = new Set(read(db, 'pos.order', orderId).accounting_entries.map((entry) => entry.move_id));
  const journal = search(db, 'account.journal').find((j) => j.code === 'POSS')?.id;
  return search(db, 'account.move').find((m) => ids.has(m.id) && m.journal_id === journal);
};
const sum = (move, db, code, key) => move.line_ids.filter((l) => l.account_id === accountId(db, code)).reduce((s, l) => s + l[key], 0);
const tenderSum = (orderId, db, code, key) => {
  const ids = new Set(read(db, 'pos.order', orderId).accounting_entries.map((entry) => entry.move_id));
  return search(db, 'account.move').filter((m) => ids.has(m.id)).reduce((total, m) => total + sum(m, db, code, key), 0);
};

const withIncludedTax = () => {
  const db0 = startSession(seed(), 0).db;
  const vat = search(db0, 'account.tax').find((t) => t.type_tax_use === 'sale' && Number(t.amount) === 14 && !t.price_include);
  const incl = create(db0, 'account.tax', { name: 'VAT 14% incl.', type_tax_use: 'sale', amount: 14, amount_type: 'percent', price_include: true, account_id: vat.account_id, tax_exigibility: 'on_invoice', active: true });
  return { db: write(incl.db, 'product', 1, { list_price: 114, tax_id: incl.id }), tax: incl.id };
};

test('a price including VAT is charged as is: 114 with 14 of tax, not 129.96', () => {
  const { db, tax } = withIncludedTax();
  const lines = priceLines(db, [{ product_id: 1, qty: 1 }]);
  assert.equal(lines[0].tax_id, tax);
  assert.deepEqual(amounts(lines), { untaxed: 100, tax: 14, total: 114 });
  const sale = payOrder(db, { lines, method: 'cash' });
  const entry = entryOf(sale.db, sale.id);
  assert.ok(isBalanced(entry.line_ids));
  assert.equal(tenderSum(sale.id, sale.db, '101501', 'debit'), 114);
  assert.equal(sum(entry, sale.db, '251000', 'credit'), 14);
});

test('the product income account and the tax account of the tax record are used', () => {
  const { db: db0 } = withIncludedTax();
  const other = search(db0, 'account.account').find((a) => a.code === '450000');
  const db = write(db0, 'product', 1, { property_account_income_id: other.id });
  const sale = payOrder(db, { lines: priceLines(db, [{ product_id: 1, qty: 2 }]), method: 'card' });
  const entry = entryOf(sale.db, sale.id);
  assert.equal(sum(entry, sale.db, '450000', 'credit'), 200);
  assert.equal(sum(entry, sale.db, '400000', 'credit'), 0);
  assert.equal(tenderSum(sale.id, sale.db, '101401', 'debit'), 228);
});

test('tender assertions exclude unrelated entries with the same order reference', () => {
  const { db } = withIncludedTax();
  const sale = payOrder(db, { lines: priceLines(db, [{ product_id: 1, qty: 1 }]), method: 'cash' });
  const order = read(sale.db, 'pos.order', sale.id);
  const unrelated = postEntry(sale.db, { journal: 'CSH1', ref: order.name, lines: [
    { account: '101501', debit: 7 }, { account: '121000', credit: 7 },
  ] });
  assert.equal(tenderSum(sale.id, unrelated.db, '101501', 'debit'), 114);
});

test('the customer\'s fiscal position maps the tax', () => {
  const { db: db0, tax } = withIncludedTax();
  const fp = create(db0, 'account.fiscal.position', { name: 'Export', tax_ids: [{ tax_src_id: tax, tax_dest_id: null }] });
  const db = write(fp.db, 'res.partner', 3, { property_account_position_id: fp.id });
  const lines = priceLines(db, [{ product_id: 1, qty: 1 }], 3);
  assert.equal(amounts(lines).tax, 0);
});

test('a refund reverses the same accounts', () => {
  const { db } = withIncludedTax();
  const sale = payOrder(db, { lines: priceLines(db, [{ product_id: 1, qty: 1 }]), method: 'cash' });
  const refund = refundOrder(sale.db, read(sale.db, 'pos.order', sale.id));
  const entry = entryOf(refund.db, refund.id);
  assert.ok(isBalanced(entry.line_ids));
  assert.equal(sum(entry, refund.db, '251000', 'debit'), 14);
  assert.equal(tenderSum(refund.id, refund.db, '101501', 'credit'), 114);
});

test('a settlement books exactly the tender collected after account-bucket rounding', () => {
  const { db: db0 } = withIncludedTax();
  const other = search(db0, 'account.account').find((a) => a.code === '450000');
  const db = write(db0, 'product', 1, { property_account_income_id: other.id });
  const half = (id) => ({ product_id: id, qty: 0.5, price_unit: 1.01, discount: 0, tax: 0, tax_type: 'percent', tax_include: false });
  const lines = [half(1), half(2)];
  assert.equal(amounts(lines).total, 1.01);
  const cash = payOrder(db, { lines, method: 'cash' });
  const entry = entryOf(cash.db, cash.id);
  assert.ok(isBalanced(entry.line_ids));
  assert.equal(tenderSum(cash.id, cash.db, '101501', 'debit'), 1.01);
  assert.equal(sum(entry, cash.db, '690000', 'debit'), 0); // the largest revenue bucket absorbs the rounding cent
  assert.equal(entry.line_ids.reduce((s, l) => s + l.credit, 0), 1.01);
  const card = payOrder(cash.db, { lines, method: 'card' });
  assert.equal(tenderSum(card.id, card.db, '101401', 'debit'), 1.01);
  const refund = refundOrder(card.db, read(card.db, 'pos.order', card.id));
  const back = entryOf(refund.db, refund.id);
  assert.ok(isBalanced(back.line_ids));
  assert.equal(tenderSum(refund.id, refund.db, '101401', 'credit'), 1.01);
});

test('distinct sub-cent tax buckets already produce a balanced POS booking', () => {
  const db = startSession(seed(), 0).db;
  const lines = [
    { product_id: 1, qty: 1, price_unit: 0.03, tax: 10, tax_name: 'Small A' },
    { product_id: 2, qty: 1, price_unit: 0.03, tax: 10, tax_name: 'Small B' },
  ];
  assert.equal(amounts(lines).tax, 0.01);
  const paid = payOrder(db, { lines, method: 'cash' });
  assert.ok(isBalanced(entryOf(paid.db, paid.id).line_ids));
  assert.equal(tenderSum(paid.id, paid.db, '101501', 'debit'), 0.07);
});

test('a refund reverses the accounts the sale used even if the product account changed since', () => {
  const { db: db0 } = withIncludedTax();
  const other = search(db0, 'account.account').find((a) => a.code === '450000');
  const sale = payOrder(db0, { lines: priceLines(db0, [{ product_id: 1, qty: 1 }]), method: 'cash' });
  assert.equal(sum(entryOf(sale.db, sale.id), sale.db, '400000', 'credit'), 100);
  const changed = write(sale.db, 'product', 1, { property_account_income_id: other.id });
  const refund = refundOrder(changed, read(changed, 'pos.order', sale.id));
  const back = entryOf(refund.db, refund.id);
  assert.equal(sum(back, refund.db, '400000', 'debit'), 100);
  assert.equal(sum(back, refund.db, '450000', 'debit'), 0);
});
