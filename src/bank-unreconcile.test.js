import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { applyDiff, diffDb } from './sync.js';

const LINE = 'account.bank.statement.line';
const button = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const withOutstanding = (db) => write(db, 'res.company', 1, { outstanding_receipts_account_id: search(db, 'account.account').find((a) => a.code === '101402').id });
function invoice(db, company, amount = 100) {
  const made = create(db, 'account.move', { company_id: company, move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: amount, tax: 0 }] });
  return { db: postMove(made.db, made.id), id: made.id };
}
test('unmatching an existing payment retains its settlement and allows payment reversal', () => {
  const inv = invoice(withOutstanding(seed()), 1);
  const p = create(inv.db, 'account.payment', { invoice_id: inv.id, partner_id: 3, payment_type: 'inbound', partner_type: 'customer', amount: 100, date: '2026-01-02' });
  let db = button(p.db, 'account.payment', p.id, 'Confirm');
  const before = read(db, 'account.payment', p.id);
  const line = create(db, LINE, { date: '2026-01-03', payment_ref: 'payment', amount: 100, payment_id: p.id });
  db = button(line.db, LINE, line.id, 'Match Payment');
  assert.throws(() => button(db, 'account.payment', p.id, 'Reverse'), /reconciled bank transaction/);
  const matched = db;
  assert.throws(() => write(matched, LINE, line.id, { state: 'to_check', move_id: null, payment_id: null, payment_move_id: null }), /reversing entries/);
  const forged = { ...matched, records: { ...matched.records, [LINE]: matched.records[LINE].map((l) => l.id === line.id ? { ...l, state: 'to_check', move_id: null, payment_id: null, payment_move_id: null } : l) } };
  assert.throws(() => applyDiff(matched, diffDb(matched, forged), { isAdmin: true }), /reversing entries/);
  db = button(db, LINE, line.id, 'Unreconcile');
  assert.equal(read(db, LINE, line.id).state, 'to_check');
  assert.deepEqual(read(db, 'account.payment', p.id), before);
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);
  const oldBank = read(matched, LINE, line.id).move_id;
  const reversal = search(db, 'account.move').find((m) => m.reversed_entry_id === oldBank);
  assert.ok(reversal);
  assert.equal(reversal.line_ids.reduce((n, l) => n + l.debit - l.credit, 0), 0);
  assert.equal(read(applyDiff(matched, diffDb(matched, db), { isAdmin: false }), LINE, line.id).state, 'to_check');
  db = button(db, 'account.payment', p.id, 'Reverse');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 100);
});

test('a standalone matched payment cannot be reversed before unreconciliation', () => {
  const p = create(withOutstanding(seed()), 'account.payment', { partner_id: 1, payment_type: 'inbound', partner_type: 'customer', amount: 123, date: '2026-01-02' });
  let db = button(p.db, 'account.payment', p.id, 'Confirm');
  const line = create(db, LINE, { date: '2026-01-03', payment_ref: 'standalone', amount: 123, payment_id: p.id });
  db = button(line.db, LINE, line.id, 'Match Payment');
  assert.throws(() => button(db, 'account.payment', p.id, 'Reverse'), /unreconcile/i);
  db = button(db, LINE, line.id, 'Unreconcile');
  assert.equal(read(db, 'account.payment', p.id).state, 'posted');
  db = button(db, 'account.payment', p.id, 'Reverse');
  assert.equal(read(db, 'account.payment', p.id).state, 'reversed');
});

test('unreconcile restores each invoice from a partly matched oversized statement', () => {
  const first = invoice(seed(), 1, 100);
  const second = invoice(first.db, 1, 40);
  const line = create(second.db, LINE, { date: '2026-01-03', payment_ref: 'split', amount: 160, move_id: first.id });
  let db = button(line.db, LINE, line.id, 'Match');
  db = write(db, LINE, line.id, { move_id: second.id });
  db = button(db, LINE, line.id, 'Match');
  assert.equal(read(db, LINE, line.id).open_amount, 20);
  const matched = db;
  db = button(db, LINE, line.id, 'Unreconcile');
  assert.equal(read(db, 'account.move', first.id).amount_residual, 100);
  assert.equal(read(db, 'account.move', second.id).amount_residual, 40);
  assert.equal(read(db, LINE, line.id).bank_move_id, null);
  assert.equal(read(db, LINE, line.id).state, 'to_check');
  const synced = applyDiff(matched, diffDb(matched, db), { isAdmin: true });
  assert.equal(read(synced, 'account.move', first.id).amount_residual, 100);
  assert.equal(read(synced, 'account.move', second.id).amount_residual, 40);
});

test('unreconciliation reverses linked cash-basis tax releases', () => {
  const inv = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 14, tax_cash_basis: true }] });
  let db = postMove(inv.db, inv.id);
  const line = create(db, LINE, { date: '2026-01-02', payment_ref: 'cash basis', amount: 114, move_id: inv.id });
  db = button(line.db, LINE, line.id, 'Match');
  const row = read(db, 'account.move', inv.id).payments.at(-1);
  assert.ok(row.cash_basis_move_id);
  const matched = db;
  db = button(db, LINE, line.id, 'Unreconcile');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 114);
  assert.ok(search(db, 'account.move').some((m) => m.reversed_entry_id === row.cash_basis_move_id));
  const synced = applyDiff(matched, diffDb(matched, db), { isAdmin: true });
  assert.equal(read(synced, 'account.move', inv.id).amount_residual, 114);
});

test('unreconcile restores a two-company invoice including an explicit write-off', () => {
  const base = seed();
  const branch = createCompany(base, { name: 'Branch', currency_id: base.records['res.company'][0].currency_id });
  const inv = invoice(branch.db, branch.id);
  const account = create(inv.db, 'account.account', { company_id: branch.id, code: '699999', name: 'Adjustment', account_type: 'expense' });
  const line = create(account.db, LINE, { company_id: branch.id, date: '2026-01-03', payment_ref: 'settlement', amount: 90, move_id: inv.id, writeoff_account_id: account.id, writeoff_label: 'Difference', writeoff_amount: 10 });
  let db = button(line.db, LINE, line.id, 'Match');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);
  const matched = db;
  db = button(db, LINE, line.id, 'Unreconcile');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 100);
  assert.equal(read(db, LINE, line.id).state, 'to_check');
  const generated = search(matched, 'account.payment').find((p) => p.move_id === read(matched, LINE, line.id).payment_move_id);
  assert.equal(read(db, 'account.payment', generated.id).state, 'reversed');
  for (const source of [read(matched, LINE, line.id).payment_move_id, read(matched, LINE, line.id).writeoff_move_id]) {
    const reversal = search(db, 'account.move').find((m) => m.reversed_entry_id === source);
    assert.ok(reversal);
    assert.equal(reversal.company_id, branch.id);
    assert.equal(reversal.line_ids.reduce((n, l) => n + l.debit - l.credit, 0), 0);
  }
  const synced = applyDiff(matched, diffDb(matched, db), { isAdmin: true });
  assert.equal(read(synced, 'account.move', inv.id).amount_residual, 100);
});
