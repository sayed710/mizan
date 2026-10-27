// Duplicate starts the copy over: workflow state, readonly and computed values come from the model defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { duplicateValues } from './duplicate.js';

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
