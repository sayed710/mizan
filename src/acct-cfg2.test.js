import test from 'node:test';
import assert from 'node:assert/strict';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { diffDb, applyDiff } from './sync.js';

test('CFG-1 invoice analysis defaults follow the Odoo 20 report view', () => {
  const def = models['account.invoice.report'];
  assert.deepEqual(def.pivot, { row: 'invoice_date', col: 'product_categ_id', measure: 'price_subtotal' });
  assert.deepEqual(def.graph, { groupBy: 'product_categ_id', measure: 'price_subtotal' });
  assert.deepEqual(def.list, ['move_id', 'journal_id', 'partner_id', 'country_id', 'invoice_date', 'invoice_date_due', 'invoice_user_id', 'product_categ_id', 'product_id', 'company_id', 'price_average', 'quantity', 'price_subtotal_currency', 'price_subtotal', 'price_total', 'price_total_currency', 'price_margin', 'inventory_value', 'state', 'payment_state', 'move_type']);
  for (const field of ['partner_id', 'invoice_date', 'invoice_date_due', 'product_id', 'price_subtotal_currency', 'price_subtotal', 'price_total', 'price_total_currency']) assert.equal(def.fields[field].optional, 'show');
  for (const field of ['journal_id', 'country_id', 'invoice_user_id', 'product_categ_id', 'price_average', 'quantity', 'price_margin', 'inventory_value', 'state', 'payment_state', 'move_type']) assert.equal(def.fields[field].optional, 'hide');
});

test('CFG-2 account code constraint is enforced through server diffs', () => {
  const db = seed();
  const account = db.records['account.account'][0];
  const staged = (code) => ({ ...db, records: { ...db.records, 'account.account': db.records['account.account'].map((a) => a.id === account.id ? { ...a, code } : a) } });
  const sync = (code) => applyDiff(db, diffDb(db, staged(code)), { isAdmin: true });
  assert.doesNotThrow(() => sync('Ab9.-Z'));
  for (const code of ['bad_code', 'bad code', 'é', '1/2', '1\n']) {
    assert.throws(() => sync(code), (error) => error.message === `The account code can only contain alphanumeric characters, dots, and dashes. (account code: ${code})`);
  }
});
