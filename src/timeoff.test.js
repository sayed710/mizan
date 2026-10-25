import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { accrue, remaining } from './models/timeoff.js';
import { seed } from './seed.js';

// A fresh employee, so the seeded allocations and requests do not affect the balances.
const fresh = () => create(seed(), 'hr.employee', { name: 'New Hire' });
const EMP = fresh().id;
const base = () => fresh().db;
const allocate = (db, vals) => create(db, 'hr.leave.allocation', { name: 'Annual', employee_id: EMP, leave_type: 'paid', number_of_days: 10, state: 'validate', ...vals });
const request = (db, from, to, vals = {}) => create(db, 'hr.leave', { name: 'Holiday', employee_id: EMP, leave_type: 'paid', date_from: from, date_to: to, state: 'confirm', ...vals });

test('requests are limited by the approved allocation; refused requests free the balance', () => {
  const { db: d0 } = allocate(base(), {});
  const { db: d1, id: first } = request(d0, '2026-11-02', '2026-11-04');
  assert.equal(remaining(d1, EMP, 'paid'), 7);
  assert.throws(() => request(d1, '2026-12-01', '2026-12-08'), /Not enough Paid Time Off left: 7 day\(s\)/);
  const freed = write(d1, 'hr.leave', first, { state: 'refuse' });
  assert.equal(request(freed, '2026-12-01', '2026-12-08').db.records['hr.leave'].at(-1).state, 'confirm');
});

test('sick time off needs no allocation; an end before the start is refused', () => {
  assert.ok(request(base(), '2026-11-02', '2026-11-20', { leave_type: 'sick' }).id);
  assert.throws(() => request(base(), '2026-11-05', '2026-11-02', { leave_type: 'sick' }), /end date/);
});

test('accrual allocations earn days per completed month and stop at their end date', () => {
  const { db, id } = allocate(base(), { allocation_type: 'accrual', number_of_days: 0, accrual_days_per_month: 1.5, date_from: '2026-01-15' });
  assert.equal(read(accrue(db, read(db, 'hr.leave.allocation', id), '2026-05-20'), 'hr.leave.allocation', id).number_of_days, 6);
  assert.equal(read(accrue(db, read(db, 'hr.leave.allocation', id), '2026-05-14'), 'hr.leave.allocation', id).number_of_days, 4.5);
  const capped = write(db, 'hr.leave.allocation', id, { date_to: '2026-03-15' });
  assert.equal(read(accrue(capped, read(capped, 'hr.leave.allocation', id), '2026-12-31'), 'hr.leave.allocation', id).number_of_days, 3);
});
