import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { allocateCents, currencyDecimalPlaces, currencyUnits, formatCurrency, roundCurrency } from './money.js';
import { createCompany, ensureMainCompany } from './models/company.js';
import { payMove, postMove, payWithDiscount } from './models/accounting.js';
import { accountId, journalId } from './models/ledger.js';
import { installments } from './models/terms.js';
import { deferralBoard } from './models/deferred.js';
import { unrealizedExchange, revalueForeignBalances } from './models/closing.js';
import { migrate } from './migrations.js';
import { postPayment, reversePayment } from './models/pay.js';

test('currency increments round half away from zero and expose display precision', () => {
  assert.equal(roundCurrency(175.7, { rounding: 1 }), 176);
  assert.equal(roundCurrency(10.1254, { rounding: 0.001 }), 10.125);
  assert.equal(roundCurrency(-1.005, { rounding: 0.01 }), -1.01);
  assert.equal(currencyDecimalPlaces({ rounding: 1 }), 0);
  assert.equal(currencyDecimalPlaces({ rounding: 0.001 }), 3);
  assert.equal(currencyDecimalPlaces({ rounding: 0.05 }), 2);
  assert.match(formatCurrency(12.6, { name: 'JPY', rounding: 1 }), /13$/);
  assert.match(formatCurrency(10.125, { name: 'KWD', rounding: 0.001 }), /10\.125$/);
  assert.match(formatCurrency(10.125, { name: 'JPY', rounding: 0.01 }), /10\.13$/);
  assert.match(formatCurrency(1.02, { name: 'USD', rounding: 0.05 }), /1\.02$/);
});

test('currency model defaults to cents and computes decimal places', () => {
  const created = create(seed(), 'res.currency', { name: 'Test currency', rounding: 0.001 });
  assert.equal(read(created.db, 'res.currency', created.id).decimal_places, 3);
  const legacy = create(created.db, 'res.currency', { name: 'Default currency' });
  assert.equal(read(legacy.db, 'res.currency', legacy.id).rounding, 0.01);
  assert.equal(read(legacy.db, 'res.currency', legacy.id).decimal_places, 2);
});

function setupPrecision(rounding, foreign) {
  let db = ensureMainCompany(seed());
  const made = create(db, 'res.currency', { name: rounding === 1 ? 'JPY' : 'KWD', rounding, rate_ids: [{ date: '2025-01-01', rate: 2 }, { date: '2025-02-01', rate: 4 }] });
  db = made.db;
  let company = 1;
  if (foreign) db = write(db, 'account.journal', journalId(db, 'BNK1'), { currency_id: made.id });
  if (!foreign) {
    const created = createCompany(db, { name: `Precision ${rounding}`, currency_id: made.id });
    db = created.db;
    company = created.id;
  }
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, company_id: company, currency_id: made.id,
    invoice_date: '2025-01-02', invoice_line_ids: [{ qty: 1, price_unit: rounding === 1 ? 1255 : 10.125, tax: 14 }] });
  return { db: postMove(invoice.db, invoice.id), id: invoice.id, company, currency: made.id };
}

function assertBalanced(db, move, step) {
  const currency = { rounding: step };
  assert.equal(move.line_ids.reduce((n, l) => n + currencyUnits(l.debit, currency) - currencyUnits(l.credit, currency), 0), 0);
  for (const line of move.line_ids) {
    assert.equal(roundCurrency(line.debit, currency), line.debit);
    assert.equal(roundCurrency(line.credit, currency), line.credit);
  }
}

for (const [rounding, expectedTotal, part] of [[1, 1431, 500], [0.001, 11.543, 3.123]]) {
  for (const foreign of [false, true]) {
    test(`${rounding === 1 ? 'zero' : 'three'} decimal ${foreign ? 'foreign' : 'company'} currency invoice and partial/full payment`, () => {
      let { db, id, company, currency } = setupPrecision(rounding, foreign);
      let invoice = read(db, 'account.move', id);
      assert.equal(invoice.amount_total, expectedTotal);
      assert.equal(invoice.amount_tax, rounding === 1 ? 176 : 1.418);
      assertBalanced(db, invoice, foreign ? 0.01 : rounding);
      if (foreign) {
        assert.ok(invoice.line_ids.every((l) => l.currency_id === currency));
        assert.equal(invoice.line_ids.reduce((n, l) => n + currencyUnits(l.amount_currency, { rounding }), 0), 0);
      }
      db = payMove(db, id, part, '2025-02-02');
      invoice = read(db, 'account.move', id);
      assert.equal(invoice.amount_residual, roundCurrency(expectedTotal - part, { rounding }));
      const first = read(db, 'account.move', invoice.payments[0].move_id);
      assertBalanced(db, first, foreign ? 0.01 : rounding);
      if (foreign) {
        assert.ok(first.line_ids.some((l) => [accountId(db, '450100', company), accountId(db, '690100', company)].includes(l.account_id)));
        const foreignLines = first.line_ids.filter((l) => l.currency_id === currency);
        assert.equal(foreignLines.length, 2);
        assert.equal(foreignLines.reduce((n, l) => n + currencyUnits(l.amount_currency, { rounding }), 0), 0);
      }
      db = payMove(db, id, invoice.amount_residual, '2025-02-02');
      invoice = read(db, 'account.move', id);
      assert.equal(invoice.amount_paid, expectedTotal);
      assert.equal(invoice.amount_residual, 0);
      assert.equal(invoice.payment_state, 'paid');
      assertBalanced(db, read(db, 'account.move', invoice.payments[1].move_id), foreign ? 0.01 : rounding);
    });
  }
}

