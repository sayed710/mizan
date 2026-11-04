import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create } from './orm.js';
import { seed } from './seed.js';
import { postMove, payMove } from './models/accounting.js';
import { agedBalance } from './models/finance.js';

test('partial payments consume oldest-due installments first for customer and vendor in separate companies', () => {
  const base = seed();
  const branch = createCompanyWithDefaultInvoiceJournals(base, { name: 'Settlement branch', currency_id: base.records['res.company'][0].currency_id });
  const term = create(branch.db, 'account.payment.term', { name: 'Later first', line_ids: [
    { value_type: 'percent', value: 70, nb_days: 30, delay_type: 'days_after' },
    { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
  ] });
  let db = term.db;
  for (const [type, kind, companyId] of [['out_invoice', 'receivable', 1], ['in_invoice', 'payable', branch.id]]) {
    const partner = create(db, 'res.partner', { name: `${kind} settlement` });
    const invoice = create(partner.db, 'account.move', { move_type: type, company_id: companyId, partner_id: partner.id, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
    db = postMove(invoice.db, invoice.id);
    db = payMove(db, invoice.id, 20, '2026-01-10');
    db = payMove(db, invoice.id, 20, '2026-01-20');
    const row = (date) => agedBalance(db, kind, date).rows.find((entry) => entry.partner_id === partner.id);
    assert.deepEqual([row('2026-01-09')['1_30'], row('2026-01-09').current, row('2026-01-09').total], [30, 70, 100]);
    assert.deepEqual([row('2026-01-15')['1_30'], row('2026-01-15').current, row('2026-01-15').total], [10, 70, 80]);
    assert.deepEqual([row('2026-01-25')['1_30'], row('2026-01-25').current, row('2026-01-25').total], [0, 60, 60]);
    assert.deepEqual([row('2026-02-15')['1_30'], row('2026-02-15').total], [60, 60]);
  }
});
