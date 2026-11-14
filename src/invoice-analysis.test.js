import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { aggregate, applyFilters, create, groupRecords, read, search, unlink, updateSettings, write } from './orm.js';
import { apps, leavesOf, models, viewsOf } from './models/index.js';
import { postMove } from './models/accounting.js';
import { profitAndLoss } from './models/ledger.js';
import { createCompany } from './models/company.js';
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

function buildInvoiceAnalysisFixture() {
  let db = seed();
  const baseCurrId = db.records['res.company'][0].currency_id;

  const categA = create(db, 'product.category', { name: 'Hardware' });
  db = categA.db;
  const categB = create(db, 'product.category', { name: 'Services' });
  db = categB.db;

  const prodA = create(db, 'product', { name: 'Laptop', type: 'goods', categ_id: categA.id, list_price: 500, standard_price: 300 });
  db = prodA.db;
  const prodB = create(db, 'product', { name: 'Consulting', type: 'service', categ_id: categB.id, list_price: 100, standard_price: 0 });
  db = prodB.db;

  const parentPartner = create(db, 'res.partner', { name: 'Acme Corp', is_company: true, country: 'Egypt' });
  db = parentPartner.db;
  const childPartner = create(db, 'res.partner', { name: 'Acme Contact', is_company: false, parent_id: parentPartner.id, country: 'Egypt' });
  db = childPartner.db;
  const vendor = create(db, 'res.partner', { name: 'Supplier Co', is_company: true, country: 'Germany' });
  db = vendor.db;

  const salesperson = db.records['hr.employee'][0];
  const saleJournal = db.records['account.journal'].find((j) => j.type === 'sale' && (!j.company_id || j.company_id === 1));
  const purchaseJournal = db.records['account.journal'].find((j) => j.type === 'purchase' && (!j.company_id || j.company_id === 1));
  const incomeAcc = db.records['account.account'].find((a) => a.account_type === 'income' && (!a.company_id || a.company_id === 1));
  const eurCurr = db.records['res.currency'].find((c) => c.name !== db.settings.currency && (c.rate_ids ?? []).length) ?? null;
  let fxCurrId = eurCurr?.id ?? null;
  if (!fxCurrId) {
    const cur = create(db, 'res.currency', {
      name: 'EUR',
      symbol: '€',
      rate_ids: [{ date: '2020-01-01', rate: 0.5 }],
    });
    db = cur.db;
    fxCurrId = cur.id;
  } else {
    db = write(db, 'res.currency', fxCurrId, { rate_ids: [{ date: '2020-01-01', rate: 0.5 }] });
  }

  // 1) Multi-line posted customer invoice with section line (excluded) and 14% VAT on one line
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: childPartner.id,
    journal_id: saleJournal.id,
    invoice_user_id: salesperson.id,
    invoice_date: '2026-03-10',
    invoice_date_due: '2026-04-10',
    currency_id: baseCurrId,
    invoice_line_ids: [
      { display_type: 'line_section', name: 'Equipment' },
      { product_id: prodA.id, qty: 2, price_unit: 500, tax: 14, account_id: incomeAcc.id },
      { product_id: prodB.id, qty: 3, price_unit: 100, tax: 0, account_id: incomeAcc.id },
    ],
  });
  db = postMove(inv1.db, inv1.id);

  // 2) Foreign-currency posted customer invoice (rate 0.5 => 100 FX = 200 company currency)
  const invFx = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: parentPartner.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-03-15',
    currency_id: fxCurrId,
    invoice_line_ids: [
      { product_id: prodB.id, qty: 2, price_unit: 50, tax: 10, account_id: incomeAcc.id },
    ],
  });
  db = postMove(invFx.db, invFx.id);

  // 3) Posted customer credit note (out_refund -> negative amounts/quantities)
  const cn1 = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: parentPartner.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-03-20',
    currency_id: baseCurrId,
    invoice_line_ids: [
      { product_id: prodA.id, qty: 1, price_unit: 500, tax: 14, account_id: incomeAcc.id },
    ],
  });
  db = postMove(cn1.db, cn1.id);

  // 4) Posted vendor bill (in_invoice -> negative cost sign)
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    journal_id: purchaseJournal.id,
    invoice_date: '2026-03-22',
    currency_id: baseCurrId,
    invoice_line_ids: [
      { product_id: prodA.id, qty: 1, price_unit: 300, tax: 0 },
    ],
  });
  db = postMove(bill1.db, bill1.id);

  // 5) Draft customer invoice (included in model, filtered by 'draft' filter, excluded by default 'posted')
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: parentPartner.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-03-25',
    currency_id: baseCurrId,
    invoice_line_ids: [
      { product_id: prodB.id, qty: 4, price_unit: 100, tax: 0, account_id: incomeAcc.id },
    ],
  });
  db = draftInv.db;

  // 6) Cancelled invoice (must be completely excluded)
  const cancelInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: parentPartner.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-03-26',
    state: 'cancel',
    currency_id: baseCurrId,
    invoice_line_ids: [
      { product_id: prodB.id, qty: 10, price_unit: 100, tax: 0, account_id: incomeAcc.id },
    ],
  });
  db = cancelInv.db;

  return {
    db,
    ids: { inv1: inv1.id, invFx: invFx.id, cn1: cn1.id, bill1: bill1.id, draftInv: draftInv.id, cancelInv: cancelInv.id },
    categA: categA.id,
    categB: categB.id,
    prodA: prodA.id,
    prodB: prodB.id,
    parentPartner: parentPartner.id,
    childPartner: childPartner.id,
    salesperson: salesperson.id,
    baseCurrId,
  };
}

