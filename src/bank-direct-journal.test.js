import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { eligiblePayments, matchPayment } from './models/bank.js';
import { translatePattern } from './i18n-patterns.js';

const runBtn = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

function setup() {
  const base = seed();
  const suspenseAcc = search(base, 'account.account').find((a) => a.code === '101404').id;
  const bnk2Account = create(base, 'account.account', {
    code: '101405',
    name: 'Bank 2 Liquidity',
    account_type: 'asset_cash',
    company_id: 1,
  });
  const bnk2Res = create(bnk2Account.db, 'account.journal', {
    code: 'BNK2',
    name: 'Bank 2',
    type: 'bank',
    company_id: 1,
    default_account_id: bnk2Account.id,
    suspense_account_id: suspenseAcc,
    outstanding_receipts_account_id: null,
    outstanding_payments_account_id: null,
  });
  const bnk2 = read(bnk2Res.db, 'account.journal', bnk2Res.id);
  const bnk1 = search(bnk2Res.db, 'account.journal').find((j) => j.code === 'BNK1');
  return { db: bnk2Res.db, bnk1, bnk2 };
}

test('1. direct payment on BNK2 is not offered on BNK1 and matching/linking raises error', () => {
  const { db: initDb, bnk1, bnk2 } = setup();
  const payment = create(initDb, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 100,
    journal_id: bnk2.id,
    date: '2026-01-02',
  });
  const db = runBtn(payment.db, 'account.payment', payment.id, 'Confirm');
  const posted = read(db, 'account.payment', payment.id);
  assert.equal(posted.state, 'posted');
  assert.equal(posted.outstanding_account_id, null);

  const bnk1LineRes = create(db, 'account.bank.statement.line', {
    journal_id: bnk1.id,
    date: '2026-01-03',
    payment_ref: 'BNK1 deposit',
    amount: 100,
  });
  const bnk1Line = read(bnk1LineRes.db, 'account.bank.statement.line', bnk1LineRes.id);

  // 1. Not offered in eligiblePayments
  const candidates = eligiblePayments(bnk1LineRes.db, bnk1Line);
  assert.equal(candidates.some((p) => p.id === posted.id), false);

  // 2. Writing payment_ids raises the clear error
  assert.throws(
    () => write(bnk1LineRes.db, 'account.bank.statement.line', bnk1Line.id, { payment_ids: [posted.id] }),
    /This payment was booked directly on journal Bank 2; match it from that journal's statement/,
  );

  // 3. matchPayment raises the clear error
  assert.throws(
    () => matchPayment(bnk1LineRes.db, { ...bnk1Line, payment_ids: [posted.id] }),
    /This payment was booked directly on journal Bank 2; match it from that journal's statement/,
  );
});

test('2. same direct payment matched from a BNK2 statement line still works and reconciles', () => {
  const { db: initDb, bnk2 } = setup();
  const payment = create(initDb, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 100,
    journal_id: bnk2.id,
    date: '2026-01-02',
  });
  const db = runBtn(payment.db, 'account.payment', payment.id, 'Confirm');
  const posted = read(db, 'account.payment', payment.id);

  const bnk2LineRes = create(db, 'account.bank.statement.line', {
    journal_id: bnk2.id,
    date: '2026-01-03',
    payment_ref: 'BNK2 deposit',
    amount: 100,
  });
  const bnk2Line = read(bnk2LineRes.db, 'account.bank.statement.line', bnk2LineRes.id);

  const candidates = eligiblePayments(bnk2LineRes.db, bnk2Line);
  assert.ok(candidates.some((p) => p.id === posted.id));

  const withPayment = write(bnk2LineRes.db, 'account.bank.statement.line', bnk2Line.id, { payment_ids: [posted.id] });
  const lineToMatch = read(withPayment, 'account.bank.statement.line', bnk2Line.id);

  const matched = runBtn(withPayment, 'account.bank.statement.line', lineToMatch.id, 'Match Payment');
  const reconciled = read(matched, 'account.bank.statement.line', bnk2Line.id);
  assert.equal(reconciled.state, 'reconciled');
  assert.equal(reconciled.open_amount, 0);
  assert.deepEqual(reconciled.payment_ids, [posted.id]);
});

