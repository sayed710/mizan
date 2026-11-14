import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { seed } from './seed.js';
import { aggregate, create, read, search, unlink, write, writeManyAtomic } from './orm.js';
import { postEntry } from './models/ledger.js';
import { today } from './models/common.js';
import { configurableReport } from './models/configurableReports.js';
import { findStatementReport } from './models/statementReports.js';
import { createCompany } from './models/company.js';
import { round } from './money.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

test('Finding 1: foldable report lines reconcile account debit, credit and balance details across subtraction, sign, and overlapping selectors', () => {
  let db = seed();
  const yr = today().slice(0, 4);
  const date = `${yr}-03-10`;
  const accA = create(db, 'account.account', { code: '879100', name: 'Detail Alpha', account_type: 'expense', company_id: 1 });
  db = accA.db;
  const accB = create(db, 'account.account', { code: '879200', name: 'Detail Beta', account_type: 'expense', company_id: 1 });
  db = accB.db;
  const accInc = create(db, 'account.account', { code: '409100', name: 'Detail Income', account_type: 'income', company_id: 1 });
  db = accInc.db;

  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date,
    lines: [
      { account: accA.id, debit: 100, partner_id: 1 },
      { account: accB.id, debit: 40, partner_id: 1 },
      { account: accInc.id, credit: 50, partner_id: 1 },
      { account: '301000', credit: 90 },
    ],
  }).db;
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date,
    lines: [
      { account: accA.id, credit: 30, partner_id: 2 },
      { account: accB.id, credit: 10, partner_id: 2 },
      { account: accInc.id, debit: 5, partner_id: 2 },
      { account: '301000', debit: 35 },
    ],
  }).db;

  const line = (code, formula, extra = {}) => ({
    code,
    name: code,
    formula,
    sequence: 10,
    parent_code: '',
    sign: 1,
    foldable: true,
    strong: false,
    ...extra,
  });

  const report = create(db, 'account.report', {
    name: 'Drilldown Reconciliation',
    company_id: 1,
    show_debit: true,
    show_credit: true,
    line_ids: [
      line('A', '879', { sequence: 10 }),
      line('B', '8792', { sequence: 20 }),
      line('DIFF', 'A - B', { sequence: 30 }),
      line('OVERLAP', 'A + B', { sequence: 40 }),
      line('INC', '409100', { sequence: 50, sign: -1 }),
      line('NET', 'INC - A', { sequence: 60 }),
    ],
  });
  db = report.db;
  const group = create(db, 'account.report.horizontal.group', {
    name: 'Partner Split',
    company_id: 1,
    report_ids: [report.id],
    rule_ids: [{ field: 'partner', ids: '1' }],
  });
  db = group.db;

  const repRec = read(db, 'account.report', report.id);
  const period = { from: date, to: date };
  for (const out of [
    configurableReport(db, repRec, period),
    configurableReport(db, repRec, period, read(db, 'account.report.horizontal.group', group.id)),
  ]) {
    for (const row of out.rows) {
      for (let colIdx = 0; colIdx < row.values.length; colIdx += 1) {
        const detailSum = round(row.accountRows.reduce((s, acc) => s + acc.values[colIdx], 0));
        assert.equal(detailSum, row.values[colIdx], `line ${row.code} col ${colIdx} detail sum ${detailSum} !== total ${row.values[colIdx]}`);
      }
    }
    if (out.buckets.length === 1) {
      const diffRow = out.rows.find((r) => r.code === 'DIFF');
      assert.equal(diffRow.accountRows.length, 1);
      assert.deepEqual(diffRow.accountRows[0].values, [70, 100, 30]);

      const overlapRow = out.rows.find((r) => r.code === 'OVERLAP');
      const overlapBeta = overlapRow.accountRows.find((a) => a.account.id === accB.id);
      assert.deepEqual(overlapBeta.values, [60, 80, 20]);

      const netRow = out.rows.find((r) => r.code === 'NET');
      assert.deepEqual(netRow.values, [-55, -135, 10]);
    }
  }
});

