import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { today } from './models/common.js';
import { customPeriodError } from './views/reportNavigation.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const findAlert = (host) => find(host, (n) => props(n)?.role === 'alert');
const findDateInputs = (host) => {
  const inputs = [];
  const walk = (n) => {
    if (!n) return;
    if (n.tagName === 'INPUT' && props(n)?.type === 'date') inputs.push(n);
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(host);
  return inputs;
};

test('DTV-1: canonical reportNavigation customPeriodError validates custom ranges', () => {
  assert.equal(customPeriodError('year', { from: '', to: '' }), null);
  assert.equal(customPeriodError('all', { from: '', to: '9999-12-31' }), null);
  assert.equal(customPeriodError('custom', { from: '2026-01-01', to: '2026-12-31' }), null);
  assert.equal(customPeriodError('custom', { from: '2026-01-01', to: '2026-12-31' }), null);

  assert.equal(customPeriodError('custom', { from: '', to: '2026-12-31' }), null);
  assert.equal(customPeriodError('custom', { from: '2026-01-01', to: '' }), 'Enter a To date');
  assert.equal(customPeriodError('custom', { from: '2026-02-30', to: '2026-03-01' }), 'Enter valid From and To dates');
  assert.equal(customPeriodError('custom', { from: '2026-01-01', to: 'not-a-date' }), 'Enter valid From and To dates');
  assert.equal(customPeriodError('custom', { from: '2026-12-31', to: '2026-01-01' }), 'From date cannot be after To date');
  assert.notEqual(customPeriodError('custom', { from: '2026-12-31', to: '2026-01-01' }), null);
});

test('DTV-1: ConfigurableReportPage (P&L, Balance Sheet, custom report) shows inline error and does not compute on invalid custom From/To', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reports/pnl' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-03-10`,
    lines: [
      { account_id: cashAcc.id, debit: 1234 },
      { account_id: revAcc.id, credit: 1234 },
    ],
  }).db;
  const customRep = create(db, 'account.report', {
    name: 'DTV Custom Revenue',
    company_id: 1,
    date_scope: 'range',
    line_ids: [{ name: 'Sales', code: 'SALES', sequence: 10, parent_code: '', formula: '400', sign: -1, foldable: false, strong: true }],
  });
  db = customRep.db;
  await React.act(async () => commit(db));

  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    // 1. P&L with comparison active + custom invalid ranges
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { statementKind: 'pnl', title: 'Profit and Loss' })));
    assert.ok(host.textContent.includes('$1,234.00'));

    const compSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'none');
    await React.act(async () => props(compSelect).onChange({ target: { value: 'previous' } }));
    assert.ok(host.textContent.includes('Variance'), 'Comparison active before custom period');

    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));

    for (const [badFrom, badTo, expectedMsg] of [
      [`${yr}-01-01`, '', 'Enter a To date'],
      [`${yr}-02-30`, `${yr}-12-31`, 'Enter valid From and To dates'],
      [`${yr}-12-31`, `${yr}-01-01`, 'From date cannot be after To date'],
    ]) {
      const [fromInput, toInput] = findDateInputs(host);
      await React.act(async () => props(fromInput).onChange({ target: { value: badFrom } }));
      await React.act(async () => props(toInput).onChange({ target: { value: badTo } }));

      const alert = findAlert(host);
      assert.ok(alert, `Alert expected for ${badFrom}..${badTo}`);
      assert.equal(textOf(alert), expectedMsg);
      assert.equal(find(host, (n) => n.tagName === 'TABLE'), null, 'Report table must not render/compute with invalid range');
      assert.ok(!host.textContent.includes('$1,234.00'));
    }

    // Fixing the custom range restores computation AND preserves comparison (no silent collapse)
    const [fromInput, toInput] = findDateInputs(host);
    await React.act(async () => props(fromInput).onChange({ target: { value: `${yr}-01-01` } }));
    await React.act(async () => props(toInput).onChange({ target: { value: `${yr}-12-31` } }));
    assert.equal(findAlert(host), null);
    assert.ok(find(host, (n) => n.tagName === 'TABLE'));
    assert.ok(host.textContent.includes('Variance'), 'Comparison must remain active after fixing custom range');
    assert.ok(host.textContent.includes('$1,234.00'));

    // 2. Balance Sheet with invalid custom range
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { key: 'bs', statementKind: 'balance', title: 'Balance Sheet' })));
    const bsPeriod = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(bsPeriod).onChange({ target: { value: 'custom' } }));
    const [, bsTo] = findDateInputs(host);
    await React.act(async () => props(bsTo).onChange({ target: { value: '' } }));
    assert.equal(textOf(findAlert(host)), 'Enter a To date');
    assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);

    // 3. Custom configurable report (always custom dates)
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { key: 'custom', id: customRep.id })));
    assert.ok(host.textContent.includes('$1,234.00'));
    const [custFrom, custTo] = findDateInputs(host);
    await React.act(async () => props(custFrom).onChange({ target: { value: `${yr}-11-01` } }));
    await React.act(async () => props(custTo).onChange({ target: { value: `${yr}-01-01` } }));
    assert.equal(textOf(findAlert(host)), 'From date cannot be after To date');
    assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('DTV-1: Reports.jsx (General Ledger, Trial Balance, Cash Flow, and other period reports) shows inline error and skips computing on invalid custom From/To', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/general-ledger' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const yr = Number(today().slice(0, 4));
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: `${yr}-03-10`,
    lines: [
      { account_id: cashAcc.id, debit: 777 },
      { account_id: revAcc.id, credit: 777 },
    ],
  }).db;
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    // 1. General Ledger: verify bad range does NOT compute with raw range
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'ledger', key: 'general-ledger' } })));
    assert.ok(host.textContent.includes('$777.00'));

    const ledgerPeriod = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(ledgerPeriod).onChange({ target: { value: 'custom' } }));

    for (const [badFrom, badTo, expectedMsg] of [
      [`${yr}-01-01`, '', 'Enter a To date'],
      [`${yr}-02-30`, `${yr}-12-31`, 'Enter valid From and To dates'],
      [`${yr}-06-01`, `${yr}-02-01`, 'From date cannot be after To date'],
    ]) {
      const [fromInput, toInput] = findDateInputs(host);
      await React.act(async () => props(fromInput).onChange({ target: { value: badFrom } }));
      await React.act(async () => props(toInput).onChange({ target: { value: badTo } }));

      const alert = findAlert(host);
      assert.ok(alert, `Ledger alert expected for ${badFrom}..${badTo}`);
      assert.equal(textOf(alert), expectedMsg);
      assert.equal(find(host, (n) => n.tagName === 'TABLE'), null, 'General Ledger must not compute/render table with bad range');
      assert.ok(!host.textContent.includes('$777.00'));
    }

    const [fromInput, toInput] = findDateInputs(host);
    await React.act(async () => props(fromInput).onChange({ target: { value: `${yr}-01-01` } }));
    await React.act(async () => props(toInput).onChange({ target: { value: `${yr}-12-31` } }));
    assert.equal(findAlert(host), null);
    assert.ok(host.textContent.includes('$777.00'));

    // 2. Trial Balance with comparison active
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'trial', key: 'trial-balance' } })));
    const trialComp = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'none');
    await React.act(async () => props(trialComp).onChange({ target: { value: 'previous' } }));
    const trialPeriod = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(trialPeriod).onChange({ target: { value: 'custom' } }));
    const [trialFrom, trialTo] = findDateInputs(host);
    await React.act(async () => props(trialFrom).onChange({ target: { value: `${yr}-09-01` } }));
    await React.act(async () => props(trialTo).onChange({ target: { value: `${yr}-01-01` } }));
    assert.equal(textOf(findAlert(host)), 'From date cannot be after To date');
    assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);
    await React.act(async () => props(trialFrom).onChange({ target: { value: `${yr}-01-01` } }));
    await React.act(async () => props(trialTo).onChange({ target: { value: `${yr}-12-31` } }));
    assert.equal(findAlert(host), null);
    assert.ok((host.textContent.match(/Initial Balance/g) ?? []).length >= 2, 'Trial Balance comparison preserved after fixing dates');

    // 3. Cash Flow & other period reports
    for (const report of ['cashflow', 'executive', 'tax', 'fiscal', 'journalAudit', 'analytic']) {
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report, key: report } })));
      const sel = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
      await React.act(async () => props(sel).onChange({ target: { value: 'custom' } }));
      const [rFrom] = findDateInputs(host);
      await React.act(async () => props(rFrom).onChange({ target: { value: '2026-13-45' } }));
      assert.equal(textOf(findAlert(host)), 'Enter valid From and To dates', `${report} must show inline date error`);
      assert.equal(find(host, (n) => n.tagName === 'TABLE'), null, `${report} must not render table with invalid custom dates`);
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('DTV-2: Invalid horizontal group selection in ConfigurableReport surfaces an inline error instead of an uncaught throw', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reports/pnl' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  // Create a second company without its own statement report (so statementKind='pnl' falls back to company 1's report),
  // plus a horizontal group belonging to company 2 so selecting it triggers configurableReport's company/report mismatch throw.
  db = {
    ...db,
    settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1, 2] },
    records: {
      ...db.records,
      'res.company': [
        ...db.records['res.company'],
        { id: 2, name: 'Branch Without Reports', currency_id: db.records['res.company'][0].currency_id },
      ],
    },
  };
  const branchGroup = create(db, 'account.report.horizontal.group', {
    name: 'Branch Group',
    company_id: 2,
    rule_ids: [{ field: 'partner', partner_ids: [1] }],
  });
  db = branchGroup.db;
  const company1Group = create(db, 'account.report.horizontal.group', {
    name: 'Main Group',
    company_id: 1,
    rule_ids: [{ field: 'partner', partner_ids: [1] }],
  });
  db = company1Group.db;
  await React.act(async () => commit(db));

  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { statementKind: 'pnl', title: 'Profit and Loss' })));
    const companySelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Company');
    await React.act(async () => props(companySelect).onChange({ target: { value: '2' } }));

    // Case 1: Select Branch Group (valid in dropdown for company 2, but invalid for company 1 fallback report -> configurableReport throws)
    const groupSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Horizontal Group');
    assert.ok(groupSelect, 'Horizontal Group selector rendered');
    await React.act(async () => props(groupSelect).onChange({ target: { value: String(branchGroup.id) } }));

    const alert1 = findAlert(host);
    assert.ok(alert1, 'Inline alert must render instead of uncaught throw');
    assert.equal(textOf(alert1), 'Horizontal group is not available for this report');
    assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);

    // Clearing back to None recovers cleanly
    await React.act(async () => props(groupSelect).onChange({ target: { value: '' } }));
    assert.equal(findAlert(host), null);
    assert.ok(find(host, (n) => n.tagName === 'TABLE'));

    // Case 2: Select an ineligible/non-existent group ID (e.g. company 1 group or unknown 999999)
    await React.act(async () => props(groupSelect).onChange({ target: { value: String(company1Group.id) } }));
    const alert2 = findAlert(host);
    assert.ok(alert2, 'Inline alert must render for ineligible horizontal group ID');
    assert.equal(textOf(alert2), 'Horizontal group is not available for this report');
    assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);

    await React.act(async () => props(groupSelect).onChange({ target: { value: '999999' } }));
    assert.equal(textOf(findAlert(host)), 'Horizontal group is not available for this report');

    // Recover cleanly
    await React.act(async () => props(groupSelect).onChange({ target: { value: '' } }));
    assert.equal(findAlert(host), null);
    assert.ok(find(host, (n) => n.tagName === 'TABLE'));
  } finally {
    await React.act(async () => root.unmount());
  }
});
