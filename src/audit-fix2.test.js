import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import {
  bookedStatementAmount,
  isBalanced,
  isPaymentMatched,
  journalItems,
} from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { postPayment, reversePayment } from './models/pay.js';
import { foreignBalanceReport } from './models/closing.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

const LINE = 'account.bank.statement.line';

const runButton = (db, id, label) =>
  models[LINE].form.buttons.find((b) => b.label === label).run(db, read(db, LINE, id)).db;

const bnk1Journal = (db, companyId = 1) =>
  search(db, 'account.journal').find(
    (j) => j.type === 'bank' && (j.company_id ?? 1) === companyId,
  );

const makeDirectPayment = (db, { journalId, partnerId, amount, paymentType, date = '2026-05-01' }) => {
  const created = create(db, 'account.payment', {
    company_id: 1,
    journal_id: journalId,
    partner_id: partnerId,
    amount,
    payment_type: paymentType,
    date,
    outstanding_account_id: null,
  });
  const postedDb = postPayment(created.db, read(created.db, 'account.payment', created.id));
  const payment = read(postedDb, 'account.payment', created.id);
  return { db: postedDb, id: created.id, move_id: payment.move_id, payment };
};

const setupFxScenario = ({ paymentDate, paymentRate, statementDate, statementRate, directOnFxJournal = false }) => {
  let db = seed();
  const company = read(db, 'res.company', 1);
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const partner = search(db, 'res.partner')[0];
  const bnk1 = bnk1Journal(db);
  const incomeAccount = search(db, 'account.account').find(
    (a) => a.account_type === 'income' && (a.company_id ?? 1) === 1,
  );

  // Use distinct rate dates (paymentDate != statementDate) so rateAt picks each exact rate.
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [
      ...(eur.rate_ids ?? []),
      { date: paymentDate, rate: paymentRate },
      { date: statementDate, rate: statementRate },
    ],
  });
  const fxBnkRes = create(db, 'account.journal', {
    name: 'EUR Bank',
    code: 'EURB',
    type: 'bank',
    currency_id: eur.id,
    default_account_id: bnk1.default_account_id,
    suspense_account_id: bnk1.suspense_account_id,
    company_id: 1,
  });
  const fxBnk = read(fxBnkRes.db, 'account.journal', fxBnkRes.id);

  const invRes = create(fxBnkRes.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    currency_id: eur.id,
    invoice_date: paymentDate,
    date: paymentDate,
    invoice_line_ids: [
      { name: 'FX Service', account_id: incomeAccount.id, qty: 1, price_unit: 100, tax: 0 },
    ],
  });
  db = postMove(invRes.db, invRes.id);

  // Both direct payment shapes (posted via BNK1 with 5th-arg journalId quirk, or directly on EURB) must reconcile cleanly.
  db = directOnFxJournal
    ? payMove(db, invRes.id, 100, paymentDate, { journalId: fxBnk.id, directBank: true })
    : payMove(db, invRes.id, 100, paymentDate, fxBnk.id);

  const allPayments = search(db, 'account.payment');
  const latestPayment = allPayments[allPayments.length - 1];

  const slRes = create(db, LINE, {
    journal_id: fxBnk.id,
    date: statementDate,
    payment_ref: 'EUR wire',
    amount: 100,
    partner_id: partner.id,
    payment_id: latestPayment.id,
    state: 'to_check',
  });

  return {
    db: slRes.db,
    company,
    eur,
    partner,
    bnk1,
    fxBnk,
    invoiceId: invRes.id,
    payment: read(slRes.db, 'account.payment', latestPayment.id),
    statementLineId: slRes.id,
  };
};

