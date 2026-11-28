import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { today } from './models/common.js';
import { createCompany, setCompanies } from './models/company.js';
import { accountId, postEntry } from './models/ledger.js';
import { setActor } from './models/authority.js';
import { receive, valuationAccountingComparison } from './models/valuation.js';
import { setupDom, find } from './test-support/dom.js';
import { fromCsv } from './csv.js';
import { readXlsx } from './xlsx.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

function cleanDbWithAccounts() {
  let db = seed();
  // Reset stock valuation layers, quants, and posted stock-valuation moves to build isolated synthetic scenarios
  const valAccId = accountId(db, '110100', 1);
  db = {
    ...db,
    records: {
      ...db.records,
      product: [],
      'product.category': [],
      'stock.quant': [],
      'stock.valuation.layer': [],
      'account.move': (db.records['account.move'] ?? []).filter(
        (m) => !(m.line_ids ?? []).some((l) => l.account_id === valAccId),
      ),
    },
  };
  return db;
}

function setupDownloadSpy(makeEl) {
  const downloads = [];
  const origCreateElement = globalThis.document.createElement;
  const origCreateElementNS = globalThis.document.createElementNS;
  const origCreateUrl = URL.createObjectURL;
  const origRevokeUrl = URL.revokeObjectURL;

  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  globalThis.document.createElement = (tag) => {
    const el = makeEl(tag);
    const origSetAttr = el.setAttribute;
    el.setAttribute = (name, value) => {
      origSetAttr(name, value);
      if (name === 'colspan' || name === 'colSpan') el.colSpan = Number(value);
      if (name === 'rowspan' || name === 'rowSpan') el.rowSpan = Number(value);
    };
    el.click = () => {
      if (tag.toLowerCase() === 'a') {
        downloads.push({ filename: el.download, blob: el._blob ?? downloads.at(-1)?.blob });
      }
    };
    return el;
  };
  URL.createObjectURL = (blob) => {
    downloads.push({ filename: null, blob });
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};

  const takeLast = async () => {
    const entry = downloads.pop();
    if (!entry?.blob) return null;
    const buf = new Uint8Array(await entry.blob.arrayBuffer());
    return {
      filename: entry.filename,
      type: entry.blob.type,
      bytes: buf,
      text: async () => entry.blob.text(),
    };
  };

  const restore = () => {
    globalThis.document.createElement = origCreateElement;
    globalThis.document.createElementNS = origCreateElementNS;
    URL.createObjectURL = origCreateUrl;
    URL.revokeObjectURL = origRevokeUrl;
  };

  return { takeLast, restore };
}

