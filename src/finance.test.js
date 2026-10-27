import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, updateSettings, write } from './orm.js';
import { models } from './models/index.js';
import { agedBalance, analyticActuals, followUps, journalCards, lockDateFor, moveGuard, receivableOf, taxReport } from './models/finance.js';
import { addDays, today } from './models/common.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const invoice = (db, vals) => {
  const { db: next, id } = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, tax: 14 }], ...vals });
  return { db: run(next, 'account.move', id, 'Confirm'), id };
};

test('confirming a quotation over the credit limit is refused', () => {
  const db0 = write(seed(), 'res.partner', 3, { credit_limit: receivableOf(seed(), 3) + 500 });
  const { db, id } = create(db0, 'sale.order', { partner_id: 3, order_line: [{ product_id: 1, qty: 1, price_unit: 1000, tax: 0 }] });
  assert.throws(() => run(db, 'sale.order', id, 'Confirm'), /credit limit/);
  const ok = create(db0, 'sale.order', { partner_id: 3, order_line: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  assert.equal(read(run(ok.db, 'sale.order', ok.id, 'Confirm'), 'sale.order', ok.id).state, 'sale');
});

test('posting into a locked period is refused', () => {
  const db = updateSettings(seed(), { lock_date: today() });
  assert.throws(() => invoice(db, { invoice_date: addDays(today(), -1) }), /locked/);
  assert.equal(read(invoice(db, { invoice_date: addDays(today(), 1) }).db, 'account.move', invoice(db, { invoice_date: addDays(today(), 1) }).id).state, 'posted');
});

test('tax return nets output VAT against input VAT', () => {
  const db0 = seed();
  const period = { from: today(), to: today() };
  const before = taxReport(db0, period);
  const { db } = invoice(db0, { invoice_date: today() });
  const after = taxReport(db, period);
  assert.equal(Math.round((after.output - before.output) * 100) / 100, 140);
  assert.equal(after.payable, Math.round((after.output - after.input) * 100) / 100);
});

test('aged receivable buckets by days overdue and follow-ups list overdue partners', () => {
  const { db } = invoice(seed(), { partner_id: 5, invoice_date: addDays(today(), -80), invoice_date_due: addDays(today(), -45) });
  const row = agedBalance(db).rows.find((r) => r.partner_id === 5);
  assert.ok(row['31_60'] >= 1140);
  assert.ok(followUps(db).some((f) => f.partner_id === 5 && f.total >= 1140));
});

test('analytic actuals sum posted lines tagged with an analytic account', () => {
  const db0 = seed();
  const office = search(db0, 'account.analytic.account')[0].id;
  const { db } = invoice(db0, { invoice_line_ids: [{ product_id: 1, qty: 2, price_unit: 500, discount: 10, tax: 14, analytic_account_id: office }] });
  assert.equal(analyticActuals(db).get(office), 900);
});

test('the lock date also guards synced changes and deletes; payments on locked invoices still work', async () => {
  const { applyDiff, diffDb } = await import('./sync.js');
  const { payMove } = await import('./models/accounting.js');
  const { db: posted, id } = invoice(seed(), { invoice_date: addDays(today(), -10) });
  const locked = updateSettings(posted, { lock_date: addDays(today(), -1) });
  const edited = { ...locked, records: { ...locked.records, 'account.move': locked.records['account.move'].map((m) => (m.id === id ? { ...m, invoice_date: today() } : m)) } };
  assert.throws(() => applyDiff(locked, diffDb(locked, edited)), /locked/);
  assert.throws(() => applyDiff(locked, { upserts: {}, deletes: { 'account.move': [id] } }), /locked/);
  assert.equal(read(payMove(locked, id, 100), 'account.move', id).amount_paid, 100);
});

test('the audit trail logs every change, keeps numbered entries and cannot be switched off', async () => {
  const { applyDiff } = await import('./sync.js');
  const { unlink } = await import('./orm.js');
  const db0 = updateSettings(seed(), { audit_trail: true });
  const { db, id } = invoice(db0, {});
  const noted = write(db, 'account.move', id, { ref: 'PO-77' });
  assert.ok(noted.messages.some((m) => m.res_id === id && m.model === 'account.move' && /Reference/.test(m.body)));
  assert.throws(() => unlink(noted, 'account.move', [id]), /audit trail/);
  assert.equal(applyDiff(noted, { upserts: {}, deletes: {}, settings: { audit_trail: false } }).settings.audit_trail, true);
  const msg = noted.messages.find((m) => m.model === 'account.move' && m.res_id === id);
  assert.ok(applyDiff(noted, { upserts: {}, deletes: {}, removedMessages: [msg.id] }).messages.some((m) => m.id === msg.id));
});

test('automatic reminders log each reached level once per customer', async () => {
  const { runFollowUps } = await import('./models/finance.js');
  const { messagesOf } = await import('./orm.js');
  const { db } = invoice(seed(), { partner_id: 5, invoice_date: addDays(today(), -60), invoice_date_due: addDays(today(), -20) });
  const first = runFollowUps(db);
  assert.equal(read(first, 'res.partner', 5).followup_level_delay, 15);
  assert.ok(messagesOf(first, 'res.partner', 5).some((m) => /First reminder/.test(m.body)));
  assert.equal(runFollowUps(first).messages.length, first.messages.length);
  const later = runFollowUps(first, addDays(today(), 12));
  assert.equal(read(later, 'res.partner', 5).followup_level_delay, 30);
});

test('sales and purchase lock dates only lock their side; the hard lock locks everything', () => {
  assert.equal(lockDateFor({ sale_lock_date: '2026-03-31' }, { move_type: 'out_invoice' }), '2026-03-31');
  assert.equal(lockDateFor({ sale_lock_date: '2026-03-31' }, { move_type: 'in_invoice' }), '');
  assert.equal(lockDateFor({ purchase_lock_date: '2026-02-28', lock_date: '2026-01-31' }, { move_type: 'in_refund' }), '2026-02-28');
  assert.equal(lockDateFor({ hard_lock_date: '2026-04-30', sale_lock_date: '2026-03-31' }, { move_type: 'entry' }), '2026-04-30');
  const db = { settings: { sale_lock_date: '2026-03-31' } };
  assert.match(moveGuard(db, null, { move_type: 'out_invoice', state: 'posted', invoice_date: '2026-03-10' }), /locked/);
  assert.equal(moveGuard(db, null, { move_type: 'in_invoice', state: 'posted', invoice_date: '2026-03-10' }), null);
});

test('journal cards count drafts, unpaid and late invoices, and bank balance with lines to reconcile', () => {
  const db = seed();
  const cards = journalCards(db, '2999-01-01');
  const sale = cards.find((c) => c.journal.code === 'INV');
  const posted = search(db, 'account.move').filter((m) => m.journal_id === sale.journal.id && m.state === 'posted' && m.amount_residual > 0);
  assert.equal(sale.unpaid, posted.length);
  assert.equal(sale.late, posted.length);
  assert.equal(sale.draft, search(db, 'account.move').filter((m) => m.state === 'draft' && m.move_type === 'out_invoice' && !m.journal_id).length);
  const bank = cards.find((c) => c.journal.code === 'BNK1');
  assert.ok(bank.balance > 0);
  assert.equal(bank.toReconcile, search(db, 'account.bank.statement.line').filter((l) => l.state === 'to_check').length);
});

test('a reminder opened in the mail app is logged on the customer with each amount in its currency', async () => {
  const { followUpText, logManualFollowUp } = await import('./models/finance.js');
  const { messagesOf } = await import('./orm.js');
  const { db } = invoice(seed(), { partner_id: 5, invoice_date: addDays(today(), -60), invoice_date_due: addDays(today(), -20) });
  const f = followUps(db).find((x) => x.partner_id === 5);
  assert.match(followUpText(db, f), /\d \S+$/m);
  const next = logManualFollowUp(db, 5);
  assert.equal(read(next, 'res.partner', 5).followup_date, today());
  assert.equal(read(next, 'res.partner', 5).followup_level_delay, 15);
  assert.ok(messagesOf(next, 'res.partner', 5).some((m) => /Payment reminder sent by email/.test(m.body)));
  assert.throws(() => logManualFollowUp(seed(), 5), /no overdue/);
});
