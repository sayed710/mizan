import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { createCompany, setCompanies } from './models/company.js';
import { postMove } from './models/accounting.js';
import { today } from './models/common.js';
import { create, read, search } from './orm.js';
import { generalLedger, partnerLedger } from './models/reports.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const reactProps = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

function findAll(node, predicate, out = []) {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) findAll(child, predicate, out);
  return out;
}

test('LED-1: General Ledger partner grouping option and company selector', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Reports } = await import('./views/Reports.jsx');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const date = today();
  const misc = search(db, 'account.journal').find((j) => j.code === 'MISC');
  const resAcc = create(db, 'account.account', { code: '121099', name: 'GL Test Receivable', account_type: 'asset_receivable', company_id: 1 });
  const resInc = create(resAcc.db, 'account.account', { code: '400099', name: 'GL Test Income', account_type: 'income', company_id: 1 });
  const p1 = create(resInc.db, 'res.partner', { name: 'Alpha Partner' });
  const p2 = create(p1.db, 'res.partner', { name: 'Beta Partner' });
  db = p2.db;
  const accRec = read(db, 'account.account', resAcc.id);
  const accInc = read(db, 'account.account', resInc.id);

  // Move 1 with Alpha Partner
  const m1 = create(db, 'account.move', {
    move_type: 'entry',
    partner_id: p1.id,
    journal_id: misc.id,
    company_id: 1,
    date,
    line_ids: [
      { account_id: accRec.id, partner_id: p1.id, debit: 300, credit: 0, name: 'Alpha line' },
      { account_id: accInc.id, partner_id: p1.id, debit: 0, credit: 300, name: 'Alpha sale' },
    ],
  });
  db = postMove(m1.db, m1.id);

  // Move 2 with Beta Partner
  const m2 = create(db, 'account.move', {
    move_type: 'entry',
    partner_id: p2.id,
    journal_id: misc.id,
    company_id: 1,
    date,
    line_ids: [
      { account_id: accRec.id, partner_id: p2.id, debit: 200, credit: 0, name: 'Beta line' },
      { account_id: accInc.id, partner_id: p2.id, debit: 0, credit: 200, name: 'Beta sale' },
    ],
  });
  db = postMove(m2.db, m2.id);

  // Move 3 with no partner
  const m3 = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: misc.id,
    company_id: 1,
    date,
    line_ids: [
      { account_id: accRec.id, partner_id: null, debit: 50, credit: 0, name: 'Anonymous line' },
      { account_id: accInc.id, partner_id: null, debit: 0, credit: 50, name: 'Anonymous sale' },
    ],
  });
  db = postMove(m3.db, m3.id);

  // 1. Model test: generalLedger with groupByPartner
  const glUngrouped = generalLedger(db, { groupByPartner: false });
  assert.ok(glUngrouped.rows.length > 0);
  const recRowUngrouped = glUngrouped.rows.find((r) => r.account.id === accRec.id);
  assert.ok(recRowUngrouped);
  assert.equal(recRowUngrouped.debit, 550);
  assert.equal(recRowUngrouped.partners.length, 0);

  const glGrouped = generalLedger(db, { groupByPartner: true });
  const recRowGrouped = glGrouped.rows.find((r) => r.account.id === accRec.id);
  assert.ok(recRowGrouped);
  assert.equal(recRowGrouped.debit, 550);
  assert.equal(recRowGrouped.partners.length, 3);
  const pAlpha = recRowGrouped.partners.find((p) => p.partner_id === p1.id);
  const pBeta = recRowGrouped.partners.find((p) => p.partner_id === p2.id);
  const pNone = recRowGrouped.partners.find((p) => !p.partner_id);
  assert.ok(pAlpha && pBeta && pNone);
  assert.equal(pAlpha.debit, 300);
  assert.equal(pBeta.debit, 200);
  assert.equal(pNone.debit, 50);

  // 2. View test in Reports component
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => commit(db));
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'ledger' } }));
    });

    // Check "Group by Partner" checkbox exists
    const groupCheckbox = find(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'checkbox' && textOf(n.parentNode).includes('Group by Partner'));
    assert.ok(groupCheckbox, 'Group by Partner checkbox exists in control panel');

    // Toggle Group by Partner on
    await React.act(async () => {
      reactProps(groupCheckbox).onChange({ target: { checked: true } });
    });

    // Unfold the receivable account
    const sectionRows = findAll(host, (n) => n.tagName === 'TR' && n.className?.includes('rep-section'));
    const recSection = sectionRows.find((tr) => tr.textContent.includes(accRec.code));
    assert.ok(recSection, 'Receivable account section row exists');
    await React.act(async () => {
      reactProps(recSection).onClick();
    });

    // Partner sub-rows should now be visible
    const partnerRows = findAll(host, (n) => n.tagName === 'TR' && n.className?.includes('rep-partner'));
    assert.ok(partnerRows.length >= 3, 'Partner sub-rows exist inside the unfolded account');
    assert.ok(partnerRows.some((tr) => tr.textContent.includes('Alpha Partner')));
    assert.ok(partnerRows.some((tr) => tr.textContent.includes('Beta Partner')));
    assert.ok(partnerRows.some((tr) => tr.textContent.includes('No Partner')));

    // Unfold Alpha Partner
    const alphaRow = partnerRows.find((tr) => tr.textContent.includes('Alpha Partner'));
    await React.act(async () => {
      reactProps(alphaRow).onClick();
    });
    const detailRows = findAll(host, (n) => n.tagName === 'TR' && n.className?.includes('rep-detail'));
    assert.ok(detailRows.some((tr) => tr.textContent.includes('Alpha line')));

    // Company selector: when multiple allowed companies exist, company selector is present
    const cBranch = createCompany(db, { name: 'Branch 2', currency_id: read(db, 'res.company', 1).currency_id });
    const scoped = setCompanies(cBranch.db, { current: 1, allowed: [1, cBranch.id] });
    await React.act(async () => commit(scoped));
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'ledger' } }));
    });
    const companySelect = find(host, (node) => node.tagName === 'SELECT' && reactProps(node)?.['aria-label'] === 'Company');
    assert.ok(companySelect, 'General Ledger provides company selector for multi-company');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('LED-2: Partner Ledger option to show journal and account columns per line and company selector', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Reports } = await import('./views/Reports.jsx');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const date = today();
  const partner = create(db, 'res.partner', { name: 'Omega Partner' });
  const accRec = search(db, 'account.account').find((a) => a.account_type === 'asset_receivable');
  const journal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const move = create(partner.db, 'account.move', {
    move_type: 'entry',
    partner_id: partner.id,
    journal_id: journal.id,
    date,
    line_ids: [
      { account_id: accRec.id, partner_id: partner.id, debit: 750, credit: 0, name: 'Omega service' },
      { account_id: search(db, 'account.account').find((a) => a.account_type === 'income').id, partner_id: partner.id, debit: 0, credit: 750, name: 'Income' },
    ],
  });
  db = postMove(move.db, move.id);

  // 1. Model test: partnerLedger lines contain journal_id and account_id
  const plData = partnerLedger(db, { partnerIds: [partner.id] }, 'receivable');
  assert.equal(plData.length, 1);
  const pLines = plData[0].lines;
  assert.ok(pLines.length > 0);
  assert.equal(pLines[0].journal_id, journal.id);
  assert.equal(pLines[0].account_id, accRec.id);

  // 2. View test in Reports component
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => commit(db));
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'partnerReceivable' } }));
    });

    // Check "Show Journal and Account" checkbox exists
    const showJaCheckbox = find(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'checkbox' && textOf(n.parentNode).includes('Show Journal and Account'));
    assert.ok(showJaCheckbox, 'Show Journal and Account checkbox exists in control panel');

    // Without checking, table headers do not have Journal and Account
    let headers = findAll(host, (n) => n.tagName === 'TH').map((th) => th.textContent);
    assert.ok(!headers.includes('Journal'));
    assert.ok(!headers.includes('Account'));

    // Check Show Journal and Account on
    await React.act(async () => {
      reactProps(showJaCheckbox).onChange({ target: { checked: true } });
    });

    // Now table headers should contain Journal and Account
    headers = findAll(host, (n) => n.tagName === 'TH').map((th) => th.textContent);
    assert.ok(headers.includes('Journal'), 'Table headers include Journal');
    assert.ok(headers.includes('Account'), 'Table headers include Account');

    // Unfold partner and inspect line columns
    const partnerSection = find(host, (n) => n.tagName === 'TR' && n.className?.includes('rep-section') && n.textContent.includes('Omega Partner'));
    assert.ok(partnerSection, 'Partner section exists');
    await React.act(async () => {
      reactProps(partnerSection).onClick();
    });

    const lineRow = find(host, (n) => n.tagName === 'TR' && n.className?.includes('rep-detail') && n.textContent.includes('Omega service'));
    assert.ok(lineRow, 'Detail line row exists');
    assert.ok(lineRow.textContent.includes(journal.code), 'Line displays journal code');
    assert.ok(lineRow.textContent.includes(accRec.code), 'Line displays account code');

    // Company selector: when multiple allowed companies exist, company selector is present
    const cBranch = createCompany(db, { name: 'Branch Partner Co', currency_id: read(db, 'res.company', 1).currency_id });
    const scoped = setCompanies(cBranch.db, { current: 1, allowed: [1, cBranch.id] });
    await React.act(async () => commit(scoped));
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'partnerReceivable' } }));
    });
    const companySelect = find(host, (node) => node.tagName === 'SELECT' && reactProps(node)?.['aria-label'] === 'Company');
    assert.ok(companySelect, 'Partner Ledger provides company selector for multi-company');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('LED-3: Trial Balance column options for Initial and End Balance and comparison periods', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Reports } = await import('./views/Reports.jsx');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const db = seed();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => commit(db));
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'trial' } }));
    });

    // 1. Initial Balance and End Balance checkboxes exist
    const initCheckbox = find(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'checkbox' && textOf(n.parentNode).includes('Initial Balance'));
    const endCheckbox = find(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'checkbox' && textOf(n.parentNode).includes('End Balance'));
    assert.ok(initCheckbox, 'Initial Balance checkbox exists');
    assert.ok(endCheckbox, 'End Balance checkbox exists');

    // By default, both are checked and present in headers
    let headers = findAll(host, (n) => n.tagName === 'TH').map((th) => th.textContent);
    assert.ok(headers.includes('Initial Balance'));
    assert.ok(headers.includes('Debit'));
    assert.ok(headers.includes('Credit'));
    assert.ok(headers.includes('End Balance'));

    // 2. Hide Initial Balance
    await React.act(async () => {
      reactProps(initCheckbox).onChange({ target: { checked: false } });
    });
    headers = findAll(host, (n) => n.tagName === 'TH').map((th) => th.textContent);
    assert.ok(!headers.includes('Initial Balance'), 'Initial Balance header hidden');
    assert.ok(headers.includes('Debit'));
    assert.ok(headers.includes('Credit'));
    assert.ok(headers.includes('End Balance'));

    // Check a detail row has 3 numeric cells instead of 4
    const detailRow = find(host, (n) => n.tagName === 'TR' && n.className?.includes('rep-detail'));
    assert.ok(detailRow);
    const detailCells = findAll(detailRow, (n) => n.tagName === 'TD');
    // Account name + Debit + Credit + End Balance = 4 cells total (was 5 cells with Initial Balance)
    assert.equal(detailCells.length, 4, 'Detail row has 4 cells without Initial Balance');

    // 3. Hide End Balance as well
    await React.act(async () => {
      reactProps(endCheckbox).onChange({ target: { checked: false } });
    });
    headers = findAll(host, (n) => n.tagName === 'TH').map((th) => th.textContent);
    assert.ok(!headers.includes('Initial Balance'));
    assert.ok(headers.includes('Debit'));
    assert.ok(headers.includes('Credit'));
    assert.ok(!headers.includes('End Balance'), 'End Balance header hidden');

    const detailCellsNoEnd = findAll(detailRow, (n) => n.tagName === 'TD');
    // Account name + Debit + Credit = 3 cells total
    assert.equal(detailCellsNoEnd.length, 3, 'Detail row has 3 cells with only Debit and Credit');

    // 4. Comparison periods: select previous period and verify column options apply per period
    const comparisonSelect = find(host, (node) => node.tagName === 'SELECT' && reactProps(node)?.value === 'none');
    assert.ok(comparisonSelect, 'Comparison dropdown exists');
    await React.act(async () => {
      reactProps(comparisonSelect).onChange({ target: { value: 'previous' } });
    });

    const compareHeaders = findAll(host, (n) => n.tagName === 'TH').map((th) => th.textContent);
    // Should have Debit and Credit for both periods, but neither Initial nor End Balance
    assert.ok(compareHeaders.some((h) => h.includes('Debit')));
    assert.ok(compareHeaders.some((h) => h.includes('Credit')));
    assert.ok(!compareHeaders.some((h) => h.includes('Initial Balance')));
    assert.ok(!compareHeaders.some((h) => h.includes('End Balance')));

    // Re-enable Initial Balance under comparison
    await React.act(async () => {
      reactProps(initCheckbox).onChange({ target: { checked: true } });
    });
    const compareHeadersWithInit = findAll(host, (n) => n.tagName === 'TH').map((th) => th.textContent);
    assert.ok(compareHeadersWithInit.some((h) => h.includes('Initial Balance')), 'Comparison headers include Initial Balance when re-enabled');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('LED-4: generalLedger converts each entry once and does not repeatedly scan entries per account and partner', () => {
  let db = seed();
  const date = '2025-03-15';
  const openingDate = '2025-01-10';
  const misc = search(db, 'account.journal').find((j) => j.code === 'MISC');
  const resAcc = create(db, 'account.account', { code: '121088', name: 'GL Perf Receivable', account_type: 'asset_receivable', company_id: 1 });
  const resInc = create(resAcc.db, 'account.account', { code: '400088', name: 'GL Perf Income', account_type: 'income', company_id: 1 });
  const p1 = create(resInc.db, 'res.partner', { name: 'Perf Partner 1' });
  const p2 = create(p1.db, 'res.partner', { name: 'Perf Partner 2' });
  db = p2.db;

  // Opening move before period from date
  const mOpen = create(db, 'account.move', {
    move_type: 'entry',
    partner_id: p1.id,
    journal_id: misc.id,
    company_id: 1,
    date: openingDate,
    line_ids: [
      { account_id: resAcc.id, partner_id: p1.id, debit: 50, credit: 0, name: 'Open L1' },
      { account_id: resInc.id, partner_id: p1.id, debit: 0, credit: 50, name: 'Open L1 income' },
    ],
  });
  db = postMove(mOpen.db, mOpen.id);

  const m1 = create(db, 'account.move', {
    move_type: 'entry',
    partner_id: p1.id,
    journal_id: misc.id,
    company_id: 1,
    date,
    line_ids: [
      { account_id: resAcc.id, partner_id: p1.id, debit: 100, credit: 0, name: 'L1' },
      { account_id: resInc.id, partner_id: p1.id, debit: 0, credit: 100, name: 'L1 income' },
    ],
  });
  db = postMove(m1.db, m1.id);

  const m2 = create(db, 'account.move', {
    move_type: 'entry',
    partner_id: p2.id,
    journal_id: misc.id,
    company_id: 1,
    date,
    line_ids: [
      { account_id: resAcc.id, partner_id: p2.id, debit: 200, credit: 0, name: 'L2' },
      { account_id: resInc.id, partner_id: p2.id, debit: 0, credit: 200, name: 'L2 income' },
    ],
  });
  db = postMove(m2.db, m2.id);

  // Set up tracking on currency conversion invocations via db.settings.current_company_id
  let conversionCount = 0;
  const originalSettings = db.settings ?? {};
  const trackingDb = {
    ...db,
    settings: {
      ...originalSettings,
      get current_company_id() {
        conversionCount++;
        return originalSettings.current_company_id ?? 1;
      },
    },
  };

  // Run generalLedger with from date and groupByPartner: true
  const res = generalLedger(trackingDb, { from: '2025-02-01', groupByPartner: true });
  assert.ok(res.rows.length > 0);

  const recRow = res.rows.find((r) => r.account.id === resAcc.id);
  assert.ok(recRow);
  assert.equal(recRow.initial, 50);
  assert.equal(recRow.debit, 300);
  assert.equal(recRow.credit, 0);
  assert.equal(recRow.end, 350);
  assert.equal(recRow.partners.length, 2);

  const p1Row = recRow.partners.find((p) => p.partner_id === p1.id);
  const p2Row = recRow.partners.find((p) => p.partner_id === p2.id);
  assert.ok(p1Row && p2Row);
  assert.equal(p1Row.initial, 50);
  assert.equal(p1Row.debit, 100);
  assert.equal(p1Row.end, 150);
  assert.equal(p2Row.initial, 0);
  assert.equal(p2Row.debit, 200);
  assert.equal(p2Row.end, 200);

  // For each journal item (period and opening), debit and credit should be converted at most once.
  // Without the fix, entries are repeatedly converted per partner and for running totals (4x to 6x conversions).
  const totalPeriodItems = res.rows.reduce((s, r) => s + r.lines.length, 0);
  assert.ok(totalPeriodItems > 0);
  // Opening items exist for accounts and are converted at most once (debit + credit)
  const maxExpectedConversions = (totalPeriodItems + 20) * 2;
  assert.ok(
    conversionCount <= maxExpectedConversions,
    `Expected at most ${maxExpectedConversions} conversions, but got ${conversionCount}`
  );
});
