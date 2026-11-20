import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor } from './models/index.js';


test('FX-16: Unrealized Currencies menu is located under Reporting > Management', () => {
  const reviewReg = menusFor('accounting').find((m) => m.label === 'Review')?.children?.find((m) => m.label === 'Regularization Entries');
  const reviewUnrealized = reviewReg?.children?.find((m) => m.key === 'unrealized-currencies' || m.report === 'unrealizedCurrencies');
  assert.equal(reviewUnrealized, undefined, 'Unrealized Currencies should no longer be under Review > Regularization Entries');

  const reportingMgmt = menusFor('accounting').find((m) => m.label === 'Reporting')?.children?.find((m) => m.label === 'Management');
  const mgmtUnrealized = reportingMgmt?.children?.find((m) => m.key === 'unrealized-currencies');
  assert.ok(mgmtUnrealized, 'Unrealized Currencies should be under Reporting > Management');
  assert.equal(mgmtUnrealized.report, 'unrealizedCurrencies');
  assert.equal(mgmtUnrealized.type, 'report');
});

test('JE-25: changing the reference of a journal entry is logged in the chatter', () => {
  const move = create(seed(), 'account.move', { move_type: 'entry', ref: 'Old Ref' });
  const db = write(move.db, 'account.move', move.id, { ref: 'New Ref' });
  const note = db.messages.slice(move.db.messages.length).find((m) => m.model === 'account.move' && m.res_id === move.id && m.body.includes('Reference:'));
  assert.ok(note, 'a reference change must create a tracking message');
  assert.match(note.body, /Old Ref/);
  assert.match(note.body, /New Ref/);
});
