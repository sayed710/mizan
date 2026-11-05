import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { deliver, receive } from './models/valuation.js';
import { migrate } from './migrations.js';
import { salesModels } from './models/sales.js';
import { postMove } from './models/accounting.js';
import { applyLandedCost } from './models/routes.js';
import { confirmMo, produce } from './models/more.js';
import { postOperationCost } from './models/workorder.js';

function customAccounts() {
  let db = seed();
  const ids = {};
  for (const [i, field, type] of [[1, 'account_stock_valuation_id', 'asset_current'], [2, 'account_stock_input_id', 'asset_current'], [3, 'account_stock_output_id', 'asset_current'], [4, 'account_cogs_id', 'expense_direct_cost'], [5, 'account_price_difference_id', 'expense'], [6, 'account_production_id', 'expense']]) {
    const account = create(db, 'account.account', { code: `99100${i}`, name: field, account_type: type, company_id: 1 });
    db = account.db; ids[field] = account.id;
  }
  return { db: write(db, 'res.company', 1, ids), ids };
}
const action = (db, model, id, label) => salesModels[model].form.buttons.find((button) => button.label === label).run(db, read(db, model, id)).db;
const balance = (db, ids, account) => (db.records['account.move'] ?? []).filter((m) => ids.includes(m.id)).flatMap((m) => m.line_ids ?? []).filter((line) => line.account_id === account).reduce((sum, line) => sum + line.debit - line.credit, 0);
const newMoves = (before, after) => (after.records['account.move'] ?? []).filter((m) => !(before.records['account.move'] ?? []).some((old) => old.id === m.id)).map((m) => m.id);

test('stock receipt posts to explicitly configured category accounts', () => {
  let db = seed();
  const valuation = create(db, 'account.account', { code: '998101', name: 'Custom stock', account_type: 'asset_current', company_id: 1 }); db = valuation.db;
  const input = create(db, 'account.account', { code: '998102', name: 'Custom input', account_type: 'asset_current', company_id: 1 }); db = input.db;
  const category = create(db, 'product.category', { name: 'Custom category', property_stock_valuation_account_id: valuation.id, property_stock_account_input_categ_id: input.id }); db = category.db;
  const product = create(db, 'product', { name: 'Custom goods', type: 'goods', categ_id: category.id, cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 }); db = product.db;
  db = receive(db, product.id, 1, 10, { date: '2026-10-01' });
  const layer = db.records['stock.valuation.layer'].find((l) => l.product_id === product.id);
  const lines = read(db, 'account.move', layer.move_id).line_ids;
  assert.ok(lines.some((line) => line.account_id === valuation.id && line.debit === 10));
  assert.ok(lines.some((line) => line.account_id === input.id && line.credit === 10));
});

test('stock receipt uses company defaults and rejects missing or foreign configuration', () => {
  let db = seed();
  const account = create(db, 'account.account', { code: '998103', name: 'Company input', account_type: 'asset_current', company_id: 1 }); db = account.db;
  db = write(db, 'res.company', 1, { account_stock_input_id: account.id });
  const product = create(db, 'product', { name: 'Default goods', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 }); db = product.db;
  const posted = receive(db, product.id, 1, 10, { date: '2026-10-01' });
  const layer = posted.records['stock.valuation.layer'].find((l) => l.product_id === product.id);
  assert.ok(read(posted, 'account.move', layer.move_id).line_ids.some((line) => line.account_id === account.id && line.credit === 10));
  const missing = write(db, 'res.company', 1, { account_stock_input_id: null });
  assert.throws(() => receive(missing, product.id, 1, 10, { date: '2026-10-01' }), /Configure the stock input account on category .* or company/);
  const foreign = create(db, 'account.account', { code: '998104', name: 'Foreign input', account_type: 'asset_current', company_id: 2 });
  const invalid = write(foreign.db, 'res.company', 1, { account_stock_input_id: foreign.id });
  assert.throws(() => receive(invalid, product.id, 1, 10, { date: '2026-10-01' }), /belongs to another company/);
});

