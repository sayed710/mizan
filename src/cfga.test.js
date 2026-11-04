import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { amounts } from './models/common.js';
import { taxSnapshot } from './models/taxes.js';
import { postMove } from './models/accounting.js';
import { invoiceBaseGroups, isBalanced } from './models/ledger.js';
import { taxesByGrid, taxesByTax } from './models/finance.js';
import { seed } from './seed.js';

const findTax = (db, name) => search(db, 'account.tax').find((t) => t.name === name && t.type_tax_use === 'sale');

test('replacing a group tax or selecting an untaxed product clears the old breakdown', () => {
  let db = seed();
  const vat = findTax(db, 'VAT 14%');
  const made = create(db, 'account.tax', { name: 'Group', type_tax_use: 'sale', amount_type: 'group', children_tax_ids: [vat.id] });
  db = made.db;
  const onchange = models['sale.order'].fields.order_line.onchange;
  const line = onchange({ product_id: 1, qty: 1, price_unit: 100, tax_id: made.id }, 'tax_id', db, {});
  const replaced = onchange({ ...line, tax_id: vat.id }, 'tax_id', db, {});
  assert.equal(amounts([replaced]).tax, 14);
  assert.deepEqual(replaced.tax_breakdown, []);
  db = write(db, 'product', 1, { tax_id: null, sale_tax: null });
  const untaxed = onchange(line, 'product_id', db, {});
  assert.equal(amounts([untaxed]).tax, 0);
  assert.deepEqual(untaxed.tax_breakdown, []);
});

test('changing the fiscal position remaps existing product lines', () => {
  const db = seed();
  const fp = search(db, 'account.fiscal.position').find((f) => f.name === 'Export');
  const lineDef = models['sale.order'].fields.order_line;
  const line = lineDef.onchange({ product_id: 1, qty: 1 }, 'product_id', db, {});
  const result = models['sale.order'].onchange({ fiscal_position_id: fp.id, order_line: [line] }, 'fiscal_position_id', db);
  assert.equal(result.order_line[0].tax, 0);
});

test('mixed exigibility reports only invoice-basis tags at posting', () => {
  let db = seed();
  const a = create(db, 'account.account.tag', { name: 'Invoice base' }); db = a.db;
  const b = create(db, 'account.account.tag', { name: 'Cash base' }); db = b.db;
  const vat = { ...findTax(db, 'VAT 14%'), tag_ids: [a.id] };
  const cash = { ...findTax(db, 'VAT 14% (Cash Basis)'), tag_ids: [b.id] };
  const line = { qty: 1, price_unit: 100, ...taxSnapshot(vat), tax_breakdown: [taxSnapshot(vat), taxSnapshot(cash)] };
  const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2040-01-01', invoice_line_ids: [line] });
  db = postMove(made.db, made.id);
  const rows = taxesByGrid(db, { from: '2040-01-01', to: '2040-01-01' });
  assert.equal(rows.find((r) => r.id === a.id)?.base, 100);
  assert.equal(rows.find((r) => r.id === b.id)?.base ?? 0, 0);
});

test('tax report keeps same-name tax identities separate', () => {
  let db = seed();
  const first = create(db, 'account.tax', { name: 'Same', type_tax_use: 'sale', amount_type: 'percent', amount: 10 }); db = first.db;
  const second = create(db, 'account.tax', { name: 'Same', type_tax_use: 'sale', amount_type: 'percent', amount: 20 }); db = second.db;
  const lines = [first.id, second.id].map((id) => ({ qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', id)) }));
  const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2040-02-01', invoice_line_ids: lines });
  db = postMove(made.db, made.id);
  assert.deepEqual(taxesByTax(db, { from: '2040-02-01', to: '2040-02-01' }).filter((r) => r.name === 'Same').map((r) => [r.base, r.tax]).sort((a, b) => a[1] - b[1]), [[100, 10], [100, 20]]);
});

test('two zero-rate component taxes with the same name on one line produce distinct base groups and report rows', () => {
  let db = seed();
  const first = create(db, 'account.tax', { name: 'Zero', type_tax_use: 'sale', amount_type: 'percent', amount: 0 }); db = first.db;
  const second = create(db, 'account.tax', { name: 'Zero', type_tax_use: 'sale', amount_type: 'percent', amount: 0 }); db = second.db;
  const groupTax = create(db, 'account.tax', { name: 'Zero Group', type_tax_use: 'sale', amount_type: 'group', children_tax_ids: [first.id, second.id] }); db = groupTax.db;
  const line = { qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', groupTax.id), db) };
  const move = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2040-03-01', invoice_line_ids: [line] });
  const groups = invoiceBaseGroups(move.db, read(move.db, 'account.move', move.id));
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.zeroTaxId).sort((a, b) => a - b), [first.id, second.id].sort((a, b) => a - b));
  db = postMove(move.db, move.id);
  const postedMove = read(db, 'account.move', move.id);
  assert.ok(isBalanced(postedMove.line_ids));
  const rows = taxesByTax(db, { from: '2040-03-01', to: '2040-03-01' }).filter((r) => r.name === 'Zero').sort((a, b) => a.tax_id - b.tax_id);
  assert.deepEqual(rows, [
    { side: 'sale', tax_id: first.id, name: 'Zero', base: 100, tax: 0 },
    { side: 'sale', tax_id: second.id, name: 'Zero', base: 100, tax: 0 },
  ]);
});
