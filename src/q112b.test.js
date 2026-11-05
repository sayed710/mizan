import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postPayment } from './models/pay.js';
import { applyDiff, diffDb } from './sync.js';
import { balanceSheet, postEntry, profitAndLoss } from './models/ledger.js';
import { createCompany } from './models/company.js';
import { rateAt, toCompany } from './models/currency.js';
import { addDays, today } from './models/common.js';
import { invoiceJournalDefaults } from './test-support/accounting-company.js';

test('Qodo 2: standalone foreign-currency payment syncs without invariant failure', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency must exist');
  const partner = search(db, 'res.partner').find((p) => p.is_company);
  assert.ok(partner, 'Company partner must exist');
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank');
  assert.ok(journal, 'Bank journal must exist');

  const payDate = addDays(today(), -1);
  const paymentAmount = 1000;

  // Create a draft standalone inbound payment in EUR
  const pResult = create(db, 'account.payment', {
    name: 'PAY/EUR/SYNC/001',
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    amount: paymentAmount,
    currency_id: eur.id,
    journal_id: journal.id,
    company_id: 1,
    date: payDate,
  });
  db = pResult.db;
  const pRec = read(db, 'account.payment', pResult.id);

  // Post payment locally
  const postedDb = postPayment(db, pRec);
  const postedPayment = read(postedDb, 'account.payment', pResult.id);
  assert.equal(postedPayment.state, 'posted');

  // Sync to server via applyDiff - this triggers paymentInvariant on the posted payment
  const diff = diffDb(db, postedDb);
  assert.doesNotThrow(() => {
    const syncedDb = applyDiff(db, diff, { isAdmin: true });
    assert.equal(read(syncedDb, 'account.payment', pResult.id).state, 'posted');
  }, /The journal entry must book this payment amount and direction/);
});

test('Qodo 4: standalone payment through journal designated in another currency sets correct line currencies', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency must exist');
  const partner = search(db, 'res.partner').find((p) => p.is_company);
  assert.ok(partner, 'Company partner must exist');

  // Create GBP currency with rate
  const gbpRes = create(db, 'res.currency', {
    name: 'GBP',
    rounding: 0.01,
    rate_ids: [{ date: '2020-01-01', rate: 0.8 }],
  });
  db = gbpRes.db;
  const gbp = read(db, 'res.currency', gbpRes.id);

  // Create a bank account and journal designated in GBP
  const gbpAcc = create(db, 'account.account', {
    code: '101420',
    name: 'GBP Bank Account',
    account_type: 'asset_cash',
    currency_id: gbp.id,
    company_id: 1,
  });
  db = gbpAcc.db;

  const gbpJournal = create(db, 'account.journal', {
    name: 'GBP Bank',
    code: 'BNKG',
    type: 'bank',
    currency_id: gbp.id,
    default_account_id: gbpAcc.id,
    suspense_account_id: search(db, 'account.account').find((a) => a.code === '101404')?.id,
    company_id: 1,
  });
  db = gbpJournal.db;

  const payDate = addDays(today(), -1);
  const paymentAmount = 900; // EUR

  // Standalone inbound payment in EUR through GBP bank journal
  const pResult = create(db, 'account.payment', {
    name: 'PAY/EUR/GBP/001',
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    amount: paymentAmount,
    currency_id: eur.id,
    journal_id: gbpJournal.id,
    company_id: 1,
    date: payDate,
  });
  db = pResult.db;
  const pRec = read(db, 'account.payment', pResult.id);

  const postedDb = postPayment(db, pRec);
  const payment = read(postedDb, 'account.payment', pResult.id);
  const move = read(postedDb, 'account.move', payment.move_id);

  const liquidityLine = move.line_ids.find((l) => l.account_id === gbpAcc.id);
  const counterpartLine = move.line_ids.find((l) => l.account_id !== gbpAcc.id);

  assert.ok(liquidityLine, 'Must have liquidity line on GBP account');
  assert.ok(counterpartLine, 'Must have counterpart line');

  // Counterpart line must carry payment currency (EUR)
  assert.equal(counterpartLine.currency_id, eur.id);
  assert.equal(counterpartLine.amount_currency, -paymentAmount);

  // Liquidity line must carry journal currency (GBP), converted from company currency
  const companyAmount = toCompany(postedDb, eur.id, paymentAmount, payDate, 1);
  const expectedGbp = Number((companyAmount * rateAt(postedDb, gbp.id, payDate, 1)).toFixed(2));
  assert.equal(liquidityLine.currency_id, gbp.id, 'Liquidity line must carry journal currency GBP');
  assert.equal(liquidityLine.amount_currency, expectedGbp, 'Liquidity amount must convert at payment date');
});

