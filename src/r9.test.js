import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { agedBalance } from './models/finance.js';
import { partnerLedger } from './models/reports.js';

const db = { records: {
  'res.company': [{ id: 1, currency_id: 1 }],
  'res.currency': [{ id: 1, name: 'USD', rounding: 0.01 }],
  'account.account': [{ id: 1, account_type: 'asset_receivable', code: '1' }],
  'res.partner': [{ id: 1, name: 'Partner' }],
  'account.move': [{ id: 7, name: 'Invoice', state: 'posted', move_type: 'out_invoice', partner_id: 1, invoice_date: '2025-01-01', invoice_date_due: '2025-01-10', line_ids: [{ account_id: 1, partner_id: 1, debit: 100, date_maturity: '2025-01-10' }] }],
  'account.payment': [],
}, settings: { base_currency_id: 1 } };

test('aged balances expose invoice bucket details at the cutoff', () => {
  const row = agedBalance(db, 'receivable', '2025-02-15').rows[0];
  assert.equal(row['31_60'], 100);
  assert.equal(row.invoices[0].move_id, 7);
  assert.equal(row.invoices[0]['31_60'], 100);
});

test('partner ledger detail retains its journal entry id', () => {
  const row = partnerLedger(db, { from: '2025-01-01', to: '2025-12-31' })[0];
  assert.equal(row.lines[0].move_id, 7);
});