test('INVVAL-1: posted drill scoping opens booked valuation journal items with company, accounts, and as-of cutoff', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = cleanDbWithAccounts();
  const valAccId = accountId(db, '110100', 1);
  const offsetAccId = accountId(db, '301000', 1);
  const p = create(db, 'product', { name: 'Drill Widget', type: 'goods', cost: 25, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = receive(p.db, p.id, 4, 25, { date: '2026-01-10', reference: 'REC-JAN' });
  db = receive(db, p.id, 2, 25, { date: '2026-02-15', reference: 'REC-FEB' });

  // Add a draft entry on 110100 before cutoff and a posted entry on another company (must both be excluded)
  const branch = createCompany(db, { name: 'Other Co', currency_id: read(db, 'res.company', 1).currency_id });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const branchValAcc = create(db, 'account.account', { code: '110199', name: 'Other Stock', account_type: 'asset_current', company_id: branch.id });
  db = branchValAcc.db;
  const branchJournal = create(db, 'account.journal', { name: 'Other Misc', code: 'OMISC', type: 'general', company_id: branch.id });
  db = branchJournal.db;
  db = postEntry(db, {
    journal_id: branchJournal.id,
    company: branch.id,
    date: '2026-01-12',
    ref: 'CO2-POSTED',
    lines: [{ account_id: branchValAcc.id, debit: 500 }, { account_id: offsetAccId, credit: 500 }],
  }).db;
  const draftMove = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    company_id: 1,
    journal_id: search(db, 'account.journal').find((j) => j.type === 'general' && (j.company_id ?? 1) === 1).id,
    date: '2026-01-15',
    ref: 'DRAFT-VAL',
    line_ids: [{ account_id: valAccId, debit: 999 }, { account_id: offsetAccId, credit: 999 }],
  });
  db = draftMove.db;

  await React.act(async () => store.commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'valuation' } })));
    const asOfInput = find(host, (n) => props(n)?.['aria-label'] === 'As of');
    await React.act(async () => props(asOfInput).onChange({ target: { value: '2026-01-31' } }));

    const tableText = textOf(find(host, (n) => n.tagName === 'TABLE'));
    assert.ok(tableText.includes('Initial Balance'));
    assert.ok(tableText.includes('Ending Stock'));
    assert.ok(tableText.includes('Stock Variation'));
    assert.ok(tableText.includes('$100.00'), 'Initial Balance and Ending Stock reflect 2026-01-31 cutoff ($100.00)');
    assert.ok(tableText.includes('$0.00'), 'Stock Variation is $0.00 when stock and GL match');

    const drillLink = find(host, (n) => n.tagName === 'A' && props(n)?.href?.startsWith('#/accounting/journal-items?'));
    assert.ok(drillLink, 'Initial Balance renders journal-items drill link');
    const href = props(drillLink).href;
    const params = new URLSearchParams(href.split('?')[1]);
    assert.equal(params.get('account'), String(valAccId));
    assert.equal(params.get('company'), '1');
    assert.equal(params.get('to'), '2026-01-31');
    assert.equal(params.get('reviewMode'), 'posted');

    const invStockLink = find(host, (n) => n.tagName === 'A' && props(n)?.href === '#/inventory/stock');
    assert.equal(invStockLink, null, 'Ending Stock does not link to #/inventory/stock in historical/multi-company context');

    // Open JournalItems with the drill href and verify scoped rows and total match
    const prevHash = globalThis.location?.hash;
    globalThis.location = { hash: href };
    try {
      await React.act(async () => root.render(React.createElement(JournalItems, { leaf: { key: 'journal-items', label: 'Journal Items', report: 'journalItems' } })));
      const jiBody = textOf(find(host, (n) => n.tagName === 'TBODY'));
      const jiFoot = textOf(find(host, (n) => n.tagName === 'TFOOT'));
      assert.ok(jiBody.includes('REC-JAN'), 'Includes posted entry on or before cutoff');
      assert.ok(!jiBody.includes('REC-FEB'), 'Excludes posted entry after cutoff');
      assert.ok(!jiBody.includes('DRAFT-VAL'), 'Excludes draft entry');
      assert.ok(!jiBody.includes('CO2-POSTED'), 'Excludes other company entry');
      assert.ok(jiFoot.includes('$100.00'), 'Journal Items footer matches Initial Balance ($100.00)');
    } finally {
      globalThis.location = { hash: prevHash ?? '' };
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('INVVAL-1: company switching scopes comparison, currency, and cutoff cleanly across companies', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = cleanDbWithAccounts();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const branch = createCompany(db, { name: 'Euro Branch', currency_id: eur.id });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const c2 = branch.id;

  const val2 = create(db, 'account.account', { code: '110190', name: 'Euro Stock Valuation', account_type: 'asset_current', company_id: c2 });
  const in2 = create(val2.db, 'account.account', { code: '110290', name: 'Euro Stock Input', account_type: 'asset_current', company_id: c2 });
  const j2 = create(in2.db, 'account.journal', { name: 'Euro Misc', code: 'EMISC', type: 'general', company_id: c2 });
  db = write(j2.db, 'res.company', c2, {
    account_stock_valuation_id: val2.id,
    account_stock_input_id: in2.id,
    default_general_journal_id: j2.id,
  });

  const p1 = create(db, 'product', { name: 'USD Item', type: 'goods', company_id: 1, cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = receive(p1.db, p1.id, 3, 10, { date: '2026-03-01', company_id: 1, reference: 'USD-REC' });

  const p2 = create(db, 'product', { name: 'EUR Item', type: 'goods', company_id: c2, cost: 40, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = receive(p2.db, p2.id, 2, 40, { date: '2026-03-05', company_id: c2, reference: 'EUR-REC-1' });
  db = receive(db, p2.id, 1, 40, { date: '2026-04-05', company_id: c2, reference: 'EUR-REC-2' });

  // Also test a pure GL manual adjustment in company 2 creating a measurable Stock Variation
  const exp2 = create(db, 'account.account', { code: '600190', name: 'Euro Expense', account_type: 'expense', company_id: c2 });
  db = exp2.db;
  db = postEntry(db, {
    journal_id: j2.id,
    company: c2,
    date: '2026-03-20',
    ref: 'EUR-MANUAL-ADJ',
    lines: [{ account_id: val2.id, debit: 20 }, { account_id: exp2.id, credit: 20 }],
  }).db;

  await React.act(async () => store.commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'valuation' } })));
    const companySelect = find(host, (n) => props(n)?.['aria-label'] === 'Company');
    const asOfInput = find(host, (n) => props(n)?.['aria-label'] === 'As of');
    await React.act(async () => props(companySelect).onChange({ target: { value: String(c2) } }));
    await React.act(async () => props(asOfInput).onChange({ target: { value: '2026-03-31' } }));

    // As of 2026-03-31 in Company 2: Stock = 2*40 = 80 EUR, GL = 80 + 20 = 100 EUR, Variation = -20 EUR
    const comp = valuationAccountingComparison(db, { at: '2026-03-31', companyId: c2 });
    assert.equal(comp.canShowPosted, true);
    assert.equal(comp.comparable, true);
    assert.equal(comp.stockTotal, 80);
    assert.equal(comp.postedBalance, 100);
    assert.equal(comp.variation, -20);

    const tableText = textOf(find(host, (n) => n.tagName === 'TABLE'));
    assert.ok(tableText.includes('100.00 €'), `Expected EUR Initial Balance (100.00 €), got: ${tableText}`);
    assert.ok(tableText.includes('80.00 €'), `Expected EUR Ending Stock (80.00 €), got: ${tableText}`);
    assert.ok(tableText.includes('-20.00 €'), `Expected EUR Stock Variation (-20.00 €), got: ${tableText}`);

    const drillLink = find(host, (n) => n.tagName === 'A' && props(n)?.href?.startsWith('#/accounting/journal-items?'));
    const params = new URLSearchParams(props(drillLink).href.split('?')[1]);
    assert.equal(params.get('company'), String(c2));
    assert.equal(params.get('account'), String(val2.id));
    assert.equal(params.get('to'), '2026-03-31');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('INVVAL-1: category override resolves multiple valuation accounts without double-counting and drills to all of them', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = cleanDbWithAccounts();
  const defaultValAccId = accountId(db, '110100', 1);
  const overrideAcc = create(db, 'account.account', { code: '110150', name: 'Special Inventory', account_type: 'asset_current', company_id: 1 });
  db = overrideAcc.db;

  const catOverride = create(db, 'product.category', {
    name: 'Override Category',
    property_stock_valuation_account_id: overrideAcc.id,
  });
  const catChild = create(catOverride.db, 'product.category', {
    name: 'Override Child',
    parent_id: catOverride.id,
  });
  db = catChild.db;

  const pDefault = create(db, 'product', { name: 'Standard Item', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  const pOver1 = create(pDefault.db, 'product', { name: 'Override Item 1', type: 'goods', categ_id: catOverride.id, cost: 25, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  const pOver2 = create(pOver1.db, 'product', { name: 'Override Item 2', type: 'goods', categ_id: catChild.id, cost: 30, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = receive(pOver2.db, pDefault.id, 5, 10, { date: '2026-04-01', reference: 'REC-DEF' });
  db = receive(db, pOver1.id, 4, 25, { date: '2026-04-02', reference: 'REC-OVR1' });
  db = receive(db, pOver2.id, 2, 30, { date: '2026-04-03', reference: 'REC-OVR2' });

  const comp = valuationAccountingComparison(db, { at: '2026-04-30', companyId: 1 });
  assert.equal(comp.canShowPosted, true);
  assert.equal(comp.comparable, true);
  // 50 + 100 + 60 = 210 (must not double-count overrideAcc across pOver1, pOver2, catOverride, catChild)
  assert.deepEqual(comp.accountIds.sort((a, b) => a - b), [defaultValAccId, overrideAcc.id].sort((a, b) => a - b));
  assert.equal(comp.postedBalance, 210);
  assert.equal(comp.stockTotal, 210);
  assert.equal(comp.variation, 0);

  await React.act(async () => store.commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'valuation' } })));
    const asOfInput = find(host, (n) => props(n)?.['aria-label'] === 'As of');
    await React.act(async () => props(asOfInput).onChange({ target: { value: '2026-04-30' } }));

    const tableText = textOf(find(host, (n) => n.tagName === 'TABLE'));
    assert.ok(tableText.includes('110100'));
    assert.ok(tableText.includes('110150'));
    assert.ok(tableText.includes('$210.00'));
    assert.ok(tableText.includes('$0.00'));

    const drillLink = find(host, (n) => n.tagName === 'A' && props(n)?.href?.startsWith('#/accounting/journal-items?'));
    const href = props(drillLink).href;
    const params = new URLSearchParams(href.split('?')[1]);
    assert.equal(params.get('account'), null);
    assert.deepEqual(params.get('accounts').split(',').map(Number).sort((a, b) => a - b), [defaultValAccId, overrideAcc.id].sort((a, b) => a - b));

    const prevHash = globalThis.location?.hash;
    globalThis.location = { hash: href };
    try {
      await React.act(async () => root.render(React.createElement(JournalItems, { leaf: { key: 'journal-items', label: 'Journal Items', report: 'journalItems' } })));
      const jiBody = textOf(find(host, (n) => n.tagName === 'TBODY'));
      const jiFoot = textOf(find(host, (n) => n.tagName === 'TFOOT'));
      assert.ok(jiBody.includes('REC-DEF'));
      assert.ok(jiBody.includes('REC-OVR1'));
      assert.ok(jiBody.includes('REC-OVR2'));
      assert.ok(jiFoot.includes('$210.00'));
    } finally {
      globalThis.location = { hash: prevHash ?? '' };
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('INVVAL-1: historical linked layers use recorded posting accounts and withhold on unreconcilable account or time basis', () => {
  let db = cleanDbWithAccounts();
  const oldAcc = create(db, 'account.account', { code: '110111', name: 'Old Stock Acc', account_type: 'asset_current', company_id: 1 });
  const newAcc = create(oldAcc.db, 'account.account', { code: '110112', name: 'New Stock Acc', account_type: 'asset_current', company_id: 1 });
  const cat = create(newAcc.db, 'product.category', { name: 'Reconfig Cat', property_stock_valuation_account_id: oldAcc.id });
  const prod = create(cat.db, 'product', { name: 'Migrated Item', type: 'goods', categ_id: cat.id, cost: 20, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = receive(prod.db, prod.id, 3, 20, { date: '2026-01-10', reference: 'OLD-ACC-REC' });

  // Reconfigure category to newAcc and receive more stock
  db = write(db, 'product.category', cat.id, { property_stock_valuation_account_id: newAcc.id });
  db = receive(db, prod.id, 2, 20, { date: '2026-02-10', reference: 'NEW-ACC-REC' });

  const reconciled = valuationAccountingComparison(db, { at: '2026-02-28', companyId: 1 });
  assert.equal(reconciled.canShowPosted, true);
  assert.equal(reconciled.comparable, true);
  assert.ok(reconciled.accountIds.includes(oldAcc.id), 'Old posting account from historical linked layer is included');
  assert.ok(reconciled.accountIds.includes(newAcc.id), 'New posting account is included');
  assert.equal(reconciled.postedBalance, 100);
  assert.equal(reconciled.stockTotal, 100);
  assert.equal(reconciled.variation, 0);

  // Time-basis mismatch: opening stock prepared on 2026-03-05 creates an opening layer dated 0001-01-01 with move dated 2026-03-05
  const openedProd = create(db, 'product', { name: 'Opened Later', type: 'goods', categ_id: cat.id, cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 4 });
  const mismatchDb = receive(openedProd.db, openedProd.id, 1, 10, { date: '2026-03-05', reference: 'OPEN-LATER' });
  const mismatch = valuationAccountingComparison(mismatchDb, { at: '2026-02-28', companyId: 1 });
  assert.equal(mismatch.canShowPosted, true, 'Posted balance/drill remains independently meaningful');
  assert.equal(mismatch.comparable, false, 'Comparison is withheld on time-basis mismatch');
  assert.equal(mismatch.reason, 'time_basis_mismatch');
  assert.equal(mismatch.variation, null);

  // Unreconcilable linked layer (linked move is draft / unposted)
  const draftMove = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    company_id: 1,
    journal_id: search(db, 'account.journal').find((j) => j.type === 'general' && (j.company_id ?? 1) === 1).id,
    date: '2026-02-15',
    line_ids: [{ account_id: newAcc.id, debit: 50 }, { account_id: accountId(db, '301000', 1), credit: 50 }],
  });
  const draftLayerDb = create(draftMove.db, 'stock.valuation.layer', {
    product_id: prod.id,
    company_id: 1,
    date: '2026-02-15',
    quantity: 1,
    unit_cost: 50,
    value: 50,
    kind: 'in',
    move_id: draftMove.id,
  }).db;
  const broken = valuationAccountingComparison(draftLayerDb, { at: '2026-02-28', companyId: 1 });
  assert.equal(broken.canShowPosted, false);
  assert.equal(broken.comparable, false);
  assert.equal(broken.reason, 'unreconcilable_layer');
  assert.equal(broken.variation, null);

  // Wholly future draft/missing-move layers must not hide an earlier valid snapshot
  const futureDraftMove = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    company_id: 1,
    journal_id: search(db, 'account.journal').find((j) => j.type === 'general' && (j.company_id ?? 1) === 1).id,
    date: '2026-03-10',
    line_ids: [{ account_id: newAcc.id, debit: 60 }, { account_id: accountId(db, '301000', 1), credit: 60 }],
  });
  let futureOnlyDb = create(futureDraftMove.db, 'stock.valuation.layer', {
    product_id: prod.id,
    company_id: 1,
    date: '2026-03-10',
    quantity: 3,
    unit_cost: 20,
    value: 60,
    kind: 'in',
    move_id: futureDraftMove.id,
  }).db;
  futureOnlyDb = create(futureOnlyDb, 'stock.valuation.layer', {
    product_id: prod.id,
    company_id: 1,
    date: '2026-03-12',
    quantity: 1,
    unit_cost: 20,
    value: 20,
    kind: 'in',
    move_id: 999999,
  }).db;
  const earlierValid = valuationAccountingComparison(futureOnlyDb, { at: '2026-02-28', companyId: 1 });
  assert.equal(earlierValid.canShowPosted, true, 'Earlier valid snapshot keeps posted balance despite future draft/missing layers');
  assert.equal(earlierValid.comparable, true, 'Earlier valid snapshot remains comparable');
  assert.equal(earlierValid.postedBalance, 100);
  assert.equal(earlierValid.stockTotal, 100);
  assert.equal(earlierValid.variation, 0);

  const atFutureDraft = valuationAccountingComparison(futureOnlyDb, { at: '2026-03-31', companyId: 1 });
  assert.equal(atFutureDraft.canShowPosted, false, 'When future draft/missing layers enter cutoff, fail closed');
  assert.equal(atFutureDraft.comparable, false);
  assert.equal(atFutureDraft.reason, 'unreconcilable_layer');
});

test('INVVAL-1: incompatible contexts suppress numerical comparison and keep print/CSV/XLSX coherent', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = cleanDbWithAccounts();
  const catA = create(db, 'product.category', { name: 'Cat Alpha' });
  const catB = create(catA.db, 'product.category', { name: 'Cat Beta' });
  const locA = create(catB.db, 'stock.location', { name: 'WH-A/Stock', usage: 'internal', company_id: 1 });
  const whA = create(locA.db, 'stock.warehouse', { name: 'Warehouse A', code: 'WHA', lot_stock_id: locA.id, company_id: 1 });
  const pA = create(whA.db, 'product', { name: 'Alpha Good', type: 'goods', categ_id: catA.id, cost: 50, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  const pB = create(pA.db, 'product', { name: 'Beta Good', type: 'goods', categ_id: catB.id, cost: 30, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = receive(pB.db, pA.id, 2, 50, { date: '2026-01-10', stockLine: { location_id: locA.id } });
  db = receive(db, pB.id, 3, 30, { date: '2026-01-10' });

  // 1. Subset filters (category, product, warehouse, location) keep posted balance/drill but suppress variation
  for (const filterOpts of [{ categoryId: catA.id }, { productId: pA.id }, { warehouseId: whA.id }, { locationId: locA.id }]) {
    const res = valuationAccountingComparison(db, { at: '2026-01-31', companyId: 1, ...filterOpts });
    assert.equal(res.canShowPosted, true);
    assert.equal(res.postedBalance, 190);
    assert.equal(res.comparable, false);
    assert.equal(res.reason, 'filtered_scope');
    assert.equal(res.variation, null);
  }

  // 2. Periodic stock without comparable booked total
  const pPer = create(db, 'product', { name: 'Periodic Good', type: 'goods', valuation: 'manual_periodic', cost: 25, qty_available: 4 });
  const perRes = valuationAccountingComparison(pPer.db, { at: today(), companyId: 1 });
  assert.equal(perRes.canShowPosted, true);
  assert.equal(perRes.postedBalance, 190);
  assert.equal(perRes.stockTotal, 290);
  assert.equal(perRes.comparable, false);
  assert.equal(perRes.reason, 'periodic_stock');
  assert.equal(perRes.variation, null);

  // 3. Historical stock unavailable (legacy unvalued stock before today)
  const pLegacy = create(db, 'product', { name: 'Legacy Stock', type: 'goods', valuation: 'real_time', cost: 15, qty_available: 5 });
  const histRes = valuationAccountingComparison(pLegacy.db, { at: '2025-01-01', companyId: 1 });
  assert.equal(histRes.canShowPosted, true);
  assert.equal(histRes.comparable, false);
  assert.equal(histRes.reason, 'historical_unavailable');
  assert.equal(histRes.variation, null);

  // 4. Absent / ambiguous configuration
  const noConfigDb = write(db, 'res.company', 1, { account_stock_valuation_id: null });
  const absentRes = valuationAccountingComparison(noConfigDb, { at: '2026-01-31', companyId: 1 });
  assert.equal(absentRes.canShowPosted, false);
  assert.equal(absentRes.comparable, false);
  assert.equal(absentRes.reason, 'unconfigured_accounts');

  const ambigDb = write(db, 'res.company', 1, { account_stock_valuation_id: accountId(db, '110200', 1) });
  const ambigRes = valuationAccountingComparison(ambigDb, { at: '2026-01-31', companyId: 1 });
  assert.equal(ambigRes.canShowPosted, false);
  assert.equal(ambigRes.comparable, false);
  assert.equal(ambigRes.reason, 'unconfigured_accounts');

  // 5. UI + Print + CSV + XLSX coherence under filtered state (no numeric delta exported)
  await React.act(async () => store.commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'valuation' } })));
    const catSelect = find(host, (n) => props(n)?.['aria-label'] === 'Product Category');
    await React.act(async () => props(catSelect).onChange({ target: { value: String(catA.id) } }));

    const tableText = textOf(find(host, (n) => n.tagName === 'TABLE'));
    assert.ok(tableText.includes('$190.00'), 'Whole-book Initial Balance remains visible');
    assert.ok(tableText.includes('$100.00'), 'Filtered Ending Stock shows $100.00');
    assert.ok(tableText.includes('Not comparable'), 'Filtered Stock Variation is non-numeric');
    assert.ok(!tableText.includes('-$90.00') && !tableText.includes('$90.00'), 'No misleading filtered-vs-book delta is shown');

    const csvBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('CSV'));
    await React.act(async () => props(csvBtn).onClick());
    const csvRows = fromCsv(await (await spy.takeLast()).text());
    assert.ok(csvRows.some((r) => r.includes('Initial Balance (110100 Stock Valuation)') && r.includes('$190.00')));
    assert.ok(csvRows.some((r) => r.includes('Stock Variation') || r.some((c) => c.includes('Stock Variation'))));
    assert.ok(csvRows.some((r) => r.includes('Not comparable')));

    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('XLSX'));
    await React.act(async () => props(xlsxBtn).onClick());
    const xlsxParsed = readXlsx((await spy.takeLast()).bytes);
    const xlsxText = xlsxParsed.rows.map((r) => r.join(' ')).join('\n');
    assert.ok(xlsxText.includes('190'));
    assert.ok(xlsxText.includes('100'));
    assert.ok(xlsxText.includes('Not comparable'));

    const printBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Print'));
    await React.act(async () => props(printBtn).onClick());
    const printText = textOf(host);
    assert.ok(printText.includes('$190.00'));
    assert.ok(printText.includes('$100.00'));
    assert.ok(printText.includes('Not comparable'));
  } finally {
    spy.restore();
    await React.act(async () => root.unmount());
  }
});

