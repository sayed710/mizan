import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { accountId, journalId, postEntry } from './models/ledger.js';
import { today } from './models/common.js';
import { configurableReport } from './models/configurableReports.js';
import { findStatementReport } from './models/statementReports.js';
import { cashFlow, executiveSummary, reportReviewMode, trialBalance } from './models/reports.js';
import { applyDiff, diffDb } from './sync.js';
import { balanceAnalyticColumns, periodsFor, pnlAnalyticColumns } from './views/reportCompare.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const collectAll = (node, pred, out = []) => {
  if (pred(node)) out.push(node);
  for (const child of node.childNodes ?? []) collectAll(child, pred, out);
  return out;
};
const rendered = async (React, container, text) => {
  for (let i = 0; i < 200 && !container.textContent.includes(text); i++) {
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
};

function cleanReportingFixture() {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const date = `${today().slice(0, 4)}-04-15`;
  // Posted sale: 100 in MISC
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date,
    lines: [
      { account: '101401', debit: 100 },
      { account: '400000', credit: 100 },
    ],
  }).db;
  // Draft entry: 250 in SAL (should only show when include unposted is enabled)
  const draft = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    journal_id: journalId(db, 'SAL'),
    company_id: 1,
    date,
    invoice_date: date,
    line_ids: [
      { account_id: accountId(db, '101401'), debit: 250, credit: 0 },
      { account_id: accountId(db, '400000'), debit: 0, credit: 250 },
    ],
  });
  db = draft.db;
  // Cancelled entry: 999 (must NEVER show even with unposted enabled)
  const cancelled = create(db, 'account.move', {
    move_type: 'entry',
    state: 'cancel',
    journal_id: journalId(db, 'MISC'),
    company_id: 1,
    date,
    invoice_date: date,
    line_ids: [
      { account_id: accountId(db, '101401'), debit: 999, credit: 0 },
      { account_id: accountId(db, '400000'), debit: 0, credit: 999 },
    ],
  });
  db = cancelled.db;
  return { db, date, yr: today().slice(0, 4) };
}

