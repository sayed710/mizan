import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write, unlink } from './orm.js';
import { applyDiff } from './sync.js';
import { payMove, postMove } from './models/accounting.js';
import { postEntry } from './models/ledger.js';
import { reconcileWith } from './models/bank.js';
import { moveInvariant, paymentInvariant } from './models/finance.js';

const invoice = (db = seed(), vals = {}) => {
  const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-04-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }], ...vals });
  return { db: postMove(made.db, made.id), id: made.id };
};

test('offsetting receivable lines have no net settlement capacity', () => {
  const inv = invoice();
  const entry = postEntry(inv.db, { journal: 'MISC', lines: [{ account: '121000', debit: 100, partner_id: 3 }, { account: '121000', credit: 100, partner_id: 3 }] });
  const before = read(entry.db, 'account.move', inv.id);
  const after = { ...before, amount_paid: 100, payments: [{ amount: 100, date: '2026-04-01', move_id: entry.id }] };
  assert.match(moveInvariant(entry.db, after, before) ?? '', /posted journal entry/);
});

test('posted payment amount, partner and direction must match its journal entry', () => {
  const inv = invoice();
  const paid = payMove(inv.db, inv.id, 100, '2026-04-02');
  const p = paid.records['account.payment'].find((p) => p.invoice_id === inv.id);
  assert.equal(paymentInvariant(paid, p), null);
  for (const vals of [{ amount: 10000 }, { amount: 0 }, { partner_id: null }, { payment_type: 'outbound' }]) {
    assert.ok(paymentInvariant(paid, { ...p, ...vals }), JSON.stringify(vals));
  }
});

test('foreign invoice applications consume journal capacity in company currency', () => {
  const fx = create(seed(), 'res.currency', { name: 'QFX', rate_ids: [{ date: '2026-01-01', rate: 0.5 }] });
  const inv = invoice(fx.db, { currency_id: fx.id });
  const paid = payMove(inv.db, inv.id, 10, '2026-04-02');
  const before = read(paid, 'account.move', inv.id);
  const p = before.payments.at(-1);
  const after = { ...before, amount_paid: 15, payments: [...before.payments, { ...p, amount: 5 }] };
  const forged = { ...paid, records: { ...paid.records, 'account.move': paid.records['account.move'].map((m) => m.id === inv.id ? after : m) } };
  assert.match(moveInvariant(forged, after, before) ?? '', /more than its journal entry booked/);
});

test('bank invoice matching links the payment entry and protects reversal', async () => {
  const inv = invoice();
  const line = create(inv.db, 'account.bank.statement.line', { amount: 100, date: '2026-04-02', payment_ref: 'Bank' });
  const paid = reconcileWith(line.db, read(line.db, 'account.bank.statement.line', line.id), inv.id);
  const paymentEntry = read(paid, 'account.move', inv.id).payments.at(-1).move_id;
  assert.equal(read(paid, 'account.bank.statement.line', line.id).payment_move_id, paymentEntry);
  assert.equal(read(paid, 'account.bank.statement.line', line.id).move_id, inv.id);
  const { reversePayment } = await import('./models/pay.js');
  const payment = paid.records['account.payment'].find((p) => p.move_id === paymentEntry);
  assert.throws(() => reversePayment(paid, payment), /reconciled bank transaction/);
});

test('posted bank-linked entries already reject accounting-line and date changes', () => {
  const inv = invoice();
  const bank = create(inv.db, 'account.bank.statement.line', { amount: 100, date: '2026-04-01', payment_ref: 'BANK', partner_id: 3 });
  const matched = reconcileWith(bank.db, read(bank.db, 'account.bank.statement.line', bank.id), inv.id);
  const paymentId = read(matched, 'account.bank.statement.line', bank.id).payment_move_id;
  const entry = read(matched, 'account.move', paymentId);
  assert.throws(() => write(matched, 'account.move', paymentId, { invoice_date: '2026-05-01' }), /cannot be changed|reset.*draft/i);
  assert.throws(() => write(matched, 'account.move', paymentId, { line_ids: entry.line_ids.map((l) => ({ ...l, debit: l.debit * 2, credit: l.credit * 2 })) }), /cannot be changed|reset.*draft/i);
});

test('a reconciled bank line cannot be deleted, directly or together with its entry', () => {
  const entry = postEntry(seed(), { journal: 'BNK1', lines: [{ account: '101401', debit: 10 }, { account: '450000', credit: 10 }] });
  const line = create(entry.db, 'account.bank.statement.line', { amount: 10, date: '2026-04-02', payment_ref: 'Bank', state: 'reconciled', move_id: entry.id });
  assert.throws(() => unlink(line.db, 'account.bank.statement.line', [line.id]), /reconciled/);
  assert.throws(() => applyDiff(line.db, { deletes: { 'account.bank.statement.line': [line.id], 'account.move': [entry.id] } }), /reconciled/);
});

test('a staged bank reconciliation protects a draft entry from deletion', () => {
  const draft = create(seed(), 'account.move', { move_type: 'entry', name: 'Draft' });
  const line = { id: 900, amount: 10, date: '2026-04-02', payment_ref: 'Bank', state: 'reconciled', move_id: draft.id };
  // Direct delete-guard coverage: the staged reference must count even before the bank guard validates it.
  const staged = { ...draft.db, records: { ...draft.db.records, 'account.bank.statement.line': [line] } };
  const { protectDelete } = modelMove;
  assert.match(protectDelete(draft.db, read(draft.db, 'account.move', draft.id), staged) ?? '', /reconciled/);
});

import { models } from './models/index.js';
const modelMove = models['account.move'];

test('posting a negative invoice through a diff is refused even with positive balanced items', () => {
  const inv = invoice();
  const old = read(inv.db, 'account.move', inv.id);
  const draft = create(inv.db, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_line_ids: [{ qty: 1, price_unit: -100, tax: 0 }] });
  const row = read(draft.db, 'account.move', draft.id);
  assert.throws(() => applyDiff(draft.db, { upserts: { 'account.move': [{ ...row, state: 'posted', name: 'NEG/1', line_ids: old.line_ids }] } }), /total must be positive/);
});
