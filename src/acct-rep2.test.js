import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { agedReportDate } from './models/finance.js';
import { createCompany, setCompanies } from './models/company.js';
import { read } from './orm.js';
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
