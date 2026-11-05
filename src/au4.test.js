// Tests for au4 audit findings: multi-currency payment entries.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search } from './orm.js';
import { postPayment } from './models/pay.js';
import { payMove, postMove } from './models/accounting.js';
import { rateAt } from './models/currency.js';
import { roundCurrency, companyCurrencyRecord } from './money.js';
import { addDays, today } from './models/common.js';

// ---------------------------------------------------------------------------
// Finding 4: Standalone payment in foreign currency must carry currency_id and
// amount_currency on its move lines, and convert debit/credit to company currency.
// ---------------------------------------------------------------------------
describe('Finding 4: standalone foreign-currency payment populates move-line FX fields', () => {
  it('EUR payment: debit/credit in company (USD) currency, lines carry EUR currency_id and amount_currency', () => {
    let db = seed();

    // Locate seeded EUR (rate 0.9 EUR per 1 USD at the most recent rate date).
    const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
    assert.ok(eur, 'EUR currency must exist in the seeded database');

    const partner = search(db, 'res.partner').find((p) => p.is_company);
    assert.ok(partner, 'At least one company partner must exist');

    const journal = search(db, 'account.journal').find((j) => j.type === 'bank');
    assert.ok(journal, 'A bank journal must exist');

    // Use a recent date that has a rate configured in seed (rate 0.9 EUR/USD).
    const payDate = addDays(today(), -1);

    // Create a draft inbound payment of 1 000 EUR.
    const paymentAmount = 1000; // EUR
    const pResult = create(db, 'account.payment', {
      name: 'PAY/TEST/001',
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

    // Post the payment (standalone — no invoice_id).
    const dbAfter = postPayment(db, pRec);

    const postedPayment = read(dbAfter, 'account.payment', pResult.id);
    assert.equal(postedPayment.state, 'posted', 'Payment must be posted');
    assert.ok(postedPayment.move_id, 'Posted payment must have a move_id');

    const move = read(dbAfter, 'account.move', postedPayment.move_id);
    assert.ok(move, 'The payment move must exist');
    assert.equal(move.line_ids.length, 2, 'Entry must have exactly 2 lines');

    // All lines must carry the EUR currency metadata.
    for (const line of move.line_ids) {
      assert.equal(line.currency_id, eur.id,
        `Line on account ${line.account_id} must carry currency_id = EUR`);
      assert.ok(typeof line.amount_currency === 'number' && line.amount_currency !== 0,
        `Line on account ${line.account_id} must have a non-zero amount_currency`);
    }

    // Debit and credit must be in company (USD) currency using the exchange rate.
    const companyCurrency = companyCurrencyRecord(dbAfter, 1);
    const rate = rateAt(dbAfter, eur.id, payDate, 1);       // EUR per USD
    const expectedUsd = roundCurrency(paymentAmount / rate, companyCurrency); // 1000 / 0.9

    const debitLine = move.line_ids.find((l) => l.debit > 0);
    const creditLine = move.line_ids.find((l) => l.credit > 0);
    assert.ok(debitLine, 'Must have a debit line');
    assert.ok(creditLine, 'Must have a credit line');

    assert.equal(debitLine.debit, expectedUsd,
      `Debit must equal 1000 EUR in USD (expected ${expectedUsd})`);
    assert.equal(creditLine.credit, expectedUsd,
      `Credit must equal 1000 EUR in USD (expected ${expectedUsd})`);

    // amount_currency on debit line must be +1000 EUR, on credit line -1000 EUR.
    const foreignRounding = { rounding: eur.rounding };
    const expectedForeignDebit = roundCurrency(paymentAmount, foreignRounding);
    const expectedForeignCredit = roundCurrency(-paymentAmount, foreignRounding);

    assert.equal(debitLine.amount_currency, expectedForeignDebit,
      `Debit amount_currency must be +${paymentAmount} EUR`);
    assert.equal(creditLine.amount_currency, expectedForeignCredit,
      `Credit amount_currency must be -${paymentAmount} EUR`);
  });
});

// ---------------------------------------------------------------------------
// Finding 7: Domestic (USD) invoice paid via a foreign-currency (EUR) bank journal
// must have currency_id and amount_currency on the liquidity line.
// ---------------------------------------------------------------------------
describe('Finding 7: USD invoice paid via EUR journal has EUR metadata on liquidity line', () => {
  it('bank line carries currency_id = EUR and amount_currency converted at rate', () => {
    let db = seed();

    const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
    assert.ok(eur, 'EUR currency must exist in the seeded database');

    const partner = search(db, 'res.partner').find((p) => p.is_company);
    assert.ok(partner, 'At least one company partner must exist');

    // Create a dedicated EUR bank account and journal.
    const eurAccResult = create(db, 'account.account', {
      code: '101410',
      name: 'EUR Bank Account',
      account_type: 'asset_cash',
      currency_id: eur.id,
      company_id: 1,
    });
    db = eurAccResult.db;

    const eurJournalResult = create(db, 'account.journal', {
      name: 'EUR Bank',
      code: 'BNKE',
      type: 'bank',
      currency_id: eur.id,
      default_account_id: eurAccResult.id,
      suspense_account_id: search(db, 'account.account').find((a) => a.code === '101404')?.id,
      company_id: 1,
    });
    db = eurJournalResult.db;
    const eurJournal = read(db, 'account.journal', eurJournalResult.id);

    // Create a USD (company-currency) invoice for 1 000 USD.
    const invoiceAmount = 1000;
    const companyCurrency = companyCurrencyRecord(db, 1);
    const invResult = create(db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: partner.id,
      invoice_date: addDays(today(), -5),
      company_id: 1,
      currency_id: companyCurrency.id, // USD — domestic invoice
      invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: invoiceAmount }],
    });
    db = invResult.db;
    db = postMove(db, invResult.id);

    // Pay the full invoice via the EUR journal.
    const payDate = addDays(today(), -1);
    db = payMove(db, invResult.id, invoiceAmount, payDate, { journalId: eurJournal.id });

    // Retrieve the payment move.
    const updatedInv = read(db, 'account.move', invResult.id);
    assert.ok(updatedInv.payments?.length, 'Invoice must have a payment record');
    const paymentMoveId = updatedInv.payments.at(-1).move_id;
    const paymentMove = read(db, 'account.move', paymentMoveId);
    assert.ok(paymentMove, 'Payment move must exist');

    // Find the liquidity (bank) line — the one on the EUR cash account.
    const liquidityLine = paymentMove.line_ids.find(
      (l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_cash',
    );
    assert.ok(liquidityLine, 'Payment move must have a liquidity (bank) line');

    // The liquidity line must carry EUR metadata.
    assert.equal(liquidityLine.currency_id, eur.id,
      'Liquidity line must carry currency_id = EUR');
    assert.ok(typeof liquidityLine.amount_currency === 'number' && liquidityLine.amount_currency !== 0,
      'Liquidity line must have a non-zero amount_currency in EUR');

    // The EUR amount must equal 1000 USD × rate (0.9 EUR/USD) = 900 EUR.
    const rate = rateAt(db, eur.id, payDate, 1);
    const expectedEur = roundCurrency(invoiceAmount * rate, eur);
    assert.equal(liquidityLine.amount_currency, expectedEur,
      `Liquidity amount_currency must be ${expectedEur} EUR (1000 USD × ${rate})`);

    // Company-currency debit must remain 1000 USD (no conversion needed for domestic invoice).
    assert.equal(liquidityLine.debit, invoiceAmount,
      'Liquidity line debit must equal the full USD invoice amount');
  });
});
