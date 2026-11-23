import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { agedReportDate } from './models/finance.js';
import { createCompany, setCompanies } from './models/company.js';
import { create, read, write } from './orm.js';
import { valuationReport } from './models/valuation.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

async function render(report, db) {
  const { initStore, commit } = await import('./store.js');
  await initStore(); await commit(db);
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Reports } = await import('./views/Reports.jsx');
  return renderToStaticMarkup(React.createElement(Reports, { leaf: { report } }));
}

test('aged dates accept past and future, defaulting to today', async () => {
  assert.equal(agedReportDate('2099-01-01', '2026-01-01'), '2099-01-01');
  assert.equal(agedReportDate('2020-01-01', '2026-01-01'), '2020-01-01');
  assert.equal(agedReportDate('', '2026-01-01'), '2026-01-01');
  for (const report of ['agedReceivable', 'agedPayable']) {
    const html = await render(report, seed());
    assert.match(html, /aria-label="Partners"/);
    assert.doesNotMatch(html, /type="date" max=/);
  }
});

test('valuation offers the allowed company selector', async () => {
  const db = seed();
  const branch = createCompany(db, { name: 'Branch', currency_id: read(db, 'res.company', 1).currency_id });
  const scoped = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  for (const report of ['ledger', 'trial', 'partnerReceivable', 'partnerPayable', 'agedReceivable', 'agedPayable', 'fiscal', 'analytic', 'valuation']) {
    assert.match(await render(report, scoped), /aria-label="Company"/, report);
  }
});

test('valuation uses the selected period end', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./views/Reports.jsx', import.meta.url), 'utf8');
  assert.match(source, /valuationReport\(db,\s*\{\s*at:\s*period\.to/);
});

test('inalterability exposes and passes a journal filter', async () => {
  const html = await render('inalterability', seed());
  assert.match(html, /aria-label="Journal"/);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('./views/Reports.jsx', import.meta.url), 'utf8'), /checkInalterability\(db,\s*\{\s*companyId:\s*id,\s*journalId/);
});
test('valuation requires a single company and respects its stock scope', async () => {
  const base = seed();
  const branch = createCompany(base, { name: 'Branch', currency_id: read(base, 'res.company', 1).currency_id });
  const scoped = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const item = create(scoped, 'product', { name: 'Scoped stock', type: 'goods', cost: 7, qty_available: 0 });
  const db = structuredClone(item.db);
  db.records['stock.quant'] = [...(db.records['stock.quant'] ?? []),
    { product_id: item.id, company_id: 1, quantity: 2 },
    { product_id: item.id, company_id: branch.id, quantity: 3 }];
  assert.equal(valuationReport(db, { companyId: branch.id })[item.id].value, 21);
  const html = await render('valuation', db);
  assert.doesNotMatch(html.match(/<select aria-label="Company">.*?<\/select>/)[0], /<option value="all"/);
});

test('historical valuation does not present legacy balances as historical', () => {
  const item = create(seed(), 'product', { name: 'Legacy stock', type: 'goods', cost: 9, qty_available: 4 });
  assert.deepEqual(valuationReport(item.db, { at: '2000-01-01' })[item.id], { qty: null, value: null, unitCost: null });
  assert.equal(valuationReport(item.db)[item.id].value, 36);
});

test('inalterability journal filter includes archived journals only for that report', async () => {
  const db = seed();
  const journal = db.records['account.journal'][0];
  const archived = write(db, 'account.journal', journal.id, { active: false, name: 'Archived review journal' });
  assert.match(await render('inalterability', archived), /Archived review journal/);
  assert.doesNotMatch(await render('ledger', archived), /Archived review journal/);
});

test('valuation assigns unowned legacy stock to company 1 even when current company is a branch', () => {
  const base = seed();
  const branch = createCompany(base, { name: 'Branch', currency_id: read(base, 'res.company', 1).currency_id });
  const scoped = setCompanies(branch.db, { current: branch.id, allowed: [1, branch.id] });
  const item = create(scoped, 'product', { name: 'Legacy unowned stock', type: 'goods', cost: 10, qty_available: 5 });
  const db = structuredClone(item.db);
  db.records['stock.quant'] = (db.records['stock.quant'] ?? []).filter((q) => q.product_id !== item.id);
  const rep1 = valuationReport(db, { companyId: 1 });
  const rep2 = valuationReport(db, { companyId: branch.id });
  assert.equal(rep1[item.id].qty, 5);
  assert.equal(rep1[item.id].value, 50);
  assert.equal(rep2[item.id].qty, 0);
  assert.equal(rep2[item.id].value, 0);
});

test('past valuation for company 1 retains numeric total when company 2 has its own products', async () => {
  const base = seed();
  const branch = createCompany(base, { name: 'Branch', currency_id: read(base, 'res.company', 1).currency_id });
  const scoped = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const item1 = create(scoped, 'product', { name: 'Comp1 product', type: 'goods', cost: 10, company_id: 1 });
  const item2 = create(item1.db, 'product', { name: 'Comp2 product', type: 'goods', cost: 20, company_id: branch.id });
  const sharedItem = create(item2.db, 'product', { name: 'Shared product', type: 'goods', cost: 15, company_id: null });
  let db = structuredClone(sharedItem.db);
  db.records['stock.valuation.layer'] = [
    ...(db.records['stock.valuation.layer'] ?? []),
    { id: 9991, product_id: item1.id, company_id: 1, date: '2025-01-01', quantity: 5, value: 50, unit_cost: 10, kind: 'in' },
    { id: 9992, product_id: item2.id, company_id: branch.id, date: '2025-01-01', quantity: 3, value: 60, unit_cost: 20, kind: 'in' },
    { id: 9993, product_id: sharedItem.id, company_id: 1, date: '2025-01-01', quantity: 2, value: 30, unit_cost: 15, kind: 'in' },
  ];

  const rep1 = valuationReport(db, { at: '2025-06-01', companyId: 1 });
  assert.equal(rep1[item1.id]?.value, 50);
  assert.equal(rep1[sharedItem.id]?.value, 30);
  assert.equal(rep1[item2.id], undefined, 'company 2 product should not be in company 1 valuation');
  assert.equal(Object.values(rep1).some((v) => v.qty === null), false, 'company 1 valuation should have no unavailable products');

  const { REPORTS } = await import('./views/Reports.jsx');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const html = renderToStaticMarkup(React.createElement(REPORTS.valuation.Body, {
    db,
    period: { to: '2025-06-01' },
    companyId: 1,
  }));
  assert.doesNotMatch(html, /Historical valuation unavailable/);
  assert.doesNotMatch(html, /Comp2 product/);
  assert.match(html, /27,832\.00/);

  const rep2 = valuationReport(db, { at: '2025-06-01', companyId: branch.id });
  assert.equal(rep2[item2.id]?.value, 60);
  assert.equal(rep2[item1.id], undefined, 'company 1 product should not be in company 2 valuation');
  assert.equal(rep2[sharedItem.id]?.qty, 0, 'shared product with no company 2 layers has 0 qty');
  assert.equal(Object.values(rep2).some((v) => v.qty === null), false, 'company 2 valuation should have no unavailable products');

  const html2 = renderToStaticMarkup(React.createElement(REPORTS.valuation.Body, {
    db,
    period: { to: '2025-06-01' },
    companyId: branch.id,
  }));
  assert.doesNotMatch(html2, /Historical valuation unavailable/);
  assert.doesNotMatch(html2, /Comp1 product/);
  assert.match(html2, /60\.00/);
});
