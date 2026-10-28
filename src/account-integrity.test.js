import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { accountId } from './models/ledger.js';

const synced = (db, next) => applyDiff(db, diffDb(db, next), { isAdmin: false, author: 'Clerk' });
const entry = (db, lines, state = 'posted') => create(db, 'account.move', { move_type: 'entry', state, name: 'MISC/TEST', invoice_date: '2026-10-01', line_ids: lines });

test('a posted entry needs an existing account on every journal item (ACC-008)', () => {
  const db = seed();
  const cash = accountId(db, '101401');
  const ok = [{ account_id: cash, debit: 100, credit: 0 }, { account_id: accountId(db, '400000'), debit: 0, credit: 100 }];
  assert.doesNotThrow(() => entry(db, ok));
  assert.throws(() => entry(db, [ok[0], { account_id: 99999, debit: 0, credit: 100 }]), /Journal item 2 needs an existing account/);
  assert.throws(() => entry(db, [{ ...ok[0], account_id: null }, ok[1]]), /Journal item 1 needs an existing account/);
  // The server applies the same rule to whatever a client sends.
  const raw = diffDb(db, entry(db, ok).db);
  raw.upserts['account.move'] = raw.upserts['account.move'].map((m) => ({ ...m, line_ids: [ok[0], { ...ok[1], account_id: 99999 }] }));
  assert.throws(() => applyDiff(db, raw, { isAdmin: false }), /needs an existing account/);
  // Drafts may be incomplete, and zero lines need no account.
  assert.doesNotThrow(() => entry(db, [{ ...ok[0], account_id: null }, ok[1]], 'draft'));
  assert.doesNotThrow(() => entry(db, [...ok, { account_id: null, debit: 0, credit: 0 }]));
});

test('accounts with journal items cannot be deleted; unused ones can', () => {
  const db = seed();
  const used = search(db, 'account.account').find((a) => db.records['account.move'].some((m) => (m.line_ids ?? []).some((l) => l.account_id === a.id)));
  const without = (id) => ({ ...db, records: { ...db.records, 'account.account': db.records['account.account'].filter((a) => a.id !== id) } });
  assert.throws(() => synced(db, without(used.id)), /has journal items and cannot be deleted/);
  const spare = create(db, 'account.account', { code: '999999', name: 'Spare', account_type: 'expense' });
  const stored = synced(db, spare.db);
  const removed = { ...stored, records: { ...stored.records, 'account.account': stored.records['account.account'].filter((a) => a.id !== spare.id) } };
  assert.ok(!synced(stored, removed).records['account.account'].some((a) => a.id === spare.id));
});

test('an account cannot be deleted in the same diff that posts an entry using it', () => {
  const db = seed();
  const spare = create(db, 'account.account', { code: '999998', name: 'Spare 2', account_type: 'expense' });
  const stored = synced(db, spare.db);
  const cash = accountId(stored, '101401');
  const posted = entry(stored, [{ account_id: spare.id, debit: 50, credit: 0 }, { account_id: cash, debit: 0, credit: 50 }]);
  const diff = diffDb(stored, posted.db);
  diff.deletes = { 'account.account': [spare.id] };
  assert.throws(() => applyDiff(stored, diff, { isAdmin: false }), /has journal items and cannot be deleted/);
});