test('installments and deferral boards conserve currency rounding units', () => {
  const term = { line_ids: [{ value_type: 'percent', value: 33 }, { value_type: 'percent', value: 33 }, { value_type: 'percent', value: 34 }] };
  for (const currency of [{ rounding: 1 }, { rounding: 0.001 }, { rounding: 0.05 }]) {
    const amount = roundCurrency(10.125, currency);
    const groups = [installments(term, amount, '2025-01-01', currency).map((x) => x.amount), deferralBoard(amount, '2025-01-01', 3, currency).map((x) => x.amount), allocateCents(amount, [1, 1, 1], currency)];
    for (const group of groups) assert.equal(group.reduce((sum, n) => sum + currencyUnits(n, currency), 0), currencyUnits(amount, currency));
  }
});

test('cash rounding and installments post in three-decimal foreign currency units', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'KWD', rounding: 0.001, rate_ids: [{ date: '2025-01-01', rate: 2 }] });
  const term = create(currency.db, 'account.payment.term', { name: 'Three payments', line_ids: [{ value_type: 'percent', value: 33 }, { value_type: 'percent', value: 33 }, { value_type: 'percent', value: 34 }] });
  const cash = create(term.db, 'account.cash.rounding', { name: 'Five fils', rounding: 0.005, rounding_method: 'UP', strategy: 'add_invoice_line' });
  const made = create(cash.db, 'account.move', { move_type: 'out_invoice', partner_id: 2, currency_id: currency.id, invoice_date: '2025-01-02', invoice_payment_term_id: term.id, invoice_cash_rounding_id: cash.id, invoice_line_ids: [{ qty: 1, price_unit: 10.122, tax: 0 }] });
  db = postMove(made.db, made.id);
  const invoice = read(db, 'account.move', made.id);
  assert.equal(invoice.amount_total, 10.125);
  const receivables = invoice.line_ids.filter((l) => l.name === invoice.name);
  assert.equal(receivables.length, 3);
  assert.equal(receivables.reduce((n, l) => n + currencyUnits(l.amount_currency, { rounding: 0.001 }), 0), 10125);
  assert.equal(invoice.line_ids.find((l) => l.name === 'Cash Rounding').amount_currency, -0.003);
  assertBalanced(db, invoice, 0.01);
});

test('posting a deferred invoice builds a board in company currency units', () => {
  let db = ensureMainCompany(seed());
  const currency = create(db, 'res.currency', { name: 'KWD', rounding: 0.001 });
  const company = createCompany(currency.db, { name: 'Deferral company', currency_id: currency.id });
  const made = create(company.db, 'account.move', { move_type: 'out_invoice', partner_id: 2, company_id: company.id, currency_id: currency.id, invoice_date: '2025-01-02', invoice_line_ids: [{ qty: 1, price_unit: 10.125, tax: 0, deferred_start_date: '2025-01-01', deferred_end_date: '2025-03-31' }] });
  db = postMove(made.db, made.id);
  const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === made.id);
  assert.ok(schedule);
  assert.equal(schedule.board.length, 3);
  assert.equal(schedule.board.reduce((sum, row) => sum + currencyUnits(row.amount, { rounding: 0.001 }), 0), 10125);
  assert.ok(schedule.board.every((row) => roundCurrency(row.amount, { rounding: 0.001 }) === row.amount));
});

test('a one-fils partial payment is retained and can be reversed', () => {
  let { db, id } = setupPrecision(0.001, false);
  db = payMove(db, id, 0.001, '2025-02-02');
  const invoice = read(db, 'account.move', id);
  assert.equal(invoice.amount_paid, 0.001);
  assert.equal(invoice.amount_residual, 11.542);
  assert.equal(invoice.payments[0].amount, 0.001);
  assertBalanced(db, read(db, 'account.move', invoice.payments[0].move_id), 0.001);
  const payment = search(db, 'account.payment').find((p) => p.move_id === invoice.payments[0].move_id);
  db = reversePayment(db, payment, '2025-02-03');
  assert.equal(read(db, 'account.move', id).amount_residual, 11.543);
  assert.equal(read(db, 'account.move', id).amount_paid, 0);
});

