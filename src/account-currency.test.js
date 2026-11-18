import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { accountId, postEntry } from './models/ledger.js';
import { postPayment } from './models/pay.js';
import { bookBankMovement, reconcileWith } from './models/bank.js';
import { postMove } from './models/accounting.js';
import { rateAt } from './models/currency.js';
import { companyCurrencyRecord, roundCurrency } from './money.js';
import { addDays, today } from './models/common.js';

const euro = (db) => search(db, 'res.currency').find((c) => c.name === 'EUR');
const synced = (db, next) => applyDiff(db, diffDb(db, next), { isAdmin: false, author: 'Clerk' });

const makeAccount = (db, vals) => create(db, 'account.account', { account_type: 'expense', ...vals });
const makeEntry = (db, lines, state = 'posted', name = 'MISC/ACCT-CUR') => create(db, 'account.move', {
  move_type: 'entry', state, name: state === 'posted' ? name : '/', invoice_date: today(), date: today(), line_ids: lines,
});

test('posting a manual entry with a foreign-currency line on an account forced to company currency is rejected; the same entry with the right currency posts', () => {
  const base = seed();
  const usd = companyCurrencyRecord(base, 1);
  const eur = euro(base);
  const made = makeAccount(base, { code: 'CUR001', name: 'USD expense', currency_id: usd.id });
  const db = made.db;
  const cash = accountId(db, '101401');
  const lines = (currency) => [
    { account_id: made.id, debit: 100, credit: 0, ...(currency ? { currency_id: currency.id, amount_currency: 100 } : {}) },
    { account_id: cash, debit: 0, credit: 100 },
  ];

  // Foreign-currency EUR line on an account forced to USD is rejected.
  assert.throws(() => makeEntry(db, lines(eur)), /The account forces journal items in its currency/);
  // An entry with company currency (no line currency or explicit USD) posts.
  assert.doesNotThrow(() => makeEntry(db, lines(null)));
  assert.doesNotThrow(() => makeEntry(db, lines(usd)));

  // Account forced to EUR also rejects company-currency lines.
  const eurAccount = makeAccount(db, { code: 'CUR002', name: 'EUR expense', currency_id: eur.id });
  assert.throws(() => makeEntry(eurAccount.db, [
    { account_id: eurAccount.id, debit: 50, credit: 0 },
    { account_id: cash, debit: 0, credit: 50 },
  ]), /The account forces journal items in its currency/);
  assert.doesNotThrow(() => makeEntry(eurAccount.db, [
    { account_id: eurAccount.id, debit: 50, credit: 0, currency_id: eur.id, amount_currency: 50 },
    { account_id: cash, debit: 0, credit: 50 },
  ]));

  // Accounts without a currency keep accepting company-currency lines.
  const plain = makeAccount(db, { code: 'CUR003', name: 'Plain expense' });
  assert.doesNotThrow(() => makeEntry(plain.db, [
    { account_id: plain.id, debit: 25, credit: 0 },
    { account_id: cash, debit: 0, credit: 25 },
  ]));
});

test('the rejection also happens through diffDb + applyDiff', () => {
  const base = seed();
  const usd = companyCurrencyRecord(base, 1);
  const eur = euro(base);
  const made = makeAccount(base, { code: 'CUR010', name: 'USD expense', currency_id: usd.id });
  const db = made.db;
  const cash = accountId(db, '101401');
  const draft = makeEntry(db, [
    { account_id: made.id, debit: 50, credit: 0, currency_id: eur.id, amount_currency: 50 },
    { account_id: cash, debit: 0, credit: 50 },
  ], 'draft');

  const forged = diffDb(db, draft.db);
  forged.upserts['account.move'] = forged.upserts['account.move'].map((m) => (
    m.id === draft.id ? { ...m, state: 'posted', name: 'MISC/SYNC' } : m
  ));
  assert.throws(() => applyDiff(db, forged, { isAdmin: false, author: 'Clerk' }), /The account forces journal items in its currency/);
});

