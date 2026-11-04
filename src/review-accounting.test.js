import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { remapDiff } from './sync.js';
import { accountId, invoiceLines } from './models/ledger.js';
import { lockedSettlementInvariant } from './models/finance.js';
import { payMove, postMove } from './models/accounting.js';
import { installments } from './models/terms.js';
import { rateAt } from './models/currency.js';

const cents = (n) => Math.round(n * 100);

test('review #1: negative invoice buckets always post nonnegative debit and credit', () => {
  const db = seed();
  for (const move_type of ['out_invoice', 'in_invoice', 'out_refund', 'in_refund']) {
    const lines = invoiceLines(db, { move_type, invoice_line_ids: [
      { qty: 1, price_unit: 100, tax: 0 },
      { qty: 1, price_unit: -10, tax: 0, account_id: accountId(db, '450000') },
    ] });
    assert.ok(lines.every((l) => l.debit >= 0 && l.credit >= 0));
    const negative = lines.find((l) => l.account_id === accountId(db, '450000'));
    assert.equal(negative.debit + negative.credit, 10);
  }
});

test('review #2: analytic distribution keys follow remapped ids in lines and queued bases immutably', () => {
  const line = { analytic_account_id: 50, analytic_distribution: { 50: 60, 51: 40 } };
  const d = {
    upserts: { 'account.move': [{ id: 1, invoice_line_ids: [line] }] },
    bases: { 'account.move': { 1: { invoice_line_ids: [line] } } },
  };
  const before = JSON.stringify(d);
  const out = remapDiff(d, { 'account.analytic.account': { 50: 60, 51: 61 } });
  for (const record of [out.upserts['account.move'][0], out.bases['account.move'][1]]) {
    assert.equal(record.invoice_line_ids[0].analytic_account_id, 60);
    assert.deepEqual(record.invoice_line_ids[0].analytic_distribution, { 60: 60, 61: 40 });
  }
  assert.equal(JSON.stringify(d), before);
});

test('review #3: closed-year settlements require a backing entry after the latest lock', () => {
  const before = { id: 1, partner_id: 3, invoice_date: '2026-01-01', payments: [], amount_paid: 0 };
  const entry = { id: 2, state: 'posted', invoice_date: '2026-06-01', line_ids: [{ partner_id: 3 }] };
  for (const lock_date of [null, '2026-03-31']) {
    const db = { settings: { lock_date }, records: {
      'account.fiscal.year': [{ state: 'closed', date_to: '2026-12-31' }],
      'account.move': [before, entry],
    } };
    const after = { ...before, amount_paid: 10, payments: [{ amount: 10, date: '2027-01-01', move_id: 2 }] };
    assert.match(lockedSettlementInvariant(db, after, before) ?? '', /2026-12-31.*locked/);
    const valid = { ...db, records: { ...db.records, 'account.move': [before, { ...entry, invoice_date: '2027-01-01' }] } };
    assert.equal(lockedSettlementInvariant(valid, after, before), null);
  }
});

test('review #4: foreign term instalments and their company settlements conserve invoice totals', () => {
  const db = seed();
  const currency = search(db, 'res.currency').find((c) => c.name === 'SAR');
  const made = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 3, currency_id: currency.id, invoice_date: '2026-10-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100.01, tax: 0 }],
  });
  let paid = postMove(made.db, made.id);
  const invoice = read(paid, 'account.move', made.id);
  const schedule = installments({ line_ids: [
    { value: 50, value_type: 'percent', nb_days: 0 },
    { value: 50, value_type: 'percent', nb_days: 30 },
  ] }, invoice.amount_total, invoice.invoice_date);
  assert.deepEqual(schedule.map((p) => p.amount), [50.01, 50]);
  assert.equal(schedule.reduce((s, p) => s + cents(p.amount), 0), cents(invoice.amount_total));
  for (const p of schedule) paid = payMove(paid, made.id, p.amount, p.date);
  const settled = read(paid, 'account.move', made.id);
  assert.equal(settled.amount_residual, 0);
  const receivable = invoice.line_ids.find((l) => l.account_id === accountId(db, '121000'));
  assert.equal(settled.payments.reduce((s, p) => s + cents(p.company_amount), 0), cents(receivable.debit));
});

