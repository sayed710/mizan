// Cashiers and payroll officers complete sales and payslips: the server books the journal entry for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, updateSettings, write } from '../src/orm.js';
import { models, modelsForApps } from '../src/models/index.js';
import { startSession } from '../src/models/pos.js';
import { applyDiff, diffDb } from '../src/sync.js';
import { seed } from '../src/seed.js';
import { runPosting } from './posting.js';
import { taxClosingProofs } from '../src/models/finance.js';
import { postEntry } from '../src/models/ledger.js';

const moves = (db) => search(db, 'account.move').length;
const commitAsSystem = (db, next) => applyDiff(db, diffDb(db, next), { author: 'test', isAdmin: false, allowed: null });

test('a POS-only user pays an order: the server prices it and posts the entry', () => {
  const pos = modelsForApps(['pos']);
  assert.equal(pos.has('account.move'), false);
  const db = startSession(seed(), 100).db;
  const out = runPosting(db, pos, '/api/pos/pay', { lines: [{ product_id: 1, qty: 2, price_unit: 0.01 }], method: 'cash' });
  const saved = commitAsSystem(db, out.db);
  const order = read(saved, 'pos.order', out.body.id);
  assert.equal(order.name, out.body.name);
  assert.ok(order.lines[0].price_unit > 1, 'price comes from the product, not the request');
  assert.ok(moves(saved) > moves(db));
  const closed = commitAsSystem(saved, runPosting(saved, pos, '/api/pos/close', { session_id: order.session_id, counted: 0 }).db);
  assert.equal(read(closed, 'pos.session', order.session_id).state, 'closed');
});

test('server POS posting preserves split tenders and whole quantities', () => {
  const db = startSession(seed(), 0).db;
  const body = { lines: [{ product_id: 1, qty: 1 }], method: 'cash' };
  const single = runPosting(db, null, '/api/pos/pay', body);
  const due = read(single.db, 'pos.order', single.body.id).amount_total;
  const payments = [{ method: 'cash', amount: 10 }, { method: 'card', amount: due - 10 }];
  const out = runPosting(db, modelsForApps(['pos']), '/api/pos/pay', { ...body, payments });
  const saved = commitAsSystem(db, out.db);
  const order = read(saved, 'pos.order', out.body.id);
  assert.equal(order.lines[0].qty, 1);
  assert.deepEqual(order.payment_ids.map((p) => p.amount), payments.map((p) => p.amount));
  assert.throws(() => runPosting(db, null, '/api/pos/pay', { ...body, payments: [{ method: 'bitcoin', amount: due }] }), /Invalid payments/);
});

test('a payroll-only user confirms a payslip through the posting button', () => {
  const payroll = modelsForApps(['payroll']);
  const { db, id } = create(seed(), 'hr.payslip', { employee_id: 1 });
  const out = runPosting(db, payroll, '/api/button', { model: 'hr.payslip', id, label: 'Confirm' });
  const saved = commitAsSystem(db, out.db);
  assert.equal(read(saved, 'hr.payslip', id).state, 'done');
  assert.ok(moves(saved) > moves(db));
});

test('server tax submission carries an internal proof through sync without trusting a forged reference', () => {
  let db = updateSettings(seed(), { lock_date: '2025-03-31' });
  const type = search(db, 'account.return.type')[0];
  const made = create(db, 'account.return', { name: 'Server VAT', type_id: type.id, company_id: 1, date_from: '2025-03-01', date_to: '2025-03-31' });
  const review = models['account.return'].form.buttons.find((b) => b.label === 'Review');
  db = review.run(made.db, read(made.db, 'account.return', made.id)).db;
  const out = runPosting(db, null, '/api/button', { model: 'account.return', id: made.id, label: 'Submit' });
  const diff = diffDb(db, out.db);
  assert.throws(() => applyDiff(db, diff, { author: 'test' }), /locked/i);
  assert.throws(() => applyDiff(db, diff, { author: 'test', taxClosingProofs: [{}] }), /locked/i);
  const proof = taxClosingProofs(out.db, diff);
  assert.equal(proof.length, 1);
  const altered = structuredClone(diff);
  altered.upserts['account.move'][0].line_ids[0].debit = 1;
  altered.upserts['account.move'][0].line_ids[1].credit = 1;
  assert.throws(() => applyDiff(db, altered, { author: 'test', taxClosingProofs: proof }), /locked/i);
  const saved = applyDiff(db, diff, { author: 'test', taxClosingProofs: proof });
  const ret = read(saved, 'account.return', made.id);
  assert.equal(ret.state, 'submitted');
  assert.equal(read(saved, 'account.move', ret.closing_move_ids[0]).state, 'posted');
});

test('server direct-pay workflow posts its validated closing into a pre-existing lock', () => {
  let db = seed();
  const type = search(db, 'account.return.type')[0];
  db = create(db, 'res.partner.bank', { partner_id: type.payment_partner_id, account_number: 'SERVER-TAX-BANK' }).db;
  db = postEntry(db, { journal: 'MISC', date: '2025-03-15', company: 1, lines: [
    { account: '251000', credit: 140, tax_name: 'VAT' }, { account: '101401', debit: 140 },
  ] }).db;
  db = updateSettings(db, { lock_date: '2025-03-31' });
  db = write(db, 'account.return.type', type.id, { states_workflow: 'generic_state_only_pay' });
  const made = create(db, 'account.return', { name: 'Server direct VAT', type_id: type.id, company_id: 1, date_from: '2025-03-01', date_to: '2025-03-31' });
  const out = runPosting(made.db, null, '/api/button', { model: 'account.return', id: made.id, label: 'Pay' });
  const diff = diffDb(made.db, out.db);
  const saved = applyDiff(made.db, diff, { author: 'test', taxClosingProofs: taxClosingProofs(out.db, diff) });
  const ret = read(saved, 'account.return', made.id);
  assert.equal(ret.state, 'paid');
  assert.equal(read(saved, 'account.move', ret.closing_move_ids[0]).state, 'posted');
  assert.equal(ret.total_amount_to_pay, 140);
  assert.equal(read(saved, 'account.payment', ret.payment_id).state, 'posted');
});

test('users without the business document, and buttons not marked as posting, are refused', () => {
  const { db, id } = create(seed(), 'hr.payslip', { employee_id: 1 });
  assert.throws(() => runPosting(db, modelsForApps(['crm']), '/api/button', { model: 'hr.payslip', id, label: 'Confirm' }), /No access/);
  assert.throws(() => runPosting(db, null, '/api/button', { model: 'hr.payslip', id, label: 'Cancel' }), /not available/);
  assert.throws(() => runPosting(db, null, '/api/button', { model: 'hr.payslip', id, label: 'Mark as Paid' }), /not available/);
  assert.throws(() => runPosting(startSession(db, 0).db, modelsForApps(['pos']), '/api/pos/pay', { lines: [{ product_id: 1, qty: 1 }], method: 'bitcoin' }), /payment method/);
});
