import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { aggregate, applyFilters, create, groupRecords, search } from './orm.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { find, setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

async function rendered(React, container, needle) {
  for (let i = 0; i < 30 && !textOf(container).includes(needle); i++) {
    await React.act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  assert.ok(textOf(container).includes(needle), `expected "${needle}" in rendered output`);
}

function mountDom(hash) {
  const { makeEl } = setupDom();
  const target = new EventTarget();
  globalThis.window = Object.assign(target, {
    HTMLIFrameElement: class {},
    scrollTo() {},
    document: globalThis.document,
    location: { hash },
  });
  globalThis.document.createElementNS = (_, tag) => makeEl(tag);
  globalThis.location = globalThis.window.location;
  const container = makeEl('div');
  container.ownerDocument = globalThis.document;
  return container;
}

function buildFixture() {
  let db = seed();
  const baseCurrId = db.records['res.company'][0].currency_id;
  const prod = create(db, 'product', { name: 'Desk Lamp', type: 'goods', list_price: 200, standard_price: 80 });
  db = prod.db;
  const partnerEgypt = create(db, 'res.partner', { name: 'Nile Buyer', is_company: true, country: 'Egypt' });
  db = partnerEgypt.db;
  const partnerGermany = create(db, 'res.partner', { name: 'Berlin GmbH', is_company: true, country: 'Germany' });
  db = partnerGermany.db;
  const partnerNoCountryNull = create(db, 'res.partner', { name: 'Stateless Partner', is_company: true, country: null });
  db = partnerNoCountryNull.db;
  const partnerNoCountryEmpty = create(db, 'res.partner', { name: 'Empty Country Partner', is_company: true, country: '' });
  db = partnerNoCountryEmpty.db;

  const saleJournal = db.records['account.journal'].find((j) => j.type === 'sale' && (!j.company_id || j.company_id === 1));
  const purchaseJournal = db.records['account.journal'].find((j) => j.type === 'purchase' && (!j.company_id || j.company_id === 1));
  const incomeAcc = db.records['account.account'].find((a) => a.account_type === 'income' && (!a.company_id || a.company_id === 1));
  const expenseAcc = db.records['account.account'].find((a) => a.account_type === 'expense' && (!a.company_id || a.company_id === 1));

  const extraSaleJournal = create(db, 'account.journal', {
    name: 'Export Sales',
    code: 'EXPS',
    type: 'sale',
    company_id: 1,
    default_account_id: incomeAcc.id,
    invoice_sequence_prefix: 'EXPS/',
    invoice_sequence_next_number: 1,
    refund_sequence_prefix: 'REXPS/',
    refund_sequence_next_number: 1,
  });
  db = extraSaleJournal.db;

  const fpExport = create(db, 'account.fiscal.position', { name: 'EU Export', company_id: 1, auto_apply: false });
  db = fpExport.db;

  // 1) Posted customer invoice (Egypt, default saleJournal, no fiscal position)
  const outInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerEgypt.id,
    journal_id: saleJournal.id,
    fiscal_position_id: null,
    invoice_date: '2026-04-01',
    currency_id: baseCurrId,
    invoice_line_ids: [{ product_id: prod.id, qty: 2, price_unit: 200, tax: 14, account_id: incomeAcc.id }],
  });
  db = postMove(outInv.db, outInv.id);

  // 2) Posted customer credit note (Germany, extraSaleJournal, EU Export fiscal position)
  const outRef = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: partnerGermany.id,
    journal_id: extraSaleJournal.id,
    fiscal_position_id: fpExport.id,
    invoice_date: '2026-04-02',
    currency_id: baseCurrId,
    invoice_line_ids: [{ product_id: prod.id, qty: 1, price_unit: 100, tax: 0, account_id: incomeAcc.id }],
  });
  db = postMove(outRef.db, outRef.id);

  // 3) Posted vendor bill (partner without country = null, purchaseJournal, no fiscal position)
  const inInv = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partnerNoCountryNull.id,
    journal_id: purchaseJournal.id,
    fiscal_position_id: null,
    invoice_date: '2026-04-03',
    currency_id: baseCurrId,
    invoice_line_ids: [{ product_id: prod.id, qty: 3, price_unit: 80, tax: 0, account_id: expenseAcc.id }],
  });
  db = postMove(inInv.db, inInv.id);

  // 4) Posted vendor credit note (partner with country = '', purchaseJournal, EU Export fiscal position)
  const inRef = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: partnerNoCountryEmpty.id,
    journal_id: purchaseJournal.id,
    fiscal_position_id: fpExport.id,
    invoice_date: '2026-04-04',
    currency_id: baseCurrId,
    invoice_line_ids: [{ product_id: prod.id, qty: 1, price_unit: 50, tax: 0, account_id: expenseAcc.id }],
  });
  db = postMove(inRef.db, inRef.id);

  // 5) Draft customer credit note (for AND-ing state filter with move type filter)
  const draftOutRef = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: partnerEgypt.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-04-05',
    currency_id: baseCurrId,
    invoice_line_ids: [{ product_id: prod.id, qty: 1, price_unit: 75, tax: 0, account_id: incomeAcc.id }],
  });
  db = draftOutRef.db;

  const ids = {
    outInv: outInv.id,
    outRef: outRef.id,
    inInv: inInv.id,
    inRef: inRef.id,
    draftOutRef: draftOutRef.id,
  };
  const cleanDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].filter((m) => Object.values(ids).includes(m.id)),
    },
  };
  return {
    db: cleanDb,
    ids,
    saleJournal,
    extraSaleJournal: extraSaleJournal.id,
    purchaseJournal,
    fpExport: fpExport.id,
  };
}

