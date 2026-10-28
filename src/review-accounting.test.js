import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { remapDiff } from './sync.js';
import { accountId, invoiceLines } from './models/ledger.js';
import { lockedSettlementInvariant } from './models/finance.js';
import { payMove, postMove } from './models/accounting.js';
import { installments } from './models/terms.js';

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
