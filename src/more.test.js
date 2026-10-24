import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

const runButton = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

test('producing a manufacturing order consumes components and adds the finished product', () => {
  const db = seed();
  const before = { desk: read(db, 'product', 2).qty_available, top: read(db, 'product', 7).qty_available };
  const after = runButton(db, 'mrp.production', 1, 'Produce').db;
  assert.equal(read(after, 'mrp.production', 1).state, 'done');
  assert.equal(read(after, 'product', 2).qty_available, before.desk + 5);
  assert.equal(read(after, 'product', 7).qty_available, before.top - 5);
});

test('producing without enough components fails and changes nothing', () => {
  const db = write(seed(), 'product', 8, { qty_available: 1 });
  assert.throws(() => runButton(db, 'mrp.production', 1, 'Produce'), /Not enough Steel Desk Frame/);
});

test('subscription invoicing creates an invoice and advances the next date', () => {
  const db = seed();
  const sub = read(db, 'sale.subscription', 1);
  const res = runButton(db, 'sale.subscription', 1, 'Generate Invoice');
  const inv = search(res.db, 'account.move').find((m) => m.invoice_origin === sub.name);
  assert.ok(inv);
  assert.equal(inv.amount_untaxed, 99);
  assert.ok(read(res.db, 'sale.subscription', 1).next_invoice_date > sub.next_invoice_date);
  assert.equal(read(db, 'sale.subscription', 2).recurring_monthly, 82.5);
});

test('time off duration counts calendar days inclusively', () => {
  const leave = read(seed(), 'hr.leave', 1);
  assert.equal(leave.number_of_days, 4);
});
