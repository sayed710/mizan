import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { accountId, journalId, postEntry } from './models/ledger.js';
import { addDays, today } from './models/common.js';
import { payMove, postMove } from './models/accounting.js';
import { configurableReport, normalizeHorizontalGroupVals, targetCompanyIds } from './models/configurableReports.js';
import { findStatementReport } from './models/statementReports.js';
import { cashFlow, executiveSummary, reportReviewMode, trialBalance } from './models/reports.js';
import { applyDiff, diffDb } from './sync.js';
import { balanceAnalyticColumns, cashflowColumns, periodsFor, pnlAnalyticColumns } from './views/reportCompare.js';
import { migrate } from './migrations.js';

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

test('Qodo 1: targetCompanyIds with explicit company rule and Company=all only shows explicit company, no Others from 1 or 3', () => {
  let db = seed();
  const date = `${today().slice(0, 4)}-06-15`;
  const period = { from: `${today().slice(0, 4)}-01-01`, to: `${today().slice(0, 4)}-12-31` };

  const co2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch Co2' });
  db = co2.db;
  const co3 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch Co3' });
  db = co3.db;

  const co2Journal = search(db, 'account.journal').find((j) => j.company_id === co2.id && j.type === 'general')
    ?? search(db, 'account.journal').find((j) => j.company_id === co2.id);
  const co3Journal = search(db, 'account.journal').find((j) => j.company_id === co3.id && j.type === 'general')
    ?? search(db, 'account.journal').find((j) => j.company_id === co3.id);

  const co2Cash = create(db, 'account.account', { code: '101402', name: 'Co2 Cash', account_type: 'asset_cash', company_id: co2.id });
  db = co2Cash.db;
  const co2Inc = create(db, 'account.account', { code: '400002', name: 'Co2 Income', account_type: 'income', company_id: co2.id });
  db = co2Inc.db;

  const co3Cash = create(db, 'account.account', { code: '101403', name: 'Co3 Cash', account_type: 'asset_cash', company_id: co3.id });
  db = co3Cash.db;
  const co3Inc = create(db, 'account.account', { code: '400003', name: 'Co3 Income', account_type: 'income', company_id: co3.id });
  db = co3Inc.db;

  // Post entry in Co1 (100)
  db = postEntry(db, {
    journal: 'MISC', company: 1, date,
    lines: [{ account: '101401', debit: 100 }, { account: '400000', credit: 100 }],
  }).db;
  // Post entry in Co2 (200)
  db = postEntry(db, {
    journal: co2Journal.id, company: co2.id, date,
    lines: [{ account_id: co2Cash.id, debit: 200 }, { account_id: co2Inc.id, credit: 200 }],
  }).db;
  // Post entry in Co3 (300)
  db = postEntry(db, {
    journal: co3Journal.id, company: co3.id, date,
    lines: [{ account_id: co3Cash.id, debit: 300 }, { account_id: co3Inc.id, credit: 300 }],
  }).db;

  // 3 allowed companies
  db = { ...db, settings: { ...db.settings, current_company_id: 1, allowed_company_ids: [1, co2.id, co3.id] } };

  // Group lists ONLY company 2
  const group = create(db, 'account.report.horizontal.group', {
    name: 'Only Co2',
    company_id: 1,
    rule_ids: [{ field: 'company', company_ids: [co2.id] }],
  });
  db = group.db;
  const groupRec = read(db, 'account.report.horizontal.group', group.id);
  const pnlRep = findStatementReport(db, 'pnl', 1);

  // Company=all passes companyIds = [1, co2.id, co3.id]
  const res = configurableReport(db, pnlRep, period, groupRec, { companyIds: [1, co2.id, co3.id] });

  // Only company 2's amounts appear, no Others amount from 1 or 3
  assert.deepEqual(res.buckets.map((b) => b.label), ['Branch Co2', 'Others']);
  assert.deepEqual(res.rows.find((r) => r.code === 'NET').values, [200, 0]);
});

