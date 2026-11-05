import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { trialBalance, partnerLedger, cashflowAnalysis } from './models/reports.js';
import { agedBalance, followUps } from './models/finance.js';

function twoCompanies() {
  const db = seed();
  const receivable = db.records['account.account'].find((a) => a.account_type === 'asset_receivable');
  const partner = db.records['res.partner'][0];
  const invoice = (id, company_id, amount, date) => ({ id, company_id, state: 'posted', move_type: 'out_invoice', date, invoice_date: date, invoice_date_due: date, partner_id: partner.id, amount_total: amount, amount_residual: amount, invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: amount, tax: 0 }], line_ids: [{ account_id: receivable.id, partner_id: partner.id, debit: amount, credit: 0 }] });
  const journal = (id, company_id) => ({ id, company_id, name: `Bank ${id}`, type: 'bank' });
  return { ...db, records: { ...db.records,
    'res.company': [...db.records['res.company'], { id: 9999, name: 'Second', currency_id: db.records['res.company'][0].currency_id }],
    'account.move': [invoice(9001, 1, 10000, '2025-01-01'), invoice(9002, 9999, 5000, '2025-01-01'), invoice(9003, 1, 1000, '2024-01-01'), invoice(9004, 9999, 2000, '2024-01-01')],
    'account.payment': [],
    'account.journal': [...db.records['account.journal'], journal(9001, 1), journal(9002, 9999)],
    'account.bank.statement.line': [{ id: 9001, company_id: 1, journal_id: 9001, date: '2025-01-10', amount: 50000 }, { id: 9002, company_id: 9999, journal_id: 9002, date: '2025-01-10', amount: 30000 }],
  } };
}

test('financial reports isolate opening, period, partner and cash movements by company', () => {
  const db = twoCompanies();
  const period = { from: '2025-01-01', to: '2025-01-31', company_id: 9999 };
  const trial = trialBalance(db, period);
  assert.equal(trial.totals.initial, 2000);
  assert.equal(trial.totals.debit, 5000);
  const [ledger] = partnerLedger(db, period);
  assert.equal(ledger.initial, 2000);
  assert.equal(ledger.debit, 5000);
  assert.equal(cashflowAnalysis(db, period).rows[0].inflow, 30000);
});

test('aged reports isolate shared contacts by company', () => {
  const db = twoCompanies();
  assert.equal(agedBalance(db, 'receivable', '2025-02-01', 1).rows[0].total, 11000);
  assert.equal(agedBalance(db, 'receivable', '2025-02-01', 9999).rows[0].total, 7000);
});

test('follow-ups filter shared contacts by company', () => {
  const db = twoCompanies();
  assert.equal(followUps(db, '2025-02-01', { companyId: 1 })[0].total, 11000);
  assert.equal(followUps(db, '2025-02-01', { companyId: 9999 })[0].total, 7000);
});
