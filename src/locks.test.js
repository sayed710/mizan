import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { create, read, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { editableFields } from './models/locks.js';

const user = { author: 'Sam', isAdmin: false };

test('a locked record keeps its editable fields on the server for non-admin users', () => {
  const db = seed();
  const year = create(db, 'account.fiscal.year', { name: 'FY 2031', date_from: '2031-01-01', date_to: '2031-12-31' });
  const closed = write(year.db, 'account.fiscal.year', year.id, { state: 'closed' });
  const base = applyDiff(db, diffDb(db, closed), { author: 'Admin', isAdmin: true });
  const renamed = write(base, 'account.fiscal.year', year.id, { name: 'Renamed' });
  assert.throws(() => applyDiff(base, diffDb(base, renamed), user), /locked: Fiscal Year cannot change/);
  // Administrators may still correct it, and workflow fields stay writable.
  assert.equal(read(applyDiff(base, diffDb(base, renamed), { author: 'Admin', isAdmin: true }), 'account.fiscal.year', year.id).name, 'Renamed');
  const reopened = write(base, 'account.fiscal.year', year.id, { state: 'open' });
  assert.equal(read(applyDiff(base, diffDb(base, reopened), user), 'account.fiscal.year', year.id).state, 'open');
});

test('order lines on a locked document only lock their user-entered columns', () => {
  const field = { type: 'one2many', fields: { product_id: { type: 'many2one' }, qty: { type: 'float' }, qty_invoiced: { type: 'float', readonly: true } } };
  const model = { fields: { lines: field, state: { type: 'selection' } }, form: { statusbar: 'state', groups: [['state']], tabs: [{ label: 'Lines', fields: ['lines'] }], lockedWhen: (r) => r.state === 'done' } };
  assert.deepEqual(editableFields(model), ['lines']);
  assert.deepEqual(editableFields({ ...model, form: { ...model.form, title: 'lines' } }), ['lines']);
});

test('every lockable model names at least one editable field it protects', () => {
  const lockable = Object.entries(models).filter(([, m]) => m.form?.lockedWhen);
  assert.ok(lockable.length > 30);
  for (const [name, m] of lockable) assert.ok(Array.isArray(editableFields(m)), name);
});
