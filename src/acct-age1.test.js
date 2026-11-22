import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { agedBalance } from './models/finance.js';

const db = { records: {
  'res.company': [{ id: 1, currency_id: 1 }],
  'res.currency': [{ id: 1, rounding: 0.01 }],
  'account.account': [{ id: 1, account_type: 'asset_receivable' }, { id: 2, account_type: 'liability_payable' }],
  'account.move': ['out_invoice', 'in_invoice'].map((move_type, i) => ({ id: i + 1, name: 'Invoice', state: 'posted', move_type, partner_id: i + 1, invoice_date: '2025-01-01', invoice_date_due: '2025-04-01', line_ids: [{ account_id: i + 1, debit: 100, date_maturity: '2025-04-01' }] })),
  'account.payment': [],
}, settings: { base_currency_id: 1 } };

test('AGE-1: configurable intervals include four ranges and respect boundaries', () => {
  const defaults = agedBalance(db, 'receivable', '2025-05-31');
  assert.deepEqual(defaults.buckets.map(([, label]) => label), ['At Date', '1-30', '31-60', '61-90', '91-120', 'Older']);
  const result = agedBalance(db, 'receivable', '2025-05-31', null, { aging_interval: 15 });
  assert.deepEqual(result.buckets.map(([, label]) => label), ['At Date', '1-15', '16-30', '31-45', '46-60', 'Older']);
  assert.equal(result.rows[0]['46_60'], 100);
  assert.equal(agedBalance(db, 'receivable', '2025-06-01', null, { aging_interval: 15 }).rows[0].older, 100);
});

test('AGE-2: invoice date basis applies to receivables and payables', () => {
  for (const kind of ['receivable', 'payable']) {
    assert.equal(agedBalance(db, kind, '2025-04-15').rows[0]['1_30'], 100);
    const row = agedBalance(db, kind, '2025-04-15', null, { aging_based_on: 'base_on_invoice_date' }).rows[0];
    assert.equal(row['91_120'], 100);
    assert.equal(row.invoices[0]['91_120'], 100);
    assert.equal(row.invoices[0].invoice_date, '2025-01-01');
    assert.equal(agedBalance(db, kind, '2025-04-15', null, { aging_based_on: 'base_on_maturity_date' }).rows[0]['1_30'], 100);
  }
});

import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const reactProps = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const nodeText = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(nodeText).join('');

for (const [report, title] of [['agedReceivable', 'AGE-1 aged filters'], ['tax', 'AGE-2 tax comparison'], ['fiscal', 'AGE-3 fiscal comparison']]) {
  test(title, async () => {
    const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
    const React = await import('react'); const { createRoot } = await import('react-dom/client');
    const { initStore } = await import('./store.js'); await initStore();
    const { Reports } = await import('./views/Reports.jsx');
    const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
    try {
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report } })));
      if (report === 'agedReceivable') {
        assert.ok(find(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'date'));
        assert.ok(find(host, (n) => n.tagName === 'SELECT' && reactProps(n)?.['aria-label'] === 'Partners'));
      } else {
        const select = find(host, (n) => n.tagName === 'SELECT' && reactProps(n)?.value === 'none');
        assert.ok(select); await React.act(async () => reactProps(select).onChange({ target: { value: 'previous' } }));
        assert.match(nodeText(host), report === 'tax' ? /Base/ : /Debit/);
        assert.ok(find(host, (n) => n.tagName === 'TH' && nodeText(n).includes(' - ')));
      }
    } finally { await React.act(async () => root.unmount()); }
  });
}


import { detailReportColumns } from './views/reportCompare.js';
const reportPeriods = [{ from: '2025-01-01', to: '2025-01-31', label: 'Jan' }, { from: '2025-02-01', to: '2025-02-28', label: 'Feb' }];
const reportDb = { records: {
  'res.company': [{ id: 1, currency_id: 1 }, { id: 2, currency_id: 1 }],
  'res.currency': [{ id: 1, rounding: 0.01 }],
  'account.account': [{ id: 1, code: '100', name: 'Receivable', account_type: 'asset_receivable', fiscal_category_id: 1 }, { id: 2, code: '200', name: 'Tax', account_type: 'liability_current', fiscal_category_id: 1 }],
  'account.fiscal.category': [{ id: 1, name: 'Category' }],
  'account.move': [
    { id: 10, name: 'January', state: 'posted', move_type: 'entry', company_id: 1, date: '2025-01-10', line_ids: [{ account_id: 1, partner_id: 1, debit: 100, credit: 0, date_maturity: '2025-01-15' }, { account_id: 2, debit: 0, credit: 10, tax_side: 'sale', tax_name: 'VAT A', tax_id: 11, tax_base: 100 }] },
    { id: 11, name: 'February', state: 'posted', move_type: 'entry', company_id: 1, date: '2025-02-10', line_ids: [{ account_id: 1, partner_id: 1, debit: 0, credit: 40 }, { account_id: 2, debit: 0, credit: 20, tax_side: 'sale', tax_name: 'VAT B', tax_id: 12, tax_base: 200 }] },
    { id: 12, name: 'Other company', state: 'posted', move_type: 'entry', company_id: 2, date: '2025-02-11', line_ids: [{ account_id: 1, partner_id: 2, debit: 900, credit: 0 }, { account_id: 2, debit: 0, credit: 90, tax_side: 'sale', tax_name: 'VAT B', tax_id: 12 }] },
  ],
  'account.partial.reconcile': [{ id: 1, debit_move_id: 10, debit_line_index: 0, credit_move_id: 11, credit_line_index: 0, amount: 40, date: '2025-02-10', active: true }],
  'account.payment': [], 'account.tax': [],
}, settings: { base_currency_id: 1, current_company_id: 1, allowed_company_ids: [1, 2] } };

