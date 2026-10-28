import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { companyAmount, companySum, currencyCode } from './models/money.js';
import { journalCards } from './models/finance.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';

const sarInvoice = () => {
  const db0 = seed();
  const sar = search(db0, 'res.currency').find((c) => c.name === 'SAR');
  const journal_id = search(db0, 'account.journal').find((j) => j.code === 'INV').id;
  const { db, id } = create(db0, 'account.move', {
    journal_id, move_type: 'out_invoice', state: 'draft', partner_id: 3, currency_id: sar.id, invoice_date: '2026-10-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 37500, discount: 0, tax: 0 }],
  });
  return { db: postMove(db, id), id, sar };
};

test('a foreign-currency document reports its own currency code', () => {
  const { db, id } = sarInvoice();
  const inv = search(db, 'account.move').find((m) => m.id === id);
  assert.equal(currencyCode(db, inv), 'SAR');
  assert.equal(currencyCode(db, search(db, 'account.move').find((m) => !m.currency_id)), null);
});

test('sums convert foreign documents to the company currency: SAR 37,500 counts as 10,000', () => {
  const { db, id } = sarInvoice();
  const inv = search(db, 'account.move').find((m) => m.id === id);
  assert.equal(companyAmount(db, inv, 'amount_total'), 10000);
  const others = search(db, 'account.move').filter((m) => m.move_type === 'out_invoice' && m.state === 'posted' && m.id !== id);
  assert.equal(companySum(db, [...others, inv], 'amount_residual'), Math.round((companySum(db, others, 'amount_residual') + 10000) * 100) / 100);
});

test('the sales journal card adds the SAR invoice at its company value', () => {
  const { db: db0 } = sarInvoice();
  const before = journalCards(seed()).find((c) => c.kind === 'sale' && c.journal.code === 'INV').unpaidAmount;
  const after = journalCards(db0).find((c) => c.kind === 'sale' && c.journal.code === 'INV').unpaidAmount;
  assert.equal(Math.round((after - before) * 100) / 100, 10000);
});

import { unratedCount } from './models/money.js';

test('a document in the company\'s own currency is never revalued, even when that currency carries a rate', () => {
  const { db, id, sar } = sarInvoice();
  const rated = { ...db, records: { ...db.records, 'res.currency': db.records['res.currency'].map((c) => (c.id === sar.id ? { ...c, rate_ids: [{ date: '2020-01-01', rate: 0.9 }] } : c)) } };
  const company = { ...rated, records: { ...rated.records, 'res.company': [{ id: 1, name: 'Co', currency_id: sar.id }] } };
  const move = read(company, 'account.move', id);
  assert.equal(companyAmount(company, move, 'amount_total'), 37500);
});

test('a currency with no rate is counted as unconverted, not as 1:1', () => {
  const { db, id, sar } = sarInvoice();
  const bare = { ...db, records: { ...db.records, 'res.currency': db.records['res.currency'].map((c) => (c.id === sar.id ? { ...c, rate_ids: [] } : c)) } };
  const move = read(bare, 'account.move', id);
  assert.equal(companyAmount(bare, move, 'amount_total'), 0);
  assert.equal(companySum(bare, [move], 'amount_total'), 0);
  assert.equal(unratedCount(bare, [move]), 1);
});
