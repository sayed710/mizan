import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { ACCOUNTING_CONFIG, modelsForApps, readOnlyForApps } from './models/index.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';

const userOf = (apps) => ({ author: 'User', isAdmin: false, allowed: modelsForApps(apps), readOnly: readOnlyForApps(apps) });

test('users outside Accounting can read but not change accounts, taxes, journals and fiscal settings (ACC-009)', () => {
  const db = seed();
  const sales = userOf(['sales']);
  const receivable = search(db, 'account.account').find((a) => a.code === '121000');
  const vat = search(db, 'account.tax').find((t) => t.name === 'VAT 14%');
  const retyped = write(db, 'account.account', receivable.id, { account_type: 'income' });
  assert.throws(() => applyDiff(db, diffDb(db, retyped), sales), /Only Accounting users can change/);
  const zeroed = write(db, 'account.tax', vat.id, { amount: 0 });
  assert.throws(() => applyDiff(db, diffDb(db, zeroed), sales), /Only Accounting users can change/);
  assert.throws(() => applyDiff(db, { upserts: {}, deletes: { 'account.account': [receivable.id] } }, sales), /Only Accounting users can change/);
});

test('Accounting users and admins still maintain the configuration', () => {
  const db = seed();
  const vat = search(db, 'account.tax').find((t) => t.name === 'VAT 14%');
  const changed = write(db, 'account.tax', vat.id, { name: 'VAT 14% (standard)' });
  assert.equal(read(applyDiff(db, diffDb(db, changed), userOf(['accounting'])), 'account.tax', vat.id).name, 'VAT 14% (standard)');
  assert.equal(readOnlyForApps(['accounting', 'sales']), null);
  assert.equal(read(applyDiff(db, diffDb(db, changed), { author: 'Admin', isAdmin: true }), 'account.tax', vat.id).name, 'VAT 14% (standard)');
});

test('a sales-only user still creates quotations that use taxes and accounts', () => {
  const db = seed();
  const vat = search(db, 'account.tax').find((t) => t.name === 'VAT 14%');
  const { db: next } = create(db, 'sale.order', { partner_id: 3, order_line: [{ product_id: 1, qty: 1, price_unit: 10, tax_id: vat.id, tax: 14 }] });
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, next), userOf(['sales'])));
});
