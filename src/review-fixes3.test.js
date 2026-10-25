import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { cleanRecord } from './validate.js';
import { accountId, journalItems } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { confirmAsset } from './models/assets.js';
import { runScheduledJobs } from './models/scheduler.js';
import { applyRule } from './models/reconcile.js';
import { taxSnapshot } from './models/taxes.js';
import { invoiceQrPayload } from './models/qr.js';
import { seed } from './seed.js';

const cashTax = (db) => search(db, 'account.tax').find((t) => t.name === 'VAT 14% (Cash Basis)');
const balanceOf = (db, code) => journalItems(db).filter((l) => l.account_id === accountId(db, code)).reduce((s, l) => s + l.credit - l.debit, 0);
const post = (db, vals) => {
  const { db: next, id } = create(db, 'account.move', { partner_id: 1, invoice_date: '2026-03-01', invoice_date_due: '2026-03-31', ...vals });
  return { db: postMove(next, id), id };
};

test('server validation keeps the tax snapshot on invoice lines', () => {
  const db = seed();
  const line = { product_id: 1, qty: 1, price_unit: 114, discount: 0, ...taxSnapshot(search(db, 'account.tax').find((t) => t.price_include)) };
  const clean = cleanRecord('account.move', { move_type: 'out_invoice', invoice_line_ids: [line] }).invoice_line_ids[0];
  assert.equal(clean.tax_include, true);
  assert.equal(clean.tax_type, 'percent');
  assert.equal(clean.tax_name, 'VAT 14% Included');
});

test('paying a cash-basis credit note reverses the released tax', () => {
  const base = seed();
  const before = balanceOf(base, '251000');
  const lines = [{ product_id: 1, qty: 1, price_unit: 1000, discount: 0, ...taxSnapshot(cashTax(base)) }];
  const inv = post(base, { move_type: 'out_invoice', invoice_line_ids: lines });
  const paid = payMove(inv.db, inv.id, 1140, '2026-03-05');
  const refund = post(paid, { move_type: 'out_refund', invoice_line_ids: lines });
  const done = payMove(refund.db, refund.id, 1140, '2026-03-06');
  assert.equal(Math.round(balanceOf(done, '251100') * 100) / 100, 0);
  assert.equal(Math.round((balanceOf(done, '251000') - before) * 100) / 100, 0);
});

test('a manual payment releases cash-basis tax of the invoices it settles', () => {
  const base = seed();
  const fresh = create(base, 'res.partner', { name: 'Cash Basis Client' });
  const inv = post(fresh.db, { move_type: 'out_invoice', partner_id: fresh.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, discount: 0, ...taxSnapshot(cashTax(base)) }] });
  const { db, id } = create(inv.db, 'account.payment', { partner_id: fresh.id, amount: 1140, payment_type: 'inbound', partner_type: 'customer', date: '2026-03-10' });
  const done = postPayment(db, read(db, 'account.payment', id));
  assert.equal(Math.round(balanceOf(done, '251100') * 100) / 100, 0);
});

test('a locked depreciation line does not stop the other scheduled jobs', () => {
  const { db, id } = create(seed(), 'account.asset', { name: 'Old Van', original_value: 1000, acquisition_date: '2020-01-01', method_number: 2, method_period: '12' });
  const running = confirmAsset(db, read(db, 'account.asset', id));
  const locked = { ...running, settings: { ...running.settings, lock_date: '2030-12-31' } };
  assert.doesNotThrow(() => runScheduledJobs(locked, '2031-01-01'));
});

