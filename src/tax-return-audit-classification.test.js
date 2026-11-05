import { test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff } from './sync.js';

test('ordinary paid returns cannot be moved to the audit workflow or unlocked by a status flag', () => {
  const initial = seed();
  const type = search(initial, 'account.return.type').find((row) => row.category === 'account_return');
  const made = create(initial, 'account.return', { name: 'VAT', type_id: type.id, company_id: 1, date_from: '2025-01-01', date_to: '2025-01-31' });
  const actions = models['account.return'].form.buttons;
  let db = made.db;
  for (const label of ['Review', 'Submit', 'Pay']) {
    db = actions.find((button) => button.label === label).run(db, read(db, 'account.return', made.id)).db;
  }
  const paid = read(db, 'account.return', made.id);
  assert.equal(paid.state, 'paid');
  assert.throws(() => write(db, 'account.return', paid.id, { audit_status: 'ongoing' }), /audit/i);
  assert.throws(() => write(db, 'account.return', paid.id, { audit_status: 'ongoing', state: 'new' }), /audit|paid/i);
  assert.throws(() => write(db, 'account.return', paid.id, { state: 'new' }), /paid/i);
  assert.throws(() => write(db, 'account.return', paid.id, { date_to: '2025-02-28' }), /modified/i);
  assert.equal(models['account.return'].form.lockedWhen({ ...paid, audit_status: 'ongoing' }, db), true);
  assert.throws(() => applyDiff(db, { upserts: { 'account.return': [{ ...paid, audit_status: 'ongoing' }] } }, { isAdmin: true }), /audit/i);
  const audit = create(db, 'account.return', { name: 'Audit', audit_status: 'ongoing', company_id: 1, date_from: '2025-01-01', date_to: '2025-12-31' });
  const auditType = read(audit.db, 'account.return', audit.id).type_id;
  assert.throws(() => write(audit.db, 'account.return', paid.id, { type_id: auditType, audit_status: 'ongoing' }), /audit|modified/i);
  assert.throws(() => write(audit.db, 'account.return', paid.id, { type_id: auditType }), /audit|modified/i);
  assert.throws(() => write(audit.db, 'account.return', made.id, { type_id: auditType, audit_status: 'ongoing', state: 'new' }), /audit|paid/i);
  assert.throws(() => create(audit.db, 'account.return', { name: 'Invalid', type_id: type.id, audit_status: 'ongoing', company_id: 1, date_from: '2025-01-01', date_to: '2025-01-31' }), /audit/i);
  const draft = create(audit.db, 'account.return', { name: 'Draft VAT', type_id: type.id, company_id: 1, date_from: '2024-01-01', date_to: '2024-01-31' });
  assert.throws(() => write(draft.db, 'account.return', draft.id, { type_id: auditType }), /audit/i);
});
