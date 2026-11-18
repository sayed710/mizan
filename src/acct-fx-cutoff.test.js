import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { models } from './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, getActiveCompany, read, search, setActiveCompany, write } from './orm.js';
import { seed } from './seed.js';
import { payMove, postMove } from './models/accounting.js';
import { reversePayment } from './models/pay.js';
import { agedBalance } from './models/finance.js';
import { foreignBankBalances, revalueForeignBalances, unrealizedExchange } from './models/closing.js';
import { accountId, isBalanced, journalId, postEntry } from './models/ledger.js';

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
  const locked = write(db, 'res.company', 1, { lock_date: '2026-02-28' });
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
  const secondCompany = createCompanyWithDefaultInvoiceJournals(first.db, { name: 'Second company', currency_id: first.db.settings.base_currency_id });
  let db = secondCompany.db;
  const accounts = {};
  for (const [code, type] of [['121000', 'asset_receivable'], ['400000', 'income'], ['450100', 'income_other'], ['650100', 'expense_other']]) {
    const existing = search(db, 'account.account').find((account) => account.company_id === secondCompany.id && account.code === code);
    const created = existing ? { db, id: existing.id } : create(db, 'account.account', { code, name: code, account_type: type, company_id: secondCompany.id });
    db = created.db;
    accounts[code] = created.id;
  }
  const journal = create(db, 'account.journal', { code: 'MISC', name: 'Second miscellaneous', type: 'general', company_id: secondCompany.id });
  db = write(journal.db, 'res.company', secondCompany.id, { account_default_receivable_id: accounts['121000'], default_general_journal_id: journal.id });
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, company_id: secondCompany.id, currency_id: read(db, 'account.move', first.id).currency_id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Other', qty: 1, price_unit: 200, tax: 0 }] });
  db = postMove(invoice.db, invoice.id);
  const done = revalueForeignBalances(db, '2026-02-28');
  const entries = search(done, 'account.move').filter((m) => m.revaluation_date === '2026-02-28');
  assert.equal(entries.length, 2);
  for (const [company, amount] of [[1, 50], [secondCompany.id, 100]]) {
    const entry = entries.find((m) => m.company_id === company);
    assert.equal(entry.journal_id, journalId(done, 'MISC', company));
    assert.equal(entry.line_ids.find((l) => l.account_id === (company === secondCompany.id ? accounts['121000'] : accountId(done, '121000', company))).debit, amount);
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
  const company = createCompanyWithDefaultInvoiceJournals(first.db, { name: 'Alternative chart', currency_id: first.db.settings.base_currency_id });
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

test('foreign bank account balance revalued', () => {
  const currency = create(seed(), 'res.currency', {
    name: 'BNKFX2',
    rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }],
  });
  const bank = accountId(currency.db, '101401');
  let db = postEntry(currency.db, {
    journal: 'MISC', date: '2026-01-10', company: 1,
    lines: [
      { account_id: bank, debit: 100, credit: 0, currency_id: currency.id, amount_currency: 200 },
      { account_id: accountId(currency.db, '301000'), debit: 0, credit: 100 },
    ],
  }).db;
  db = postEntry(db, {
    journal: 'MISC', date: '2026-01-15', company: 1,
    lines: [
      { account_id: accountId(db, '600000'), debit: 25, credit: 0 },
      { account_id: bank, debit: 0, credit: 25, currency_id: currency.id, amount_currency: -50 },
    ],
  }).db;
  const done = revalueForeignBalances(db, '2026-02-28', { companyId: 1 });
  const entry = search(done, 'account.move').find((m) => m.company_id === 1 && m.revaluation_date === '2026-02-28');
  assert.ok(entry);
  assert.equal(entry.line_ids.find((l) => l.account_id === bank)?.debit, 75);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(done, '450100'))?.credit, 75);
  assert.ok(isBalanced(entry.line_ids));
});