test('Finding 2: average aggregation excludes null/undefined measures, returns null when empty, and renders safely in Graph, Pivot, and CSV export', async () => {
  let db = seed();
  const cat = create(db, 'product.category', { name: 'Avg Cat' });
  db = cat.db;
  const prod = create(db, 'product', { name: 'Avg Prod', type: 'service', categ_id: cat.id, list_price: 100 });
  db = prod.db;
  const noRateProd = create(db, 'product', { name: 'No Rate Prod', type: 'service', categ_id: cat.id, list_price: 50 });
  db = noRateProd.db;
  const partner = create(db, 'res.partner', { name: 'Avg Partner', is_company: true });
  db = partner.db;
  const saleJournal = db.records['account.journal'].find((j) => j.type === 'sale' && (!j.company_id || j.company_id === 1));
  const incomeAcc = db.records['account.account'].find((a) => a.account_type === 'income' && (!a.company_id || a.company_id === 1));
  const baseCurrId = db.records['res.company'][0].currency_id;
  const fxCurr = create(db, 'res.currency', { name: 'XAF', symbol: 'FCFA', rate_ids: [] });
  db = fxCurr.db;

  const invPriced = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-04-10',
    currency_id: baseCurrId,
    invoice_line_ids: [{ product_id: prod.id, qty: 2, price_unit: 100, tax: 0, account_id: incomeAcc.id }],
  });
  db = invPriced.db;

  const invMissingRate = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-04-10',
    currency_id: fxCurr.id,
    invoice_line_ids: [
      { product_id: prod.id, qty: 3, price_unit: 999, tax: 0, account_id: incomeAcc.id },
      { product_id: noRateProd.id, qty: 1, price_unit: 500, tax: 0, account_id: incomeAcc.id },
    ],
  });
  db = invMissingRate.db;

  const reportRows = search(db, 'account.invoice.report').filter((r) => [invPriced.id, invMissingRate.id].includes(r.move_id));
  const prodRows = reportRows.filter((r) => r.product_id === prod.id);
  const nullOnlyRows = reportRows.filter((r) => r.product_id === noRateProd.id);
  assert.equal(prodRows.length, 2);
  assert.equal(prodRows.find((r) => r.move_id === invPriced.id).price_average, 100);
  assert.equal(prodRows.find((r) => r.move_id === invMissingRate.id).price_average, null);
  assert.equal(nullOnlyRows[0].price_average, null);

  // Average excludes null/undefined; empty/all-null yields null; sum keeps existing behavior
  assert.equal(aggregate(prodRows, 'price_average', 'account.invoice.report'), 100);
  assert.equal(aggregate([...prodRows, { price_average: undefined }], 'price_average', 'account.invoice.report'), 100);
  assert.equal(aggregate(nullOnlyRows, 'price_average', 'account.invoice.report'), null);
  assert.equal(aggregate([{ price_average: undefined }], 'price_average', 'account.invoice.report'), null);
  assert.equal(aggregate([], 'price_average', 'account.invoice.report'), null);
  assert.equal(aggregate(prodRows, 'price_subtotal', 'account.invoice.report'), 200);
  assert.equal(aggregate([], 'price_subtotal', 'account.invoice.report'), 0);

  // Render Graph, Pivot, and CSV export with null averages
  const { makeEl } = setupDom();
  globalThis.window = Object.assign(new EventTarget(), { scrollTo() {}, HTMLIFrameElement: class {}, document: globalThis.document });
  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  let capturedBlob = null;
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.click = () => {};
    return el;
  };
  const origCreateUrl = URL.createObjectURL;
  const origRevokeUrl = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { capturedBlob = blob; return 'blob:mock'; };
  URL.revokeObjectURL = () => {};

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Graph, formatMeasure } = await import('./views/Graph.jsx');
  const { Pivot } = await import('./views/Pivot.jsx');

  assert.equal(formatMeasure('account.invoice.report', 'price_average', null), '—');

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Graph, { db, model: 'account.invoice.report', records: reportRows, groupBy: ['product_id'] })));
    const measureSel = find(host, (n) => n.tagName === 'SELECT');
    await React.act(async () => props(measureSel).onChange({ target: { value: 'price_average' } }));
    const showTableBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n).includes('Show data table'));
    await React.act(async () => props(showTableBtn).onClick());
    assert.ok(!textOf(host).includes('NaN'));
    assert.ok(textOf(host).includes('No Rate Prod'));
    assert.ok(textOf(host).includes('—'));

    const lineBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Line');
    await React.act(async () => props(lineBtn).onClick());
    assert.ok(!textOf(host).includes('NaN'));

    await React.act(async () => root.render(React.createElement(Pivot, { db, model: 'account.invoice.report', records: reportRows, groupBy: ['product_id'] })));
    const pivotMeasure = find(host, (n) => n.tagName === 'SELECT');
    await React.act(async () => props(pivotMeasure).onChange({ target: { value: 'price_average' } }));
    assert.ok(!textOf(host).includes('NaN'));
    assert.ok(textOf(host).includes('—'));

    const exportBtn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n).includes('Export'));
    await React.act(async () => props(exportBtn).onClick());
    assert.ok(capturedBlob, 'CSV export produced a blob');
    const csvText = await capturedBlob.text();
    assert.ok(!csvText.includes('"null"'), `CSV should not contain "null": ${csvText}`);
  } finally {
    URL.createObjectURL = origCreateUrl;
    URL.revokeObjectURL = origRevokeUrl;
    globalThis.document.createElement = origCreate;
    await React.act(async () => root.unmount());
  }
});

