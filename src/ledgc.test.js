import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, emptyDb, read, write } from './orm.js';
import { seed } from './seed.js';
import { conversionRate, rateAt } from './models/currency.js';
import { closeFiscalYear } from './models/closing.js';
import { migrate } from './migrations.js';
import { createCompany, ensureMainCompany } from './models/company.js';
import { companyAmount, reportingBookedAmount } from './models/money.js';

test('exchange rates identify the configured base by id rather than name', () => {
  const original = seed();
  const base = read(original, 'res.company', 1).currency_id;
  const foreign = create(original, 'res.currency', { name: 'Different', rate_ids: [{ date: '2020-01-01', rate: 2 }] });
  const db = { ...foreign.db, settings: { ...foreign.db.settings, base_currency_id: base, currency: 'Different' } };
  assert.equal(rateAt(db, foreign.id, '2024-01-01'), 2);
});

test('fiscal closing uses the explicitly configured earnings account', () => {
  const account = create(seed(), 'account.account', { code: '777777', name: 'Earnings', account_type: 'equity' });
  const configured = write(account.db, 'res.company', 1, { current_year_earnings_account_id: account.id });
  const year = create(configured, 'account.fiscal.year', { name: 'FY 2024', date_from: '2024-01-01', date_to: '2024-12-31' });
  const closed = closeFiscalYear(year.db, year.id);
  const move = read(closed, 'account.move', read(closed, 'account.fiscal.year', year.id).closing_move_id);
  assert.ok(move.line_ids.every((line) => line.account_id === account.id));
});

test('legacy migration configures only uniquely matched currency and earnings accounts', () => {
  const base = seed();
  const company = read(base, 'res.company', 1);
  const currency = read(base, 'res.currency', company.currency_id);
  const earnings = read(base, 'account.account', company.current_year_earnings_account_id);
  const legacy = (currencies, accounts) => ({ ...base, schema_version: 22,
    settings: { ...base.settings, base_currency_id: undefined, currency: currency.name },
    records: { ...base.records, 'res.currency': currencies, 'account.account': accounts,
      'res.company': [{ ...company, current_year_earnings_account_id: undefined }] } });
  const once = migrate(legacy([currency], [earnings]));
  assert.equal(once.settings.base_currency_id, currency.id);
  assert.equal(read(once, 'res.company', 1).current_year_earnings_account_id, earnings.id);
  const absent = migrate(legacy([], []));
  assert.equal(absent.settings.base_currency_id, undefined);
  assert.equal(read(absent, 'res.company', 1).current_year_earnings_account_id, undefined);
  const ambiguous = migrate(legacy([currency, { ...currency, id: 999 }], [earnings, { ...earnings, id: 999 }]));
  assert.equal(ambiguous.settings.base_currency_id, undefined);
  assert.equal(read(ambiguous, 'res.company', 1).current_year_earnings_account_id, undefined);
  assert.throws(() => rateAt(absent, currency.id, '2024-01-01'), /configure.*base currency/i);
  const missingAccount = { ...base, records: { ...base.records, 'res.company': [{ ...company, current_year_earnings_account_id: null }] } };
  const year = create(missingAccount, 'account.fiscal.year', { name: '2024', date_from: '2024-01-01', date_to: '2024-12-31' });
  assert.throws(() => closeFiscalYear(year.db, year.id), /configure.*earnings/i);
});

test('same-currency conversions work without a base but cross-currency conversions require it', () => {
  const original = seed();
  const company = read(original, 'res.company', 1);
  const db = { ...original, settings: { ...original.settings, base_currency_id: null } };
  assert.equal(conversionRate(db, company.currency_id, company.currency_id, '2024-01-01'), 1);
  assert.equal(rateAt(db, company.currency_id, '2024-01-01', company.id), 1);
  assert.equal(reportingBookedAmount(db, { company_id: company.id, date: '2024-01-01' }, 7), 7);
  const other = create(db, 'res.currency', { name: 'Other', rate_ids: [] });
  assert.throws(() => conversionRate(other.db, company.currency_id, other.id, '2024-01-01'), /base currency/i);
});

test('main company onboarding configures the base currency for same-currency invoices', () => {
  const db = ensureMainCompany(emptyDb());
  const company = read(db, 'res.company', 1);
  assert.equal(db.settings.base_currency_id, company.currency_id);
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', company_id: company.id, currency_id: company.currency_id,
    invoice_date: '2024-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  assert.equal(companyAmount(invoice.db, read(invoice.db, 'account.move', invoice.id), 'amount_total'), 100);
});

test('a newly created company has its own earnings account and can close a fiscal year', () => {
  const initial = seed();
  const company = createCompany(initial, { name: 'New company', currency_id: initial.settings.base_currency_id });
  const configured = read(company.db, 'res.company', company.id);
  assert.equal(read(company.db, 'account.account', configured.current_year_earnings_account_id).company_id, company.id);
  const year = create(company.db, 'account.fiscal.year', { name: '2024', company_id: company.id, date_from: '2024-01-01', date_to: '2024-12-31' });
  assert.equal(read(closeFiscalYear(year.db, year.id), 'account.fiscal.year', year.id).state, 'closed');
});