test('Invoice Analysis menu leaf and account.invoice.report structure match Odoo 20', () => {
  const leaf = leavesOf(apps.find((a) => a.id === 'accounting')).find((l) => l.key === 'invoice-analysis');
  assert.deepEqual(leaf, { key: 'invoice-analysis', label: 'Invoice Analysis', model: 'account.invoice.report', view: 'pivot' });
  assert.deepEqual(viewsOf('account.invoice.report'), ['graph', 'pivot', 'list']);

  const def = models['account.invoice.report'];
  assert.equal(def.readonly, true);
  assert.deepEqual(def.pivot, { row: 'invoice_date', col: null, measure: 'price_subtotal' });
  assert.deepEqual(def.defaultFilters, ['posted']);
  assert.equal(def.fields.price_average.groupOperator, 'avg');
  assert.deepEqual(def.groupBys, ['invoice_user_id', 'partner_id', 'product_id', 'product_categ_id', 'state', 'company_id', 'invoice_date']);

  const requiredFields = [
    'move_id', 'invoice_date', 'invoice_date_due', 'journal_id', 'company_id',
    'partner_id', 'commercial_partner_id', 'country_id', 'invoice_user_id',
    'move_type', 'state', 'payment_state', 'fiscal_position_id', 'account_id',
    'product_id', 'product_categ_id', 'product_uom_id',
    'quantity', 'price_subtotal', 'price_total', 'price_average', 'currency_id',
  ];
  for (const field of requiredFields) assert.ok(def.fields[field], `missing field ${field}`);
});