test('review #5: foreign account buckets absorb rounding while preserving the counterpart total', () => {
  const db = seed();
  const currency = search(db, 'res.currency').find((c) => c.name === 'SAR');
  for (const move_type of ['out_invoice', 'in_invoice', 'out_refund', 'in_refund']) {
    const lines = invoiceLines(db, { move_type, currency_id: currency.id, invoice_date: '2026-10-01', invoice_line_ids: [
      { qty: 1, price_unit: 0.02, tax: 0 },
      { qty: 1, price_unit: 0.02, tax: 0, account_id: accountId(db, '450000') },
    ] });
    assert.equal(lines.reduce((s, l) => s + cents(l.debit) - cents(l.credit), 0), 0);
    assert.equal(cents(lines[0].debit + lines[0].credit), 1);
  }
});

test('posted invoices and refunds retain dated payment-term counterparts in both currencies', () => {
  let db = seed();
  const currency = search(db, 'res.currency').find((c) => c.name === 'SAR');
  const term = create(db, 'account.payment.term', { name: 'Two instalments', line_ids: [
    { value: 50, value_type: 'percent', nb_days: 0 }, { value: 50, value_type: 'percent', nb_days: 30 },
  ] });
  db = term.db;
  for (const move_type of ['out_invoice', 'in_invoice', 'out_refund', 'in_refund']) {
    const made = create(db, 'account.move', { move_type, partner_id: 3, currency_id: currency.id, invoice_date: '2026-10-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ qty: 1, price_unit: 100.01, tax: 0 }] });
    db = postMove(made.db, made.id);
    const move = read(db, 'account.move', made.id);
    const items = move.line_ids.filter((l) => l.account_id === accountId(db, move_type.startsWith('out') ? '121000' : '211000'));
    assert.deepEqual(items.map((l) => l.date_maturity), ['2026-10-01', '2026-10-31']);
    assert.deepEqual(items.map((l) => Math.abs(l.amount_currency)), [50.01, 50]);
    assert.equal(items.reduce((s, l) => s + cents(l.debit + l.credit), 0), cents(100.01 / rateAt(db, currency.id, '2026-10-01', move.company_id)));
  }
});

test('posted foreign invoice preserves zero-conversion account buckets', () => {
  const db = seed();
  const currency = search(db, 'res.currency').find((c) => c.name === 'SAR');
  const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, currency_id: currency.id, invoice_date: '2026-10-01', invoice_line_ids: [
    { qty: 1, price_unit: 0.02, tax: 0 }, { qty: 1, price_unit: 0.02, tax: 0, account_id: accountId(db, '450000') },
  ] });
  const posted = read(postMove(made.db, made.id), 'account.move', made.id);
  assert.equal(posted.line_ids.reduce((s, l) => s + cents(l.amount_currency || 0), 0), 0);
  assert.equal(posted.line_ids.find((l) => l.account_id === accountId(db, '450000')).amount_currency, -0.02);
});

test('review #4: small invoices and refunds with payment terms avoid opposite-signed final instalments', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', { name: 'Three instalments', line_ids: [
    { value: 33.33, value_type: 'percent', nb_days: 0 },
    { value: 33.33, value_type: 'percent', nb_days: 30 },
    { value: 33.34, value_type: 'percent', nb_days: 60 },
  ] });
  db = term.db;
  for (const move_type of ['out_invoice', 'out_refund']) {
    const made = create(db, 'account.move', {
      move_type,
      partner_id: 3,
      invoice_date: '2026-10-01',
      invoice_payment_term_id: term.id,
      invoice_line_ids: [{ qty: 1, price_unit: 0.02, tax: 0 }],
    });
    db = postMove(made.db, made.id);
    const posted = read(db, 'account.move', made.id);
    const items = posted.line_ids.filter((l) => l.account_id === accountId(db, move_type.startsWith('out') ? '121000' : '211000'));
    assert.ok(items.every((l) => l.debit >= 0 && l.credit >= 0));
    assert.equal(items.reduce((s, l) => s + cents(l.debit + l.credit), 0), 2);
  }
});

