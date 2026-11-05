import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, updateSettings, write } from './orm.js';
import { createCompany } from './models/company.js';
import { postEntry, accountId } from './models/ledger.js';
import { closeFiscalYear, reopenFiscalYear } from './models/closing.js';
import { migrate } from './migrations.js';
import { closedYearLock } from './models/finance.js';

const dates = { date_from: '2032-01-01', date_to: '2032-12-31' };
const book = (db, company, amount) => postEntry(db, { company, journal: 'MISC', date: '2032-04-01', lines: [
  { account: '600000', debit: amount }, { account: '301000', credit: amount },
] }).db;

test('fiscal closing and reopening isolate companies and their locks', () => {
  const initial = seed();
  const company = createCompany(initial, { name: 'Independent', currency_id: initial.records['res.company'][0].currency_id });
  let db = updateSettings(company.db, { current_company_id: 1, allowed_company_ids: [1] });
  const expense = { db, id: read(db, 'res.company', company.id).account_price_difference_id };
  const earnings = read(expense.db, 'account.account', read(expense.db, 'res.company', company.id).current_year_earnings_account_id);
  db = write(expense.db, 'res.company', company.id, { current_year_earnings_account_id: earnings.id });
  db = book(book(db, 1, 100), company.id, 300);
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

test('migration retains global closing locks without clearing them for closed fiscal years', () => {
  const company = createCompany(seed(), { name: 'Other company' });
  const year = create(company.db, 'account.fiscal.year', { name: 'Legacy year', ...dates });
  const closed = closeFiscalYear(year.db, year.id);
  const legacy = write(write({ ...closed, schema_version: 20, settings: { ...closed.settings, lock_date: dates.date_to } }, 'res.company', 1, { lock_date: dates.date_to }), 'res.company', company.id, { lock_date: dates.date_to });
  assert.throws(() => reopenFiscalYear(legacy, year.id), /locked/);
  const migrated = migrate(legacy);
  assert.ok(migrated.records['res.company'].every((c) => c.lock_date === dates.date_to));
  assert.equal('lock_date' in migrated.settings, false);
  assert.equal(legacy.settings.lock_date, dates.date_to);
  assert.equal(closedYearLock(migrated, 1), dates.date_to);
  assert.throws(() => book(migrated, 1, 1), /locked/);
  assert.throws(() => book(migrated, company.id, 1), /locked/);
  const unlocked = migrated.records['res.company'].reduce((db, c) => write(db, 'res.company', c.id, { lock_date: null }), migrated);
  const otherBooked = book(unlocked, company.id, 1);
  const reopened = reopenFiscalYear(otherBooked, year.id);
  assert.equal(read(reopened, 'account.fiscal.year', year.id).state, 'open');
  assert.ok(read(reopened, 'account.move', read(reopened, 'account.fiscal.year', year.id).opening_move_id));
  assert.equal(closedYearLock(reopened, 1), '');
  assert.doesNotThrow(() => book(reopened, 1, 1));
  assert.equal(migrate(migrated), migrated);
});

test('migration preserves global locks not matching a closed fiscal year', () => {
  const year = create(seed(), 'account.fiscal.year', { name: 'Legacy year', ...dates });
  const closed = closeFiscalYear(year.db, year.id);
  for (const lock_date of ['2031-12-31', '2033-12-31']) {
    const migrated = migrate({ ...closed, schema_version: 20, settings: { ...closed.settings, lock_date } });
    assert.ok(migrated.records['res.company'].every((c) => c.lock_date === lock_date));
    assert.equal('lock_date' in migrated.settings, false);
  }
  const open = migrate({ ...year.db, schema_version: 20, settings: { ...year.db.settings, lock_date: dates.date_to } });
  assert.ok(open.records['res.company'].every((c) => c.lock_date === dates.date_to));
  assert.equal('lock_date' in open.settings, false);
});

test('migration assigns legacy fiscal years to company one without changing explicit ownership', () => {
  const db = seed();
  const old = { ...db, schema_version: 19, records: { ...db.records, 'account.fiscal.year': [{ id: 1 }, { id: 2, company_id: 2 }] } };
  assert.deepEqual(migrate(old).records['account.fiscal.year'].map((y) => y.company_id), [1, 2]);
});