test('Probe 3: match multiple posted direct payments to one statement line and unreconcile cleanly', () => {
  const base = seed();
  const bnk1 = bnk1Journal(base);
  const partner = search(base, 'res.partner')[0];

  const p1 = makeDirectPayment(base, {
    journalId: bnk1.id,
    partnerId: partner.id,
    amount: 40,
    paymentType: 'inbound',
  });
  const p2 = makeDirectPayment(p1.db, {
    journalId: bnk1.id,
    partnerId: partner.id,
    amount: 60,
    paymentType: 'inbound',
  });
  assert.equal(p1.payment.outstanding_account_id, null);
  assert.equal(p2.payment.outstanding_account_id, null);

  const slRes = create(p2.db, LINE, {
    journal_id: bnk1.id,
    date: '2026-05-10',
    payment_ref: 'Combined direct deposit 40 + 60',
    amount: 100,
    partner_id: partner.id,
    payment_ids: [p1.id, p2.id],
    state: 'to_check',
  });

  const matchedDb = runButton(slRes.db, slRes.id, 'Match Payment');
  const line = read(matchedDb, LINE, slRes.id);

  assert.equal(line.state, 'reconciled');
  assert.equal(line.open_amount, 0);
  assert.deepEqual(line.payment_ids, [p1.id, p2.id]);
  assert.deepEqual(line.allocations, [
    { payment_move_id: p1.move_id, amount: 40 },
    { payment_move_id: p2.move_id, amount: 60 },
  ]);
  assert.equal(bookedStatementAmount(matchedDb, line), 100);
  assert.equal(isPaymentMatched(matchedDb, read(matchedDb, 'account.payment', p1.id)), true);
  assert.equal(isPaymentMatched(matchedDb, read(matchedDb, 'account.payment', p2.id)), true);

  // Sync / lineGuard accepts the valid multi-direct-payment change set, and rejects incomplete/forged allocations.
  const synced = applyDiff(slRes.db, diffDb(slRes.db, matchedDb), { isAdmin: true });
  assert.equal(read(synced, LINE, slRes.id).state, 'reconciled');

  const forgedPartial = {
    ...matchedDb,
    records: {
      ...matchedDb.records,
      [LINE]: matchedDb.records[LINE].map((l) =>
        l.id === slRes.id ? { ...l, allocations: [{ payment_move_id: p1.move_id, amount: 100 }] } : l,
      ),
    },
  };
  assert.throws(
    () => applyDiff(slRes.db, diffDb(slRes.db, forgedPartial), { isAdmin: true }),
    /match/i,
  );

  const forgedSubset = {
    ...matchedDb,
    records: {
      ...matchedDb.records,
      [LINE]: matchedDb.records[LINE].map((l) =>
        l.id === slRes.id ? { ...l, allocations: [{ payment_move_id: p1.move_id, amount: 40 }] } : l,
      ),
    },
  };
  assert.throws(
    () => applyDiff(slRes.db, diffDb(slRes.db, forgedSubset), { isAdmin: true }),
    /match/i,
  );

  // Double-matching or reversing either matched direct payment is refused while reconciled.
  const secondSl = create(matchedDb, LINE, {
    journal_id: bnk1.id,
    date: '2026-05-11',
    payment_ref: 'Duplicate match attempt',
    amount: 60,
    partner_id: partner.id,
    payment_id: p2.id,
    state: 'to_check',
  });
  assert.throws(() => runButton(secondSl.db, secondSl.id, 'Match Payment'), /already matched/i);
  assert.throws(
    () => reversePayment(matchedDb, read(matchedDb, 'account.payment', p1.id)),
    /reconciled|unreconcile/i,
  );
  assert.throws(
    () => reversePayment(matchedDb, read(matchedDb, 'account.payment', p2.id)),
    /reconciled|unreconcile/i,
  );

  // Unreconcile restores statement line and releases BOTH direct payments without cancelling them.
  const undoneDb = runButton(matchedDb, slRes.id, 'Unreconcile');
  const undoneLine = read(undoneDb, LINE, slRes.id);
  const undoneP1 = read(undoneDb, 'account.payment', p1.id);
  const undoneP2 = read(undoneDb, 'account.payment', p2.id);

  assert.equal(undoneLine.state, 'to_check');
  assert.equal(undoneLine.open_amount, null);
  assert.equal(undoneLine.bank_move_id, null);
  assert.equal(undoneLine.move_id, null);
  assert.equal(undoneLine.payment_id, null);
  assert.equal(undoneLine.payment_move_id, null);
  assert.deepEqual(undoneLine.payment_ids ?? [], []);
  assert.deepEqual(undoneLine.allocations ?? [], []);
  assert.equal(undoneP1.state, 'posted');
  assert.equal(undoneP2.state, 'posted');
  assert.equal(isPaymentMatched(undoneDb, undoneP1), false);
  assert.equal(isPaymentMatched(undoneDb, undoneP2), false);

  // Both payments can now be matched again.
  const rematchedDb = write(undoneDb, LINE, slRes.id, { payment_ids: [p1.id, p2.id] });
  const rematchFinal = runButton(rematchedDb, slRes.id, 'Match Payment');
  assert.equal(read(rematchFinal, LINE, slRes.id).state, 'reconciled');
});