test('AGE-1 uses as-of reconciliation and company for manual receivable journal items', () => {
  const jan = agedBalance(reportDb, 'receivable', '2025-01-31', 1);
  assert.equal(jan.rows[0].partner_id, 1);
  assert.equal(jan.rows[0].total, 100);
  assert.equal(jan.rows[0]['1_30'], 100);
  const feb = agedBalance(reportDb, 'receivable', '2025-02-28', 1);
  assert.equal(feb.rows[0].total, 60);
  assert.equal(agedBalance(reportDb, 'receivable', '2025-02-28', 2).rows[0].total, 900);
});

test('AGE-2 aligns taxes by identity and excludes another company in each period', () => {
  const result = detailReportColumns(reportDb, 'tax', reportPeriods, { company_id: 1 });
  const a = result.rows.find((row) => row.label === 'VAT A');
  const b = result.rows.find((row) => row.label === 'VAT B');
  assert.deepEqual(a.columns.map((c) => c?.values[1] ?? 0), [10, 0]);
  assert.deepEqual(b.columns.map((c) => c?.values[1] ?? 0), [0, 20]);
  assert.deepEqual(result.rows.find((row) => row.label === 'Output Tax').columns.map((c) => c.values[1]), [10, 20]);
});

test('AGE-3 fiscal comparison aligns account and category movements for selected company', () => {
  const result = detailReportColumns(reportDb, 'fiscal', reportPeriods, { company_id: 1 });
  const account = result.rows.find((row) => row.accountId === 1);
  assert.deepEqual(account.columns.map((c) => c.values), [[100, 0, 100], [0, 40, -40]]);
  const category = result.rows.find((row) => row.label === 'Category');
  assert.deepEqual(category.columns.map((c) => c.values), [[100, 10, 90], [0, 60, -60]]);
});


test('AGE-1 aged report applies selected company, partner and custom cutoff in the view', async () => {
  const { makeEl } = setupDom(); globalThis.location = { hash: '#/accounting' };
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js'); await initStore();
  const base = getDb(); const account = base.records['account.account'].find((a) => a.account_type === 'asset_receivable');
  const company = base.records['res.company'][0];
  const makeMove = (id, companyId, partnerId, date, amount) => ({ id, name: `AGE-${id}`, state: 'posted', move_type: 'entry', company_id: companyId, date, line_ids: [{ account_id: account.id, partner_id: partnerId, debit: amount, credit: 0 }] });
  const data = { ...base, settings: { ...base.settings, current_company_id: company.id, allowed_company_ids: [company.id, 999] }, records: { ...base.records,
    'res.company': [...base.records['res.company'], { ...company, id: 999, name: 'Other Company' }],
    'res.partner': [...base.records['res.partner'], { id: 991, name: 'Selected Partner' }, { id: 992, name: 'Other Partner' }],
    'account.move': [makeMove(991, company.id, 991, '2025-01-01', 101), makeMove(992, company.id, 992, '2025-01-01', 202), makeMove(993, 999, 991, '2025-01-01', 303), makeMove(994, company.id, 991, '2025-03-01', 404)] } };
  await React.act(async () => commit(data));
  const { Reports } = await import('./views/Reports.jsx'); const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'agedReceivable' } })));
    const cutoff = find(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'date');
    await React.act(async () => reactProps(cutoff).onChange({ target: { value: '2025-02-01' } }));
    const companySelect = find(host, (n) => n.tagName === 'SELECT' && reactProps(n)?.['aria-label'] === 'Company');
    await React.act(async () => reactProps(companySelect).onChange({ target: { value: String(company.id) } }));
    const partners = find(host, (n) => n.tagName === 'SELECT' && reactProps(n)?.['aria-label'] === 'Partners');
    await React.act(async () => reactProps(partners).onChange({ target: { selectedOptions: [{ value: '991' }] } }));
    assert.match(nodeText(host), /Selected Partner/); assert.doesNotMatch(nodeText(host), /\$202\.00/);
    assert.match(nodeText(host), /101/); assert.doesNotMatch(nodeText(host), /\$(?:303|404)\.00/);
  } finally { await React.act(async () => root.unmount()); }
});