test('Qodo 2: Cash flow with a bank journal filter resolves invoice income accounts from unfiltered company db', async () => {
  let db = seed();
  const date = addDays(today(), -2);
  const period = { from: addDays(today(), -7), to: addDays(today(), 7) };

  // Customer invoice in sales journal (INV)
  const { db: withInv, id: invId } = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 5, invoice_date: date, company_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 500 }],
  });
  db = postMove(withInv, invId);
  const invoice = read(db, 'account.move', invId);
  assert.equal(invoice.state, 'posted');

  // Bank payment in Bank journal (BNK)
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  assert.ok(bankJournal);
  db = payMove(db, invId, 500, date);

  // Bank-filtered db (as Reports.jsx builds when targetJournalIds = [bankJournal.id])
  const bankFilteredDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': (db.records['account.move'] ?? []).filter((m) => m.journal_id === bankJournal.id),
    },
    unfilteredDb: db,
  };

  // With the unfiltered records attached (also through cashflowColumns), invoice is resolved and classified under income account (400000)
  const cf = cashFlow(bankFilteredDb, period);
  assert.ok(cf.lines.some((l) => l.account.code === '400000'), 'movement is classified under invoice income account');
  assert.ok(!cf.lines.some((l) => l.account.account_type === 'asset_receivable'), 'receivable account is not used when invoice is resolved');

  const cols = cashflowColumns(bankFilteredDb, [period]);
  const opSection = cols.sections.find((s) => s.title === 'Operating Activities');
  assert.ok(opSection.rows.some((row) => row.account.code === '400000'), 'comparison path resolves invoice income account');

  // Also verify UI integration in Reports.jsx (ReportPage for cashflow)
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { commit, initStore } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(db));

  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'cashflow' } })));
    const journalSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Journals');
    assert.ok(journalSelect);

    // Select only the bank journal
    await React.act(async () => props(journalSelect).onChange({
      target: {
        selectedOptions: [{ value: String(bankJournal.id) }],
      },
    }));

    // The rendered Cash Flow table must show the invoice income account (400000)
    assert.ok(textOf(host).includes('400000'), 'Cash Flow with bank journal filter renders invoice income account 400000');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Qodo 3: Legacy horizontal-group rule migration and normalization moves ids into relational many2many', () => {
  // 1) normalizeHorizontalGroupVals unions parsed ids into field many2many and clears ids
  const normalized = normalizeHorizontalGroupVals({
    rule_ids: [
      { field: 'partner', partner_ids: [1], ids: '2, 3' },
      { field: 'journal', ids: '10' },
      { field: 'analytic', ids: '' },
    ],
  });
  assert.deepEqual(normalized.rule_ids[0].partner_ids, [1, 2, 3]);
  assert.equal(normalized.rule_ids[0].ids, '');
  assert.deepEqual(normalized.rule_ids[1].journal_ids, [10]);
  assert.equal(normalized.rule_ids[1].ids, '');

  // 2) Migration 59 upgrades legacy stored horizontal groups
  const legacyDb = {
    ...seed(),
    schema_version: 58,
    records: {
      ...seed().records,
      'account.report.horizontal.group': [
        {
          id: 991,
          name: 'Legacy Group',
          company_id: 1,
          rule_ids: [
            { field: 'partner', ids: '1, 2' },
            { field: 'journal', journal_ids: [1], ids: '2' },
          ],
        },
      ],
    },
  };
  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, 62);
  const upgradedGroup = migrated.records['account.report.horizontal.group'].find((g) => g.id === 991);
  assert.deepEqual(upgradedGroup.rule_ids[0].partner_ids, [1, 2]);
  assert.equal(upgradedGroup.rule_ids[0].ids, '');
  assert.deepEqual(upgradedGroup.rule_ids[1].journal_ids, [1, 2]);
  assert.equal(upgradedGroup.rule_ids[1].ids, '');
});

