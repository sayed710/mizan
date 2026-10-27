import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postEntry, profitAndLoss } from './models/ledger.js';
import { closeFiscalYear, reopenFiscalYear } from './models/closing.js';
import { applyDiff, diffDb } from './sync.js';

const period = { from: '2024-01-01', to: '2024-12-31' };
const opened = () => {
  const booked = postEntry(seed(), { journal: 'MISC', date: '2024-06-15', lines: [{ account: '101401', debit: 1000 }, { account: '400000', credit: 1000 }] }).db;
  return create(booked, 'account.fiscal.year', { name: 'FY 2024', date_from: period.from, date_to: period.to });
};
// A non-admin sync: settings such as the lock date are not applied.
const sync = (base, next) => applyDiff(base, diffDb(base, next), { isAdmin: false });

test('a year closed by a non-admin keeps its P&L and its lock on the server', () => {
  const { db: base, id } = opened();
  const server = sync(base, closeFiscalYear(base, id));
  assert.equal(server.settings.lock_date ?? null, base.settings.lock_date ?? null);
  const closing = read(server, 'account.move', read(server, 'account.fiscal.year', id).closing_move_id);
  assert.equal(closing.is_closing, true);
  assert.equal(profitAndLoss(server, period).net, 1000);
  const sale = server.records['account.move'].find((m) => m.invoice_date === '2024-06-15');
  assert.throws(() => applyDiff(server, { upserts: { 'account.move': [{ ...sale, id: 9999, name: 'MISC/2024/9999' }] } }, { isAdmin: false }), /locked/);
  assert.throws(() => postEntry(server, { journal: 'MISC', date: '2024-03-01', lines: [{ account: '101401', debit: 5 }, { account: '400000', credit: 5 }] }), /locked/);
});

test('a reopened year unlocks again and the closing flag cannot be forged', () => {
  const { db: base, id } = opened();
  const closed = sync(base, closeFiscalYear(base, id));
  const reopened = sync(closed, reopenFiscalYear(closed, id));
  assert.equal(read(reopened, 'account.fiscal.year', id).state, 'open');
  assert.equal(profitAndLoss(reopened, period).net, 1000);
  assert.ok(postEntry(reopened, { journal: 'MISC', date: '2024-03-01', lines: [{ account: '101401', debit: 5 }, { account: '400000', credit: 5 }] }).db);
  const sale = reopened.records['account.move'].find((m) => !m.is_closing);
  assert.throws(() => write(reopened, 'account.move', sale.id, { is_closing: true }), /closing/);
  assert.throws(() => applyDiff(reopened, { upserts: { 'account.move': [{ ...sale, is_closing: true }] } }), /closing/);
  const closing = read(closed, 'account.move', read(closed, 'account.fiscal.year', id).closing_move_id);
  assert.throws(() => applyDiff(closed, { upserts: { 'account.move': [{ ...closing, is_closing: false }] } }), /closing/);
});

test('a fiscal year cannot name an arbitrary entry as its closing entry', () => {
  const { db, id } = opened();
  const sale = db.records['account.move'].find((m) => m.invoice_date === '2024-06-15');
  assert.throws(() => write(db, 'account.fiscal.year', id, { closing_move_id: sale.id }), /closing the fiscal year/);
  assert.throws(() => write(db, 'account.fiscal.year', id, { state: 'closed' }), /closing entry/);
  assert.throws(() => write(db, 'account.fiscal.year', id, { state: 'closed', closing_move_id: sale.id }), /fiscal year end/);
  assert.throws(() => write(db, 'account.fiscal.year', id, { opening_move_id: sale.id }), /fiscal year end/);
});