test('setting currency_id on an account that already has EUR items is rejected, directly and through applyDiff', () => {
  const base = seed();
  const eur = euro(base);
  const usd = companyCurrencyRecord(base, 1);
  const made = makeAccount(base, { code: 'CUR020', name: 'Expense with EUR items' });
  const cash = accountId(base, '101401');
  const posted = makeEntry(made.db, [
    { account_id: made.id, debit: 40, credit: 0, currency_id: eur.id, amount_currency: 40 },
    { account_id: cash, debit: 0, credit: 40 },
  ]);
  const db = posted.db;

  assert.throws(() => write(db, 'account.account', made.id, { currency_id: usd.id }), /The account has journal items in another currency/);

  const forged = {
    ...db,
    records: {
      ...db.records,
      'account.account': db.records['account.account'].map((a) => (a.id === made.id ? { ...a, currency_id: usd.id } : a)),
    },
  };
  assert.throws(() => synced(db, forged), /The account has journal items in another currency/);
});

test('an account currency can be set when its posted items already use it', () => {
  const base = seed();
  const eur = euro(base);
  const made = makeAccount(base, { code: 'CUR030', name: 'Expense' });
  const cash = accountId(base, '101401');
  const amount = roundCurrency(40 * rateAt(base, eur.id, today(), 1), eur);
  let db = makeEntry(made.db, [
    { account_id: made.id, debit: 40, credit: 0, currency_id: eur.id, amount_currency: amount },
    { account_id: cash, debit: 0, credit: 40 },
  ]).db;

  db = write(db, 'account.account', made.id, { currency_id: eur.id });
  assert.equal(read(db, 'account.account', made.id).currency_id, eur.id);
});

test('a currency change and a new entry are judged against the final change set', () => {
  const base = seed();
  const eur = euro(base);
  const made = makeAccount(base, { code: 'CUR040', name: 'Expense' });
  const db = made.db;
  const cash = accountId(db, '101401');
  const draft = makeEntry(db, [
    { account_id: made.id, debit: 60, credit: 0 },
    { account_id: cash, debit: 0, credit: 60 },
  ], 'draft');

  const staged = (currencyFields) => ({
    ...draft.db,
    records: {
      ...draft.db.records,
      'account.account': draft.db.records['account.account'].map((a) => (a.id === made.id ? { ...a, currency_id: eur.id } : a)),
      'account.move': draft.db.records['account.move'].map((m) => (m.id === draft.id
        ? { ...m, state: 'posted', name: 'MISC/ORDER', line_ids: m.line_ids.map((l) => (l.account_id === made.id ? { ...l, ...currencyFields } : l)) }
        : m)),
    },
  });

  // The move guard runs first and sees the final account currency in the same change set.
  assert.throws(() => applyDiff(db, diffDb(db, staged({})), { isAdmin: false, author: 'Clerk' }), (err) => (
    err.message === 'The account forces journal items in its currency'
  ));

  const amount = roundCurrency(60 * rateAt(draft.db, eur.id, today(), 1), eur);
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, staged({ currency_id: eur.id, amount_currency: amount })), { isAdmin: false, author: 'Clerk' }));
});

