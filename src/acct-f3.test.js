import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { postEntry } from './models/ledger.js';
import { createCompany } from './models/company.js';
import { findStatementReport } from './models/statementReports.js';
import { renderAnnualReportHtml } from './models/auditreport.js';

test('FIN-3: renderAnnualReportHtml evaluates company active account.report definitions and renders customized report lines', () => {
  let db = seed();

  // Customize the company's active Profit and Loss report by adding a custom report line
  const pnlReport = findStatementReport(db, 'pnl', 1);
  assert.ok(pnlReport, 'Standard active P&L report exists');

  const customPnlLine = {
    name: 'Royalties & Licensing',
    code: 'ROY_INC',
    sequence: 25,
    parent_code: 'REV',
    formula: 'type:income',
    sign: -1,
    foldable: true,
    strong: false,
  };

  const updatedPnlReport = {
    ...pnlReport,
    line_ids: [...pnlReport.line_ids, customPnlLine],
  };
  db = write(db, 'account.report', pnlReport.id, { line_ids: updatedPnlReport.line_ids });

  // Customize the company's active Balance Sheet report by adding a custom report line
  const bsReport = findStatementReport(db, 'balance', 1);
  assert.ok(bsReport, 'Standard active Balance Sheet report exists');

  const customBsLine = {
    name: 'Intellectual Property & Patents',
    code: 'IP_ASSETS',
    sequence: 75,
    parent_code: 'ASSETS',
    formula: 'type:asset_current',
    sign: 1,
    foldable: true,
    strong: false,
  };

  const updatedBsReport = {
    ...bsReport,
    line_ids: [...bsReport.line_ids, customBsLine],
  };
  db = write(db, 'account.report', bsReport.id, { line_ids: updatedBsReport.line_ids });

  // Post entry in 2026 affecting revenue and assets
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-06-15',
    lines: [
      { account: '101401', debit: 500 },
      { account: '400000', credit: 500 },
    ],
  }).db;

  const html = renderAnnualReportHtml(db, {
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    company_id: 1,
  });

  // Verify customized report lines appear in the generated Annual Report HTML
  assert.ok(
    html.includes('Royalties &amp; Licensing') || html.includes('Royalties & Licensing'),
    'Annual Report HTML should include customized P&L line "Royalties & Licensing"',
  );
  assert.ok(
    html.includes('Intellectual Property &amp; Patents') || html.includes('Intellectual Property & Patents'),
    'Annual Report HTML should include customized Balance Sheet line "Intellectual Property & Patents"',
  );
});

test('FIN-3: renaming a standard line on the company report reflects in the generated annual report HTML', () => {
  let db = seed();

  const pnlReport = findStatementReport(db, 'pnl', 1);
  assert.ok(pnlReport, 'Company 1 P&L report exists');

  // Rename standard Revenue line to 'Turnover & Operating Sales'
  const renamedLines = pnlReport.line_ids.map((line) => {
    if (line.code === 'REV') {
      return { ...line, name: 'Turnover & Operating Sales' };
    }
    return line;
  });

  db = write(db, 'account.report', pnlReport.id, { line_ids: renamedLines });

  // Post revenue entry
  db = postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-03-10',
    lines: [
      { account: '101401', debit: 1200 },
      { account: '400000', credit: 1200 },
    ],
  }).db;

  const html = renderAnnualReportHtml(db, {
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    company_id: 1,
  });

  assert.ok(
    html.includes('Turnover &amp; Operating Sales') || html.includes('Turnover & Operating Sales'),
    'Annual Report HTML must display the renamed line name',
  );
  assert.ok(
    !html.includes('<td>Revenue</td>'),
    'Annual report HTML must no longer contain the old hardcoded line name',
  );
});