test('Finding 3: every company keeps at least one resolvable report per statement kind across delete and write, while duplicates and custom reports can be removed', async () => {
  let db = seed();
  const co2 = createCompany(db, { name: 'Subsidiary' });
  db = co2.db;

  const bs = findStatementReport(db, 'balance', 1);
  const pnl = findStatementReport(db, 'pnl', 1);
  assert.ok(bs && pnl);
  const bs2 = findStatementReport(db, 'balance', co2.id);
  const pnl2 = findStatementReport(db, 'pnl', co2.id);
  assert.ok(bs2 && pnl2);

  const assertResolvable = (state) => {
    assert.ok(findStatementReport(state, 'balance', 1));
    assert.ok(findStatementReport(state, 'pnl', 1));
    assert.ok(findStatementReport(state, 'balance', co2.id));
    assert.ok(findStatementReport(state, 'pnl', co2.id));
  };

  // Renaming does not bypass protection
  db = write(db, 'account.report', bs.id, { name: 'Renamed Statement' });
  assertResolvable(db);

  // Last standard report of each (company, kind) cannot be deleted
  let errMsg = '';
  assert.throws(() => unlink(db, 'account.report', [bs.id]), (err) => {
    errMsg = err.message;
    return /at least one report/i.test(err.message);
  });
  assertResolvable(db);
  assert.throws(() => unlink(db, 'account.report', [pnl.id]), /at least one report/i);
  assertResolvable(db);
  assert.throws(() => unlink(db, 'account.report', [bs2.id]), /at least one report/i);
  assertResolvable(db);

  // Changing kind or company_id of the last standard report is blocked
  assert.throws(() => write(db, 'account.report', bs.id, { kind: '' }), /at least one report/i);
  assertResolvable(db);
  assert.throws(() => write(db, 'account.report', pnl.id, { kind: 'balance' }), /at least one report/i);
  assertResolvable(db);
  assert.throws(() => write(db, 'account.report', bs.id, { company_id: co2.id }), /at least one report/i);
  assertResolvable(db);
  assert.throws(() => write(db, 'account.report', pnl2.id, { company_id: 1 }), /at least one report/i);
  assertResolvable(db);

  // Archiving does not break statement lookup because findStatementReport falls back to inactive reports
  const archivedState = write(db, 'account.report', bs.id, { active: false });
  assert.equal(findStatementReport(archivedState, 'balance', 1)?.id, bs.id);

  // Verify Arabic translation exists and differs from English
  assert.ok(errMsg);
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import(`./i18n.js?qodo118_ar=${Date.now()}`);
    assert.notEqual(t(errMsg), errMsg, `Missing Arabic translation for: ${errMsg}`);
  } finally {
    globalThis.localStorage = prevStorage;
  }

  // Creating a duplicate standard report allows deleting one or changing its kind/company while one remains
  const sampleLine = { code: 'A', name: 'A', formula: '10', sequence: 10, parent_code: '', sign: 1, foldable: false, strong: false };
  const bsDup = create(db, 'account.report', {
    name: 'Alt Balance Sheet',
    kind: 'balance',
    company_id: 1,
    line_ids: [sampleLine],
  });
  const afterSingleDupDelete = unlink(bsDup.db, 'account.report', [bsDup.id]);
  assert.equal(read(afterSingleDupDelete, 'account.report', bsDup.id), undefined);
  assert.equal(findStatementReport(afterSingleDupDelete, 'balance', 1)?.id, bs.id);

  const afterDupRetype = write(bsDup.db, 'account.report', bsDup.id, { kind: '' });
  assert.equal(read(afterDupRetype, 'account.report', bsDup.id).kind, '');
  assert.equal(findStatementReport(afterDupRetype, 'balance', 1)?.id, bs.id);

  const afterDupMove = write(bsDup.db, 'account.report', bsDup.id, { company_id: co2.id });
  assert.equal(read(afterDupMove, 'account.report', bsDup.id).company_id, co2.id);
  assert.equal(findStatementReport(afterDupMove, 'balance', 1)?.id, bs.id);

  // Deleting all standard reports of a (company, kind) in one multi-record call is blocked
  assert.throws(() => unlink(bsDup.db, 'account.report', [bs.id, bsDup.id]), /at least one report/i);
  assertResolvable(bsDup.db);
  assert.throws(
    () => writeManyAtomic(bsDup.db, 'account.report', new Map([[bs.id, { kind: '' }], [bsDup.id, { kind: '' }]])),
    /at least one report/i,
  );
  assertResolvable(bsDup.db);

  // Non-standard report (even if named "Balance Sheet") can still be deleted
  const custom = create(db, 'account.report', {
    name: 'Balance Sheet',
    company_id: 1,
    line_ids: [sampleLine],
  });
  const afterDelete = unlink(custom.db, 'account.report', [custom.id]);
  assert.equal(read(afterDelete, 'account.report', custom.id), undefined);
  assertResolvable(afterDelete);
});