test('standard receipts and deliveries use configured price difference and COGS accounts', () => {
  let db = seed();
  const variance = create(db, 'account.account', { code: '998105', name: 'Custom variance', account_type: 'expense', company_id: 1 }); db = variance.db;
  const cogs = create(db, 'account.account', { code: '998106', name: 'Custom COGS', account_type: 'expense_direct_cost', company_id: 1 }); db = cogs.db;
  const category = create(db, 'product.category', { name: 'Costing category', property_account_creditor_price_difference_categ: variance.id, property_account_expense_categ_id: cogs.id }); db = category.db;
  const product = create(db, 'product', { name: 'Standard goods', type: 'goods', categ_id: category.id, cost: 10, cost_method: 'standard', valuation: 'real_time', qty_available: 0 }); db = product.db;
  db = receive(db, product.id, 2, 12, { date: '2026-10-01' });
  const receipt = db.records['stock.valuation.layer'].find((l) => l.product_id === product.id);
  assert.ok(read(db, 'account.move', receipt.move_id).line_ids.some((line) => line.account_id === variance.id && line.debit === 4));
  db = deliver(db, product.id, 1, { date: '2026-10-01' }).db;
  const delivery = db.records['stock.valuation.layer'].find((l) => l.product_id === product.id && l.kind === 'out');
  assert.ok(read(db, 'account.move', delivery.move_id).line_ids.some((line) => line.account_id === cogs.id && line.debit === 10));
});

test('receipt inherits an input account from the parent category', () => {
  let db = seed();
  const input = create(db, 'account.account', { code: '998107', name: 'Inherited input', account_type: 'asset_current', company_id: 1 }); db = input.db;
  const parent = create(db, 'product.category', { name: 'Parent', property_stock_account_input_categ_id: input.id }); db = parent.db;
  const child = create(db, 'product.category', { name: 'Child', parent_id: parent.id }); db = child.db;
  const product = create(db, 'product', { name: 'Inherited goods', type: 'goods', categ_id: child.id, cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 }); db = product.db;
  db = receive(db, product.id, 1, 10, { date: '2026-10-01' });
  const receipt = db.records['stock.valuation.layer'].find((l) => l.product_id === product.id);
  assert.ok(read(db, 'account.move', receipt.move_id).line_ids.some((line) => line.account_id === input.id && line.credit === 10));
});

test('stock account migration matches company chart accounts by code and type only', () => {
  let db = seed();
  const valuation = create(db, 'account.account', { code: '110100', name: 'Branch stock', account_type: 'asset_current', company_id: 2 }); db = valuation.db;
  const wrong = create(db, 'account.account', { code: '110200', name: 'Wrong type', account_type: 'expense', company_id: 2 }); db = wrong.db;
  const company = create(db, 'res.company', { name: 'Legacy branch' }); db = company.db;
  const migrated = migrate({ ...db, schema_version: 28 });
  assert.equal(read(migrated, 'res.company', company.id).account_stock_valuation_id, valuation.id);
  assert.equal(read(migrated, 'res.company', company.id).account_stock_input_id, undefined);
});

test('landed costs capitalize on the configured valuation account', () => {
  let { db, ids } = customAccounts();
  const p = create(db, 'product', { name: 'Freight goods', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 }); db = p.db;
  const pick = create(db, 'stock.picking', { picking_type: 'incoming', state: 'ready', move_ids: [{ product_id: p.id, qty: 5 }] });
  db = action(pick.db, 'stock.picking', pick.id, 'Validate');
  const cost = create(db, 'stock.landed.cost', { name: 'Freight', picking_id: pick.id, cost_lines: [{ name: 'Freight', amount: 25 }] });
  const done = applyLandedCost(cost.db, read(cost.db, 'stock.landed.cost', cost.id));
  assert.equal(balance(done, newMoves(cost.db, done), ids.account_stock_valuation_id), 25);
});

