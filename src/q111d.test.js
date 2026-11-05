import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

import { create, read, search, write } from './orm.js';
import { createCompany, ensureCurrencyRecord } from './models/company.js';
import { models } from './models/index.js';
import { payMove, postMove, residual } from './models/accounting.js';
import { today } from './models/common.js';
import { migrate } from './migrations.js';
import { seed } from './seed.js';
import { publicSite } from '../server/api.js';

test('Qodo 1: publicSite handles an unresolved company currency without failing', () => {
  const base = seed();
  const legacyDb = {
    ...base,
    schema_version: 35,
    settings: { ...base.settings, currency: 'UNKNOWN_LEGACY_CODE', companies: [{ id: 1, name: 'Unresolved Co', currency: 'UNKNOWN_LEGACY_CODE' }] },
    records: {
      ...base.records,
      'res.company': base.records['res.company'].map((c) => ({ ...c, currency_id: null })),
    },
  };
  const migrated = migrate(legacyDb);
  assert.equal(read(migrated, 'res.company', 1).currency_id, null);
  const site = publicSite(migrated);
  assert.equal(site.currency, null);
  assert.ok(Array.isArray(site.pages));
  assert.ok(Array.isArray(site.products));
});

test('Qodo 3: switching to a company with unresolved currency shows explicit unconfigured state instead of USD amounts', async () => {
  const { initStore, commit, getDb, switchCompany } = await import('./store.js');
  const { money } = await import('./ui.jsx');
  const base = seed();
  const co2 = { id: 2, name: 'Unconfigured Currency Co', currency_id: null };
  const db = {
    ...base,
    records: {
      ...base.records,
      'res.company': [...base.records['res.company'], co2],
    },
  };
  await initStore();
  await commit(db);
  switchCompany(2);
  const formatted = money(100);
  assert.ok(!formatted.includes('$'), `Should not contain USD dollar sign, got: ${formatted}`);
  assert.ok(!formatted.includes('USD'), `Should not contain USD code, got: ${formatted}`);
  assert.match(formatted, /currency not configured/i, 'Should explicitly indicate currency is not configured');

  const { display } = await import('./ui.jsx');
  const displayed = display(getDb(), { type: 'monetary' }, 100);
  assert.ok(!displayed.includes('$'), `Display should not contain USD dollar sign, got: ${displayed}`);
  assert.ok(!displayed.includes('USD'), `Display should not contain USD code, got: ${displayed}`);
  assert.match(displayed, /currency not configured/i, 'Display should indicate currency is not configured');
});

test('Qodo 4: adding a company with a selected currency succeeds when main company currency is unset', () => {
  const base = seed();
  let db = write(base, 'res.company', 1, { currency_id: null });
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency exists in seed');

  const created = createCompany(db, { name: 'Branch EUR', currency_id: eur.id });
  assert.ok(created.id);
  const newCompany = read(created.db, 'res.company', created.id);
  assert.equal(newCompany.name, 'Branch EUR');
  assert.equal(newCompany.currency_id, eur.id);

  const resolved = ensureCurrencyRecord(db, 'EUR');
  assert.equal(resolved.id, eur.id);
  const withResolved = createCompany(resolved.db, { name: 'Branch EUR 2', currency_id: resolved.id });
  assert.equal(read(withResolved.db, 'res.company', withResolved.id).currency_id, eur.id);
});

test('Qodo 5: an invoice whose company currency is unresolved shows an unavailable payment state instead of partial', () => {
  let db = seed();
  // 1. Fully settled invoice
  const { db: createdDb, id } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(createdDb, id);
  db = payMove(db, id, 100, today());
  const settled = read(db, 'account.move', id);
  assert.equal(settled.payment_state, 'paid');

  // 2. Partially paid invoice
  const { db: partCreatedDb, id: partId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(partCreatedDb, partId);
  db = payMove(db, partId, 40, today());
  const partial = read(db, 'account.move', partId);
  assert.equal(partial.payment_state, 'partial');

  // 3. Unpaid invoice
  const { db: unpaidCreatedDb, id: unpaidId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(unpaidCreatedDb, unpaidId);
  const unpaid = read(db, 'account.move', unpaidId);
  assert.equal(unpaid.payment_state, 'not_paid');

  // Now simulate company currency becoming unresolved (e.g. migration 36)
  const unconfiguredDb = write(db, 'res.company', settled.company_id ?? 1, { currency_id: null });
  assert.equal(residual(settled, unconfiguredDb), null);
  assert.equal(residual(partial, unconfiguredDb), null);
  assert.equal(residual(unpaid, unconfiguredDb), null);

  // The open amount is unknown without a currency, so no invoice is shown as paid, partial or unpaid
  for (const move of [settled, partial, unpaid]) {
    assert.equal(models['account.move'].fields.payment_state.compute(move, unconfiguredDb), 'unavailable');
  }
});