test('FIN-5: include unposted entries option passes reviewMode through to journalItems across configurable and standard reports', async () => {
  const { db, yr } = cleanReportingFixture();
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31` };
  const pnlRep = findStatementReport(db, 'pnl', 1);
  const bsRep = findStatementReport(db, 'balance', 1);

  assert.equal(configurableReport(db, pnlRep, period).rows.find((r) => r.code === 'NET').values[0], 100);
  assert.equal(configurableReport(db, pnlRep, period, null, { includeUnposted: true }).rows.find((r) => r.code === 'NET').values[0], 350);

  const bsWithDraft = configurableReport(db, bsRep, period, null, { includeUnposted: true });
  assert.equal(bsWithDraft.rows.find((r) => r.code === 'ASSETS').values[0], 350);
  assert.equal(bsWithDraft.rows.find((r) => r.code === 'LIAB_EQUITY').values[0], 350);
  assert.equal(bsWithDraft.rows.find((r) => r.code === 'CYE').values[0], 350);

  assert.equal(cashFlow(db, { ...period, company_id: 1 }).closing, 100);
  assert.equal(cashFlow(db, { ...period, company_id: 1, includeUnposted: true }).closing, 350);

  assert.equal(executiveSummary(db, { ...period, company_id: 1 }).revenue, 100);
  assert.equal(executiveSummary(db, { ...period, company_id: 1, includeUnposted: true }).revenue, 350);

  assert.equal(trialBalance(db, { ...period, company_id: 1 }).totals.debit, 100);
  assert.equal(trialBalance(db, { ...period, company_id: 1, includeUnposted: true }).totals.debit, 350);

  // UI toggle on P&L, Cash Flow, and Executive Summary
  const { makeEl } = setupDom();
  globalThis.window = Object.assign(new EventTarget(), { scrollTo() {}, HTMLIFrameElement: class {}, print() {} });
  document.createElementNS = (_ns, tag) => document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);
  try {
    for (const report of ['pnl', 'cashflow', 'executive']) {
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report } })));
      await rendered(React, host, '100.00');
      assert.ok(textOf(host).includes('100.00'), `${report} shows posted 100.00`);
      assert.ok(!textOf(host).includes('350.00'), `${report} hides unposted before toggle`);
      const toggle = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
      assert.ok(toggle, `${report} renders Include Unposted Entries toggle`);
      await React.act(async () => props(toggle).onChange({ target: { checked: true } }));
      assert.ok(textOf(host).includes('350.00'), `${report} includes unposted after toggle`);
      assert.ok(!textOf(host).includes('999.00'), `${report} never includes cancelled moves`);
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('FIN-5 canonical: single reportReviewMode helper enforces priority (explicit reviewMode > includeUnposted > period.reviewMode > posted)', () => {
  // explicit reviewMode wins
  assert.equal(reportReviewMode({ reviewMode: 'draft', includeUnposted: true }), 'draft');
  assert.equal(reportReviewMode({ reviewMode: 'posted', includeUnposted: true }), 'posted');
  assert.equal(reportReviewMode({ reviewMode: 'all', includeUnposted: false }), 'all');
  assert.equal(reportReviewMode({ reviewMode: 'draft' }, { reviewMode: 'all' }), 'all');
  assert.equal(reportReviewMode({ reviewMode: 'draft' }, { reviewMode: 'posted', includeUnposted: true }), 'posted');

  // includeUnposted gives 'all'
  assert.equal(reportReviewMode({ includeUnposted: true }), 'all');
  assert.equal(reportReviewMode({}, { includeUnposted: true }), 'all');
  assert.equal(reportReviewMode({ reviewMode: 'draft' }, { includeUnposted: true }), 'all');

  // period's reviewMode
  assert.equal(reportReviewMode({ reviewMode: 'draft' }, {}), 'draft');
  assert.equal(reportReviewMode({ reviewMode: 'all' }, {}), 'all');

  // fallback to 'posted'
  assert.equal(reportReviewMode({}, {}), 'posted');
  assert.equal(reportReviewMode({}), 'posted');
  assert.equal(reportReviewMode(), 'posted');
});

test('FIN-7: Journals filter is multi-select on P&L, Balance Sheet, Cash Flow, and Executive Summary', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const date = `${today().slice(0, 4)}-05-10`;
  db = postEntry(db, { journal: 'MISC', company: 1, date, lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }] }).db;
  db = postEntry(db, { journal: 'SAL', company: 1, date, lines: [{ account: '101401', debit: 200 }, { account: '400000', credit: 200 }] }).db;
  db = postEntry(db, { journal: 'BNK1', company: 1, date, lines: [{ account: '101401', debit: 400 }, { account: '400000', credit: 400 }] }).db;

  const miscId = journalId(db, 'MISC');
  const salId = journalId(db, 'SAL');

  const { makeEl } = setupDom();
  globalThis.window = Object.assign(new EventTarget(), { scrollTo() {}, HTMLIFrameElement: class {}, print() {} });
  document.createElementNS = (_ns, tag) => document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);

  try {
    for (const report of ['pnl', 'balance', 'cashflow', 'executive']) {
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report } })));
      await rendered(React, host, '700.00');
      const journalSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Journals');
      assert.ok(journalSelect, `${report} has a Journals selector`);
      assert.equal(props(journalSelect).multiple, true, `${report} Journals selector is multi-select`);
      await React.act(async () => props(journalSelect).onChange({
        target: { selectedOptions: [{ value: String(miscId) }, { value: String(salId) }] },
      }));
      assert.ok(textOf(host).includes('300.00'), `${report} sums both selected journals (100 + 200)`);
      assert.ok(!textOf(host).includes('700.00'), `${report} excludes unselected journal (400)`);
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('FIN-8: custom date ranges support comparison and offsets compute from the selected period', async () => {
  // Custom non-month-boundary range (10 days)
  assert.deepEqual(
    periodsFor('custom', 'previous', { from: '2024-03-10', to: '2024-03-19' }),
    [
      { from: '2024-02-29', to: '2024-03-09', label: '2024-02-29 → 2024-03-09' },
      { from: '2024-03-10', to: '2024-03-19', label: '2024-03-10 → 2024-03-19' },
    ],
  );
  // Custom full calendar month respects calendar month boundaries
  assert.deepEqual(
    periodsFor('custom', 'previous', { from: '2024-03-01', to: '2024-03-31' }),
    [
      { from: '2024-02-01', to: '2024-02-29', label: '2024-02-01 → 2024-02-29' },
      { from: '2024-03-01', to: '2024-03-31', label: '2024-03-01 → 2024-03-31' },
    ],
  );
  // Custom same period last year (including leap Feb 29 -> Feb 28)
  assert.deepEqual(
    periodsFor('custom', 'lastYear', { from: '2024-02-01', to: '2024-02-29' }),
    [
      { from: '2023-02-01', to: '2023-02-28', label: '2023-02-01 → 2023-02-28' },
      { from: '2024-02-01', to: '2024-02-29', label: '2024-02-01 → 2024-02-29' },
    ],
  );
  // Standard period key anchored to a historical selected period (not today)
  assert.deepEqual(
    periodsFor('month', 'previous', { from: '2022-05-01', to: '2022-05-31' }),
    [
      { from: '2022-04-01', to: '2022-04-30', label: 'Apr 2022' },
      { from: '2022-05-01', to: '2022-05-31', label: 'May 2022' },
    ],
  );

  // UI test on P&L and Cash Flow with historical custom range 2023-03-01..2023-03-31 vs 2022-03-01..2022-03-31
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2022-03-10', lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }] }).db;
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2023-03-10', lines: [{ account: '101401', debit: 250 }, { account: '400000', credit: 250 }] }).db;
  db = postEntry(db, { journal: 'MISC', company: 1, date: `${today().slice(0, 4)}-03-10`, lines: [{ account: '101401', debit: 900 }, { account: '400000', credit: 900 }] }).db;

  const { makeEl } = setupDom();
  globalThis.window = Object.assign(new EventTarget(), { scrollTo() {}, HTMLIFrameElement: class {}, print() {} });
  document.createElementNS = (_ns, tag) => document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = document;
  const root = createRoot(host);

  try {
    for (const report of ['pnl', 'cashflow']) {
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report } })));
      await rendered(React, host, '900.00');
      const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
      assert.ok(periodSelect);
      await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
      const dates = collectAll(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
      assert.equal(dates.length, 2);
      await React.act(async () => props(dates[0]).onChange({ target: { value: '2023-03-01' } }));
      await React.act(async () => props(dates[1]).onChange({ target: { value: '2023-03-31' } }));
      const compareSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'none');
      assert.ok(compareSelect, `${report} allows Comparison when Period is custom`);
      await React.act(async () => props(compareSelect).onChange({ target: { value: 'lastYear' } }));
      const txt = textOf(host);
      assert.ok(txt.includes('100.00'), `${report} shows 2022 comparison 100.00`);
      assert.ok(txt.includes('250.00'), `${report} shows 2023 custom period 250.00`);
      assert.ok(txt.includes('150.00'), `${report} shows variance 150.00`);
      assert.ok(!txt.includes('900.00'), `${report} does not compute offsets from today`);
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('FIN-12: horizontal groups store real record ids validated against chosen model and company, and group by journal and company', async () => {
  const ruleFields = models['account.report.horizontal.group'].fields.rule_ids.fields;
  const fieldValues = ruleFields.field.options.map(([v]) => v);
  assert.ok(fieldValues.includes('journal'), 'field options include journal');
  assert.ok(fieldValues.includes('company'), 'field options include company');
  assert.equal(ruleFields.ids?.hidden, true, 'legacy comma-separated text box is hidden from UI');

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const co2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch Two' });
  db = co2.db;
  db = { ...db, settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1, co2.id] } };

  const miscId = journalId(db, 'MISC', 1);
  const salId = journalId(db, 'SAL', 1);
  const co2Journal = search(db, 'account.journal').find((j) => j.company_id === co2.id);
  const co2Partner = create(db, 'res.partner', { name: 'Co2 Private Partner', company_id: co2.id });
  db = co2Partner.db;
  const co2Analytic = create(db, 'account.analytic.account', { name: 'Co2 Analytic', company_id: co2.id });
  db = co2Analytic.db;

  // Server-side guard tests through diffDb + applyDiff
  const baseGroup = create(db, 'account.report.horizontal.group', {
    name: 'Valid Journal Group',
    company_id: 1,
    rule_ids: [{ field: 'journal', journal_ids: [miscId, salId] }],
  });
  db = baseGroup.db;
  assert.deepEqual(read(db, 'account.report.horizontal.group', baseGroup.id).rule_ids[0].journal_ids, [miscId, salId]);

  // Direct write must fail
  assert.throws(() => write(db, 'account.report.horizontal.group', baseGroup.id, {
    rule_ids: [{ field: 'journal', journal_ids: [co2Journal.id] }],
  }), /available to the group company|company/i);

  // Forged diff bypassing write()
  const badDiffJournal = diffDb(db, {
    ...db,
    records: {
      ...db.records,
      'account.report.horizontal.group': db.records['account.report.horizontal.group'].map((g) => (
        g.id === baseGroup.id ? { ...g, rule_ids: [{ field: 'journal', journal_ids: [co2Journal.id] }] } : g
      )),
    },
  });
  assert.throws(() => applyDiff(db, badDiffJournal, { isAdmin: true }), /available to the group company|company/i);

  const badDiffWrongField = diffDb(db, {
    ...db,
    records: {
      ...db.records,
      'account.report.horizontal.group': db.records['account.report.horizontal.group'].map((g) => (
        g.id === baseGroup.id ? { ...g, rule_ids: [{ field: 'partner', journal_ids: [miscId] }] } : g
      )),
    },
  });
  assert.throws(() => applyDiff(db, badDiffWrongField, { isAdmin: true }), /rule|field|match/i);

  const badDiffMissingCompany = diffDb(db, {
    ...db,
    records: {
      ...db.records,
      'account.report.horizontal.group': db.records['account.report.horizontal.group'].map((g) => (
        g.id === baseGroup.id ? { ...g, rule_ids: [{ field: 'company', company_ids: [999999] }] } : g
      )),
    },
  });
  assert.throws(() => applyDiff(db, badDiffMissingCompany, { isAdmin: true }), /available to the group company|does not exist/i);

  // Foreign partner and foreign analytic rejected via applyDiff
  for (const rule of [
    { field: 'partner', partner_ids: [co2Partner.id] },
    { field: 'analytic', analytic_ids: [co2Analytic.id] },
  ]) {
    const forged = diffDb(db, {
      ...db,
      records: {
        ...db.records,
        'account.report.horizontal.group': db.records['account.report.horizontal.group'].map((g) => (
          g.id === baseGroup.id ? { ...g, rule_ids: [rule] } : g
        )),
      },
    });
    assert.throws(() => applyDiff(db, forged, { isAdmin: true }), /available to the group company|company/i);
  }

  // Group by journal & company evaluation
  const yr = today().slice(0, 4);
  const date = `${yr}-06-15`;
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31` };
  db = postEntry(db, { journal: 'MISC', company: 1, date, lines: [{ account: '101401', debit: 120 }, { account: '400000', credit: 120 }] }).db;
  db = postEntry(db, { journal: 'SAL', company: 1, date, lines: [{ account: '101401', debit: 80 }, { account: '400000', credit: 80 }] }).db;
  db = postEntry(db, { journal: 'BNK1', company: 1, date, lines: [{ account: '101401', debit: 50 }, { account: '400000', credit: 50 }] }).db;

  const co2Cash = create(db, 'account.account', { code: '101499', name: 'Co2 Bank', account_type: 'asset_cash', company_id: co2.id });
  db = co2Cash.db;
  const co2Inc = create(db, 'account.account', { code: '400099', name: 'Co2 Sales', account_type: 'income', company_id: co2.id });
  db = co2Inc.db;
  db = postEntry(db, {
    journal: co2Journal.id,
    company: co2.id,
    date,
    lines: [{ account_id: co2Cash.id, debit: 400 }, { account_id: co2Inc.id, credit: 400 }],
  }).db;

  const pnlRep = findStatementReport(db, 'pnl', 1);
  const bsRep = findStatementReport(db, 'balance', 1);

  const journalGroup = read(db, 'account.report.horizontal.group', baseGroup.id);
  const jOut = configurableReport(db, pnlRep, period, journalGroup);
  // Sorted by journal name: Customer Invoices (no SAL? SAL='Salaries', MISC='Miscellaneous Operations')
  assert.deepEqual(jOut.buckets.map((b) => b.label), ['Miscellaneous Operations', 'Salaries', 'Others']);
  assert.deepEqual(jOut.rows.find((r) => r.code === 'NET').values, [120, 80, 50]);
  assert.deepEqual(pnlAnalyticColumns(db, journalGroup, period).totals.find((t) => t.label === 'Net Income').values, [120, 80, 50]);

  const companyGroupRes = create(db, 'account.report.horizontal.group', {
    name: 'By Company',
    company_id: 1,
    rule_ids: [{ field: 'company', company_ids: [1, co2.id] }],
  });
  db = companyGroupRes.db;
  const companyGroup = read(db, 'account.report.horizontal.group', companyGroupRes.id);
  const cPnl = configurableReport(db, pnlRep, period, companyGroup);
  assert.deepEqual(cPnl.rows.find((r) => r.code === 'NET').values, [400, 250, 0]); // Branch Two ('B...') before My Company ('M...')
  const cBs = configurableReport(db, bsRep, period, companyGroup);
  assert.deepEqual(cBs.rows.find((r) => r.code === 'ASSETS').values, [400, 250, 0]);
  assert.deepEqual(cBs.rows.find((r) => r.code === 'LIAB_EQUITY').values, [400, 250, 0]);
  assert.deepEqual(balanceAnalyticColumns(db, companyGroup, period).totals.find((t) => t.label === 'Total Assets').values, [400, 250, 0]);

  // Company horizontal grouping with allowed_company_ids = [1, 2] and third company 3 holding posted entries
  const co3 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Third Co' });
  db = co3.db;
  const co3Journal = search(db, 'account.journal').find((j) => j.company_id === co3.id);
  const co3Cash = create(db, 'account.account', { code: '101498', name: 'Co3 Bank', account_type: 'asset_cash', company_id: co3.id });
  db = co3Cash.db;
  const co3Inc = create(db, 'account.account', { code: '400098', name: 'Co3 Sales', account_type: 'income', company_id: co3.id });
  db = co3Inc.db;
  db = postEntry(db, {
    journal: co3Journal.id,
    company: co3.id,
    date,
    lines: [{ account_id: co3Cash.id, debit: 999 }, { account_id: co3Inc.id, credit: 999 }],
  }).db;

  // Set user allowed companies to [1, co2.id] only (excluding co3.id)
  db = { ...db, settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1, co2.id] } };

  // 1) Group with no explicit company ids: takes only allowed companies 1 and 2, excludes company 3
  const groupAllCompaniesRes = create(db, 'account.report.horizontal.group', {
    name: 'All Allowed Companies',
    company_id: 1,
    rule_ids: [{ field: 'company', company_ids: [] }],
  });
  db = groupAllCompaniesRes.db;
  const groupAllCompanies = read(db, 'account.report.horizontal.group', groupAllCompaniesRes.id);
  const resAll = configurableReport(db, pnlRep, period, groupAllCompanies);
  assert.deepEqual(resAll.buckets.map((b) => b.label), ['Branch Two', 'Mizan Demo Co', 'Others']);
  assert.deepEqual(resAll.rows.find((r) => r.code === 'NET').values, [400, 250, 0]);

  // 2) Group with explicit company ids including company 3: drops explicit rule ids the user may not see
  const groupExplicitWithCo3Res = create(db, 'account.report.horizontal.group', {
    name: 'Explicit With Co3',
    company_id: 1,
    rule_ids: [{ field: 'company', company_ids: [1, co2.id, co3.id] }],
  });
  db = groupExplicitWithCo3Res.db;
  const groupExplicitWithCo3 = read(db, 'account.report.horizontal.group', groupExplicitWithCo3Res.id);
  const resExplicit = configurableReport(db, pnlRep, period, groupExplicitWithCo3);
  assert.deepEqual(resExplicit.buckets.map((b) => b.label), ['Branch Two', 'Mizan Demo Co', 'Others']);
  assert.deepEqual(resExplicit.rows.find((r) => r.code === 'NET').values, [400, 250, 0]);

  // None of company 3's amounts appear in pnlAnalyticColumns or balanceAnalyticColumns
  const pnlCols = pnlAnalyticColumns(db, groupAllCompanies, period);
  assert.deepEqual(pnlCols.headers, ['Branch Two', 'Mizan Demo Co', 'Others']);
  assert.deepEqual(pnlCols.totals.find((t) => t.label === 'Net Income').values, [400, 250, 0]);
  const bsCols = balanceAnalyticColumns(db, groupAllCompanies, period);
  assert.deepEqual(bsCols.headers, ['Branch Two', 'Mizan Demo Co', 'Others']);
  assert.deepEqual(bsCols.totals.find((t) => t.label === 'Total Assets').values, [400, 250, 0]);

  // Verify Arabic translations exist for new strings
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import(`./i18n.js?acct_f4_ar=${Date.now()}`);
    for (const key of [
      'Include Unposted Entries',
      'Select partner, analytic account, journal, or company',
      'Rule IDs must match the selected grouping field',
      'Journals',
      'Companies',
    ]) {
      assert.notEqual(t(key), key, `Missing Arabic translation for "${key}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
