import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { discountAvailable, payWithDiscount, postMove } from './models/accounting.js';
import { taxRepartitionLine, taxSnapshot } from './models/taxes.js';

test('untaxed early discount settles to the configured account in each invoice company', () => {
  const base = seed();
  const branch = createCompany(base, { name: 'Discount branch', currency_id: base.records['res.company'][0].currency_id });
  let db = branch.db;
  for (const companyId of [1, branch.id]) {
    const account = create(db, 'account.account', { name: 'Early discount expense', code: `DISC${companyId}`, account_type: 'expense', company_id: companyId });
    db = write(account.db, 'res.company', companyId, { expense_early_payment_discount_account_id: account.id });
    const term = create(db, 'account.payment.term', { name: '2% before tax', early_discount: true, discount_percent: 2, discount_days: 10, discount_tax_computation: 'excluded' });
    const invoice = create(term.db, 'account.move', { move_type: 'out_invoice', company_id: companyId, partner_id: 1, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 14 }] });
    db = postMove(invoice.db, invoice.id);
    assert.equal(discountAvailable(db, read(db, 'account.move', invoice.id), '2026-01-11'), 2);
    assert.equal(discountAvailable(db, read(db, 'account.move', invoice.id), '2026-01-12'), 0);
    const late = payWithDiscount(db, invoice.id, 112, '2026-01-12');
    assert.equal(read(late, 'account.move', invoice.id).amount_residual, 2);
    db = payWithDiscount(db, invoice.id, 112, '2026-01-11');
    const paid = read(db, 'account.move', invoice.id);
    assert.equal(paid.amount_residual, 0);
    const entry = read(db, 'account.move', paid.payments.at(-1).move_id);
    assert.equal(entry.company_id, companyId);
    assert.ok(entry.line_ids.some((line) => line.account_id === account.id && line.debit === 2));
    assert.equal(search(db, 'account.move').filter((move) => move.id === entry.id).length, 1);
  }
});

test('tax-inclusive early discount reduces both revenue and invoice-basis VAT', () => {
  const base = seed();
  const term = create(base, 'account.payment.term', { name: 'Tax-inclusive 2%', early_discount: true, discount_percent: 2, discount_days: 10, discount_tax_computation: 'included' });
  const tax = search(term.db, 'account.tax').find((item) => item.type_tax_use === 'sale' && item.amount === 14 && item.tax_exigibility === 'on_invoice' && !item.price_include);
  const invoice = create(term.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(tax) }] });
  const posted = postMove(invoice.db, invoice.id);
  const paid = payWithDiscount(posted, invoice.id, 111.72, '2026-01-11');
  const move = read(paid, 'account.move', invoice.id);
  assert.equal(move.amount_residual, 0);
  const entry = read(paid, 'account.move', move.payments.at(-1).move_id);
  assert.equal(entry.line_ids.find((line) => line.account_id === taxRepartitionLine(tax)?.account_id)?.debit, 0.28);
  assert.equal(entry.line_ids.find((line) => read(paid, 'account.account', line.account_id)?.code === '690200')?.debit, 2);
});