test('INVVAL-1 regression: zero-quantity row with nonzero residual value displays blank unit cost and aligns Total, Ending Stock, export, and Stock Variation', async () => {
  const { makeEl } = setupDom();
  const spy = setupDownloadSpy(makeEl);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = cleanDbWithAccounts();
  const valAccId = accountId(db, '110100', 1);
  const offsetAccId = accountId(db, '500000', 1);
  const journalId = search(db, 'account.journal').find((j) => j.type === 'general' && (j.company_id ?? 1) === 1).id;

  // Product with net zero quantity (10 in, 10 out) but +25.00 residual layer value posted to 110100
  const pResid = create(db, 'product', { name: 'Residual Residue Item', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = pResid.db;
  const pZero = create(db, 'product', { name: 'Fully Zero Item', type: 'goods', cost: 10, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = pZero.db;
  const pActive = create(db, 'product', { name: 'Active Stock Item', type: 'goods', cost: 40, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = receive(pActive.db, pActive.id, 2, 40, { date: '2026-05-01', reference: 'ACT-REC' });

  const residMove = postEntry(db, {
    journal_id: journalId,
    company: 1,
    date: '2026-05-05',
    ref: 'RESID-VAL',
    lines: [{ account_id: valAccId, debit: 25 }, { account_id: offsetAccId, credit: 25 }],
  });
  db = residMove.db;
  db = create(db, 'stock.valuation.layer', {
    product_id: pResid.id,
    company_id: 1,
    date: '2026-05-05',
    quantity: 0,
    unit_cost: 0,
    value: 25,
    kind: 'revaluation',
    reference: 'RESID-VAL',
    move_id: residMove.id,
  }).db;
  // Fully zeroed product (qty 0, value 0) must stay hidden
  db = create(db, 'stock.valuation.layer', {
    product_id: pZero.id,
    company_id: 1,
    date: '2026-05-05',
    quantity: 0,
    unit_cost: 0,
    value: 0,
    kind: 'adjustment',
    reference: 'ZERO-VAL',
  }).db;

  await React.act(async () => store.commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'valuation' } })));
    const asOfInput = find(host, (n) => props(n)?.['aria-label'] === 'As of');
    await React.act(async () => props(asOfInput).onChange({ target: { value: '2026-05-31' } }));

    const table = find(host, (n) => n.tagName === 'TABLE');
    const tbody = find(table, (n) => n.tagName === 'TBODY');
    const rows = (tbody.childNodes ?? []).filter((n) => n.tagName === 'TR');
    const rowCellsText = (tr) => (tr.childNodes ?? []).filter((n) => n.tagName === 'TD').map((td) => textOf(td));

    const residRow = rows.find((tr) => textOf(tr).includes('Residual Residue Item'));
    assert.ok(residRow, 'Zero-quantity row with nonzero residual value is shown');
    assert.deepEqual(rowCellsText(residRow), ['Residual Residue Item', '0', '', '$25.00'], 'Undefined unit cost is left blank');

    assert.equal(rows.some((tr) => textOf(tr).includes('Fully Zero Item')), false, 'Zero-quantity zero-value row remains hidden');

    const totalRow = rows.find((tr) => rowCellsText(tr)[0] === 'Total');
    const initialRow = rows.find((tr) => rowCellsText(tr)[0].startsWith('Initial Balance'));
    const endingRow = rows.find((tr) => rowCellsText(tr)[0].startsWith('Ending Stock'));
    const variationRow = rows.find((tr) => rowCellsText(tr)[0].startsWith('Stock Variation'));

    // 80.00 (active) + 25.00 (residual) = 105.00
    assert.equal(rowCellsText(totalRow)[3], '$105.00');
    assert.equal(rowCellsText(initialRow)[3], '$105.00');
    assert.equal(rowCellsText(endingRow)[3], '$105.00');
    assert.equal(rowCellsText(variationRow)[3], '$0.00');

    const csvBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('CSV'));
    await React.act(async () => props(csvBtn).onClick());
    const csvRows = fromCsv(await (await spy.takeLast()).text());
    const csvResid = csvRows.find((r) => r[0] === 'Residual Residue Item');
    assert.deepEqual(csvResid, ['Residual Residue Item', '0', '', '$25.00']);
    assert.ok(csvRows.some((r) => r[0] === 'Total' && r[3] === '$105.00'));
    assert.ok(csvRows.some((r) => r[0] === 'Ending Stock' && r[3] === '$105.00'));
    assert.ok(csvRows.some((r) => r[0] === 'Stock Variation' && r[3] === '$0.00'));

    const xlsxBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('XLSX'));
    await React.act(async () => props(xlsxBtn).onClick());
    const xlsxParsed = readXlsx((await spy.takeLast()).bytes);
    const xlsxResid = xlsxParsed.rows.find((r) => r[0] === 'Residual Residue Item');
    assert.deepEqual(xlsxResid, ['Residual Residue Item', 0, '', 25]);
    assert.ok(xlsxParsed.rows.some((r) => r[0] === 'Total' && r[3] === 105));
    assert.ok(xlsxParsed.rows.some((r) => r[0] === 'Ending Stock' && r[3] === 105));
    assert.ok(xlsxParsed.rows.some((r) => r[0] === 'Stock Variation' && r[3] === 0));
  } finally {
    spy.restore();
    await React.act(async () => root.unmount());
  }
});

