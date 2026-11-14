import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, updateSettings, write, writeManyAtomic } from './orm.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { postEntry } from './models/ledger.js';
import { closeFiscalYear } from './models/closing.js';
import { today } from './models/common.js';
import { configurableReport } from './models/configurableReports.js';
import { ensureStatementReports, findStatementReport } from './models/statementReports.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const findAll = (node, predicate, out = []) => {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
};

test('Finding 1: archived statements are never resolved, archiving the last active statement is blocked, and ensureStatementReports restores missing active statements without duplicates', async () => {
  let db = seed();
  const bs = findStatementReport(db, 'balance', 1);
  assert.ok(bs);

  // Archiving the last active standard report of a (company, kind) must be blocked
  assert.throws(() => write(db, 'account.report', bs.id, { active: false }), /at least one report/i);

  // Legacy data where a company's only Balance Sheet is archived must NOT resolve to the archived report
  const legacyOnlyArchived = {
    ...db,
    records: {
      ...db.records,
      'account.report': db.records['account.report'].map((r) => (r.id === bs.id ? { ...r, active: false } : r)),
    },
  };
  assert.equal(findStatementReport(legacyOnlyArchived, 'balance', 1), null);

  // Rendering ConfigurableReportPage when only an archived Balance Sheet exists must not render the archived record
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(legacyOnlyArchived));
  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { statementKind: 'balance', title: 'Balance Sheet' })));
    assert.ok(textOf(host).includes('Report not found'), 'ConfigurableReportPage must not render an archived statement');
  } finally {
    await React.act(async () => root.unmount());
  }

  // ensureStatementReports creates an active report when only an archived one exists, and does not duplicate when active exists
  const ensured = ensureStatementReports(legacyOnlyArchived, 1);
  const restoredBs = findStatementReport(ensured, 'balance', 1);
  assert.ok(restoredBs && restoredBs.id !== bs.id && restoredBs.active !== false);
  const ensuredAgain = ensureStatementReports(ensured, 1);
  assert.equal(ensuredAgain.records['account.report'].length, ensured.records['account.report'].length);

  // Even when an archived duplicate exists, archiving the last active report is still blocked
  assert.throws(() => write(ensured, 'account.report', restoredBs.id, { active: false }), /at least one report/i);

  // When two active reports exist, archiving one is allowed and findStatementReport returns the remaining active one
  const sampleLine = { code: 'A', name: 'A', formula: '10', sequence: 10, parent_code: '', sign: 1, foldable: false, strong: false };
  const dup = create(db, 'account.report', { name: 'Alt BS', kind: 'balance', company_id: 1, line_ids: [sampleLine] });
  const afterArchiveDup = write(dup.db, 'account.report', dup.id, { active: false });
  assert.equal(findStatementReport(afterArchiveDup, 'balance', 1)?.id, bs.id);

  // Atomically archiving all active reports for a (company, kind) is blocked
  assert.throws(
    () => writeManyAtomic(dup.db, 'account.report', new Map([[bs.id, { active: false }], [dup.id, { active: false }]])),
    /at least one report/i,
  );
});

