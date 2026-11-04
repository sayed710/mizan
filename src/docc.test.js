import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { seed } from './seed.js';
import { create, read } from './orm.js';
import { postMove, payWithDiscount } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { taxesByGrid } from './models/finance.js';

test('included early payment discounts adjust tagged tax grids in the payment period', () => {
  const tag = create(seed(), 'account.account.tag', { name: 'Grid', applicability: 'taxes' });
  const tax = create(tag.db, 'account.tax', { name: 'VAT', amount: 10, type_tax_use: 'sale', tag_ids: [tag.id] });
  const term = create(tax.db, 'account.payment.term', { name: 'Discount', early_discount: true, discount_percent: 2, discount_days: 30, discount_tax_computation: 'included' });
  const invoice = create(term.db, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_date: '2025-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(term.db, 'account.tax', tax.id)) }] });
  let db = postMove(invoice.db, invoice.id);
  db = payWithDiscount(db, invoice.id, 107.8, '2025-01-10');
  const discount = read(db, 'account.move', read(db, 'account.move', invoice.id).payments.at(-1).move_id);
  assert.equal(discount.line_ids.find((l) => l.tax_name === 'VAT').tax_id, tax.id);
  assert.deepEqual(taxesByGrid(db, { from: '2025-01-10', to: '2025-01-10' }).find((r) => r.id === tag.id), { id: tag.id, name: 'Grid', base: -2, tax: -0.2 });
  assert.deepEqual(taxesByGrid(db, { from: '2025-01-01', to: '2025-01-31' }).find((r) => r.id === tag.id), { id: tag.id, name: 'Grid', base: 98, tax: 9.8 });
});