test('INVVAL-1: Ending Stock links to #/inventory/stock only for matching current whole-company scope', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  await store.initStore();

  let db = cleanDbWithAccounts();
  const cat = create(db, 'product.category', { name: 'Link Cat' });
  const prod = create(cat.db, 'product', { name: 'Link Widget', type: 'goods', categ_id: cat.id, cost: 25, cost_method: 'fifo', valuation: 'real_time', qty_available: 0 });
  db = receive(prod.db, prod.id, 4, 25, { date: today(), reference: 'TODAY-REC' });
  await React.act(async () => store.commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const stockLink = () => find(host, (n) => n.tagName === 'A' && props(n)?.href === '#/inventory/stock');

  try {
    // 1. Supported: single-company 1, current date (today), no subset filters -> linked
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'valuation' } })));
    assert.ok(stockLink(), 'Ending Stock links to #/inventory/stock for matching current whole-company context');

    // 2. Subset filter active -> plain text (no link)
    const catSelect = find(host, (n) => props(n)?.['aria-label'] === 'Product Category');
    await React.act(async () => props(catSelect).onChange({ target: { value: String(cat.id) } }));
    assert.equal(stockLink(), null, 'Ending Stock renders as plain text when category filter is active');
    await React.act(async () => props(catSelect).onChange({ target: { value: '' } }));
    assert.ok(stockLink(), 'Ending Stock link returns when subset filter is cleared');

    // 3. Historical date -> plain text (no link)
    const asOfInput = find(host, (n) => props(n)?.['aria-label'] === 'As of');
    await React.act(async () => props(asOfInput).onChange({ target: { value: '2026-01-15' } }));
    assert.equal(stockLink(), null, 'Ending Stock renders as plain text for historical date');

    // 4. Other-company / multi-company context at today() -> plain text (no link)
    const branch = createCompany(db, { name: 'Other Branch', currency_id: read(db, 'res.company', 1).currency_id });
    const multiDb = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
    await React.act(async () => store.commit(multiDb));
    await React.act(async () => props(asOfInput).onChange({ target: { value: today() } }));
    assert.equal(stockLink(), null, 'Ending Stock renders as plain text in multi-company scope');
    const companySelect = find(host, (n) => props(n)?.['aria-label'] === 'Company');
    await React.act(async () => props(companySelect).onChange({ target: { value: String(branch.id) } }));
    assert.equal(stockLink(), null, 'Ending Stock renders as plain text for another selected company');

    // 5. Restricted accounting-only user (no Inventory app access) -> plain text for Ending Stock, ledger drill kept
    const prevFetch = globalThis.fetch;
    const prevInterval = globalThis.setInterval;
    const jsonReply = (body) => ({ ok: true, status: 200, headers: { get: (h) => ({ 'content-type': 'application/json', etag: '"1"' })[h.toLowerCase()] ?? null }, json: async () => body });
    globalThis.fetch = async (path) => jsonReply(path === '/api/session' ? { id: 2, login: 'acct', name: 'Accountant', isAdmin: false, apps: ['accounting'] } : path === '/api/db' ? db : []);
    globalThis.setInterval = () => 0;
    try {
      await React.act(async () => store.initStore());
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'valuation' } })));
      assert.equal(stockLink(), null, 'Ending Stock renders as plain text for accounting-only user without Inventory access');
      assert.ok(find(host, (n) => n.tagName === 'A' && props(n)?.href?.startsWith('#/accounting/journal-items?')), 'Initial Balance ledger drill remains available for accounting-only user');
    } finally {
      globalThis.setInterval = prevInterval;
      globalThis.fetch = prevFetch;
      setActor(null);
      await React.act(async () => store.initStore());
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});