test('Qodo 4: groupError allows saving groups with existing archived records but blocks newly added archived records', () => {
  let db = seed();
  // Partner 5 is active initially
  const p5 = read(db, 'res.partner', 5);
  assert.ok(p5 && p5.active !== false);
  const p6 = read(db, 'res.partner', 6);
  assert.ok(p6 && p6.active !== false);

  // Create a group with partner 5
  const group = create(db, 'account.report.horizontal.group', {
    name: 'Active Partners Group',
    company_id: 1,
    rule_ids: [{ field: 'partner', partner_ids: [5] }],
  });
  db = group.db;

  // Archive partner 5
  db = write(db, 'res.partner', 5, { active: false });
  assert.equal(read(db, 'res.partner', 5).active, false);

  // Updating the group (e.g. changing its name) must NOT fail even though partner 5 is archived
  assert.doesNotThrow(() => {
    db = write(db, 'account.report.horizontal.group', group.id, { name: 'Renamed Group' });
  });

  // Verify through diffDb + applyDiff (server-side diff guard verification)
  const modifiedGroup = { ...read(db, 'account.report.horizontal.group', group.id), name: 'Diff Renamed' };
  const targetDb = {
    ...db,
    records: {
      ...db.records,
      'account.report.horizontal.group': db.records['account.report.horizontal.group'].map((g) => (g.id === group.id ? modifiedGroup : g)),
    },
  };
  const diff = diffDb(db, targetDb);
  assert.doesNotThrow(() => {
    applyDiff(db, diff);
  });

  // Archive partner 6
  db = write(db, 'res.partner', 6, { active: false });

  // Adding archived partner 6 to the existing rule MUST be blocked
  assert.throws(() => {
    write(db, 'account.report.horizontal.group', group.id, {
      rule_ids: [{ field: 'partner', partner_ids: [5, 6] }],
    });
  }, /Rule IDs must identify records available to the group company/);

  // A second rule referencing already-used archived partner 5 MUST be blocked
  assert.throws(() => {
    write(db, 'account.report.horizontal.group', group.id, {
      rule_ids: [{ field: 'partner', partner_ids: [5] }, { field: 'partner', partner_ids: [5] }],
    });
  }, /Rule IDs must identify records available to the group company/);

  // Creating a new group with archived partner 6 MUST be blocked
  assert.throws(() => {
    create(db, 'account.report.horizontal.group', {
      name: 'New With Archived',
      company_id: 1,
      rule_ids: [{ field: 'partner', partner_ids: [6] }],
    });
  }, /Rule IDs must identify records available to the group company/);
});

test('Qodo 5: Multi-select Journals dropdowns pass value as string array without React warning', async () => {
  const db = seed();
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { commit, initStore } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(db));

  const warnings = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => warnings.push(args.join(' '));
  console.error = (...args) => warnings.push(args.join(' '));

  try {
    // 1) ConfigurableReportPage
    const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
    const host1 = makeEl('div');
    host1.ownerDocument = globalThis.document;
    const root1 = createRoot(host1);
    try {
      await React.act(async () => root1.render(React.createElement(ConfigurableReportPage, { statementKind: 'pnl', title: 'Profit and Loss' })));
      const journalSel1 = find(host1, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Journals');
      assert.ok(journalSel1);
      assert.deepEqual(props(journalSel1).value, [], 'ConfigurableReport empty journals selection value is string array []');
    } finally {
      await React.act(async () => root1.unmount());
    }

    // 2) Reports.jsx (ReportPage)
    const { Reports } = await import('./views/Reports.jsx');
    const host2 = makeEl('div');
    host2.ownerDocument = globalThis.document;
    const root2 = createRoot(host2);
    try {
      await React.act(async () => root2.render(React.createElement(Reports, { leaf: { report: 'pnl' } })));
      const journalSel2 = find(host2, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Journals');
      assert.ok(journalSel2);
      assert.deepEqual(props(journalSel2).value, [], 'Reports empty journals selection value is string array []');
    } finally {
      await React.act(async () => root2.unmount());
    }

    // Verify NO React warning about "The `value` prop supplied to <select> must be an array"
    const selectWarnings = warnings.filter((w) => w.includes('The `value` prop supplied to <select> must be an array'));
    assert.equal(selectWarnings.length, 0, 'No React warning for select multiple value');
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
});

test('group restricted to a company that is no longer allowed shows no company amounts', () => {
  const co2 = createCompanyWithDefaultInvoiceJournals(seed(), { name: 'Archived Branch' });
  const db = {
    ...co2.db,
    records: { ...co2.db.records, 'res.company': co2.db.records['res.company'].map((c) => (c.id === co2.id ? { ...c, active: false } : c)) },
  };
  const group = { company_id: 1, rule_ids: [{ field: 'company', company_ids: [co2.id] }] };
  assert.deepEqual(targetCompanyIds(db, { company_id: 1 }, group, {}), []);
});

test('compared cash flow keeps the review mode each period asks for', () => {
  const { db, yr } = cleanReportingFixture();
  const period = { from: `${yr}-01-01`, to: `${yr}-12-31`, reviewMode: 'all' };
  assert.equal(cashFlow(db, { ...period, company_id: 1 }).closing, 350);
  const cols = cashflowColumns(db, [period], { company_id: 1 });
  assert.deepEqual(cols.totals.find((t) => t.label === 'Cash at End').values, [350]);
});