test('a company-currency payment allocates and records a three-decimal foreign exchange difference', () => {
  let { db, id } = setupPrecision(0.001, true);
  const payment = create(db, 'account.payment', { partner_id: 2, partner_type: 'customer', payment_type: 'inbound', amount: 1, date: '2025-02-02' });
  db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const invoice = read(db, 'account.move', id);
  assert.equal(invoice.payments[0].amount, 4);
  assert.equal(invoice.amount_residual, 7.543);
  const fx = read(db, 'account.move', invoice.payments[0].payment_fx_move_id);
  assert.ok(fx);
  assertBalanced(db, fx, 0.01);
});

test('three-decimal credit notes clear the document balance', () => {
  let { db, id } = setupPrecision(0.001, true);
  const invoice = read(db, 'account.move', id);
  const note = create(db, 'account.move', { move_type: 'out_refund', partner_id: invoice.partner_id, currency_id: invoice.currency_id, company_id: invoice.company_id, reversed_entry_id: id, invoice_date: '2025-02-02', invoice_line_ids: invoice.invoice_line_ids });
  db = postMove(note.db, note.id);
  assert.equal(read(db, 'account.move', id).amount_residual, 0);
  assert.equal(read(db, 'account.move', note.id).amount_residual, 0);
  assertBalanced(db, read(db, 'account.move', note.id), 0.01);
});

test('early payment discount is computed in document units', () => {
  let { db, id } = setupPrecision(0.001, true);
  const term = create(db, 'account.payment.term', { name: 'Discount', early_discount: true, discount_percent: 2, discount_days: 30, discount_tax_computation: 'included' });
  // A new invoice is needed because posted invoice terms are immutable.
  const made = create(term.db, 'account.move', { move_type: 'out_invoice', partner_id: 2, currency_id: read(term.db, 'account.move', id).currency_id, invoice_date: '2025-01-02', invoice_payment_term_id: term.id, invoice_line_ids: [{ qty: 1, price_unit: 10.125, tax: 0 }] });
  db = postMove(made.db, made.id);
  db = payWithDiscount(db, made.id, 9.922, '2025-01-10');
  const invoice = read(db, 'account.move', made.id);
  assert.equal(invoice.amount_residual, 0);
  assert.equal(invoice.payments.at(-1).amount, 0.203);
  assert.equal(search(db, 'account.move').find((m) => m.id === invoice.payments.at(-1).move_id).state, 'posted');
});

for (const rounding of [1, 0.001]) {
  test(`${rounding === 1 ? 'zero' : 'three'} decimal company books and revalues a foreign invoice in company units`, () => {
    let db = ensureMainCompany(seed());
    const own = create(db, 'res.currency', { name: rounding === 1 ? 'JPY' : 'KWD', rounding, rate_ids: [{ date: '2025-01-01', rate: 2 }, { date: '2025-02-01', rate: 4 }] });
    const company = createCompany(own.db, { name: 'Foreign books', currency_id: own.id });
    db = company.db;
    const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
    const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, company_id: company.id, currency_id: usd.id, invoice_date: '2025-01-02', invoice_line_ids: [{ qty: 1, price_unit: 10.13, tax: 0 }] });
    db = postMove(made.db, made.id);
    let invoice = read(db, 'account.move', made.id);
    assert.equal(invoice.amount_total, 10.13);
    assertBalanced(db, invoice, rounding);
    assert.equal(invoice.line_ids.find((l) => l.debit).debit, roundCurrency(20.26, { rounding }));
    const [valuation] = unrealizedExchange(db, '2025-02-02').filter((row) => row.invoice_id === made.id);
    assert.equal(valuation.difference, roundCurrency(roundCurrency(40.52, { rounding }) - roundCurrency(20.26, { rounding }), { rounding }));
    db = revalueForeignBalances(db, '2025-02-02');
    const revaluation = search(db, 'account.move').find((m) => m.revaluation_date === '2025-02-02' && m.company_id === company.id);
    assertBalanced(db, revaluation, rounding);
    db = payMove(db, made.id, 4.12, '2025-02-02');
    invoice = read(db, 'account.move', made.id);
    assert.equal(invoice.amount_residual, 6.01);
    const payment = read(db, 'account.move', invoice.payments[0].move_id);
    assertBalanced(db, payment, rounding);
    assert.ok(payment.line_ids.some((l) => l.account_id === accountId(db, '450100', company.id)));
    db = payMove(db, made.id, 6.01, '2025-02-02');
    invoice = read(db, 'account.move', made.id);
    assert.equal(invoice.amount_residual, 0);
    assertBalanced(db, read(db, 'account.move', invoice.payments[1].move_id), rounding);
  });
}

test('migration defaults missing currency rounding without inferring from names', () => {
  const db = seed();
  const old = { ...db, schema_version: 21, records: { ...db.records, 'res.currency': [{ id: 1, name: 'JPY' }, { id: 2, name: 'KWD', rounding: 0.001 }] } };
  const migrated = migrate(old);
  assert.equal(migrated.records['res.currency'][0].rounding, 0.01);
  assert.equal(migrated.records['res.currency'][1].rounding, 0.001);
});