test('customer refund revalued with the right sign', () => {
  const currency = create(seed(), 'res.currency', {
    name: 'REFFX',
    rate_ids: [
      { date: '2026-01-01', rate: 2 },
      { date: '2026-02-01', rate: 1 },
      { date: '2026-03-01', rate: 4 },
    ],
  });
  const refund = create(currency.db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Refund', qty: 1, price_unit: 100, tax: 0 }],
  });
  const posted = postMove(refund.db, refund.id);
  const receivable = accountId(posted, '121000');
  const loss = accountId(posted, '690100');
  const gain = accountId(posted, '450100');

  const doneLoss = revalueForeignBalances(posted, '2026-02-28', { companyId: 1 });
  const entryLoss = search(doneLoss, 'account.move').find((m) => m.company_id === 1 && m.revaluation_date === '2026-02-28');
  assert.ok(entryLoss);
  assert.equal(entryLoss.line_ids.find((l) => l.account_id === receivable)?.credit, 50);
  assert.equal(entryLoss.line_ids.find((l) => l.account_id === loss)?.debit, 50);
  assert.ok(isBalanced(entryLoss.line_ids));

  const doneGain = revalueForeignBalances(posted, '2026-03-15', { companyId: 1 });
  const entryGain = search(doneGain, 'account.move').find((m) => m.company_id === 1 && m.revaluation_date === '2026-03-15');
  assert.ok(entryGain);
  assert.equal(entryGain.line_ids.find((l) => l.account_id === receivable)?.debit, 25);
  assert.equal(entryGain.line_ids.find((l) => l.account_id === gain)?.credit, 25);
  assert.ok(isBalanced(entryGain.line_ids));
});

test('a payment dated after the revaluation date is ignored', () => {
  const currency = create(seed(), 'res.currency', {
    name: 'CUTOFF_PAY_FX',
    rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }],
  });
  const invoice = create(currency.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    currency_id: currency.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }],
  });
  let db = postMove(invoice.db, invoice.id);
  db = payMove(db, invoice.id, 100, '2026-03-10');
  const paidInvoice = read(db, 'account.move', invoice.id);
  assert.equal(paidInvoice.amount_residual, 0);

  const done = revalueForeignBalances(db, '2026-02-28', { companyId: 1 });
  const entry = search(done, 'account.move').find((m) => m.company_id === 1 && m.revaluation_date === '2026-02-28');
  assert.ok(entry);
  const receivable = accountId(done, '121000');
  assert.equal(entry.line_ids.find((l) => l.account_id === receivable)?.debit, 50);
  assert.equal(entry.line_ids.find((l) => l.account_id === accountId(done, '450100'))?.credit, 50);

  const bank = accountId(done, '101401');
  assert.equal(entry.line_ids.some((l) => l.account_id === bank), false);
});

test('the next-day reversal exists', () => {
  const { db } = fixture();
  const done = revalueForeignBalances(db, '2026-02-28', { companyId: 1 });
  const entry = search(done, 'account.move').find((m) => m.company_id === 1 && m.revaluation_date === '2026-02-28');
  assert.ok(entry);
  assert.equal(entry.state, 'posted');
  assert.equal(entry.date, '2026-02-28');

  assert.ok(entry.reversal_move_id);
  const reversal = read(done, 'account.move', entry.reversal_move_id);
  assert.ok(reversal);
  assert.equal(reversal.state, 'posted');
  assert.equal(reversal.move_type, 'entry');
  assert.equal(reversal.date, '2026-03-01');
  assert.equal(reversal.invoice_date, '2026-03-01');
  assert.equal(reversal.reversed_entry_id, entry.id);
  assert.equal(reversal.company_id, 1);
  assert.ok(isBalanced(entry.line_ids));
  assert.ok(isBalanced(reversal.line_ids));
  assert.deepEqual(
    reversal.line_ids.map((l) => [l.account_id, l.debit, l.credit]),
    entry.line_ids.map((l) => [l.account_id, l.credit, l.debit]),
  );
});