test('IAN-1: account.invoice.report includes country_id, journal_id, fiscal_position_id in groupBys with accurate group totals and None bucket', async () => {
  const def = models['account.invoice.report'];
  for (const field of ['country_id', 'journal_id', 'fiscal_position_id']) {
    assert.ok(def.groupBys.includes(field), `expected ${field} in account.invoice.report.groupBys`);
  }

  const { db, saleJournal, extraSaleJournal, purchaseJournal, fpExport } = buildFixture();
  const postedRows = applyFilters('account.invoice.report', search(db, 'account.invoice.report'), ['posted'], db);
  assert.equal(postedRows.length, 4);

  // Group by country_id: Egypt (+400), Germany (-100), None (-240 + 50 = -190, combining null & '')
  const byCountry = groupRecords(db, 'account.invoice.report', postedRows, 'country_id');
  assert.deepEqual(byCountry.map((g) => g.label), ['Egypt', 'Germany', 'None']);
  assert.equal(aggregate(byCountry[0].records, 'price_subtotal', 'account.invoice.report'), 400);
  assert.equal(aggregate(byCountry[0].records, 'price_total', 'account.invoice.report'), 456);
  assert.equal(aggregate(byCountry[1].records, 'price_subtotal', 'account.invoice.report'), -100);
  assert.equal(aggregate(byCountry[2].records, 'price_subtotal', 'account.invoice.report'), -190);
  assert.equal(byCountry[2].records.length, 2);

  // Group by journal_id
  const byJournal = groupRecords(db, 'account.invoice.report', postedRows, 'journal_id');
  const sumByJournal = new Map(byJournal.map((g) => [g.key, aggregate(g.records, 'price_subtotal', 'account.invoice.report')]));
  assert.equal(sumByJournal.get(saleJournal.id), 400);
  assert.equal(sumByJournal.get(extraSaleJournal), -100);
  assert.equal(sumByJournal.get(purchaseJournal.id), -190);

  // Group by fiscal_position_id (rows without fiscal_position_id fall into None: +400 - 240 = +160)
  const byFp = groupRecords(db, 'account.invoice.report', postedRows, 'fiscal_position_id');
  assert.deepEqual(byFp.map((g) => g.label), ['EU Export', 'None']);
  assert.equal(byFp[0].key, fpExport);
  assert.equal(aggregate(byFp[0].records, 'price_subtotal', 'account.invoice.report'), -50);
  assert.equal(aggregate(byFp[1].records, 'price_subtotal', 'account.invoice.report'), 160);

  // UI: Group By menu in ControlPanel and Pivot selectors offer Country, Journal, and Fiscal Position
  const container = mountDom('#/accounting/invoice-analysis');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(db));

  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'Invoice Analysis');

    for (const label of ['Country', 'Journal', 'Fiscal Position']) {
      assert.ok(
        find(container, (n) => n.tagName === 'OPTION' && textOf(n) === label),
        `expected Pivot selector option ${label}`,
      );
    }

    const toggle = find(container, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    assert.ok(toggle);
    await React.act(async () => props(toggle).onClick());

    const groupBySection = find(container, (n) => n.tagName === 'SECTION' && textOf(n).includes('Group By'));
    assert.ok(groupBySection);
    for (const label of ['Country', 'Journal', 'Fiscal Position']) {
      assert.ok(
        find(groupBySection, (n) => n.tagName === 'BUTTON' && textOf(n) === label),
        `expected Group By menu button ${label}`,
      );
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('IAN-2: account.invoice.report offers Move Type filter group and filters all four move_type values accurately', async () => {
  const { db, ids } = buildFixture();
  const rows = search(db, 'account.invoice.report');
  const def = models['account.invoice.report'];

  const expectedLabels = ['Customer Invoices', 'Customer Credit Notes', 'Vendor Bills', 'Vendor Credit Notes'];
  const moveTypeGroup = def.filters.find((group) => expectedLabels.every((label) => group.some((f) => f.label === label)));
  assert.ok(moveTypeGroup, 'expected a Move Type filter group with all four move_type labels');
  assert.equal(moveTypeGroup.length, 4);

  const byLabel = Object.fromEntries(moveTypeGroup.map((f) => [f.label, f.id]));

  // Single-filter assertions across all rows (including draft)
  assert.deepEqual(
    applyFilters('account.invoice.report', rows, [byLabel['Customer Invoices']], db).map((r) => r.move_id),
    [ids.outInv],
  );
  assert.deepEqual(
    applyFilters('account.invoice.report', rows, [byLabel['Customer Credit Notes']], db).map((r) => r.move_id).sort((a, b) => a - b),
    [ids.outRef, ids.draftOutRef].sort((a, b) => a - b),
  );
  assert.deepEqual(
    applyFilters('account.invoice.report', rows, [byLabel['Vendor Bills']], db).map((r) => r.move_id),
    [ids.inInv],
  );
  assert.deepEqual(
    applyFilters('account.invoice.report', rows, [byLabel['Vendor Credit Notes']], db).map((r) => r.move_id),
    [ids.inRef],
  );

  // Same-group OR semantics and cross-group AND semantics
  assert.deepEqual(
    applyFilters('account.invoice.report', rows, ['posted', byLabel['Customer Credit Notes']], db).map((r) => r.move_id),
    [ids.outRef],
  );
  assert.deepEqual(
    applyFilters('account.invoice.report', rows, ['posted', byLabel['Customer Invoices'], byLabel['Vendor Credit Notes']], db)
      .map((r) => r.move_id)
      .sort((a, b) => a - b),
    [ids.outInv, ids.inRef].sort((a, b) => a - b),
  );

  // UI: SearchPanel renders all four Move Type filters and Arabic translations exist
  const container = mountDom('#/accounting/invoice-analysis');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(db));

  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'Invoice Analysis');
    const toggle = find(container, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    assert.ok(toggle);
    await React.act(async () => props(toggle).onClick());

    const filtersSection = find(container, (n) => n.tagName === 'SECTION' && textOf(n).includes('Filters'));
    assert.ok(filtersSection);
    for (const label of expectedLabels) {
      assert.ok(
        find(filtersSection, (n) => n.tagName === 'BUTTON' && textOf(n) === label),
        `expected filter button ${label}`,
      );
    }
  } finally {
    await React.act(async () => root.unmount());
  }

  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-ian1');
    for (const label of [...expectedLabels, 'Country', 'Journal', 'Fiscal Position', 'None']) {
      assert.notEqual(t(label), label, `missing Arabic translation for ${label}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('IAN-3: account.invoice.report exact groupBys array matches Odoo 20 search view ordering including country_id, journal_id, and fiscal_position_id', () => {
  const def = models['account.invoice.report'];
  assert.deepEqual(def.groupBys, [
    'invoice_user_id',
    'partner_id',
    'country_id',
    'product_id',
    'product_categ_id',
    'journal_id',
    'fiscal_position_id',
    'state',
    'company_id',
    'invoice_date',
  ]);
});