test('customer return reverses configured COGS rather than a chart code', () => {
  let { db, ids } = customAccounts();
  const p = create(db, 'product', { name: 'Return goods', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = receive(p.db, p.id, 2, 10);
  const sale = create(db, 'sale.order', { partner_id: 1, order_line: [{ product_id: p.id, qty: 1, price_unit: 20, tax: 0 }] });
  db = action(sale.db, 'sale.order', sale.id, 'Confirm');
  const pick = search(db, 'stock.picking').find((row) => row.sale_id === sale.id);
  db = action(db, 'stock.picking', pick.id, 'Validate');
  const before = db;
  db = action(db, 'stock.picking', pick.id, 'Return');
  const ret = search(db, 'stock.picking').find((row) => row.return_of === pick.id);
  db = action(db, 'stock.picking', ret.id, 'Validate');
  assert.equal(balance(db, newMoves(before, db), ids.account_cogs_id), -10);
});

test('vendor bill and price adjustment use configured input and difference accounts', () => {
  let { db, ids } = customAccounts();
  const p = create(db, 'product', { name: 'Bill goods', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  const po = create(p.db, 'purchase.order', { partner_id: 2, order_line: [{ product_id: p.id, qty: 2, price_unit: 10, tax: 0 }] });
  db = action(po.db, 'purchase.order', po.id, 'Confirm Order');
  const pick = search(db, 'stock.picking').find((row) => row.purchase_id === po.id);
  db = action(db, 'stock.picking', pick.id, 'Validate');
  db = action(db, 'purchase.order', po.id, 'Create Bill');
  const bill = search(db, 'account.move').find((row) => row.purchase_id === po.id);
  db = write(db, 'account.move', bill.id, { invoice_line_ids: bill.invoice_line_ids.map((line) => ({ ...line, price_unit: 12 })) });
  const before = db;
  db = postMove(db, bill.id);
  const lines = read(db, 'account.move', bill.id).line_ids;
  assert.ok(lines.some((line) => line.account_id === ids.account_stock_input_id));
  assert.ok(lines.some((line) => line.account_id === ids.account_price_difference_id && line.debit === 4));
  assert.notEqual(db, before);
});

test('manufacturing and work orders use configured production and valuation accounts', () => {
  let { db, ids } = customAccounts();
  const component = create(db, 'product', { name: 'Component', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = receive(component.db, component.id, 2, 10);
  const finished = create(db, 'product', { name: 'Finished', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  const bom = create(finished.db, 'mrp.bom', { name: 'BOM', product_id: finished.id, product_qty: 1, components: [{ product_id: component.id, qty: 2 }] });
  const mo = create(bom.db, 'mrp.production', { product_id: finished.id, bom_id: bom.id, product_qty: 1 });
  db = confirmMo(mo.db, read(mo.db, 'mrp.production', mo.id));
  const before = db;
  db = produce(db, read(db, 'mrp.production', mo.id)).db;
  const moves = newMoves(before, db);
  assert.ok(moves.some((id) => read(db, 'account.move', id).line_ids.some((line) => line.account_id === ids.account_production_id)));
  const wc = create(db, 'mrp.workcenter', { name: 'Assembly', costs_hour: 30 });
  const another = create(wc.db, 'mrp.production', { product_id: finished.id, bom_id: bom.id, product_qty: 1, state: 'confirmed' });
  const wo = create(another.db, 'mrp.workorder', { name: 'Assembly', production_id: another.id, workcenter_id: wc.id, state: 'done', time_ids: [{ minutes: 60, date_start: '2026-10-25T08:00:00Z', date_end: '2026-10-25T09:00:00Z' }] });
  db = postOperationCost(wo.db, another.id);
  const lines = read(db, 'account.move', read(db, 'mrp.production', another.id).operation_cost_move_id).line_ids;
  assert.ok(lines.some((line) => line.account_id === ids.account_stock_valuation_id && line.debit === 30));
  assert.ok(lines.some((line) => line.account_id === ids.account_production_id && line.credit === 30));
});