test('3. a payment through an outstanding account on BNK2 can still be matched from a BNK1 line', () => {
  const { db: initDb, bnk1, bnk2 } = setup();
  const outstandingAcc = search(initDb, 'account.account').find((a) => a.code === '101402').id;
  const configuredDb = write(initDb, 'account.journal', bnk2.id, { outstanding_receipts_account_id: outstandingAcc });

  const payment = create(configuredDb, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 100,
    journal_id: bnk2.id,
    date: '2026-01-02',
  });
  const db = runBtn(payment.db, 'account.payment', payment.id, 'Confirm');
  const posted = read(db, 'account.payment', payment.id);
  assert.equal(posted.outstanding_account_id, outstandingAcc);

  const bnk1LineRes = create(db, 'account.bank.statement.line', {
    journal_id: bnk1.id,
    date: '2026-01-03',
    payment_ref: 'BNK1 deposit for BNK2 payment',
    amount: 100,
  });
  const bnk1Line = read(bnk1LineRes.db, 'account.bank.statement.line', bnk1LineRes.id);

  const candidates = eligiblePayments(bnk1LineRes.db, bnk1Line);
  assert.ok(candidates.some((p) => p.id === posted.id));

  const withPayment = write(bnk1LineRes.db, 'account.bank.statement.line', bnk1Line.id, { payment_ids: [posted.id] });
  const lineToMatch = read(withPayment, 'account.bank.statement.line', bnk1Line.id);

  const matched = runBtn(withPayment, 'account.bank.statement.line', lineToMatch.id, 'Match Payment');
  const reconciled = read(matched, 'account.bank.statement.line', bnk1Line.id);
  assert.equal(reconciled.state, 'reconciled');
  assert.equal(reconciled.open_amount, 0);
  assert.deepEqual(reconciled.payment_ids, [posted.id]);
});

test('4. Arabic translation present for the new message', () => {
  const msg = 'This payment was booked directly on journal Bank 2; match it from that journal\'s statement';
  const translated = translatePattern(msg, () => null);
  assert.equal(translated, 'تم قيد هذه الدفعة مباشرة في دفتر اليومية Bank 2؛ طابقها من كشف حساب ذلك الدفتر');
});

test('5. two journals sharing one liquidity account, direct payment on one, matched from the other -> works', () => {
  const { db: initDb, bnk1 } = setup();
  const suspenseAcc = search(initDb, 'account.account').find((a) => a.code === '101404').id;
  const bnk3Res = create(initDb, 'account.journal', {
    code: 'BNK3',
    name: 'Bank 3 Shared Account',
    type: 'bank',
    company_id: 1,
    default_account_id: bnk1.default_account_id,
    suspense_account_id: suspenseAcc,
    outstanding_receipts_account_id: null,
    outstanding_payments_account_id: null,
  });
  const bnk3 = read(bnk3Res.db, 'account.journal', bnk3Res.id);

  // Direct payment on BNK1 (no outstanding account)
  const payment = create(bnk3Res.db, 'account.payment', {
    partner_id: 3,
    payment_type: 'inbound',
    partner_type: 'customer',
    amount: 100,
    journal_id: bnk1.id,
    date: '2026-01-02',
    outstanding_account_id: null,
  });
  const db = runBtn(payment.db, 'account.payment', payment.id, 'Confirm');
  const posted = read(db, 'account.payment', payment.id);
  assert.equal(posted.outstanding_account_id, null);

  // Statement line on BNK3 (shares liquidity account with BNK1)
  const bnk3LineRes = create(db, 'account.bank.statement.line', {
    journal_id: bnk3.id,
    date: '2026-01-03',
    payment_ref: 'BNK3 shared deposit',
    amount: 100,
  });
  const bnk3Line = read(bnk3LineRes.db, 'account.bank.statement.line', bnk3LineRes.id);

  const candidates = eligiblePayments(bnk3LineRes.db, bnk3Line);
  assert.ok(candidates.some((p) => p.id === posted.id), 'direct payment on BNK1 is eligible for BNK3 statement line sharing same liquidity account');

  const withPayment = write(bnk3LineRes.db, 'account.bank.statement.line', bnk3Line.id, { payment_ids: [posted.id] });
  const lineToMatch = read(withPayment, 'account.bank.statement.line', bnk3Line.id);

  const matched = runBtn(withPayment, 'account.bank.statement.line', lineToMatch.id, 'Match Payment');
  const reconciled = read(matched, 'account.bank.statement.line', bnk3Line.id);
  assert.equal(reconciled.state, 'reconciled');
  assert.equal(reconciled.open_amount, 0);
  assert.deepEqual(reconciled.payment_ids, [posted.id]);
});
