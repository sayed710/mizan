import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));

test('Working Files: menu route rendering, default filters, separation from tax returns, and model buttons', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { initStore, commit, getDb } = await import('./store.js');
  const { create, read, search, write } = await import('./orm.js');
  const { seed } = await import('./seed.js');
  const { ensureAuditReturnType } = await import('./models/taxreturn.js');
  const { menusFor } = await import('./models/index.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  const { FormView } = await import('./views/FormView.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  await initStore();
  let db = seed();

  // Ensure audit return type for company 1
  const auditTypeRes = ensureAuditReturnType(db, 1);
  db = auditTypeRes.db;
  const auditTypeId = auditTypeRes.typeId;

  // Create an ongoing, paused, and done working file
  const wfOngoing = create(db, 'account.return', {
    name: 'Audit 2026 Ongoing',
    type_id: auditTypeId,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    company_id: 1,
    audit_status: 'ongoing',
  });
  db = wfOngoing.db;

  const wfPaused = create(db, 'account.return', {
    name: 'Audit 2026 Paused',
    type_id: auditTypeId,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    company_id: 1,
    audit_status: 'paused',
  });
  db = wfPaused.db;

  const wfDone = create(db, 'account.return', {
    name: 'Audit 2026 Done',
    type_id: auditTypeId,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    company_id: 1,
    audit_status: 'done',
  });
  db = wfDone.db;

  // Create a standard tax return
  const vatType = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.category === 'account_return');
  const taxReturn = create(db, 'account.return', {
    name: 'VAT 2026 Q1',
    type_id: vatType.id,
    date_from: '2026-01-01',
    date_to: '2026-03-31',
    company_id: 1,
    state: 'new',
  });
  db = taxReturn.db;

  commit(db);

  // 1. Check menus structure
  const menus = menusFor('accounting');
  const review = menus.find((m) => m.label === 'Review');
  const auditMenu = review.children.find((m) => m.label === 'Audit');
  assert.ok(auditMenu, 'Review > Audit menu exists');
  const wfLeaf = auditMenu.children.find((m) => m.key === 'working-files');
  assert.ok(wfLeaf, 'Working Files menu exists under Review > Audit');
  assert.deepEqual(wfLeaf.defaultFilters, ['ongoing', 'paused']);
  assert.deepEqual(wfLeaf.defaults, { audit_status: 'ongoing' });

  // 2. ActionView for Working Files: lists only audit files, defaulting to ongoing and paused
  const hostWF = makeEl('div');
  hostWF.ownerDocument = globalThis.document;
  const rootWF = createRoot(hostWF);

  try {
    await React.act(async () => {
      rootWF.render(React.createElement(ActionView, {
        leaf: wfLeaf,
        base: '#/accounting/working-files',
        params: new URLSearchParams(),
      }));
    });

    const renderedText = textOf(hostWF);
    assert.ok(renderedText.includes('Audit 2026 Ongoing'), 'Ongoing working file is listed');
    assert.ok(renderedText.includes('Audit 2026 Paused'), 'Paused working file is listed');
    assert.ok(!renderedText.includes('Audit 2026 Done'), 'Done working file is excluded by default filters');
    assert.ok(!renderedText.includes('VAT 2026 Q1'), 'Standard tax return is excluded from Working Files');
  } finally {
    await React.act(async () => rootWF.unmount());
  }

  // 3. ActionView for Tax Returns: must not show audit files
  const closingMenu = menus.find((m) => m.label === 'Accounting').children.find((m) => m.label === 'Closing');
  const trLeaf = closingMenu.children.find((m) => m.key === 'tax-returns');
  assert.ok(trLeaf, 'Tax Returns menu exists');

  const hostTR = makeEl('div');
  hostTR.ownerDocument = globalThis.document;
  const rootTR = createRoot(hostTR);

  try {
    await React.act(async () => {
      rootTR.render(React.createElement(ActionView, {
        leaf: trLeaf,
        base: '#/accounting/tax-returns',
        params: new URLSearchParams(),
      }));
    });

    const renderedText = textOf(hostTR);
    assert.ok(renderedText.includes('VAT 2026 Q1'), 'VAT return is listed in Tax Returns');
    assert.ok(!renderedText.includes('Audit 2026 Ongoing'), 'Ongoing audit file is not in Tax Returns');
    assert.ok(!renderedText.includes('Audit 2026 Paused'), 'Paused audit file is not in Tax Returns');
    assert.ok(!renderedText.includes('Audit 2026 Done'), 'Done audit file is not in Tax Returns');
  } finally {
    await React.act(async () => rootTR.unmount());
  }

  // 4. FormView and Model Buttons on Working Files (Pause, Resume, Mark as Done)
  const hostForm = makeEl('div');
  hostForm.ownerDocument = globalThis.document;
  const rootForm = createRoot(hostForm);

  try {
    // Open ongoing working file
    await React.act(async () => {
      rootForm.render(React.createElement(FormView, {
        leaf: wfLeaf,
        id: wfOngoing.id,
        base: '#/accounting/working-files',
        params: new URLSearchParams(),
      }));
    });

    // Check checks and attachments fields
    const recordInDb = read(getDb(), 'account.return', wfOngoing.id);
    assert.ok(Array.isArray(recordInDb.checks), 'Checks is an array');
    assert.ok(recordInDb.checks.some((c) => c.name === 'Draft Entries'), 'Checks draft entries');
    assert.ok(recordInDb.checks.some((c) => c.name === 'Balanced Entries'), 'Checks balanced entries');
    assert.ok(recordInDb.checks.some((c) => c.name === 'Data Inalterability'), 'Checks data inalterability');

    // Click Pause button
    const pauseBtn = find(hostForm, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Pause');
    assert.ok(pauseBtn, 'Pause button is visible for ongoing audit return');
    await React.act(async () => {
      await props(pauseBtn).onClick();
    });

    assert.equal(read(getDb(), 'account.return', wfOngoing.id).audit_status, 'paused', 'Audit status updated to paused');

    // Re-render form with paused status
    await React.act(async () => {
      rootForm.render(React.createElement(FormView, {
        leaf: wfLeaf,
        id: wfOngoing.id,
        base: '#/accounting/working-files',
        params: new URLSearchParams(),
      }));
    });

    // Click Resume button
    const resumeBtn = find(hostForm, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Resume');
    assert.ok(resumeBtn, 'Resume button is visible for paused audit return');
    await React.act(async () => {
      await props(resumeBtn).onClick();
    });

    assert.equal(read(getDb(), 'account.return', wfOngoing.id).audit_status, 'ongoing', 'Audit status updated to ongoing');

    // Re-render form with ongoing status
    await React.act(async () => {
      rootForm.render(React.createElement(FormView, {
        leaf: wfLeaf,
        id: wfOngoing.id,
        base: '#/accounting/working-files',
        params: new URLSearchParams(),
      }));
    });

    // Click Mark as Done button
    const doneBtn = find(hostForm, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Mark as Done');
    assert.ok(doneBtn, 'Mark as Done button is visible');
    await React.act(async () => {
      await props(doneBtn).onClick();
    });

    assert.equal(read(getDb(), 'account.return', wfOngoing.id).audit_status, 'done', 'Audit status updated to done');

    // Done audit file guard: cannot modify core fields
    assert.throws(
      () => write(getDb(), 'account.return', wfOngoing.id, { name: 'Attempted Renaming' }),
      /Done audit files cannot be modified/,
    );
  } finally {
    await React.act(async () => rootForm.unmount());
  }
});

test('Annual Report: menu route, body pre-filling, Refresh, Mark as Done, read-only when done, Reset to Draft', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { initStore, commit, getDb } = await import('./store.js');
  const { create, read, write } = await import('./orm.js');
  const { seed } = await import('./seed.js');
  const { postEntry } = await import('./models/ledger.js');
  const { menusFor } = await import('./models/index.js');
  const { FormView } = await import('./views/FormView.jsx');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (namespace, tag) => makeEl(tag);
  await initStore();
  let db = seed();

  // Post an initial entry for company 1 (1,250.00 sales)
  const entry1 = postEntry(db, {
    journal: 'MISC',
    date: '2026-03-15',
    ref: 'Initial Sales Entry',
    company: 1,
    lines: [
      { account: '121000', debit: 1250 },
      { account: '400000', credit: 1250 },
    ],
  });
  db = entry1.db;
  commit(db);

  // 1. Menu navigation check
  const menus = menusFor('accounting');
  const review = menus.find((m) => m.label === 'Review');
  const auditMenu = review.children.find((m) => m.label === 'Audit');
  const arLeaf = auditMenu.children.find((m) => m.key === 'annual-report');
  assert.ok(arLeaf, 'Annual Report menu leaf exists under Review > Audit');

  // 2. Create Annual Report and verify pre-filled HTML body
  const rep = create(getDb(), 'audit.report', {
    title: 'Audit Report 2026',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    company_id: 1,
  });
  commit(rep.db);

  const createdReport = read(getDb(), 'audit.report', rep.id);
  assert.equal(createdReport.status, 'draft');
  assert.ok(createdReport.body.includes('Balance Sheet'), 'Body contains Balance Sheet header');
  assert.ok(createdReport.body.includes('Profit and Loss'), 'Body contains Profit and Loss header');
  // Seed has 8,400.00 sales, plus 1,250.00 = 9,650.00
  assert.ok(createdReport.body.includes('9,650.00'), 'Body contains the initial posted balance (8,400 + 1,250)');

  // 3. FormView actions: Refresh button
  const hostForm = makeEl('div');
  hostForm.ownerDocument = globalThis.document;
  const rootForm = createRoot(hostForm);

  try {
    await React.act(async () => {
      rootForm.render(React.createElement(FormView, {
        leaf: arLeaf,
        id: rep.id,
        base: '#/accounting/annual-report',
        params: new URLSearchParams(),
      }));
    });

    // Post another entry in the same period (+ 750.00 sales)
    const entry2 = postEntry(getDb(), {
      journal: 'MISC',
      date: '2026-06-20',
      ref: 'Midyear Sales Entry',
      company: 1,
      lines: [
        { account: '121000', debit: 750 },
        { account: '400000', credit: 750 },
      ],
    });
    await React.act(async () => {
      commit(entry2.db);
    });

    // Refresh button click
    const refreshBtn = find(hostForm, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Refresh');
    assert.ok(refreshBtn, 'Refresh button is present on draft report');
    await React.act(async () => {
      await props(refreshBtn).onClick();
    });

    const refreshedReport = read(getDb(), 'audit.report', rep.id);
    assert.ok(refreshedReport.body.includes('10,400.00'), 'Refreshed body now reflects 9,650 + 750 = 10,400.00');

    // 4. Mark as Done button
    const doneBtn = find(hostForm, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Mark as Done');
    assert.ok(doneBtn, 'Mark as Done button is present');
    await React.act(async () => {
      await props(doneBtn).onClick();
    });

    const doneReport = read(getDb(), 'audit.report', rep.id);
    assert.equal(doneReport.status, 'done', 'Report status is now done');

    // Done report is read-only
    assert.throws(
      () => write(getDb(), 'audit.report', rep.id, { title: 'New Title When Done' }),
      /Done reports are read-only/,
    );

    // Re-render form with done status
    await React.act(async () => {
      rootForm.render(React.createElement(FormView, {
        leaf: arLeaf,
        id: rep.id,
        base: '#/accounting/annual-report',
        params: new URLSearchParams(),
      }));
    });

    // Refresh button must be hidden when done
    const refreshWhenDone = find(hostForm, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Refresh');
    assert.equal(refreshWhenDone, null, 'Refresh button is hidden when report is done');

    // 5. Reset to Draft button
    const resetBtn = find(hostForm, (n) => n.tagName === 'BUTTON' && textOf(n) === 'Reset to Draft');
    assert.ok(resetBtn, 'Reset to Draft button is present on done report');
    await React.act(async () => {
      await props(resetBtn).onClick();
    });

    const draftReport = read(getDb(), 'audit.report', rep.id);
    assert.equal(draftReport.status, 'draft', 'Report status is reset to draft');

    // Now edits are allowed again
    await React.act(async () => {
      const updated = write(getDb(), 'audit.report', rep.id, { title: 'Updated Draft Title' });
      commit(updated);
    });
    assert.equal(read(getDb(), 'audit.report', rep.id).title, 'Updated Draft Title');
  } finally {
    await React.act(async () => rootForm.unmount());
  }
});

test('Two-company isolation: Working Files and Annual Report are strictly scoped by company', async () => {
  const { initStore, commit, getDb } = await import('./store.js');
  const { create, read } = await import('./orm.js');
  const { seed } = await import('./seed.js');
  const { ensureAuditReturnType } = await import('./models/taxreturn.js');
  const { postEntry } = await import('./models/ledger.js');
  const { createCompany } = await import('./models/company.js');
  const { actionRecords } = await import('./companyView.js');
  const { menusFor } = await import('./models/index.js');

  await initStore();
  let db = seed();

  // Create Company 2
  const comp2 = createCompany(db, { name: 'Audit Company Two' });
  db = comp2.db;
  const company2Id = comp2.id;

  // Create company-specific accounts for Company 2
  const c2Rec = create(db, 'account.account', { code: '121000', name: 'Receivable C2', account_type: 'asset_receivable', company_id: company2Id });
  db = c2Rec.db;
  const c2Inc = create(db, 'account.account', { code: '400000', name: 'Sales C2', account_type: 'income', company_id: company2Id });
  db = c2Inc.db;

  // Post entry in Company 1: 1,111.00
  const entryC1 = postEntry(db, {
    journal: 'MISC',
    date: '2026-04-10',
    ref: 'C1 Sales',
    company: 1,
    lines: [
      { account: '121000', debit: 1111 },
      { account: '400000', credit: 1111 },
    ],
  });
  db = entryC1.db;

  // Post entry in Company 2: 2,222.00
  const entryC2 = postEntry(db, {
    journal: 'MISC',
    date: '2026-04-10',
    ref: 'C2 Sales',
    company: company2Id,
    lines: [
      { account: '121000', debit: 2222 },
      { account: '400000', credit: 2222 },
    ],
  });
  db = entryC2.db;

  // Ensure audit return types for both companies
  const typeC1Res = ensureAuditReturnType(db, 1);
  db = typeC1Res.db;
  const typeC2Res = ensureAuditReturnType(db, company2Id);
  db = typeC2Res.db;

  // Create working file in Company 1 and Company 2
  const wfC1 = create(db, 'account.return', {
    name: 'WF Company 1',
    type_id: typeC1Res.typeId,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    company_id: 1,
    audit_status: 'ongoing',
  });
  db = wfC1.db;

  const wfC2 = create(db, 'account.return', {
    name: 'WF Company 2',
    type_id: typeC2Res.typeId,
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    company_id: company2Id,
    audit_status: 'ongoing',
  });
  db = wfC2.db;

  // Create annual reports for both companies
  const arC1 = create(db, 'audit.report', {
    title: 'Report Company 1',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    company_id: 1,
  });
  db = arC1.db;

  const arC2 = create(db, 'audit.report', {
    title: 'Report Company 2',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    company_id: company2Id,
  });
  db = arC2.db;

  commit(db);

  // Verify company figures in prefilled HTML bodies
  // Company 1 has 8,400 + 1,111 = 9,511.00
  const report1 = read(getDb(), 'audit.report', arC1.id);
  assert.ok(report1.body.includes('9,511.00'), 'Company 1 report includes Company 1 revenue');
  assert.ok(!report1.body.includes('2,222.00'), 'Company 1 report does NOT include Company 2 revenue');

  // Company 2 has 2,222.00
  const report2 = read(getDb(), 'audit.report', arC2.id);
  assert.ok(report2.body.includes('2,222.00'), 'Company 2 report includes Company 2 revenue');
  assert.ok(!report2.body.includes('9,511.00'), 'Company 2 report does NOT include Company 1 revenue');

  // Verify view/action scoping for Working Files
  const menus = menusFor('accounting');
  const auditMenu = menus.find((m) => m.label === 'Review').children.find((m) => m.label === 'Audit');
  const wfLeaf = auditMenu.children.find((m) => m.key === 'working-files');
  const arLeaf = auditMenu.children.find((m) => m.key === 'annual-report');

  const dbScopedC1 = { ...getDb(), settings: { ...getDb().settings, current_company_id: 1, allowed_company_ids: [1] } };
  const recordsC1 = actionRecords(dbScopedC1, wfLeaf);
  assert.ok(recordsC1.some((r) => r.id === wfC1.id), 'Company 1 view shows WF C1');
  assert.ok(!recordsC1.some((r) => r.id === wfC2.id), 'Company 1 view hides WF C2');

  const dbScopedC2 = { ...getDb(), settings: { ...getDb().settings, current_company_id: company2Id, allowed_company_ids: [company2Id] } };
  const recordsC2 = actionRecords(dbScopedC2, wfLeaf);
  assert.ok(recordsC2.some((r) => r.id === wfC2.id), 'Company 2 view shows WF C2');
  assert.ok(!recordsC2.some((r) => r.id === wfC1.id), 'Company 2 view hides WF C1');

  // Verify view/action scoping for Annual Reports
  const arRecordsC1 = actionRecords(dbScopedC1, arLeaf);
  assert.ok(arRecordsC1.some((r) => r.id === arC1.id), 'Company 1 view shows AR C1');
  assert.ok(!arRecordsC1.some((r) => r.id === arC2.id), 'Company 1 view hides AR C2');

  const arRecordsC2 = actionRecords(dbScopedC2, arLeaf);
  assert.ok(arRecordsC2.some((r) => r.id === arC2.id), 'Company 2 view shows AR C2');
  assert.ok(!arRecordsC2.some((r) => r.id === arC1.id), 'Company 2 view hides AR C1');
});

test('annual report bodies escape account names and stored HTML keeps only structural markup (XSS)', async () => {
  const { seed } = await import('./seed.js');
  const { create } = await import('./orm.js');
  const { postEntry } = await import('./models/ledger.js');
  const { renderAnnualReportHtml } = await import('./models/auditreport.js');
  const { sanitizeHtml } = await import('./ui.jsx');
  const made = create(seed(), 'account.account', { code: '600900', name: '<img src=x onerror=alert(1)>', account_type: 'expense', company_id: 1 });
  const db = postEntry(made.db, { journal: 'MISC', date: '2026-02-01', company: 1, lines: [{ account: '600900', debit: 5 }, { account: '101401', credit: 5 }] }).db;
  const body = renderAnnualReportHtml(db, { start_date: '2026-01-01', end_date: '2026-12-31', company_id: 1 });
  assert.ok(body.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!body.includes('<img'));
  // A minimal element tree stands in for DOMParser, which Node lacks.
  const el = (tagName, attrs = {}, children = []) => {
    const node = { nodeType: 1, tagName, childNodes: children, attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })) };
    node.removeAttribute = (name) => { node.attributes = node.attributes.filter((a) => a.name !== name); };
    for (const child of children) child.parent = node;
    return node;
  };
  const text = (value) => ({ nodeType: 3, value });
  const detach = (node, replacement) => { const list = node.parent.childNodes; list.splice(list.indexOf(node), 1, ...replacement); for (const r of replacement) r.parent = node.parent; };
  const tree = el('BODY', {}, [el('TABLE', { onclick: 'x()', class: 'report' }, [el('TR', {}, [el('TD', { colspan: '2', style: 'x' }, [text('ok')])])]), el('SCRIPT', {}, [text('alert(1)')]), el('A', { href: 'javascript:alert(1)' }, [text('link')])]);
  const walk = (node) => { for (const child of node.childNodes) { child.remove = () => detach(child, []); child.replaceWith = (...nodes) => detach(child, nodes); if (child.nodeType === 1) walk(child); } };
  walk(tree);
  sanitizeHtml('', () => ({ body: tree }));
  const [table, link] = tree.childNodes;
  assert.deepEqual(table.attributes, [{ name: 'class', value: 'report' }]);
  assert.deepEqual(table.childNodes[0].childNodes[0].attributes, [{ name: 'colspan', value: '2' }]);
  assert.equal(tree.childNodes.length, 2);
  assert.equal(link.nodeType, 3);
});
