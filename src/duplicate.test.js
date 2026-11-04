// Duplicate starts the copy over: workflow state, readonly and computed values come from the model defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { duplicateValues } from './duplicate.js';
import { models } from './models/index.js';

test('a duplicated submitted expense is a draft without the journal entry', () => {
  const vals = duplicateValues('hr.expense', { id: 9, name: 'Taxi', state: 'submitted', move_id: 4, total_amount: 30, employee_id: 1 });
  assert.equal(vals.name, 'Taxi (copy)');
  assert.equal('state' in vals || 'move_id' in vals || 'id' in vals, false);
  const res = create(seed(), 'hr.expense', vals);
  assert.equal(read(res.db, 'hr.expense', res.id).state, 'draft');
});

test('readonly line values are dropped from duplicated lines', () => {
  const vals = duplicateValues('account.move', { id: 1, state: 'posted', name: 'INV/1', invoice_line_ids: [{ product_id: 1, qty: 2, tax: 14 }] });
  assert.deepEqual(vals.invoice_line_ids, [{ product_id: 1, qty: 2 }]);
  assert.equal(vals.state, undefined);
});

test('invoice and manufacturing copies discard generated accounting and work-order arrays', () => {
  const db = seed();
  const invoice = create(db, 'account.move', duplicateValues('account.move', { id: 100, move_type: 'out_invoice', partner_id: 1, state: 'posted', line_ids: [{ account_id: 1, debit: 100, credit: 0 }], invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }] }));
  assert.deepEqual(read(invoice.db, 'account.move', invoice.id).line_ids, []);
  const mo = create(db, 'mrp.production', duplicateValues('mrp.production', { id: 100, name: 'Completed', product_id: 1, product_qty: 1, state: 'done', workorders: [{ name: 'Assembly', state: 'done', duration: 30 }] }));
  assert.deepEqual(read(mo.db, 'mrp.production', mo.id).workorders, []);
});

test('maintenance copies restart both displayed and operational state', () => {
  const made = create(seed(), 'maintenance.request', duplicateValues('maintenance.request', { id: 10, name: 'Repaired', stage: 'repaired', stage_id: 'repaired', kanban_state: 'done', request_date: '2026-01-01', close_date: '2026-10-01' }));
  const copy = read(made.db, 'maintenance.request', made.id);
  assert.equal(copy.stage ?? copy.stage_id, 'new');
  assert.equal(copy.stage_id, 'new');
  assert.equal(copy.kanban_state, 'normal');
  assert.equal(copy.close_date, undefined);
});

test('deposits cannot be duplicated without receiving and booking another payment', () => {
  assert.throws(() => duplicateValues('rental.deposit', { id: 1, rental_id: 1, amount: 100, state: 'held', move_id: 20 }), /cannot be duplicated/);
  assert.equal(models['rental.deposit'].duplicate, false);
});