test('Probe 3b: match multiple posted outbound direct payments and unreconcile cleanly', () => {
  const base = seed();
  const bnk1 = bnk1Journal(base);
  const partner = search(base, 'res.partner')[0];

  const p1 = makeDirectPayment(base, {
    journalId: bnk1.id,
    partnerId: partner.id,
    amount: 35,
    paymentType: 'outbound',
  });
  const p2 = makeDirectPayment(p1.db, {
    journalId: bnk1.id,
    partnerId: partner.id,
    amount: 65,
    paymentType: 'outbound',
  });

  const slRes = create(p2.db, LINE, {
    journal_id: bnk1.id,
    date: '2026-05-12',
    payment_ref: 'Combined outbound 35 + 65',
    amount: -100,
    partner_id: partner.id,
    payment_ids: [p1.id, p2.id],
    state: 'to_check',
  });

  const matchedDb = runButton(slRes.db, slRes.id, 'Match Payment');
  const line = read(matchedDb, LINE, slRes.id);
  assert.equal(line.state, 'reconciled');
  assert.deepEqual(line.allocations, [
    { payment_move_id: p1.move_id, amount: 35 },
    { payment_move_id: p2.move_id, amount: 65 },
  ]);
  assert.equal(bookedStatementAmount(matchedDb, line), 100);
  assert.equal(isPaymentMatched(matchedDb, read(matchedDb, 'account.payment', p1.id)), true);
  assert.equal(isPaymentMatched(matchedDb, read(matchedDb, 'account.payment', p2.id)), true);

  const undoneDb = runButton(matchedDb, slRes.id, 'Unreconcile');
  assert.equal(read(undoneDb, LINE, slRes.id).state, 'to_check');
  assert.equal(isPaymentMatched(undoneDb, read(undoneDb, 'account.payment', p1.id)), false);
  assert.equal(isPaymentMatched(undoneDb, read(undoneDb, 'account.payment', p2.id)), false);
});

test('Probe 4: direct FX payment with rate delta posts balanced realized exchange loss on configured account', () => {
  const setup = setupFxScenario({
    paymentDate: '2026-05-01',
    paymentRate: 2.0, // 100 EUR -> 50 USD
    statementDate: '2026-05-15',
    statementRate: 2.5, // 100 EUR -> 40 USD (10 USD loss)
  });

  const matchedDb = runButton(setup.db, setup.statementLineId, 'Match Payment');
  const line = read(matchedDb, LINE, setup.statementLineId);
  assert.equal(line.state, 'reconciled');
  assert.equal(line.open_amount, 0);

  const bankEntry = read(matchedDb, 'account.move', line.bank_move_id);
  assert.equal(bankEntry.state, 'posted');
  const entryLines = journalItems(matchedDb).filter((l) => l.move_id === bankEntry.id);
  assert.equal(isBalanced(entryLines, read(matchedDb, 'res.currency', setup.company.currency_id)), true);

  // Single liquidity adjustment line reducing 101401 from 50 USD to 40 USD.
  const bankLines = entryLines.filter((l) => l.account_id === setup.fxBnk.default_account_id);
  assert.equal(bankLines.length, 1);
  assert.equal(bankLines[0].debit, 0);
  assert.equal(bankLines[0].credit, 10);

  // Realized loss booked strictly to company.expense_currency_exchange_account_id.
  const lossLines = entryLines.filter(
    (l) => l.account_id === setup.company.expense_currency_exchange_account_id,
  );
  assert.equal(lossLines.length, 1);
  assert.equal(lossLines[0].debit, 10);
  assert.equal(lossLines[0].credit, 0);

  // Total net bank liquidity across payment + adjustment equals 40 USD.
  const paymentLines = journalItems(matchedDb).filter(
    (l) => l.move_id === setup.payment.move_id && l.account_id === setup.fxBnk.default_account_id,
  );
  const netBank = [...paymentLines, ...bankLines].reduce(
    (sum, l) => sum + (l.debit || 0) - (l.credit || 0),
    0,
  );
  assert.equal(netBank, 40);
  assert.equal(bookedStatementAmount(matchedDb, line), 40);
  assert.equal(isPaymentMatched(matchedDb, read(matchedDb, 'account.payment', setup.payment.id)), true);

  // ApplyDiff accepts the reconciled entry + line, and rejects reversing while reconciled.
  const synced = applyDiff(setup.db, diffDb(setup.db, matchedDb), { isAdmin: true });
  assert.equal(read(synced, LINE, setup.statementLineId).state, 'reconciled');
  assert.throws(
    () => reversePayment(matchedDb, read(matchedDb, 'account.payment', setup.payment.id)),
    /reconciled|unreconcile/i,
  );

  // Unreconcile reverses the FX adjustment entry and releases the payment cleanly.
  const undoneDb = runButton(matchedDb, setup.statementLineId, 'Unreconcile');
  const undoneLine = read(undoneDb, LINE, setup.statementLineId);
  assert.equal(undoneLine.state, 'to_check');
  assert.equal(undoneLine.open_amount, null);
  assert.equal(isPaymentMatched(undoneDb, read(undoneDb, 'account.payment', setup.payment.id)), false);
  assert.equal(read(undoneDb, 'account.payment', setup.payment.id).state, 'posted');
});