test('posted two-cent invoices and refunds never reverse an instalment in either currency', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', { name: 'Four quarters', line_ids: [0, 30, 60, 90].map((nb_days) => ({ value: 25, value_type: 'percent', nb_days })) });
  db = term.db;
  const currency = create(db, 'res.currency', { name: 'Test foreign', symbol: 'T', rate_ids: [{ date: '2020-01-01', rate: 0.5 }] });
  db = currency.db;
  for (const move_type of ['out_invoice', 'out_refund', 'in_invoice', 'in_refund']) {
    for (const currency_id of [null, currency.id]) {
      const made = create(db, 'account.move', { move_type, partner_id: 3, currency_id, invoice_date: '2026-10-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ qty: 1, price_unit: 0.02, tax: 0 }] });
      db = postMove(made.db, made.id);
      const posted = read(db, 'account.move', made.id);
      const account = accountId(db, move_type.startsWith('out') ? '121000' : '211000');
      const items = posted.line_ids.filter((l) => l.account_id === account);
      const debit = ['out_invoice', 'in_refund'].includes(move_type);
      assert.ok(items.every((l) => (debit ? l.credit : l.debit) === 0));
      if (currency_id) assert.ok(items.every((l) => debit ? l.amount_currency >= 0 : l.amount_currency <= 0));
      assert.equal(items.reduce((sum, l) => sum + cents(l.debit + l.credit), 0), currency_id ? 4 : 2);
      if (currency_id) assert.equal(items.reduce((sum, l) => sum + Math.abs(cents(l.amount_currency)), 0), 2);
      assert.equal(posted.line_ids.reduce((sum, l) => sum + cents(l.debit) - cents(l.credit), 0), 0);
      if (currency_id) assert.equal(posted.line_ids.reduce((sum, l) => sum + cents(l.amount_currency || 0), 0), 0);
    }
  }
});

test('review #4: rounded invoice payment-term instalments conserve rounded document total', () => {
  let db = seed();
  const currency = search(db, 'res.currency').find((c) => c.name === 'SAR');
  const rounding = create(db, 'account.cash.rounding', {
    name: '0.05 UP',
    rounding: 0.05,
    rounding_method: 'UP',
    strategy: 'add_invoice_line',
    profit_account_id: accountId(db, '450000'),
    loss_account_id: accountId(db, '690000'),
  });
  db = rounding.db;
  const term = create(db, 'account.payment.term', { name: 'Two halves', line_ids: [
    { value: 50, value_type: 'percent', nb_days: 0 },
    { value: 50, value_type: 'percent', nb_days: 30 },
  ] });
  db = term.db;

  const made = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    currency_id: currency.id,
    invoice_date: '2026-10-01',
    invoice_cash_rounding_id: rounding.id,
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ qty: 1, price_unit: 10.02, tax: 0 }],
  });
  db = postMove(made.db, made.id);
  const posted = read(db, 'account.move', made.id);
  assert.equal(posted.amount_total, 10.05);

  const items = posted.line_ids.filter((l) => l.account_id === accountId(db, '121000'));
  assert.deepEqual(items.map((l) => Math.abs(l.amount_currency)), [5.03, 5.02]);
  assert.equal(items.reduce((s, l) => s + cents(Math.abs(l.amount_currency)), 0), 1005);
});

test('review #4: second company foreign payment-term instalments conserve company and document currency', () => {
  let db = seed();
  const currency = search(db, 'res.currency').find((c) => c.name === 'SAR');
  const c2 = create(db, 'res.company', { name: 'Second Co' }); db = c2.db;
  for (const [code, type] of [['121000', 'asset_receivable'], ['400000', 'income']]) {
    db = create(db, 'account.account', { code, name: `C2 ${code}`, account_type: type, company_id: c2.id }).db;
  }
  const acc = (code) => search(db, 'account.account').find((a) => a.code === code && a.company_id === c2.id);
  db = create(db, 'account.journal', { name: 'C2 Sale', code: 'INV', type: 'sale', company_id: c2.id, default_account_id: acc('400000').id }).db;

  const term = create(db, 'account.payment.term', { name: 'Split', line_ids: [
    { value: 50, value_type: 'percent', nb_days: 0 },
    { value: 50, value_type: 'percent', nb_days: 30 },
  ] }); db = term.db;

  const made = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: c2.id,
    partner_id: 3,
    currency_id: currency.id,
    invoice_date: '2026-10-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ qty: 1, price_unit: 100.01, tax: 0 }],
  });
  db = postMove(made.db, made.id);
  const posted = read(db, 'account.move', made.id);
  assert.equal(posted.company_id, c2.id);
  const items = posted.line_ids.filter((l) => l.account_id === acc('121000').id);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((l) => Math.abs(l.amount_currency)), [50.01, 50]);
  assert.equal(posted.line_ids.reduce((s, l) => s + cents(l.debit - l.credit), 0), 0);
});
