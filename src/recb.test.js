import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { accountId } from './models/ledger.js';
import { postMove, payMove } from './models/accounting.js';
import { cashFlow } from './models/reports.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;

test('4. an inbound batch posts its payments to the selected bank journal', () => {
  let db = seed();
  const bank2 = create(db, 'account.account', { code: '101499', name: 'Second bank', account_type: 'asset_cash' });
  const journal = create(bank2.db, 'account.journal', { code: 'BNK2', name: 'Second Bank', type: 'bank', default_account_id: bank2.id });
  const inv = create(journal.db, 'account.move', { move_type: 'out_invoice', partner_id: 3, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = run(inv.db, 'account.move', inv.id, 'Confirm');
  const batch = create(db, 'account.batch.payment', { batch_type: 'inbound', journal_id: journal.id, lines: [{ move_id: inv.id, amount: 100 }] });
  db = run(batch.db, 'account.batch.payment', batch.id, 'Validate');
  const payment = search(db, 'account.payment').find((p) => p.id === read(db, 'account.batch.payment', batch.id).lines[0].payment_id);
  assert.equal(payment.journal_id, journal.id);
});

/** A foreign fixed-asset sale booked at rate 2 and paid in full at rate 1 realizes an exchange gain. */
const fxFlow = (configure) => {
  let db = seed();
  const fx = create(db, 'res.currency', { name: 'RECBFX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-01-02', rate: 1 }] });
  db = configure(fx.db);
  const m = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_date_due: '2026-01-01', currency_id: fx.id, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0, account_id: accountId(db, '151000') }] });
  db = payMove(postMove(m.db, m.id), m.id, 100, '2026-01-02');
  const flow = cashFlow(db, { from: '2026-01-02', to: '2026-01-02' });
  return [flow.investing, flow.operating, flow.net];
};

test('6. cash-flow exchange reclassification follows the configured exchange accounts, not their codes', () => {
  const standard = fxFlow((db) => db);
  const custom = fxFlow((db) => {
    const gain = create(db, 'account.account', { code: '459900', name: 'Custom FX gain', account_type: 'income_other' });
    const loss = create(gain.db, 'account.account', { code: '699900', name: 'Custom FX loss', account_type: 'expense_other' });
    return write(loss.db, 'res.company', 1, { income_currency_exchange_account_id: gain.id, expense_currency_exchange_account_id: loss.id });
  });
  assert.deepEqual(custom, standard);
});
