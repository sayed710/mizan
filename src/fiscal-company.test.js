import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, updateSettings, write } from './orm.js';
import { createCompany } from './models/company.js';
import { postEntry, accountId } from './models/ledger.js';
import { closeFiscalYear, reopenFiscalYear } from './models/closing.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';

const dates = { date_from: '2032-01-01', date_to: '2032-12-31' };
const book = (db, company, amount) => postEntry(db, { company, journal: 'MISC', date: '2032-04-01', lines: [
  { account: '600000', debit: amount }, { account: '301000', credit: amount },
] }).db;

test('fiscal closing and reopening isolate companies and their locks', () => {
  const company = createCompany(seed(), { name: 'Independent' });
  let db = updateSettings(company.db, { current_company_id: 1, allowed_company_ids: [1] });
  const expense = create(db, 'account.account', { code: '600000', name: 'Company expense', account_type: 'expense', company_id: company.id });
  db = book(book(expense.db, 1, 100), company.id, 300);
  const draft = create(db, 'account.move', { company_id: company.id, move_type: 'entry', invoice_date: '2032-08-01' });
  db = draft.db;
  const first = create(db, 'account.fiscal.year', { name: 'First', ...dates });
  const second = create(first.db, 'account.fiscal.year', { name: 'Second', company_id: company.id, ...dates });
  assert.equal(read(second.db, 'account.fiscal.year', first.id).company_id, 1);
  assert.throws(() => write(second.db, 'account.fiscal.year', first.id, { company_id: company.id }), /overlap|company/i);
  db = closeFiscalYear(second.db, first.id);
  const move = read(db, 'account.move', read(db, 'account.fiscal.year', first.id).closing_move_id);
  assert.equal(move.company_id, 1);
  assert.equal(move.line_ids.find((l) => l.account_id === accountId(db, '600000', 1)).credit, 100);
  assert.equal(move.line_ids.find((l) => l.account_id === accountId(db, '302000', 1)).debit, 100);
  assert.throws(() => book(db, 1, 1), /locked/);
  db = book(db, company.id, 1);
  assert.throws(() => closeFiscalYear(db, second.id), /draft moves/);
  db = write(db, 'account.move', draft.id, { state: 'cancel' });
  db = closeFiscalYear(db, second.id);
  const other = read(db, 'account.move', read(db, 'account.fiscal.year', second.id).closing_move_id);
  assert.equal(other.company_id, company.id);
  assert.equal(other.line_ids.find((l) => l.account_id === accountId(db, '600000', company.id)).credit, 301);
  db = reopenFiscalYear(db, first.id);
  db = book(db, 1, 1);
  assert.throws(() => book(db, company.id, 1), /locked/);
  const reversal = read(db, 'account.move', read(db, 'account.fiscal.year', first.id).opening_move_id);
  assert.equal(reversal.company_id, 1);
});

test('migration assigns legacy fiscal years to company one without changing explicit ownership', () => {
  const db = seed();
  const old = { ...db, schema_version: SCHEMA_VERSION - 1, records: { ...db.records, 'account.fiscal.year': [{ id: 1 }, { id: 2, company_id: 2 }] } };
  assert.deepEqual(migrate(old).records['account.fiscal.year'].map((y) => y.company_id), [1, 2]);
});