test('company 2 items untouched when revaluing company 1', () => {
  const first = fixture();
  const secondCompany = createCompanyWithDefaultInvoiceJournals(first.db, {
    name: 'Second company isolation',
    currency_id: first.db.settings.base_currency_id,
  });
  let db = secondCompany.db;
  const accounts = {};
  for (const [code, type] of [['121000', 'asset_receivable'], ['400000', 'income'], ['450100', 'income_other'], ['650100', 'expense_other']]) {
    const existing = search(db, 'account.account').find((account) => account.company_id === secondCompany.id && account.code === code);
    const created = existing ? { db, id: existing.id } : create(db, 'account.account', { code, name: code, account_type: type, company_id: secondCompany.id });
    db = created.db;
    accounts[code] = created.id;
  }
  const journal = create(db, 'account.journal', { code: 'MISC', name: 'Second misc', type: 'general', company_id: secondCompany.id });
  db = write(journal.db, 'res.company', secondCompany.id, {
    account_default_receivable_id: accounts['121000'],
    income_currency_exchange_account_id: accounts['450100'],
    expense_currency_exchange_account_id: accounts['650100'],
    default_general_journal_id: journal.id,
  });

  const invoice2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: secondCompany.id,
    currency_id: read(db, 'account.move', first.id).currency_id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'C2 service', qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(invoice2.db, invoice2.id);

  const c2MovesBefore = search(db, 'account.move').filter((m) => m.company_id === secondCompany.id);

  const done = revalueForeignBalances(db, '2026-02-28', { companyId: 1 });

  const c1Reval = search(done, 'account.move').filter((m) => (m.company_id ?? 1) === 1 && m.revaluation_date === '2026-02-28');
  assert.equal(c1Reval.length, 1);

  const c2Reval = search(done, 'account.move').filter((m) => m.company_id === secondCompany.id && m.revaluation_date === '2026-02-28');
  assert.equal(c2Reval.length, 0);

  const c2MovesAfter = search(done, 'account.move').filter((m) => m.company_id === secondCompany.id);
  assert.deepEqual(c2MovesAfter, c2MovesBefore);
});

test('a foreign line without a recorded foreign amount is not revalued', () => {
  const currency = create(seed(), 'res.currency', { name: 'NOAMTFX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const bank = accountId(currency.db, '101401');
  // A stored item (e.g. imported) that names a currency but never recorded the foreign amount.
  const move = { id: 9401, company_id: 1, state: 'posted', move_type: 'entry', date: '2026-01-10',
    line_ids: [{ account_id: bank, debit: 100, credit: 0, currency_id: currency.id }, { account_id: accountId(currency.db, '301000'), debit: 0, credit: 100 }] };
  const db = { ...currency.db, records: { ...currency.db.records, 'account.move': [...currency.db.records['account.move'], move] } };
  assert.deepEqual(foreignBankBalances(db, '2026-02-28', { companyId: 1 }).filter((r) => r.currency_id === currency.id), []);
});

test('an account can be kept in its own currency from the account form', () => {
  const field = models['account.account'].fields.currency_id;
  assert.equal(field?.relation, 'res.currency');
  assert.ok(models['account.account'].form.tabs.some((tab) => (tab.groups ?? []).flat().includes('currency_id')));
  const db = seed();
  const created = create(db, 'account.account', { code: 'OWNCUR', name: 'Own currency', account_type: 'asset_current', currency_id: db.records['res.currency'].find((c) => c.name === 'EUR').id });
  assert.equal(read(created.db, 'account.account', created.id).currency_id, db.records['res.currency'].find((c) => c.name === 'EUR').id);
});

test('company-scoped foreign bank balances ignore which company is active', () => {
  const currency = create(seed(), 'res.currency', { name: 'ACTFX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const bank = accountId(currency.db, '101401');
  let db = postEntry(currency.db, {
    journal: 'MISC', date: '2026-01-10', company: 1,
    lines: [
      { account_id: bank, debit: 100, credit: 0, currency_id: currency.id, amount_currency: 200 },
      { account_id: accountId(currency.db, '301000'), debit: 0, credit: 100 },
    ],
  }).db;
  const second = createCompanyWithDefaultInvoiceJournals(db, { name: 'Active elsewhere', currency_id: db.settings.base_currency_id });
  db = second.db;
  const previous = getActiveCompany();
  setActiveCompany(second.id);
  try {
    assert.equal(foreignBankBalances(db, '2026-02-28', { companyId: 1 }).filter((r) => r.currency_id === currency.id).length, 1);
  } finally {
    setActiveCompany(previous);
  }
});