test('a bank journal account forced to USD: reconciling a USD statement line produces lines in USD with correct amount_currency; a payment through that journal too', async () => {
  const { createCompanyWithDefaultInvoiceJournals, withDefaultBankJournal } = await import('./test-support/accounting-company.js');
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const coEur = createCompanyWithDefaultInvoiceJournals(db, { name: 'EUR Co', currency_id: eur.id });
  db = withDefaultBankJournal(coEur.db, coEur.id);

  const journal = search(db, 'account.journal').find((j) => j.company_id === coEur.id && j.type === 'bank');
  db = write(db, 'account.account', journal.default_account_id, { currency_id: usd.id });
  const bank = read(db, 'account.account', journal.default_account_id);

  const partner = search(db, 'res.partner').find((p) => p.is_company);

  // 1. Payment through that journal carries USD currency_id and amount_currency.
  const madePay = create(db, 'account.payment', {
    company_id: coEur.id,
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    amount: 100,
    currency_id: usd.id,
    date: today(),
    journal_id: journal.id,
  });
  db = postPayment(madePay.db, read(madePay.db, 'account.payment', madePay.id));
  const pay = read(db, 'account.payment', madePay.id);
  const payMove = read(db, 'account.move', pay.move_id);
  const payBankLine = payMove.line_ids.find((l) => l.account_id === bank.id);
  assert.equal(payBankLine.currency_id, usd.id);
  assert.equal(payBankLine.amount_currency, 100);

  // 2. Reconciling a USD statement line produces lines in USD with correct amount_currency.
  const stmtLine = create(db, 'account.bank.statement.line', {
    company_id: coEur.id,
    journal_id: journal.id,
    date: today(),
    amount: 80,
    payment_ref: 'USD Deposit',
  });
  db = stmtLine.db;
  const inv = create(db, 'account.move', {
    company_id: coEur.id,
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: today(),
    currency_id: usd.id,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 80, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const booked = reconcileWith(db, read(db, 'account.bank.statement.line', stmtLine.id), inv.id);
  const stmtRec = read(booked, 'account.bank.statement.line', stmtLine.id);
  const bankEntry = read(booked, 'account.move', stmtRec.bank_move_id);
  const bankLine = bankEntry.line_ids.find((l) => l.account_id === bank.id);
  assert.equal(bankLine.currency_id, usd.id);
  assert.ok(bankLine.amount_currency > 0);
});

test('payments into a foreign-currency bank account carry that account currency', () => {
  const base = seed();
  const eur = euro(base);
  const bank = makeAccount(base, { code: '101499', name: 'EUR Bank', account_type: 'asset_cash', currency_id: eur.id });
  const journal = create(bank.db, 'account.journal', {
    name: 'EUR Bank', code: 'BNKEUR', type: 'bank', company_id: 1,
    default_account_id: bank.id, suspense_account_id: accountId(bank.db, '101404'),
  });
  const partner = search(journal.db, 'res.partner').find((p) => p.is_company);
  const made = create(journal.db, 'account.payment', {
    payment_type: 'inbound', partner_type: 'customer', partner_id: partner.id,
    amount: 100, date: today(), journal_id: journal.id,
  });
  const posted = postPayment(made.db, read(made.db, 'account.payment', made.id));
  const payment = read(posted, 'account.payment', made.id);
  const move = read(posted, 'account.move', payment.move_id);
  const line = move.line_ids.find((l) => l.account_id === bank.id);
  assert.equal(line.currency_id, eur.id);
  assert.equal(line.amount_currency, roundCurrency(100 * rateAt(posted, eur.id, today(), 1), eur));
});

test('bank statement bookings carry the bank account currency', () => {
  const base = seed();
  const eur = euro(base);
  const bank = makeAccount(base, { code: '101498', name: 'Statement Bank', account_type: 'asset_cash', currency_id: eur.id });
  const journal = create(bank.db, 'account.journal', {
    name: 'Statement Bank', code: 'STMTEUR', type: 'bank', company_id: 1,
    default_account_id: bank.id, suspense_account_id: accountId(bank.db, '101404'),
  });
  const line = create(journal.db, 'account.bank.statement.line', {
    journal_id: journal.id, date: today(), amount: 80, payment_ref: 'Deposit',
  });
  const booked = bookBankMovement(line.db, read(line.db, 'account.bank.statement.line', line.id), 1, { date: today(), openAmount: 80 });
  const entry = read(booked.db, 'account.move', booked.bankMoveId);
  const bankLine = entry.line_ids.find((l) => l.account_id === bank.id);
  assert.equal(bankLine.currency_id, eur.id);
  assert.equal(bankLine.amount_currency, roundCurrency(80 * rateAt(booked.db, eur.id, today(), 1), eur));
});

test('an exchange difference generated on settlement of a USD invoice does not violate the rule', async () => {
  const { createCompanyWithDefaultInvoiceJournals, withDefaultBankJournal } = await import('./test-support/accounting-company.js');
  let db = seed();
  const eur = euro(db);
  const usd = companyCurrencyRecord(db, 1);
  const co2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'EUR Co', currency_id: eur.id });
  db = withDefaultBankJournal(co2.db, co2.id);

  const co = read(db, 'res.company', co2.id);
  const lossAccount = co.expense_currency_exchange_account_id;
  db = write(db, 'account.account', lossAccount, { currency_id: usd.id });

  const partner = search(db, 'res.partner').find((p) => p.is_company);
  const invoice = create(db, 'account.move', {
    company_id: co2.id,
    move_type: 'out_invoice',
    partner_id: partner.id,
    currency_id: usd.id,
    invoice_date: addDays(today(), -50),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invoice.db, invoice.id);

  const bankJournal = search(db, 'account.journal').find((j) => j.company_id === co2.id && j.type === 'bank');
  const payment = create(db, 'account.payment', {
    company_id: co2.id,
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    amount: 100,
    currency_id: usd.id,
    date: addDays(today(), -1),
    journal_id: bankJournal.id,
  });
  db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const settled = read(db, 'account.move', invoice.id);
  const fxMoveId = settled.payments?.[0]?.payment_fx_move_id;
  assert.ok(fxMoveId, 'exchange difference move must be generated');
  const fxMove = read(db, 'account.move', fxMoveId);
  assert.equal(fxMove.state, 'posted');
  const lossLine = fxMove.line_ids.find((l) => l.account_id === lossAccount);
  assert.equal(lossLine.currency_id, usd.id);
  assert.ok(lossLine.amount_currency > 0);
});

test('exchange difference entries carry the exchange account currency', () => {
  const base = seed();
  const fx = create(base, 'res.currency', {
    name: 'ACCTFX', rounding: 0.01,
    rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-01-02', rate: 4 }],
  });
  const loss = search(fx.db, 'account.account').find((a) => a.code === '690100');
  let db = write(fx.db, 'account.account', loss.id, { currency_id: fx.id });

  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', currency_id: fx.id,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invoice.db, invoice.id);
  const payment = create(db, 'account.payment', {
    payment_type: 'inbound', partner_type: 'customer', partner_id: 1,
    amount: 25, date: '2026-01-02', currency_id: fx.id,
  });
  db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));

  const settled = read(db, 'account.move', invoice.id);
  const fxEntry = read(db, 'account.move', settled.payments[0].payment_fx_move_id);
  const line = fxEntry.line_ids.find((l) => l.account_id === loss.id);
  const company = (Number(line.debit) || 0) - (Number(line.credit) || 0);
  assert.ok(company > 0, 'the loss entry must debit the exchange loss account');
  assert.equal(line.currency_id, fx.id);
  assert.equal(line.amount_currency, roundCurrency(company * rateAt(db, fx.id, '2026-01-02', 1), fx));
});