test('FIN-3: multi-company isolation preserves company-specific account.report customizations in annual reports', () => {
  let db = seed();

  // Create Company 2
  const comp2 = createCompany(db, {
    name: 'Branch Company Two',
    currency_id: db.records['res.company'][0].currency_id,
  });
  db = comp2.db;
  const company2Id = comp2.id;

  // Customize Company 2 P&L with a unique custom line
  const pnlC2 = findStatementReport(db, 'pnl', company2Id);
  assert.ok(pnlC2, 'Company 2 has an active P&L report');

  const customLineC2 = {
    name: 'Franchise Royalty Fees C2',
    code: 'FRAN_C2',
    sequence: 22,
    parent_code: 'REV',
    formula: 'type:income',
    sign: -1,
    foldable: true,
    strong: false,
  };
  db = write(db, 'account.report', pnlC2.id, { line_ids: [...pnlC2.line_ids, customLineC2] });

  // Create an income account in Company 2 and post revenue
  const c2Acc = create(db, 'account.account', {
    code: '401000',
    name: 'Franchise Income C2',
    account_type: 'income',
    company_id: company2Id,
  });
  db = c2Acc.db;

  db = postEntry(db, {
    journal: 'MISC',
    company: company2Id,
    date: '2026-07-20',
    lines: [
      { account: '101401', debit: 3500 },
      { account: c2Acc.id, credit: 3500 },
    ],
  }).db;

  const htmlC1 = renderAnnualReportHtml(db, {
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    company_id: 1,
  });

  const htmlC2 = renderAnnualReportHtml(db, {
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    company_id: company2Id,
  });

  // Company 2 report has Company 2 custom line and 3,500.00
  assert.ok(htmlC2.includes('Franchise Royalty Fees C2'), 'Company 2 report includes custom line');
  assert.ok(htmlC2.includes('Franchise Income C2'), 'Company 2 report includes account detail');
  assert.ok(htmlC2.includes('3,500.00'), 'Company 2 report reflects posted balance');

  // Company 1 report does NOT contain Company 2 custom line or balance
  assert.ok(!htmlC1.includes('Franchise Royalty Fees C2'), 'Company 1 report does not have Company 2 custom line');
  assert.ok(!htmlC1.includes('3,500.00'), 'Company 1 report does not include Company 2 amounts');
});

test('FIN-3: audit.report record creation and Refresh button evaluate company active account.report definitions', () => {
  let db = seed();

  // Add custom line to company 1 Balance Sheet
  const bsReport = findStatementReport(db, 'balance', 1);
  const customBsLine = {
    name: 'Long-term Strategic Reserves',
    code: 'STRAT_RES',
    sequence: 85,
    parent_code: 'ASSETS',
    formula: 'type:asset_current',
    sign: 1,
    foldable: true,
    strong: false,
  };
  db = write(db, 'account.report', bsReport.id, { line_ids: [...bsReport.line_ids, customBsLine] });

  // Create audit.report record
  const repRes = create(db, 'audit.report', {
    title: 'Audit Report 2026 Custom Lines',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    company_id: 1,
  });
  db = repRes.db;

  const createdReport = read(db, 'audit.report', repRes.id);
  assert.ok(
    createdReport.body.includes('Long-term Strategic Reserves'),
    'Newly created audit.report body prefilled with active account.report definitions',
  );

  // Add another custom line and test Refresh button
  const pnlReport = findStatementReport(db, 'pnl', 1);
  const customPnlLine = {
    name: 'Direct Distribution Expenses',
    code: 'DIST_EXP',
    sequence: 68,
    parent_code: 'EXP_GRP',
    formula: 'type:expense',
    sign: 1,
    foldable: true,
    strong: false,
  };
  db = write(db, 'account.report', pnlReport.id, { line_ids: [...pnlReport.line_ids, customPnlLine] });

  const auditModel = read(db, 'audit.report', repRes.id);
  const updatedHtml = renderAnnualReportHtml(db, {
    start_date: auditModel.start_date,
    end_date: auditModel.end_date,
    company_id: auditModel.company_id,
  });

  assert.ok(
    updatedHtml.includes('Direct Distribution Expenses'),
    'Refreshed annual report body reflects dynamically added P&L custom line',
  );
});

test('FIN-3: throws clear error if company lacks required statement report', () => {
  let db = seed();

  // For a non-existent company or company where reports are not configured
  assert.throws(
    () => renderAnnualReportHtml(db, { company_id: 99999 }),
    /Configure the Balance Sheet report for this company/,
  );
});