test('invoice matching never pays another partner or a different amount', () => {
  const inv = post(seed(), { move_type: 'out_invoice', partner_id: 1, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const rule = { name: 'Match', rule_type: 'invoice_matching', line_ids: [] };
  const other = create(inv.db, 'account.bank.statement.line', { date: '2026-03-02', payment_ref: 'x', amount: 100, partner_id: 2, state: 'to_check' });
  assert.equal(applyRule(other.db, rule, read(other.db, 'account.bank.statement.line', other.id)), other.db);
  const bigger = create(inv.db, 'account.bank.statement.line', { date: '2026-03-02', payment_ref: 'x', amount: 1000, partner_id: 1, state: 'to_check' });
  assert.equal(applyRule(bigger.db, rule, read(bigger.db, 'account.bank.statement.line', bigger.id)), bigger.db);
  const exact = create(inv.db, 'account.bank.statement.line', { date: '2026-03-02', payment_ref: 'x', amount: 100, partner_id: 1, state: 'to_check' });
  const done = applyRule(exact.db, rule, read(exact.db, 'account.bank.statement.line', exact.id));
  assert.equal(read(done, 'account.move', inv.id).payment_state, 'paid');
});

test('a write-off to an unknown account is refused', () => {
  const { db, id } = create(seed(), 'account.bank.statement.line', { date: '2026-03-02', payment_ref: 'fee', amount: -5, state: 'to_check' });
  const rule = { name: 'Typo', rule_type: 'writeoff_button', line_ids: [{ account_code: '690O00', amount_type: 'percentage', amount: 100 }] };
  assert.throws(() => applyRule(db, rule, read(db, 'account.bank.statement.line', id)), /Unknown account/);
});

test('no EPC QR for paid or foreign-currency invoices', () => {
  const settings = { invoice_qr: 'epc', company_iban: 'DE89370400440532013000' };
  const company = { name: 'Mizan', currency: 'EUR' };
  const move = { move_type: 'out_invoice', state: 'posted', name: 'INV/1', amount_residual: 0 };
  assert.equal(invoiceQrPayload(settings, company, move), null);
  assert.equal(invoiceQrPayload(settings, company, { ...move, amount_residual: 10, currency_id: 2 }), null);
});

test('a payment confirmed from a draft with an invoice gets a number', () => {
  const inv = post(seed(), { move_type: 'out_invoice', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const { db, id } = create(inv.db, 'account.payment', { partner_id: 1, amount: 100, invoice_id: inv.id, payment_type: 'inbound', partner_type: 'customer' });
  assert.match(read(postPayment(db, read(db, 'account.payment', id)), 'account.payment', id).name, /^PBNK1\//);
});

test('agy review: fleet ignores unset odometers, payroll ignores short days, helpdesk merge and auto-close boundaries', async () => {
  const { vehicleCosts } = await import('./models/fleetplus.js');
  const { workedDays } = await import('./models/payroll.js');
  const { autoCloseStale, mergeTickets, assignTicket } = await import('./models/helpdesk.js');
  let db = seed();
  const v = search(db, 'fleet.vehicle')[0];
  db = create(db, 'fleet.odometer', { vehicle_id: v.id, date: '2026-03-01', value: 1000 }).db;
  db = create(db, 'fleet.odometer', { vehicle_id: v.id, date: '2026-03-20', value: 1500 }).db;
  db = create(db, 'fleet.service', { vehicle_id: v.id, name: 'Oil change', date: '2026-03-10', state: 'done', cost: 100, odometer: 0 }).db;
  assert.equal(vehicleCosts(db, v.id, { from: '2026-03-01', to: '2026-03-31' }).km, 500);
  const emp = search(db, 'hr.employee')[0];
  db = create(db, 'hr.attendance', { employee_id: emp.id, date: '2026-03-02', check_in: '08:00', check_out: '18:00' }).db;
  db = create(db, 'hr.attendance', { employee_id: emp.id, date: '2026-03-03', check_in: '08:00', check_out: '13:00' }).db;
  assert.equal(workedDays(db, { employee_id: emp.id, date_from: '2026-03-01', date_to: '2026-03-31' }).overtime_hours, 2);
  const a = create(db, 'helpdesk.ticket', { name: 'Target' });
  const b = create(a.db, 'helpdesk.ticket', { name: 'S1', partner_id: 1 });
  const c = create(b.db, 'helpdesk.ticket', { name: 'S2', partner_id: 2 });
  assert.throws(() => mergeTickets(c.db, a.id, [b.id, c.id]), /different customers/);
  assert.equal(read(mergeTickets(c.db, a.id, [b.id]), 'helpdesk.ticket', a.id).partner_id, 1);
  const team = create(db, 'helpdesk.team', { name: 'T', assignment: 'manual', auto_close: true, auto_close_days: 7, member_ids: [{ employee_id: emp.id }] });
  const t = create(team.db, 'helpdesk.ticket', { name: 'Old', team_id: team.id, stage_id: 'hold', create_date: '2026-10-01' });
  assert.equal(read(assignTicket(t.db, read(t.db, 'helpdesk.ticket', t.id)), 'helpdesk.ticket', t.id).user_id ?? null, null);
  assert.notEqual(read(autoCloseStale(t.db, '2026-10-08'), 'helpdesk.ticket', t.id).stage_id, 'hold');
});

test('agy review 2: empty measures fail, archived points ignored, timers and ticket closing guarded, hired excludes refused', async () => {
  const { evaluateMeasure } = await import('./models/qualityplus.js');
  const { stopTimer, markDone } = await import('./models/fsm.js');
  const { jobPipeline, applicantScore } = await import('./models/recruitplus.js');
  const point = { tolerance_min: -1, tolerance_max: 1 };
  assert.deepEqual(['', null, '  ', true, '0'].map((v) => evaluateMeasure(point, v)), ['fail', 'fail', 'fail', 'fail', 'pass']);
  const task = { id: 1, timer_start: '2026-01-01T10:00:00Z' };
  assert.throws(() => stopTimer(seed(), task, '2026-01-01T09:00:00Z'), /after the start/);
  assert.throws(() => markDone(seed(), { id: 1, timer_start: '2026-01-01T10:00:00Z', worksheet: [] }), /Stop the timer/);
  const t = create(seed(), 'helpdesk.ticket', { name: 'X', stage_id: 'cancelled' });
  const fsm = create(t.db, 'fsm.task', { name: 'Visit', helpdesk_ticket_id: t.id });
  assert.equal(read(markDone(fsm.db, read(fsm.db, 'fsm.task', fsm.id)), 'helpdesk.ticket', t.id).stage_id, 'cancelled');
  const job = create(seed(), 'hr.job', { name: 'Dev' });
  const ap = create(job.db, 'hr.applicant', { name: 'A', partner_name: 'A', job_id: job.id, stage_id: 'hired', active: false });
  assert.equal(jobPipeline(ap.db, job.id).hired, 0);
  assert.equal(applicantScore({ priority: 0, salary_expected: 0, expected_salary: 900 }, { salary_max: 1000 }), 20);
});