test('Qodo 4: standalone payment through journal explicitly designated in company currency leaves liquidity line in company currency', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const partner = search(db, 'res.partner').find((p) => p.is_company);

  // Bank journal explicitly designated in company currency USD
  const usdAcc = create(db, 'account.account', {
    code: '101430',
    name: 'USD Explicit Bank Account',
    account_type: 'asset_cash',
    currency_id: usd.id,
    company_id: 1,
  });
  db = usdAcc.db;

  const usdJournal = create(db, 'account.journal', {
    name: 'USD Explicit Bank',
    code: 'BNKU',
    type: 'bank',
    currency_id: usd.id,
    default_account_id: usdAcc.id,
    suspense_account_id: search(db, 'account.account').find((a) => a.code === '101404')?.id,
    company_id: 1,
  });
  db = usdJournal.db;

  const payDate = addDays(today(), -1);
  const paymentAmount = 500;

  const pResult = create(db, 'account.payment', {
    name: 'PAY/EUR/USD/001',
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    amount: paymentAmount,
    currency_id: eur.id,
    journal_id: usdJournal.id,
    company_id: 1,
    date: payDate,
  });
  db = pResult.db;

  const postedDb = postPayment(db, read(db, 'account.payment', pResult.id));
  const payment = read(postedDb, 'account.payment', pResult.id);
  const move = read(postedDb, 'account.move', payment.move_id);

  const liquidityLine = move.line_ids.find((l) => l.account_id === usdAcc.id);
  const counterpartLine = move.line_ids.find((l) => l.account_id !== usdAcc.id);

  assert.ok(liquidityLine);
  assert.ok(counterpartLine);
  // Counterpart line has EUR metadata
  assert.equal(counterpartLine.currency_id, eur.id);
  assert.equal(counterpartLine.amount_currency, -paymentAmount);
  // Liquidity line has no foreign currency metadata
  assert.equal(liquidityLine.currency_id ?? null, null);
  assert.equal(liquidityLine.amount_currency ?? null, null);
});

test('Qodo 5: multi-company balance sheet splits current and prior earnings at each company fiscal year start', () => {
  let db = seed();
  // Company 1 has calendar year fiscal year (default: 2026-01-01 to 2026-12-31)

  // Create Company 2 with fiscal year starting July 1:
  // FY 2025-2026: 2025-07-01 to 2026-06-30 (closed/prior)
  // FY 2026-2027: 2026-07-01 to 2027-06-30 (current)
  const comp2 = createCompany(db, { name: 'Company Two', ...invoiceJournalDefaults(db) });
  db = comp2.db;
  const earnings2 = create(db, 'account.account', {
    name: 'Co 2 Current Year Earnings', code: 'C2-EARN', account_type: 'equity', company_id: comp2.id,
  });
  db = write(earnings2.db, 'res.company', comp2.id, { current_year_earnings_account_id: earnings2.id });

  // Add fiscal year records for Company 2
  const fyPrior = create(db, 'account.fiscal.year', {
    name: 'FY2025-2026',
    company_id: comp2.id,
    date_from: '2025-07-01',
    date_to: '2026-06-30',
  });
  db = fyPrior.db;
  const fyCurrent = create(db, 'account.fiscal.year', {
    name: 'FY2026-2027',
    company_id: comp2.id,
    date_from: '2026-07-01',
    date_to: '2027-06-30',
  });
  db = fyCurrent.db;

  // Post income for Company 1 on 2026-03-15 ($100) -> current year for Co 1
  const income1 = search(db, 'account.account').find((a) => a.account_type === 'income');
  const cash1 = search(db, 'account.account').find((a) => a.account_type === 'asset_cash');
  const entry1 = postEntry(db, {
    journal: 'MISC', date: '2026-03-15', company: 1,
    lines: [
      { account_id: cash1.id, debit: 100 },
      { account_id: income1.id, credit: 100 },
    ],
  });
  db = entry1.db;

  // For Company 2:
  // Post income on 2026-03-15 ($200) -> this is PRIOR fiscal year for Co 2 (prior to 2026-07-01)
  // Post income on 2026-08-15 ($300) -> this is CURRENT fiscal year for Co 2 (after 2026-07-01)
  const income2 = create(db, 'account.account', { name: 'C2 Income', code: 'C2-INC', account_type: 'income', company_id: comp2.id });
  db = income2.db;
  const cash2 = create(db, 'account.account', { name: 'C2 Cash', code: 'C2-CSH', account_type: 'asset_cash', company_id: comp2.id });
  db = cash2.db;

  const comp2Journal = search(db, 'account.journal').find((j) => j.company_id === comp2.id);
  const entry2Prior = postEntry(db, {
    journal: comp2Journal.id,
    date: '2026-03-15',
    company: comp2.id,
    lines: [
      { account_id: cash2.id, debit: 200 },
      { account_id: income2.id, credit: 200 },
    ],
  });
  db = entry2Prior.db;

  const entry2Current = postEntry(db, {
    journal: comp2Journal.id,
    date: '2026-08-15',
    company: comp2.id,
    lines: [
      { account_id: cash2.id, debit: 300 },
      { account_id: income2.id, credit: 300 },
    ],
  });
  db = entry2Current.db;

  // Run balanceSheet at 2026-09-30 without company filter
  const sheet = balanceSheet(db, '2026-09-30');

  // Co 1 current earnings (from 2026-01-01) + Co 2 current earnings (300, from 2026-07-01!)
  const co1Current = profitAndLoss(db, { from: '2026-01-01', to: '2026-09-30', company_id: 1 }).net;
  assert.equal(sheet.earnings, co1Current + 300, 'Combined current earnings must be Co 1 current + Co 2 current');

  // Co 2 prior earnings (200 from 2026-03-15) must be assigned to Co 2 earnings account in equity
  const c2EquityRow = sheet.equity.find((r) => r.account.id === earnings2.id);
  assert.ok(c2EquityRow, 'Company 2 earnings account must be in equity');
  assert.equal(c2EquityRow.balance, 200, 'Company 2 prior earnings must be 200');

  // Total balance sheet must be balanced
  assert.equal(sheet.totalAssets, sheet.totalLiabilities + sheet.totalEquity, 'Assets must equal liabilities + equity');

  // When filtered by company 2 explicitly, preserves single-company behavior
  const sheet2 = balanceSheet(db, { to: '2026-09-30', company_id: comp2.id });
  assert.equal(sheet2.earnings, 300);
  assert.equal(sheet2.equity.find((r) => r.account.id === earnings2.id)?.balance, 200);
  assert.equal(sheet2.totalAssets, sheet2.totalLiabilities + sheet2.totalEquity);
});
