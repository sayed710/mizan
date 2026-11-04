import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { companySum, unratedCount } from './models/money.js';
import { invoiceKpis } from './dashboardKpis.js';
import { journalCards } from './models/finance.js';

const fixture = () => {
  const db = seed();
  const usd = db.records['res.currency'].find((c) => c.name === db.settings.currency).id;
  const foreign = db.records['res.currency'].find((c) => c.id !== usd).id;
  const journal = db.records['account.journal'].find((j) => j.code === 'INV').id;
  return { ...db, settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1, 2] }, records: { ...db.records,
    'res.company': [{ id: 1, name: 'Base', currency_id: usd }, { id: 2, name: 'Foreign', currency_id: foreign }],
    'res.currency': db.records['res.currency'].map((c) => c.id === foreign ? { ...c, rate_ids: [{ date: '2020-01-01', rate: 2 }, { date: '2030-01-01', rate: 4 }] } : c),
    'account.move': [
      { id: 900, invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }], move_type: 'out_invoice', state: 'posted', company_id: 1, currency_id: usd, invoice_date: '2026-01-01', amount_total: 100, amount_residual: 100, journal_id: journal },
      { id: 901, invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }], move_type: 'out_invoice', state: 'posted', company_id: 2, currency_id: foreign, invoice_date: '2026-01-01', amount_total: 100, amount_residual: 100, journal_id: journal },
    ],
  } };
};

test('mixed company totals use the active currency at the report date', () => {
  const db = fixture();
  assert.equal(companySum(db, db.records['account.move'], 'amount_total', '2029-01-01'), 150);
  assert.equal(companySum(db, db.records['account.move'], 'amount_total', '2030-01-01'), 125);
  const switched = { ...db, settings: { ...db.settings, current_company_id: 2 } };
  assert.equal(companySum(switched, switched.records['account.move'], 'amount_total', '2030-01-01'), 500);
});

test('missing reporting rates are counted in KPI and journal summaries, including company-own currency records', () => {
  const db = fixture();
  const broken = { ...db, records: { ...db.records, 'res.currency': db.records['res.currency'].map((c) => c.id === db.records['res.company'][1].currency_id ? { ...c, rate_ids: [] } : c) } };
  assert.equal(companySum(broken, broken.records['account.move'], 'amount_total'), 100);
  assert.equal(unratedCount(broken, broken.records['account.move']), 1);
  assert.equal(invoiceKpis(broken, '2026-01').unratedCount, 1);
  assert.equal(journalCards(broken).find((c) => c.journal.code === 'INV').unratedCount, 1);
});
