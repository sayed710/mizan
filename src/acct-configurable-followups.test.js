import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { today } from './models/common.js';
import { migrate } from './migrations.js';
import { applyDiff, diffDb } from './sync.js';
import { reversePayment } from './models/pay.js';

const press = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('standalone payment allocations use company-configured exchange accounts and can be synchronized and reversed', () => {
  for (const [paymentRate, field, side] of [[1, 'income_currency_exchange_account_id', 'credit'], [4, 'expense_currency_exchange_account_id', 'debit']]) {
    const branch = createCompanyWithDefaultInvoiceJournals(seed(), { name: 'FX branch' });
    for (const company of [1, branch.id]) {
      const account = create(branch.db, 'account.account', { name: 'Configured exchange', code: `FX${company}`, account_type: side === 'credit' ? 'income_other' : 'expense_other', company_id: company });
      const configured = write(account.db, 'res.company', company, { [field]: account.id });
      const currency = create(configured, 'res.currency', { name: 'Exchange test', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: paymentRate }] });
      const invoice = create(currency.db, 'account.move', { move_type: 'out_invoice', company_id: company, partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
      const posted = press(invoice.db, 'account.move', invoice.id, 'Confirm');
      const draft = create(posted, 'account.payment', { company_id: company, partner_id: 1, partner_type: 'customer', payment_type: 'inbound', amount: 20, date: '2026-02-01' });
      const paid = press(draft.db, 'account.payment', draft.id, 'Confirm');
      const allocation = read(paid, 'account.move', invoice.id).payments[0];
      const fx = read(paid, 'account.move', allocation.payment_fx_move_id);
      assert.ok(fx.line_ids.some((line) => line.account_id === account.id && line[side] > 0));
      assert.equal(fx.company_id, company);
      assert.doesNotThrow(() => applyDiff(draft.db, diffDb(draft.db, paid), { isAdmin: true }));
      const reversed = reversePayment(paid, read(paid, 'account.payment', draft.id), '2026-02-02');
      assert.equal(read(reversed, 'account.move', invoice.id).amount_residual, 100);
      assert.ok(reversed.records['account.move'].some((move) => move.reversed_entry_id === fx.id));
    }
  }
});

test('bank match uses each company exchange account for payment and write-off', () => {
  const branch = createCompanyWithDefaultInvoiceJournals(seed(), { name: 'FX branch' });
  let db = branch.db;
  for (const company of [1, branch.id]) {
    const gain = create(db, 'account.account', { name: 'FX gain', code: `FX${company}`, account_type: 'income_other', company_id: company });
    db = write(gain.db, 'res.company', company, { income_currency_exchange_account_id: gain.id });
    const currency = create(db, 'res.currency', { name: `FX${company}`, rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
    const invoice = create(currency.db, 'account.move', { move_type: 'out_invoice', company_id: company, partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
    db = press(invoice.db, 'account.move', invoice.id, 'Confirm');
    const expense = create(db, 'account.account', { name: 'Write off', code: `WO${company}`, account_type: 'expense', company_id: company });
    const line = create(expense.db, 'account.bank.statement.line', { company_id: company, payment_ref: 'Bank receipt', date: '2026-02-01', amount: 90, move_id: invoice.id, writeoff_account_id: expense.id, writeoff_amount: 10, writeoff_label: 'Adjustment' });
    db = press(line.db, 'account.bank.statement.line', line.id, 'Match');
    const statement = read(db, 'account.bank.statement.line', line.id);
    for (const id of [statement.payment_move_id, statement.writeoff_move_id]) {
      assert.ok(read(db, 'account.move', id).line_ids.some((item) => item.account_id === gain.id && item.credit > 0));
    }
  }
});

test('discount button uses the posted invoice counterpart account', () => {
  const base = seed();
  const account = create(base, 'account.account', { name: 'Alternative receivable', code: '129999', account_type: 'asset_receivable', company_id: 1 });
  const term = create(account.db, 'account.payment.term', { name: '2 percent', early_discount: true, discount_percent: 2, discount_days: 10, discount_tax_computation: 'excluded' });
  const invoice = create(term.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_date: today(), invoice_payment_term_id: term.id, invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  const posted = press(invoice.db, 'account.move', invoice.id, 'Confirm');
  const db = { ...posted, records: { ...posted.records, 'account.move': posted.records['account.move'].map((move) => move.id === invoice.id ? { ...move, line_ids: move.line_ids.map((line) => read(posted, 'account.account', line.account_id)?.account_type === 'asset_receivable' ? { ...line, account_id: account.id } : line) } : move) } };
  const oldPrompt = globalThis.prompt;
  globalThis.prompt = () => '98';
  try {
    const paid = press(db, 'account.move', invoice.id, 'Register Payment');
    const discount = read(paid, 'account.move', read(paid, 'account.move', invoice.id).payments.at(-1).move_id);
    assert.ok(discount.line_ids.some((line) => line.account_id === account.id && line.credit === 2));
  } finally { globalThis.prompt = oldPrompt; }
});


test('migration preserves both legacy company-one and other company tax locks', () => {
  const base = seed();
  const old = { ...base, schema_version: 17, settings: { ...base.settings, tax_lock_date: '2026-01-31', tax_lock_dates: { 1: '2025-01-01', 2: '2026-02-28' } } };
  const migrated = migrate(old);
  assert.deepEqual(migrated.settings.tax_lock_dates, { 1: '2026-01-31', 2: '2026-02-28' });
  assert.equal('tax_lock_date' in migrated.settings, false);
  assert.equal(migrate(migrated), migrated);
});