test('account.invoice.report splits lines, converts FX, negates credit notes, excludes cancelled, and ties out to P&L revenue', () => {
  const { db, ids, categA, categB, prodA, prodB, parentPartner, childPartner, salesperson, baseCurrId } = buildInvoiceAnalysisFixture();
  // Remove seeded moves so our P&L revenue ties strictly to this fixture's posted customer moves
  const cleanDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].filter((m) => Object.values(ids).includes(m.id)),
    },
  };

  const rows = search(cleanDb, 'account.invoice.report');
  // Cancelled invoice and section line must be excluded:
  // inv1 (2 lines) + invFx (1) + cn1 (1) + bill1 (1) + draftInv (1) = 6 rows
  assert.equal(rows.length, 6);
  assert.equal(rows.some((r) => r.move_id === ids.cancelInv), false);

  // Read by id and verify write protection
  const firstRow = read(cleanDb, 'account.invoice.report', rows[0].id);
  assert.equal(firstRow.move_id, rows[0].move_id);
  assert.throws(() => create(cleanDb, 'account.invoice.report', {}), /read-only/);
  assert.throws(() => write(cleanDb, 'account.invoice.report', firstRow.id, { quantity: 99 }), /read-only/);
  assert.throws(() => unlink(cleanDb, 'account.invoice.report', [firstRow.id]), /read-only/);

  // Multi-line split + partner hierarchy + category + salesperson + taxes
  const inv1Rows = rows.filter((r) => r.move_id === ids.inv1);
  assert.equal(inv1Rows.length, 2);
  const lapRow = inv1Rows.find((r) => r.product_id === prodA);
  const svcRow = inv1Rows.find((r) => r.product_id === prodB);
  assert.equal(lapRow.product_categ_id, categA);
  assert.equal(lapRow.partner_id, childPartner);
  assert.equal(lapRow.commercial_partner_id, parentPartner);
  assert.equal(lapRow.country_id, 'Egypt');
  assert.equal(lapRow.invoice_user_id, salesperson);
  assert.equal(lapRow.quantity, 2);
  assert.equal(lapRow.price_subtotal, 1000);
  assert.equal(lapRow.price_total, 1140);
  assert.equal(lapRow.price_average, 500);
  assert.equal(lapRow.currency_id, baseCurrId);

  assert.equal(svcRow.product_categ_id, categB);
  assert.equal(svcRow.quantity, 3);
  assert.equal(svcRow.price_subtotal, 300);
  assert.equal(svcRow.price_total, 300);
  assert.equal(svcRow.price_average, 100);

  // Foreign-currency line converted to company currency (rate 0.5 => x2)
  const fxRow = rows.find((r) => r.move_id === ids.invFx);
  assert.equal(fxRow.currency_id, baseCurrId);
  assert.equal(fxRow.price_subtotal, 200);
  assert.equal(fxRow.price_total, 220);
  assert.equal(fxRow.price_average, 100);

  // Credit note negative quantity, price_subtotal, price_total, positive price_average
  const cnRow = rows.find((r) => r.move_id === ids.cn1);
  assert.equal(cnRow.quantity, -1);
  assert.equal(cnRow.price_subtotal, -500);
  assert.equal(cnRow.price_total, -570);
  assert.equal(cnRow.price_average, 500);

  // Filters: Invoices vs Vendors Bills, Posted vs Draft
  const postedInvoices = applyFilters('account.invoice.report', rows, ['posted', 'customer'], cleanDb);
  assert.deepEqual(postedInvoices.map((r) => r.move_id).sort(), [ids.inv1, ids.inv1, ids.invFx, ids.cn1].sort());

  const postedBills = applyFilters('account.invoice.report', rows, ['posted', 'supplier'], cleanDb);
  assert.equal(postedBills.length, 1);
  assert.equal(postedBills[0].move_id, ids.bill1);
  assert.equal(postedBills[0].price_subtotal, -300);

  const drafts = applyFilters('account.invoice.report', rows, ['draft'], cleanDb);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].move_id, ids.draftInv);

  // Same-group OR semantics: Invoices + Vendors Bills returns both customer & vendor rows
  const bothTypes = applyFilters('account.invoice.report', rows, ['posted', 'customer', 'supplier'], cleanDb);
  assert.equal(bothTypes.length, 5);

  // Untaxed sum of posted customer invoices minus credit notes equals P&L revenue
  const customerUntaxedSum = postedInvoices.reduce((s, r) => s + r.price_subtotal, 0);
  const pnl = profitAndLoss(cleanDb, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(customerUntaxedSum, 1000);
  assert.equal(pnl.revenue, customerUntaxedSum);

  // Group by product category and average price aggregation
  const byCategory = groupRecords(cleanDb, 'account.invoice.report', postedInvoices, 'product_categ_id');
  assert.equal(byCategory.length, 2);
  // Hardware has Laptop inv (+500 avg) & Laptop cn (+500 avg); Services has Consulting (100) & FX Consulting (100)
  // Together average of all 4 rows = (500 + 100 + 100 + 500) / 4 = 300
  assert.equal(aggregate(postedInvoices, 'price_average', 'account.invoice.report'), 300);
});

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