test('generated entries carry the account currency and convert at the entry date', () => {
  const base = seed();
  const eur = euro(base);
  const made = makeAccount(base, { code: 'CUR050', name: 'EUR expense', currency_id: eur.id });
  const cash = accountId(made.db, '101401');
  const booked = postEntry(made.db, {
    journal: 'MISC', date: today(), ref: 'Generated expense', system_generated: true,
    lines: [
      { account_id: made.id, debit: 100, credit: 0 },
      { account_id: cash, debit: 0, credit: 100 },
    ],
  });
  const entry = read(booked.db, 'account.move', booked.id);
  const line = entry.line_ids.find((l) => l.account_id === made.id);
  const expected = roundCurrency(100 * rateAt(booked.db, eur.id, today(), 1), eur);
  assert.equal(line.currency_id, eur.id);
  assert.equal(line.amount_currency, expected);
});

test('a generated entry without an exchange rate fails clearly instead of dropping the currency', () => {
  const base = seed();
  const unrated = create(base, 'res.currency', { name: 'UNRATED', rounding: 0.01 });
  const made = makeAccount(unrated.db, { code: 'CUR060', name: 'Unrated expense', currency_id: unrated.id });
  const cash = accountId(made.db, '101401');
  assert.throws(() => postEntry(made.db, {
    journal: 'MISC', date: today(), ref: 'No rate',
    lines: [
      { account_id: made.id, debit: 10, credit: 0 },
      { account_id: cash, debit: 0, credit: 10 },
    ],
  }), /exchange rate|rate on or before/i);
  assert.equal(companyCurrencyRecord(made.db, 1).name, 'USD');
});
