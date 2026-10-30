import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, updateSettings, write } from './orm.js';
import { seed } from './seed.js';
import { payMove, postMove } from './models/accounting.js';
import { reversePayment } from './models/pay.js';
import { agedBalance } from './models/finance.js';
import { revalueForeignBalances, unrealizedExchange } from './models/closing.js';
import { accountId, isBalanced, journalId, postEntry } from './models/ledger.js';
import { createCompany } from './models/company.js';

function fixture(type = 'out_invoice') {
  const currency = create(seed(), 'res.currency', { name: 'FXC', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }, { date: '2026-03-01', rate: 0.5 }] });
  const invoice = create(currency.db, 'account.move', { move_type: type, partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
  return { db: postMove(invoice.db, invoice.id), id: invoice.id };
}

for (const [type, kind] of [['out_invoice', 'receivable'], ['in_invoice', 'payable']]) {
  test(`${kind} cutoff reconstructs foreign and booked open amounts across payment reversal`, () => {
    const invoice = fixture(type);
    let db = payMove(invoice.db, invoice.id, 40, '2026-01-10');
    const payment = search(db, 'account.payment').find((p) => p.invoice_id === invoice.id && p.state === 'posted');
    db = reversePayment(db, payment, '2026-01-20');
    for (const [date, foreign, booked] of [['2026-01-05', 100, 50], ['2026-01-15', 60, 30], ['2026-01-25', 100, 50]]) {
      const row = unrealizedExchange(db, date).find((r) => r.invoice_id === invoice.id);
      assert.deepEqual([row.residual, row.booked], [foreign, booked]);
      assert.equal(agedBalance(db, kind, date).rows.find((r) => r.partner_id === 1)?.total, booked);
    }
  });
}

test('revaluation reverses next day, is idempotent, and later cutoff uses reversed state', () => {
  const { db } = fixture();
  const first = revalueForeignBalances(db, '2026-02-28');
  const entry = search(first, 'account.move').find((m) => m.revaluation_date === '2026-02-28');
  const reversal = read(first, 'account.move', entry.reversal_move_id);
  assert.ok(isBalanced(entry.line_ids) && isBalanced(reversal.line_ids));
  assert.equal(reversal.invoice_date, '2026-03-01');
  assert.deepEqual(reversal.line_ids.map((l) => [l.account_id, l.debit, l.credit]), entry.line_ids.map((l) => [l.account_id, l.credit, l.debit]));
  assert.equal(revalueForeignBalances(first, '2026-02-28'), first);
  const later = revalueForeignBalances(first, '2026-03-31');
  const second = search(later, 'account.move').find((m) => m.revaluation_date === '2026-03-31');
  assert.equal(second.line_ids.find((l) => l.account_id === accountId(later, '121000')).debit, 150);
});

test('locked revaluation rejects without changing the database', () => {
  const { db } = fixture();
  const locked = updateSettings(db, { lock_date: '2026-02-28' });
  const before = JSON.stringify(locked);
  assert.throws(() => revalueForeignBalances(locked, '2026-02-28'), /locked/i);
  assert.equal(JSON.stringify(locked), before);
});

test('revaluation uses the company configured exchange accounts', () => {
  const { db } = fixture();
  const gain = create(db, 'account.account', { code: '459999', name: 'Company gain', account_type: 'income_other' });
  const company = write(gain.db, 'res.company', 1, { income_currency_exchange_account_id: gain.id });
  const done = revalueForeignBalances(company, '2026-02-28');
  const entry = search(done, 'account.move').find((m) => m.revaluation_date === '2026-02-28');
  assert.equal(entry.line_ids.find((l) => l.account_id === gain.id)?.credit, 50);
});

test('companies revalue only their own invoices using their own journal and accounts', () => {
  const first = fixture();
  const secondCompany = createCompany(first.db, { name: 'Second company' });
  let db = secondCompany.db;
  for (const [code, type] of [['121000', 'asset_receivable'], ['400000', 'income'], ['450100', 'income_other'], ['650100', 'expense_other']]) {
    db = create(db, 'account.account', { code, name: code, account_type: type, company_id: secondCompany.id }).db;
  }
  db = create(db, 'account.journal', { code: 'MISC', name: 'Second miscellaneous', type: 'general', company_id: secondCompany.id }).db;
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, company_id: secondCompany.id, currency_id: read(db, 'account.move', first.id).currency_id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Other', qty: 1, price_unit: 200, tax: 0 }] });
  db = postMove(invoice.db, invoice.id);
  const done = revalueForeignBalances(db, '2026-02-28');
  const entries = search(done, 'account.move').filter((m) => m.revaluation_date === '2026-02-28');
  assert.equal(entries.length, 2);
  for (const [company, amount] of [[1, 50], [secondCompany.id, 100]]) {
    const entry = entries.find((m) => m.company_id === company);
    assert.equal(entry.journal_id, journalId(done, 'MISC', company));
    assert.equal(entry.line_ids.find((l) => l.account_id === accountId(done, '121000', company)).debit, amount);
    assert.equal(entry.line_ids.find((l) => l.account_id === accountId(done, '450100', company)).credit, amount);
  }
});

test('foreign bank balances are revalued at the cutoff', () => {
  const currency = create(seed(), 'res.currency', { name: 'BANKFX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const bank = accountId(currency.db, '101401');
  const posted = create(currency.db, 'account.move', { name: 'MISC/2026/991', move_type: 'entry', state: 'posted', journal_id: journalId(currency.db, 'MISC'), invoice_date: '2026-01-01', line_ids: [{ account_id: bank, debit: 50, credit: 0, currency_id: currency.id, amount_currency: 100 }, { account_id: accountId(currency.db, '301000'), debit: 0, credit: 50 }] });
  const done = revalueForeignBalances(posted.db, '2026-02-28');
  const entry = search(done, 'account.move').find((m) => m.revaluation_date === '2026-02-28');
  assert.ok(entry);
  assert.equal(entry.line_ids.find((l) => l.account_id === bank).debit, 50);
});

test('a matching reference on an unrelated entry does not suppress revaluation', () => {
  const { db } = fixture();
  const unrelated = postEntry(db, { journal: 'MISC', date: '2026-02-28', ref: 'Foreign currency revaluation: 2026-02-28', lines: [{ account: '101401', debit: 1 }, { account: '301000', credit: 1 }] });
  const result = revalueForeignBalances(unrelated.db, '2026-02-28');
  assert.equal(search(result, 'account.move').filter((m) => m.revaluation_date === '2026-02-28').length, 1);
});

test('untracked legacy payments reject revaluation without posting anything', () => {
  const { db, id } = fixture();
  const invoice = read(db, 'account.move', id);
  const legacy = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === id ? { ...m, amount_paid: 40 } : m) } };
  const snapshot = JSON.stringify(legacy);
  assert.throws(() => revalueForeignBalances(legacy, '2026-02-28'), (error) => /allocation/i.test(error.message) && error.message.includes(invoice.name));
  assert.equal(JSON.stringify(legacy), snapshot);
});