test('Finding 2: ConfigurableReportPage limits ledgers and journals to selected company and clears unavailable selections on company change', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  db = { ...db, records: { ...db.records, 'account.move': [], 'account.payment': [] } };
  const co2 = createCompany(db, { name: 'Branch Co' });
  db = co2.db;
  db = updateSettings(db, { current_company_id: 1, allowed_company_ids: [1, co2.id] });

  const cash2 = create(db, 'account.account', { code: '101402', name: 'Co2 Cash', account_type: 'asset_cash', company_id: co2.id });
  db = cash2.db;
  const inc2 = create(db, 'account.account', { code: '400002', name: 'Co2 Income', account_type: 'income', company_id: co2.id });
  db = inc2.db;

  const j1 = create(db, 'account.journal', { name: 'Main Ops', code: 'MOPS', type: 'general', company_id: 1 });
  db = j1.db;
  const j2 = create(db, 'account.journal', { name: 'Branch Ops', code: 'BOPS', type: 'general', company_id: co2.id });
  db = j2.db;

  const l1 = create(db, 'account.journal.group', { name: 'Main Ledger', company_id: 1, journal_ids: [j1.id] });
  db = l1.db;
  const l2 = create(db, 'account.journal.group', { name: 'Branch Ledger', company_id: co2.id, journal_ids: [j2.id] });
  db = l2.db;

  const date = today();
  db = postEntry(db, {
    journal: j1.id, company: 1, date,
    lines: [{ account: '101401', debit: 111 }, { account: '400000', credit: 111 }],
  }).db;
  db = postEntry(db, {
    journal: j2.id, company: co2.id, date,
    lines: [{ account_id: cash2.id, debit: 222 }, { account_id: inc2.id, credit: 222 }],
  }).db;

  await React.act(async () => commit(db));
  const { ConfigurableReportPage } = await import('./views/ConfigurableReport.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  const selectByLabel = (label) => find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === label);
  const optionValues = (sel) => findAll(sel, (n) => n.tagName === 'OPTION').map((o) => String(props(o).value));
  const optionTexts = (sel) => findAll(sel, (n) => n.tagName === 'OPTION').map((o) => textOf(o));

  try {
    await React.act(async () => root.render(React.createElement(ConfigurableReportPage, { statementKind: 'pnl', title: 'Profit and Loss' })));

    const companySel = selectByLabel('Company');
    const ledgerSel = () => selectByLabel('Ledger');
    const journalSel = () => selectByLabel('Journals');
    assert.ok(companySel && ledgerSel() && journalSel());

    // Under 'all', both companies' ledgers and journals are available
    assert.ok(optionTexts(ledgerSel()).includes('Main Ledger'));
    assert.ok(optionTexts(ledgerSel()).includes('Branch Ledger'));
    assert.ok(optionValues(journalSel()).includes(String(j1.id)));
    assert.ok(optionValues(journalSel()).includes(String(j2.id)));

    // Select Co1's journal and verify report filters to 111.00
    await React.act(async () => props(journalSel()).onChange({ target: { value: String(j1.id) } }));
    assert.ok(textOf(host).includes('111.00'));
    assert.ok(!textOf(host).includes('222.00'));

    // Switch company to Co2: Co1's journal & ledger must disappear from options, selection must clear, and Co2's 222.00 must render
    await React.act(async () => props(companySel).onChange({ target: { value: String(co2.id) } }));
    assert.ok(!optionTexts(ledgerSel()).includes('Main Ledger'), 'Main Ledger should not be listed for Branch Co');
    assert.ok(optionTexts(ledgerSel()).includes('Branch Ledger'), 'Branch Ledger should be listed for Branch Co');
    assert.ok(!optionValues(journalSel()).includes(String(j1.id)), 'Main Ops journal should not be listed for Branch Co');
    assert.ok(optionValues(journalSel()).includes(String(j2.id)), 'Branch Ops journal should be listed for Branch Co');
    assert.equal(props(journalSel()).value, '', 'Unavailable journal selection must be cleared on company change');
    assert.ok(textOf(host).includes('222.00'), 'Branch Co figures must not be emptied by stale journal filter');

    // Switching back to Co1 must keep the cleared journal selection (not resurrect j1) and exclude Co2's ledger/journal
    await React.act(async () => props(selectByLabel('Company')).onChange({ target: { value: '1' } }));
    assert.equal(props(journalSel()).value, '', 'Cleared journal selection must stay cleared');
    assert.ok(!optionTexts(ledgerSel()).includes('Branch Ledger'));
    assert.ok(!optionValues(journalSel()).includes(String(j2.id)));
    assert.ok(textOf(host).includes('111.00'));

    // Selecting Co1's ledger then switching to Co2 must also clear the unavailable ledger selection
    await React.act(async () => props(ledgerSel()).onChange({ target: { value: String(l1.id) } }));
    assert.equal(props(ledgerSel()).value, String(l1.id));
    await React.act(async () => props(selectByLabel('Company')).onChange({ target: { value: String(co2.id) } }));
    assert.equal(props(ledgerSel()).value, '', 'Unavailable ledger selection must be cleared on company change');
    assert.ok(textOf(host).includes('222.00'), 'Branch Co figures must render after clearing stale ledger');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Finding 4: Balance Sheet earnings expressions honour exclude_closing so ASSETS = LIABILITIES + EQUITY holds both ways after closing', () => {
  let db = seed();
  const yr = 2024;
  // Prior year (2024): revenue 1000, expense 350 -> net 650
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-05-10`,
    lines: [{ account: '101401', debit: 1000 }, { account: '400000', credit: 1000 }],
  }).db;
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr}-08-15`,
    lines: [{ account: '600000', debit: 350 }, { account: '101401', credit: 350 }],
  }).db;
  const fy = create(db, 'account.fiscal.year', {
    name: `FY ${yr}`, company_id: 1, date_from: `${yr}-01-01`, date_to: `${yr}-12-31`,
  });
  db = closeFiscalYear(fy.db, fy.id);

  // Next year (2025): additional revenue 200 -> total assets 850
  db = postEntry(db, {
    journal: 'MISC', company: 1, date: `${yr + 1}-03-10`,
    lines: [{ account: '101401', debit: 200 }, { account: '400000', credit: 200 }],
  }).db;

  const baseBs = findStatementReport(db, 'balance', 1);
  const byCode = (out, code) => out.rows.find((r) => r.code === code).values[0];

  for (const [label, reportDate, expected] of [
    ['closed year end', `${yr}-12-31`, { assets: 650, false: { cye: 0, ret: 650, pye: 0 }, true: { cye: 650, ret: 0, pye: 0 } }],
    ['following year', `${yr + 1}-06-30`, { assets: 850, false: { cye: 200, ret: 650, pye: 0 }, true: { cye: 200, ret: 0, pye: 650 } }],
  ]) {
    for (const excludeClosing of [false, true]) {
      const report = { ...baseBs, exclude_closing: excludeClosing };
      const out = configurableReport(db, report, { from: '', to: reportDate });
      const exp = expected[String(excludeClosing)];
      assert.equal(byCode(out, 'ASSETS'), expected.assets, `${label} exclude_closing=${excludeClosing} ASSETS`);
      assert.equal(byCode(out, 'CYE'), exp.cye, `${label} exclude_closing=${excludeClosing} CYE`);
      assert.equal(byCode(out, 'RET'), exp.ret, `${label} exclude_closing=${excludeClosing} RET`);
      assert.equal(byCode(out, 'PYE'), exp.pye, `${label} exclude_closing=${excludeClosing} PYE`);
      assert.equal(
        byCode(out, 'ASSETS'),
        byCode(out, 'LIAB_EQUITY'),
        `${label} exclude_closing=${excludeClosing}: ASSETS must equal LIABILITIES + EQUITY`,
      );
    }
  }
});