test('Probe 4b: direct FX payment posted on the FX bank journal preserves foreign balance and posts gain when rate improves', () => {
  const setup = setupFxScenario({
    paymentDate: '2026-05-01',
    paymentRate: 2.5, // 100 EUR -> 40 USD
    statementDate: '2026-05-15',
    statementRate: 2.0, // 100 EUR -> 50 USD (10 USD gain)
    directOnFxJournal: true,
  });

  const matchedDb = runButton(setup.db, setup.statementLineId, 'Match Payment');
  const line = read(matchedDb, LINE, setup.statementLineId);
  assert.equal(line.state, 'reconciled');

  const entryLines = journalItems(matchedDb).filter((l) => l.move_id === line.bank_move_id);
  assert.equal(isBalanced(entryLines, read(matchedDb, 'res.currency', setup.company.currency_id)), true);

  const bankLines = entryLines.filter((l) => l.account_id === setup.fxBnk.default_account_id);
  assert.equal(bankLines.length, 1);
  assert.equal(bankLines[0].debit, 10);
  assert.equal(bankLines[0].credit, 0);

  const gainLines = entryLines.filter(
    (l) => l.account_id === setup.company.income_currency_exchange_account_id,
  );
  assert.equal(gainLines.length, 1);
  assert.equal(gainLines[0].debit, 0);
  assert.equal(gainLines[0].credit, 10);

  // Foreign balance on the EUR bank account across payment + FX adjustment totals 100 EUR / 50 USD (0 net difference at 2.0 rate).
  const fxRows = foreignBalanceReport(matchedDb, '2026-05-31', { companyId: 1 });
  const eurBankRows = fxRows.filter(
    (r) => r.account_id === setup.fxBnk.default_account_id && r.currency_id === setup.eur.id,
  );
  assert.ok(eurBankRows.length > 0, 'EUR bank account should appear in foreign balance report');
  assert.equal(eurBankRows.reduce((s, r) => s + r.foreign, 0), 100);
  assert.equal(eurBankRows.reduce((s, r) => s + r.booked, 0), 50);
  assert.equal(eurBankRows.reduce((s, r) => s + (r.difference ?? 0), 0), 0);
});

test('Probe 4d: direct FX payment at matching statement rate takes fast path without extra entry', () => {
  const setup = setupFxScenario({
    paymentDate: '2026-05-01',
    paymentRate: 2.0,
    statementDate: '2026-05-15',
    statementRate: 2.0,
    directOnFxJournal: true,
  });

  const matchedDb = runButton(setup.db, setup.statementLineId, 'Match Payment');
  const line = read(matchedDb, LINE, setup.statementLineId);
  assert.equal(line.state, 'reconciled');
  assert.equal(line.bank_move_id, setup.payment.move_id);
  assert.deepEqual(line.allocations, [{ payment_move_id: setup.payment.move_id, amount: 50 }]);
  assert.equal(bookedStatementAmount(matchedDb, line), 50);
});

test('Probe 4c: fails clearly when company exchange gain or loss account is not configured', () => {
  const lossSetup = setupFxScenario({
    paymentDate: '2026-05-01',
    paymentRate: 2.0,
    statementDate: '2026-05-15',
    statementRate: 2.5,
  });
  const noLossDb = write(lossSetup.db, 'res.company', 1, {
    expense_currency_exchange_account_id: null,
  });
  assert.throws(
    () => runButton(noLossDb, lossSetup.statementLineId, 'Match Payment'),
    /Configure the exchange loss account on company/,
  );
  assert.equal(read(noLossDb, LINE, lossSetup.statementLineId).state, 'to_check');

  const gainSetup = setupFxScenario({
    paymentDate: '2026-05-01',
    paymentRate: 2.5,
    statementDate: '2026-05-15',
    statementRate: 2.0,
  });
  const noGainDb = write(gainSetup.db, 'res.company', 1, {
    income_currency_exchange_account_id: null,
  });
  assert.throws(
    () => runButton(noGainDb, gainSetup.statementLineId, 'Match Payment'),
    /Configure the exchange gain account on company/,
  );
  assert.equal(read(noGainDb, LINE, gainSetup.statementLineId).state, 'to_check');
});
