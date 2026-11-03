import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { createCompany } from './models/company.js';
import { agedBalance, followUps, followUpCompanies } from './models/finance.js';

test('posted installments drive aging and company follow-ups even after payment terms change', () => {
  const base = seed();
  const company = createCompany(base, { name: 'Branch', currency_id: base.records['res.company'][0].currency_id });
  const partner = create(company.db, 'res.partner', { name: 'Installment customer' });
  const term = create(partner.db, 'account.payment.term', { name: '30 now, 70 later', line_ids: [
    { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 70, nb_days: 30, delay_type: 'days_after' },
  ] });
  let db = term.db;
  for (const [type, companyId] of [['out_invoice', 1], ['in_invoice', company.id]]) {
    const move = create(db, 'account.move', { move_type: type, company_id: companyId, partner_id: partner.id, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100.01, tax: 0 }] });
    db = postMove(move.db, move.id);
    const accountType = type === 'out_invoice' ? 'asset_receivable' : 'liability_payable';
    const items = read(db, 'account.move', move.id).line_ids.filter((l) => read(db, 'account.account', l.account_id)?.account_type === accountType);
    assert.deepEqual(items.map((l) => [l.date_maturity, l.debit || l.credit]), [['2026-01-01', 30], ['2026-01-31', 70.01]]);
  }
  db = write(db, 'account.payment.term', term.id, { line_ids: [{ value_type: 'percent', value: 100, nb_days: 90, delay_type: 'days_after' }] });
  for (const kind of ['receivable', 'payable']) {
    const row = agedBalance(db, kind, '2026-01-15').rows.find((r) => r.partner_id === partner.id);
    assert.deepEqual([row['1_30'], row.current, row.total], [30, 70.01, 100.01]);
  }
  const reminder = followUps(db, '2026-01-15').find((f) => f.partner_id === partner.id);
  assert.ok(reminder);
  const [group] = followUpCompanies(reminder);
  assert.equal(group.company_id, 1);
  assert.equal(group.oldest, '2026-01-01');
  assert.equal(group.total, 30);
});
