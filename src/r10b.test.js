import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { today } from './models/common.js';

test('sales journal entries respect the sales lock', () => {
  let db = seed();
  db = { ...db, settings: { ...db.settings, sale_lock_date: '2026-12-31' } };
  const journal = db.records['account.journal'].find((j) => j.type === 'sale');
  const accounts = db.records['account.account'];
  const move = create(db, 'account.move', { move_type: 'entry', journal_id: journal.id, date: '2026-01-01', line_ids: [{ account_id: accounts[0].id, debit: 1, credit: 0 }, { account_id: accounts[1].id, debit: 0, credit: 1 }] });
  assert.throws(() => postMove(move.db, move.id), /lock/i);
});

test('current currency rate excludes future rates', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'TEST', rate_ids: [{ date: today(), rate: 1 }, { date: '9999-01-01', rate: 2 }] });
  db = currency.db;
  assert.equal(read(db, 'res.currency', currency.id).current_rate, 1);
});