test('Invoice Analysis UI renders pivot, graph, and list views without New button, and translates all labels in Arabic', async () => {
  const { db } = buildInvoiceAnalysisFixture();
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
    assert.ok(textOf(container).includes('Invoice Analysis'));
    assert.ok(textOf(container).includes('Posted'), 'Posted default filter chip active');
    assert.ok(textOf(container).includes('Untaxed Total'));
    assert.equal(find(container, (n) => n.tagName === 'A' && textOf(n) === 'New'), null);
    for (const label of ['Product', 'Product Category', 'Average Price', 'Salesperson', 'Partner', 'Status', 'Company']) {
      assert.ok(textOf(container).includes(label) || find(container, (n) => n.tagName === 'OPTION' && textOf(n) === label), `missing ${label}`);
    }
    const toggle = find(container, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    assert.ok(toggle);
    await React.act(async () => props(toggle).onClick());
    assert.ok(textOf(container).includes('Vendors Bills'));
    assert.ok(textOf(container).includes('Invoices'));
    assert.ok(textOf(container).includes('Draft'));
    const listBtn = find(container, (n) => n.tagName === 'A' && props(n)?.href?.includes('view=list'));
    const graphBtn = find(container, (n) => n.tagName === 'A' && props(n)?.href?.includes('view=graph'));
    assert.ok(listBtn && graphBtn, 'pivot, graph, and list switcher controls rendered');

    // Switch to Graph and List views to ensure both render cleanly
    globalThis.location.hash = '#/accounting/invoice-analysis?view=graph';
    await React.act(async () => globalThis.window.dispatchEvent(new Event('hashchange')));
    for (let i = 0; i < 30 && !find(container, (n) => props(n)?.className === 'graph-view'); i++) {
      await React.act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    assert.ok(find(container, (n) => props(n)?.className === 'graph-view'), 'graph view rendered');

    globalThis.location.hash = '#/accounting/invoice-analysis?view=list';
    await React.act(async () => globalThis.window.dispatchEvent(new Event('hashchange')));
    for (let i = 0; i < 30 && !textOf(container).includes('Laptop'); i++) {
      await React.act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    assert.ok(textOf(container).includes('Laptop'), 'list view rendered invoice lines');
  } finally {
    await React.act(async () => root.unmount());
  }

  // Verify Arabic translations exist and differ from English source strings
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import('./i18n.js?lang=ar');
    const def = models['account.invoice.report'];
    const labels = [
      def.label,
      ...Object.values(def.fields).flatMap((f) => [f.label, ...(f.options ?? []).map(([, o]) => o)]),
      ...def.filters.flat().map((f) => f.label),
    ];
    for (const label of labels) {
      assert.notEqual(t(label), label, `missing Arabic translation for ${label}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('Cashflow Analysis view isolates company 1 vs company 2 movements through its company selector', async () => {
  const container = mountDom('#/accounting/cashflow-analysis');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const other = createCompany(db, { name: 'Second Cashflow Co', currency_id: db.records['res.company'][0].currency_id });
  const suspenseId = other.db.records['account.account'].find((a) => a.code === '101404').id;
  const bank1 = create(other.db, 'account.journal', { name: 'C1 Bank', code: 'C1B', type: 'bank', company_id: 1, suspense_account_id: suspenseId });
  const bank2 = create(bank1.db, 'account.journal', { name: 'C2 Bank', code: 'C2B', type: 'bank', company_id: other.id, suspense_account_id: suspenseId });
  db = bank2.db;
  db = create(db, 'account.bank.statement.line', { journal_id: bank1.id, company_id: 1, date: '2026-03-05', amount: 150, payment_ref: 'C1 inflow' }).db;
  db = create(db, 'account.bank.statement.line', { journal_id: bank2.id, company_id: other.id, date: '2026-03-06', amount: 420, payment_ref: 'C2 inflow' }).db;
  db = updateSettings(db, { current_company_id: 1, allowed_company_ids: [1, other.id] });
  await React.act(async () => commit(db));

  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'Cashflow Analysis');
    const dates = [];
    const collectDates = (n) => {
      if (n.tagName === 'INPUT' && props(n)?.type === 'date') dates.push(n);
      (n.childNodes ?? []).forEach(collectDates);
    };
    collectDates(container);
    await React.act(async () => props(dates[0]).onChange({ target: { value: '2026-03-01' } }));
    await React.act(async () => props(dates[1]).onChange({ target: { value: '2026-03-31' } }));

    const companySelect = find(container, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Company');
    assert.ok(companySelect, 'company filter select rendered');

    // All Companies shows 150 + 420 = 570
    const rowText = () => textOf(find(container, (n) => n.tagName === 'TR' && textOf(n).startsWith('2026-03')));
    assert.ok(rowText().includes('570.00'));

    // Filter to Company 1 -> 150.00 only
    await React.act(async () => props(companySelect).onChange({ target: { value: '1' } }));
    assert.ok(rowText().includes('150.00'));
    assert.ok(!textOf(container).includes('420.00'));

    // Filter to Company 2 -> 420.00 only
    await React.act(async () => props(companySelect).onChange({ target: { value: String(other.id) } }));
    assert.ok(rowText().includes('420.00'));
    assert.ok(!textOf(container).includes('150.00'));
  } finally {
    await React.act(async () => root.unmount());
  }
});