test('revaluation uses the actual company two receivable account even with a different code', () => {
  const first = fixture();
  const company = createCompany(first.db, { name: 'Alternative chart' });
  const account = create(company.db, 'account.account', { name: 'Receivable alternative', code: '129999', account_type: 'asset_receivable', company_id: company.id });
  const invoice = create(account.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, company_id: company.id, currency_id: read(account.db, 'account.move', first.id).currency_id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Other', qty: 1, price_unit: 200, tax: 0 }] });
  const posted = postMove(invoice.db, invoice.id);
  const original = read(posted, 'account.move', invoice.id);
  const db = { ...posted, records: { ...posted.records, 'account.move': posted.records['account.move'].map((m) => m.id === invoice.id ? { ...m, line_ids: m.line_ids.map((l) => read(posted, 'account.account', l.account_id)?.account_type === 'asset_receivable' ? { ...l, account_id: account.id } : l) } : m) } };
  assert.ok(original.line_ids.some((l) => read(posted, 'account.account', l.account_id)?.account_type === 'asset_receivable'));
  const row = unrealizedExchange(db, '2026-02-28').find((r) => r.invoice_id === invoice.id);
  assert.equal(row.account_id, account.id);
  const done = revalueForeignBalances(db, '2026-02-28');
  const entry = search(done, 'account.move').find((m) => m.company_id === company.id && m.revaluation_date === '2026-02-28');
  assert.equal(entry.line_ids.find((l) => l.account_id === account.id)?.debit, 100);
});
