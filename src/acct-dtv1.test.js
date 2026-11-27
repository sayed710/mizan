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
  assert.equal(customPeriodError('custom', { from: '', to: '2026-12-31' }, { requireFrom: true }), 'Enter a From date');
  assert.equal(customPeriodError('custom', { from: '', to: '' }, { requireFrom: true }), 'Enter both From and To dates');
  assert.equal(customPeriodError('custom', { from: '2026-01-01', to: '' }, { requireFrom: true }), 'Enter a To date');
  assert.equal(customPeriodError('custom', { from: '2026-01-01', to: '2026-12-31' }, { requireFrom: true }), null);
  assert.equal(customPeriodError('year', { from: '', to: '' }, { requireFrom: true }), null);
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
    const bsPeriod = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'today');
    assert.ok(bsPeriod);
    await React.act(async () => props(bsPeriod).onChange({ target: { value: 'custom' } }));
    assert.equal(findDateInputs(host).length, 1);
    const [bsTo] = findDateInputs(host);
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

test('DTV-1 regression: clearing From with an active comparison shows inline error instead of crashing in ConfigurableReport and Reports', async () => {
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
      { account_id: cashAcc.id, debit: 500 },
      { account_id: revAcc.id, credit: 500 },
    ],
  }).db;
  const customRep = create(db, 'account.report', {
    name: 'DTV Comparison Custom Report',
    company_id: 1,
    date_scope: 'range',
    line_ids: [{ name: 'Sales', code: 'SALES', sequence: 10, parent_code: '', formula: '400', sign: -1, foldable: false, strong: true }],
  });
  db = customRep.db;
  await React.act(async () => commit(db));

  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  const findActionBtn = (label) => find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === label);
  const assertActionsDisabled = (disabled) => {
    for (const label of ['Print', 'Download CSV', 'Export XLSX']) {
      assert.equal(Boolean(props(findActionBtn(label))?.disabled), disabled, `${label} disabled=${disabled}`);
    }
  };

  try {
    // 1. ConfigurableReportPage (P&L and Balance Sheet)
    for (const [statementKind, title] of [['pnl', 'Profit and Loss'], ['balance', 'Balance Sheet']]) {
      await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { key: `cmp-${statementKind}`, statementKind, title })));
      if (statementKind === 'balance') {
        const asOf = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'today');
        assert.ok(asOf);
        await React.act(async () => props(asOf).onChange({ target: { value: 'custom' } }));
        const dates = findDateInputs(host);
        assert.equal(dates.length, 1);
        await React.act(async () => props(dates[0]).onChange({ target: { value: '' } }));
        assert.equal(textOf(findAlert(host)), 'Enter a To date');
        assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);
        assertActionsDisabled(true);
        continue;
      }
      const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
      await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
      const [fromInput] = findDateInputs(host);
      await React.act(async () => props(fromInput).onChange({ target: { value: '' } }));

      // Non-comparison empty From remains valid
      assert.equal(findAlert(host), null, `${statementKind} allows empty From without comparison`);
      assert.ok(find(host, (n) => n.tagName === 'TABLE'));
      assertActionsDisabled(false);

      // Selecting each comparison mode shows inline error instead of crashing
      for (const mode of ['previous', 'lastYear', 'last3']) {
        const compSelect = find(host, (n) => n.tagName === 'SELECT' && ['none', 'previous', 'lastYear', 'last3'].includes(props(n)?.value));
        await React.act(async () => props(compSelect).onChange({ target: { value: mode } }));
        assert.equal(textOf(findAlert(host)), 'Enter a From date', `${statementKind} (${mode}) must show inline From error`);
        assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);
        assertActionsDisabled(true);
      }

      // Entering From restores comparison table
      const [fromAgain] = findDateInputs(host);
      await React.act(async () => props(fromAgain).onChange({ target: { value: `${yr}-01-01` } }));
      assert.equal(findAlert(host), null);
      assert.ok(find(host, (n) => n.tagName === 'TABLE'));
      assertActionsDisabled(false);
    }

    // 2. ConfigurableReportPage custom account.report (always custom period)
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { key: 'cmp-custom', id: customRep.id })));
    const compSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Comparison');
    await React.act(async () => props(compSelect).onChange({ target: { value: 'previous' } }));
    const [custFrom] = findDateInputs(host);
    await React.act(async () => props(custFrom).onChange({ target: { value: '' } }));
    assert.equal(textOf(findAlert(host)), 'Enter a From date');
    assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);
    assertActionsDisabled(true);

    // 3. Reports.jsx comparable reports (P&L, Balance Sheet, Cash Flow, Executive, Trial, Tax, Fiscal)
    for (const report of ['pnl', 'balance', 'cashflow', 'executive', 'trial', 'tax', 'fiscal']) {
      await React.act(async () => root.render(React.createElement(Reports, { key: `rep-${report}`, leaf: { report, key: report } })));
      if (report === 'balance') {
        const asOf = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'today');
        assert.ok(asOf);
        await React.act(async () => props(asOf).onChange({ target: { value: 'custom' } }));
        const dates = findDateInputs(host);
        assert.equal(dates.length, 1);
        await React.act(async () => props(dates[0]).onChange({ target: { value: '' } }));
        assert.equal(textOf(findAlert(host)), 'Enter a To date');
        assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);
        assertActionsDisabled(true);
        continue;
      }
      const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
      await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
      const [rFrom] = findDateInputs(host);
      await React.act(async () => props(rFrom).onChange({ target: { value: '' } }));

      assert.equal(findAlert(host), null, `${report} allows empty From without comparison`);
      assert.ok(find(host, (n) => n.tagName === 'TABLE'));

      const comp = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'none');
      await React.act(async () => props(comp).onChange({ target: { value: 'previous' } }));
      assert.equal(textOf(findAlert(host)), 'Enter a From date', `${report} must show inline From error when comparison is active`);
      assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);
      assertActionsDisabled(true);

      await React.act(async () => props(comp).onChange({ target: { value: 'none' } }));
      assert.equal(findAlert(host), null);
      assert.ok(find(host, (n) => n.tagName === 'TABLE'));
      assertActionsDisabled(false);
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('DTV-2 regression: ConfigurableReportPage logs unexpected computation error with stack and context while showing inline alert', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/reports/custom' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  // Bypass ORM validation to store a broken custom report whose computation throws inside compareConfigurableReport.
  const brokenId = 99001;
  db = {
    ...db,
    records: {
      ...db.records,
      'account.report': [
        ...(db.records['account.report'] ?? []),
        { id: brokenId, name: 'Broken Report', company_id: 1, date_scope: 'range', active: true, line_ids: null },
      ],
    },
  };
  await React.act(async () => commit(db));

  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  const logged = [];
  const origError = console.error;
  console.error = (...args) => logged.push(args);
  try {
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { id: brokenId })));

    const alert = findAlert(host);
    assert.ok(alert, 'Inline alert must render on computation failure');
    assert.ok(textOf(alert).length > 0);
    assert.equal(find(host, (n) => n.tagName === 'TABLE'), null);
    for (const label of ['Print', 'Download CSV', 'Export XLSX']) {
      const btn = find(host, (n) => n.tagName === 'BUTTON' && textOf(n) === label);
      assert.equal(Boolean(props(btn)?.disabled), true, `${label} must be disabled when report computation fails`);
    }

    const reportLog = logged.find((args) => args.some((a) => a instanceof Error));
    assert.ok(reportLog, 'Original exception must be logged via console.error');
    const errArg = reportLog.find((a) => a instanceof Error);
    assert.ok(errArg.stack && errArg.stack.includes('configurableReport'), 'Logged error must include stack trace');
    const ctxArg = reportLog.find((a) => a && typeof a === 'object' && !(a instanceof Error));
    assert.equal(ctxArg?.reportId, brokenId);
  } finally {
    console.error = origError;
    await React.act(async () => root.unmount());
  }
});

test('DTV-1 i18n: Arabic translations exist for new custom From date errors', async () => {
  globalThis.localStorage = { getItem: () => 'ar', setItem() {} };
  try {
    const { t } = await import(`./i18n.js?dtv1-ar=${Date.now()}`);
    assert.notEqual(t('Enter a From date'), 'Enter a From date');
    assert.notEqual(t('Enter both From and To dates'), 'Enter both From and To dates');
  } finally {
    delete globalThis.localStorage;
  }
});
