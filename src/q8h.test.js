import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { applyPaymentCredit, postPayment, unapplyPaymentCredit } from './models/pay.js';
import { payOrder, priceLines, startSession } from './models/pos.js';
import { applyDiff, diffDb } from './sync.js';
import { migrate } from './migrations.js';

const button = (model, label) => models[model].form.buttons.find((b) => b.label === label);
const run = (db, model, id, label) => button(model, label).run(db, read(db, model, id)).db;
const force = (db, model, id, vals) => ({ ...db, records: { ...db.records, [model]: db.records[model].map((r) => (r.id === id ? { ...r, ...vals } : r)) } });

test('Qodo 1: an invoice-only unapplication that does not restore the payment credit is rejected by sync', () => {
  const payment = create(seed(), 'account.payment', { partner_id: 1, partner_type: 'customer', payment_type: 'inbound', amount: 100, date: '2026-01-02' });
  let db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 40, tax: 0 }] });
  db = applyPaymentCredit(postMove(invoice.db, invoice.id), payment.id, invoice.id);
  const moveId = read(db, 'account.payment', payment.id).move_id;
  const applied = read(db, 'account.move', invoice.id).payments.at(-1).date;
  const local = unapplyPaymentCredit(db, invoice.id, moveId, applied);
  // The genuine unapplication (invoice and payment together) is accepted.
  assert.equal(read(applyDiff(db, diffDb(db, local), { isAdmin: true }), 'account.payment', payment.id).unapplied, 100);
  const invoiceOnly = force(local, 'account.payment', payment.id, { unapplied: read(db, 'account.payment', payment.id).unapplied });
  assert.throws(() => applyDiff(db, diffDb(db, invoiceOnly), { isAdmin: true }), /restore its outstanding credit/);
});

test('Qodo 16: an on-payment tax cannot be saved without its transition account', () => {
  assert.throws(() => create(seed(), 'account.tax', { name: 'Incomplete cash tax', company_id: 1, type_tax_use: 'sale', amount: 5, tax_exigibility: 'on_payment' }), /Configure the cash basis transition account/);
});

test('Qodo 17: migration 33 finds a legacy payroll journal stored without a company', () => {
  const db = seed();
  const structure = read(db, 'res.company', 1).default_payroll_structure_id;
  const journal = search(db, 'account.journal').find((j) => j.code === 'SAL');
  const legacy = force(force({ ...db, schema_version: 32 }, 'account.journal', journal.id, { company_id: null }), 'hr.payroll.structure', structure, { journal_id: null });
  assert.equal(read(migrate(legacy), 'hr.payroll.structure', structure).journal_id, journal.id);
});

test('Qodo 53: a salary structure needs exactly one net rule', () => {
  const db = seed();
  const structure = read(db, 'res.company', 1).default_payroll_structure_id;
  const rules = read(db, 'hr.payroll.structure', structure).rules;
  assert.throws(() => write(db, 'hr.payroll.structure', structure, { rules: [...rules, { ...rules.find((r) => r.category === 'net'), code: 'NET2', sequence: 99 }] }), /exactly one net rule/);
});

test('Qodo 54: a structure stored with no rules is reported instead of computed from defaults', () => {
  const db = seed();
  const structure = read(db, 'res.company', 1).default_payroll_structure_id;
  const empty = force(db, 'hr.payroll.structure', structure, { rules: [] });
  const slip = create(empty, 'hr.payslip', { employee_id: 1, structure_id: structure, date_from: '2037-01-01', date_to: '2037-01-31' });
  assert.throws(() => run(slip.db, 'hr.payslip', slip.id, 'Compute Sheet'), /Add salary rules/);
});

test('Qodo 55: salary payment clears the payable booked at confirmation', () => {
  let db = seed();
  const structureId = read(db, 'res.company', 1).default_payroll_structure_id;
  const slip = create(db, 'hr.payslip', { employee_id: 1, date_from: '2037-01-01', date_to: '2037-01-31' });
  db = run(run(slip.db, 'hr.payslip', slip.id, 'Compute Sheet'), 'hr.payslip', slip.id, 'Confirm');
  const booked = read(db, 'hr.payslip', slip.id).payable_account_id;
  assert.ok(booked);
  const other = create(db, 'account.account', { name: 'New payable', code: 'Q8HPAY', account_type: 'liability_current', company_id: 1 });
  const structure = read(other.db, 'hr.payroll.structure', structureId);
  db = write(other.db, 'hr.payroll.structure', structureId, { rules: structure.rules.map((r) => (r.category === 'net' ? { ...r, account_credit_id: other.id } : r)) });
  db = run(db, 'hr.payslip', slip.id, 'Mark as Paid');
  const payment = search(db, 'account.move').find((m) => m.ref === `Salary payment ${read(db, 'hr.payslip', slip.id).name}`);
  assert.ok(payment.line_ids.some((l) => l.account_id === booked && l.debit > 0));
  assert.ok(!payment.line_ids.some((l) => l.account_id === other.id));
});

test('Qodo 56: a periodic-valuation POS return needs no cost-of-goods-sold account', () => {
  let db = write(seed(), 'res.company', 1, { account_cogs_id: null });
  const product = create(db, 'product', { name: 'Periodic item', type: 'goods', valuation: 'manual_periodic', cost: 12, list_price: 20 });
  const preset = create(product.db, 'pos.preset', { name: 'Returns', is_return: true, identification: 'none' });
  const config = search(preset.db, 'pos.config')[0];
  db = startSession(write(preset.db, 'pos.config', config.id, { available_preset_ids: [preset.id], default_preset_id: preset.id }), 0).db;
  const sale = payOrder(db, { lines: priceLines(db, [{ product_id: product.id, qty: -1 }]), method: 'cash', preset_id: preset.id });
  assert.ok(search(sale.db, 'pos.order').length > search(db, 'pos.order').length);
});

test('Qodo 57: an approved expense with only a tax percentage can be reset to draft to select its tax', () => {
  const product = create(seed(), 'product', { name: 'Taxed claim', type: 'service' });
  const claim = create(product.db, 'hr.expense', { name: 'Legacy claim', employee_id: 1, product_id: product.id, tax: 10, total_amount: 110, state: 'approved', date: '2037-01-01' });
  assert.throws(() => run(claim.db, 'hr.expense', claim.id, 'Post Journal Entries'), /Configure the expense tax on Legacy claim/);
  const reset = button('hr.expense', 'Reset to Draft');
  assert.ok(reset.when(read(claim.db, 'hr.expense', claim.id)));
  assert.equal(read(write(claim.db, 'hr.expense', claim.id, reset.vals), 'hr.expense', claim.id).state, 'draft');
});
