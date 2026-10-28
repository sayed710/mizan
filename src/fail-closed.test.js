import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiff } from './sync.js';
import { withCompany } from './models/company.js';
import { seed } from './seed.js';

test('applyDiff without an isAdmin flag is treated as a non-admin change (ARCH-005)', () => {
  const db = seed();
  const settings = { company: 'Renamed Co', lock_date: '2026-03-31' };
  const plain = applyDiff(db, { upserts: {}, deletes: {}, settings });
  assert.equal(plain.settings.company, db.settings.company);
  assert.equal(plain.settings.lock_date, db.settings.lock_date);
  const admin = applyDiff(db, { upserts: {}, deletes: {}, settings }, { isAdmin: true });
  assert.equal(admin.settings.company, 'Renamed Co');
  assert.equal(admin.settings.lock_date, '2026-03-31');
});

test('the company wrapper passes the caller context to the model guard', () => {
  const seen = [];
  const { 'sale.order': order } = withCompany({ 'sale.order': { fields: {}, guard: (db, before, r, ctx) => { seen.push(ctx); return null; } } });
  order.guard(seed(), null, { company_id: 1 }, { isAdmin: false });
  assert.deepEqual(seen, [{ isAdmin: false }]);
});

test('missing and unknown users cannot approve or bypass record locks through sync', () => {
  const db = seed();
  const leave = db.records['hr.leave'].find((r) => r.state !== 'validate');
  const order = db.records['sale.order'].find((r) => r.state === 'sale');
  assert.ok(leave);
  assert.ok(order);
  for (const opts of [undefined, {}, { login: 'unknown' }, { isAdmin: null }, { isAdmin: 'true' }]) {
    assert.throws(() => applyDiff(db, { upserts: { 'hr.leave': [{ ...leave, state: 'validate' }] } }, opts), /link your user/);
    assert.throws(() => applyDiff(db, { upserts: { 'sale.order': [{ ...order, partner_id: order.partner_id === 1 ? 2 : 1 }] } }, opts), /locked/);
    const out = applyDiff(db, { settings: { company: 'Changed' } }, opts);
    assert.equal(out.settings.company, db.settings.company);
  }
});
