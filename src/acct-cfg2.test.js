import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { diffDb, applyDiff } from './sync.js';
import { aggregate } from './orm.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const { measuresOf, formatMeasure } = await import('./views/Graph.jsx');

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

test('CFG-3 document-currency fields are unavailable as aggregate measures in graph and pivot', () => {
  const def = models['account.invoice.report'];
  assert.equal(def.fields.price_subtotal_currency.groupOperator, false);
  assert.equal(def.fields.price_total_currency.groupOperator, false);

  const measureKeys = measuresOf('account.invoice.report').map(([k]) => k);
  assert.ok(!measureKeys.includes('price_subtotal_currency'), 'price_subtotal_currency must not be in graph/pivot measures');
  assert.ok(!measureKeys.includes('price_total_currency'), 'price_total_currency must not be in graph/pivot measures');

  // Standard measures remain available
  for (const expected of ['__count', 'quantity', 'price_subtotal', 'price_total', 'price_margin', 'inventory_value', 'price_average']) {
    assert.ok(measureKeys.includes(expected), `expected ${expected} in measures`);
  }

  // Aggregate returns null when a field opts out of grouping, preventing raw multi-currency sums
  const multiCurrencyRecords = [
    { price_subtotal_currency: 100, price_total_currency: 110, currency_id: 1 },
    { price_subtotal_currency: 200, price_total_currency: 220, currency_id: 2 },
  ];
  assert.equal(aggregate(multiCurrencyRecords, 'price_subtotal_currency', 'account.invoice.report'), null);
  assert.equal(aggregate(multiCurrencyRecords, 'price_total_currency', 'account.invoice.report'), null);
  assert.equal(formatMeasure('account.invoice.report', 'price_subtotal_currency', null), '—');

  // Fields remain available in the list view definition
  assert.ok(def.list.includes('price_subtotal_currency'));
  assert.ok(def.list.includes('price_total_currency'));
});

test('CFG-4 document-currency fields opt out of list footer and grouped totals', async () => {
  const def = models['account.invoice.report'];
  assert.equal(def.fields.price_subtotal_currency.sum, false, 'price_subtotal_currency must have sum: false');
  assert.equal(def.fields.price_total_currency.sum, false, 'price_total_currency must have sum: false');

  const { List, visibleListColumns } = await import('./views/List.jsx');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');

  const db = seed();
  const records = [
    {
      id: 991,
      move_id: 1,
      partner_id: 1,
      currency_id: 2,
      price_subtotal_currency: 100,
      price_total_currency: 110,
      price_subtotal: 200,
      price_total: 220,
    },
    {
      id: 992,
      move_id: 2,
      partner_id: 1,
      currency_id: 2,
      price_subtotal_currency: 300,
      price_total_currency: 330,
      price_subtotal: 600,
      price_total: 660,
    },
  ];

  const { cols } = visibleListColumns(def, db, {});
  const idxSubtotalCurr = cols.indexOf('price_subtotal_currency');
  const idxTotalCurr = cols.indexOf('price_total_currency');
  const idxSubtotal = cols.indexOf('price_subtotal');
  const idxTotal = cols.indexOf('price_total');

  assert.ok(idxSubtotalCurr >= 0, 'price_subtotal_currency must be visible in list');
  assert.ok(idxTotalCurr >= 0, 'price_total_currency must be visible in list');
  assert.ok(idxSubtotal >= 0, 'price_subtotal must be visible in list');
  assert.ok(idxTotal >= 0, 'price_total must be visible in list');

  // 1. Footer totals
  const footerHtml = renderToStaticMarkup(createElement(List, {
    db,
    model: 'account.invoice.report',
    records,
    open: () => {},
    selected: new Set(),
    setSelected: () => {},
    groupBy: [],
  }));

  const tfootMatch = footerHtml.match(/<tfoot>[\s\S]*?<\/tfoot>/);
  assert.ok(tfootMatch, 'tfoot must be rendered');
  const footerTds = [...tfootMatch[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  assert.equal(footerTds[idxSubtotalCurr + 1], '', 'price_subtotal_currency must not have footer sum');
  assert.equal(footerTds[idxTotalCurr + 1], '', 'price_total_currency must not have footer sum');
  assert.notEqual(footerTds[idxSubtotal + 1], '', 'price_subtotal must have footer sum');
  assert.notEqual(footerTds[idxTotal + 1], '', 'price_total must have footer sum');

  // 2. Grouped row totals
  const groupedHtml = renderToStaticMarkup(createElement(List, {
    db,
    model: 'account.invoice.report',
    records,
    open: () => {},
    selected: new Set(),
    setSelected: () => {},
    groupBy: ['partner_id'],
  }));

  const groupRowMatch = groupedHtml.match(/<tr[^>]*class="group-row"[^>]*>[\s\S]*?<\/tr>/);
  assert.ok(groupRowMatch, 'group-row must be rendered');
  const groupTds = [...groupRowMatch[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  assert.equal(groupTds[idxSubtotalCurr], '', 'price_subtotal_currency must not have group sum');
  assert.equal(groupTds[idxTotalCurr], '', 'price_total_currency must not have group sum');
  assert.notEqual(groupTds[idxSubtotal], '', 'price_subtotal must have group sum');
  assert.notEqual(groupTds[idxTotal], '', 'price_total must have group sum');
});
