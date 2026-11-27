import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { agedBalance } from './models/finance.js';
import { journalItems } from './models/ledger.js';
import { cashFlow, trialBalance, trialOpeningItems } from './models/reports.js';
import { reportJournalItemsHref } from './views/reportDrill.js';
import { AgedDetailRow } from './views/aged-detail-row.js';
import { register } from 'node:module';
import { seed } from './seed.js';
import { create, read, search } from './orm.js';
import { accountId } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('aged balances include draft entries only in review mode', () => {
  const db = { records: {
    'res.company': [{ id: 1, currency_id: 1 }],
    'res.currency': [{ id: 1, rounding: 0.01 }],
    'account.account': [{ id: 1, account_type: 'asset_receivable' }],
    'account.move': [
      { id: 1, state: 'posted', move_type: 'entry', date: '2025-01-01', line_ids: [{ account_id: 1, partner_id: 1, debit: 100 }] },
      { id: 2, state: 'draft', move_type: 'entry', date: '2025-01-01', line_ids: [{ account_id: 1, partner_id: 1, debit: 25 }] },
    ],
    'account.payment': [],
  }, settings: { base_currency_id: 1 } };
  assert.equal(agedBalance(db, 'receivable', '2025-01-31').rows[0].total, 100);
  assert.equal(agedBalance(db, 'receivable', '2025-01-31', null, { reviewMode: 'all' }).rows[0].total, 125);
});

test('aged bucket links resolve posted and draft installments for each partner', async () => {
  let db = seed();
  const term = create(db, 'account.payment.term', { name: 'Two installments', line_ids: [{ value_type: 'percent', value: 50, nb_days: 0, delay_type: 'days_after' }, { value_type: 'percent', value: 50, nb_days: 30, delay_type: 'days_after' }] });
  db = term.db;
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const expected = {};
  for (const [kind, type] of [['receivable', 'out_invoice'], ['payable', 'in_invoice']]) {
    const first = create(db, 'account.move', { move_type: type, partner_id: 1, invoice_date: '2025-02-01', company_id: 1, invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
    db = payMove(postMove(first.db, first.id), first.id, 20, '2025-02-10', { journalId: bank.id });
    const other = create(db, 'account.move', { move_type: type, partner_id: 2, invoice_date: '2025-02-10', company_id: 1, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 40, tax: 0 }] });
    db = postMove(other.db, other.id);
    const draft = create(db, 'account.move', { move_type: type, partner_id: 1, invoice_date: '2025-02-10', company_id: 1, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 30, tax: 0 }] });
    db = draft.db;
    expected[kind] = { first: first.id, other: other.id, draft: draft.id };
  }
  const { setupDom, find } = await import('./test-support/dom.js'); const { makeEl } = setupDom();
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js'); const { REPORTS } = await import('./views/Reports.jsx'); const { JournalItems } = await import('./views/JournalItems.jsx');
  await store.initStore(); await store.commit(db);
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const all = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => all(child, predicate))];
  try {
    for (const kind of ['receivable', 'payable']) for (const includeDraft of [false, true]) {
      const period = { to: '2025-03-15', ...(includeDraft ? { reviewMode: 'all' } : {}) };
      const Body = REPORTS[kind === 'receivable' ? 'agedReceivable' : 'agedPayable'].Body;
      await React.act(async () => root.render(React.createElement('table', null, React.createElement(Body, { db, period, companyId: 1, agingOptions: {} }))));
      const links = all(host, (node) => node.tagName === 'A' && props(node)?.href?.includes('agedBucket=')).map((node) => props(node).href);
      assert.ok(links.length >= 2);
      for (const href of links) {
        const params = new URLSearchParams(href.split('?')[1]);
        const partner = Number(params.get('partner')); const bucket = params.get('agedBucket');
        const wanted = partner === 1 ? (bucket === '1_30' ? [expected[kind].first] : [expected[kind].first, ...(includeDraft ? [expected[kind].draft] : [])]) : [expected[kind].other];
        globalThis.location = { hash: href };
        await React.act(async () => root.render(React.createElement(JournalItems, { key: href })));
        const body = find(host, (node) => node.tagName === 'TBODY');
        const actual = all(body, (node) => node.tagName === 'A' && props(node)?.href?.startsWith('#/accounting/entries/')).map((node) => Number(props(node).href.split('/').pop()));
        assert.deepEqual(actual.sort((a, b) => a - b), wanted.sort((a, b) => a - b), `${kind} ${partner} ${bucket} draft=${includeDraft}`);
      }
    }
  } finally { await React.act(async () => root.unmount()); }
});

test('drill link retains account, partner, dates and draft scope', () => {
  const href = reportJournalItemsHref({ accountId: 3, partnerId: 7, companyId: 1, period: { from: '2025-01-01', to: '2025-01-31', reviewMode: 'all' }, column: 'debit' });
  const params = new URLSearchParams(href.split('?')[1]);
  assert.equal(params.get('account'), '3');
  assert.equal(params.get('partner'), '7');
  assert.equal(params.get('from'), '2025-01-01');
  assert.equal(params.get('to'), '2025-01-31');
  assert.equal(params.get('reviewMode'), 'all');
  const db = { records: { 'account.move': [
    { id: 1, state: 'posted', date: '2025-01-05', company_id: 1, line_ids: [{ account_id: 3, partner_id: 7, debit: 10 }] },
    { id: 2, state: 'draft', date: '2025-01-10', company_id: 1, line_ids: [{ account_id: 3, partner_id: 7, debit: 5 }] },
    { id: 3, state: 'posted', date: '2025-01-12', company_id: 1, line_ids: [{ account_id: 3, partner_id: 8, debit: 50 }] },
  ] }, settings: {} };
  const items = journalItems(db, { from: params.get('from'), to: params.get('to'), company_id: Number(params.get('company')), reviewMode: params.get('reviewMode') });
  assert.equal(items.filter((line) => line.account_id === Number(params.get('account')) && line.partner_id === Number(params.get('partner'))).reduce((sum, line) => sum + line.debit, 0), 15);
  assert.equal(new URLSearchParams(reportJournalItemsHref({ accountId: 3, period: { from: '2025-01-01' }, column: 'initial' }).split('?')[1]).get('to'), '2024-12-31');
});

test('trial opening drill selects the same fiscal-year reclassification as the report', () => {
  const db = { records: {
    'res.company': [{ id: 1, currency_id: 1 }], 'res.currency': [{ id: 1, rounding: 0.01 }],
    'account.account': [{ id: 1, code: '100', name: 'Cash', account_type: 'asset_cash', company_id: 1 }],
    'account.move': [
      { id: 1, state: 'posted', date: '2024-12-01', company_id: 1, line_ids: [{ account_id: 1, debit: 12 }] },
      { id: 2, state: 'draft', date: '2024-12-02', company_id: 1, line_ids: [{ account_id: 1, debit: 3 }] },
      { id: 3, state: 'posted', date: '2025-01-05', company_id: 1, line_ids: [{ account_id: 1, debit: 9 }] },
    ],
  }, settings: { current_company_id: 1, base_currency_id: 1 } };
  const period = { from: '2025-01-01', to: '2025-01-31', reviewMode: 'all' };
  const params = new URLSearchParams(reportJournalItemsHref({ accountId: 1, companyId: 1, period, column: 'initial', trialOpening: true }).split('?')[1]);
  const items = trialOpeningItems(db, journalItems(db, { to: params.get('to'), company_id: 1, reviewMode: params.get('reviewMode') }), params.get('trialOpening')).filter((item) => item.account_id === Number(params.get('account')));
  assert.equal(items.reduce((sum, item) => sum + item.debit - (item.credit ?? 0), 0), trialBalance(db, { ...period, company_id: 1 }).rows[0].initial);
});

test('generic tax drill links identify the base and tax line filters', () => {
  for (const taxKind of ['base', 'tax']) {
    const params = new URLSearchParams(reportJournalItemsHref({ taxId: 9, taxKind, period: { from: '2025-01-01', to: '2025-01-31', reviewMode: 'all' } }).split('?')[1]);
    assert.equal(params.get('tax'), '9');
    assert.equal(params.get('taxKind'), taxKind);
    assert.equal(params.get('reviewMode'), 'all');
  }
});

test('cash flow records source moves for each classified account', () => {
  const db = { records: {
    'res.company': [{ id: 1, currency_id: 1 }], 'res.currency': [{ id: 1, rounding: 0.01 }],
    'account.account': [{ id: 1, code: '100', account_type: 'asset_cash' }, { id: 2, code: '200', account_type: 'expense' }, { id: 3, code: '300', account_type: 'expense' }],
    'account.move': [
      { id: 1, state: 'posted', move_type: 'entry', date: '2025-01-10', company_id: 1, line_ids: [{ account_id: 1, credit: 40 }, { account_id: 2, debit: 40 }] },
      { id: 2, state: 'posted', move_type: 'entry', date: '2025-01-15', company_id: 1, line_ids: [{ account_id: 1, credit: 20 }, { account_id: 3, debit: 20 }] },
    ], 'account.payment': [],
  }, settings: { current_company_id: 1, base_currency_id: 1 } };
  const report = cashFlow(db, { from: '2025-01-01', to: '2025-01-31', company_id: 1, includeSources: true });
  assert.deepEqual(report.lines.find((line) => line.account.id === 2).sourceMoveIds, [1]);
  assert.deepEqual(report.lines.find((line) => line.account.id === 3).sourceMoveIds, [2]);
});

test('cash flow links open liquidity items for customer payment, vendor payment and bank fee', async () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  assert.ok(bank);
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2025-03-01', company_id: 1, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  db = payMove(postMove(inv.db, inv.id), inv.id, 100, '2025-03-05', { journalId: bank.id });
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_date: '2025-03-01', company_id: 1, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 80, tax: 0 }] });
  db = payMove(postMove(bill.db, bill.id), bill.id, 80, '2025-03-06', { journalId: bank.id });
  const liquidity = accountId(db, '101401');
  const feeAccount = accountId(db, '621000') ?? search(db, 'account.account').find((a) => a.account_type === 'expense').id;
  const fee = create(db, 'account.move', { move_type: 'entry', invoice_date: '2025-03-07', journal_id: bank.id, company_id: 1, line_ids: [{ account_id: liquidity, credit: 5 }, { account_id: feeAccount, debit: 5 }] });
  db = postMove(fee.db, fee.id);
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom(); const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js'); const { JournalItems } = await import('./views/JournalItems.jsx');
  await store.initStore(); await store.commit(db);
  const host = makeEl('div'); host.ownerDocument = globalThis.document; const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const all = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => all(child, predicate))];
  const period = { from: '2025-03-01', to: '2025-03-31' };
  const report = cashFlow(db, { ...period, company_id: 1, includeSources: true });
  const payments = search(db, 'account.payment').filter((p) => [inv.id, bill.id].includes(p.invoice_id));
  assert.equal(payments.length, 2);
  const expectedMoves = new Set([...payments.map((p) => p.move_id), fee.id]);
  const expectedByAccount = new Map();
  for (const documentId of [inv.id, bill.id]) {
    const document = read(db, 'account.move', documentId);
    const source = document.line_ids.find((line) => ['income', 'income_other', 'expense', 'expense_direct_cost', 'expense_other'].includes(read(db, 'account.account', line.account_id)?.account_type));
    assert.ok(source);
    const payment = payments.find((item) => item.invoice_id === documentId);
    if (!expectedByAccount.has(source.account_id)) expectedByAccount.set(source.account_id, new Set());
    expectedByAccount.get(source.account_id).add(payment.move_id);
  }
  if (!expectedByAccount.has(feeAccount)) expectedByAccount.set(feeAccount, new Set());
  expectedByAccount.get(feeAccount).add(fee.id);
  for (const [account, moves] of expectedByAccount) {
    const line = report.lines.find((item) => item.account.id === account);
    assert.ok(line, `cash flow includes account ${account}`);
    assert.deepEqual(line.sourceMoveIds.slice().sort((a, b) => a - b), [...moves].sort((a, b) => a - b));
  }
  try {
    for (const line of report.lines.filter((item) => item.sourceMoveIds.some((id) => expectedMoves.has(id)))) {
      globalThis.location = { hash: reportJournalItemsHref({ period, companyId: 1, cashFlowAccount: line.account.id }) };
      await React.act(async () => root.render(React.createElement(JournalItems, { key: line.account.id })));
      const body = find(host, (node) => node.tagName === 'TBODY');
      const actual = all(body, (node) => node.tagName === 'A' && props(node)?.href?.startsWith('#/accounting/entries/')).map((node) => Number(props(node).href.split('/').pop()));
      assert.deepEqual(actual.sort((a, b) => a - b), [...expectedByAccount.get(line.account.id)].sort((a, b) => a - b));
    }
    assert.ok(report.lines.some((line) => line.sourceMoveIds.includes(fee.id)));
  } finally { await React.act(async () => root.unmount()); }
});

test('seeded purchase tax supplies distinct base and tax journal items', async () => {
  let db = seed();
  const tax = create(db, 'account.tax', { name: 'Drill tax', amount: 10, amount_type: 'percent', type_tax_use: 'purchase', company_id: 1, invoice_repartition_line_ids: [{ repartition_type: 'base', factor_percent: 100 }, { repartition_type: 'tax', factor_percent: 100, account_id: accountId(db, '131000') }] });
  db = tax.db;
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_date: '2025-03-10', company_id: 1, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', tax.id)) }] });
  db = postMove(bill.db, bill.id);
  const items = journalItems(db, { from: '2025-03-01', to: '2025-03-31', company_id: 1 }).filter((item) => item.move_id === bill.id);
  assert.equal(items.filter((item) => (item.tax_ids ?? []).includes(tax.id)).reduce((sum, item) => sum + item.debit - item.credit, 0), 100);
  assert.equal(items.filter((item) => (item.tax_line_id ?? item.tax_id) === tax.id).reduce((sum, item) => sum + item.debit - item.credit, 0), 10);
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  const { Tax } = await import('./views/Reports.jsx');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await store.initStore();
  await store.commit(db);
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement('table', null, React.createElement(Tax, { db, period: { from: '2025-03-01', to: '2025-03-31' }, companyId: 1, variant: 'generic' }))));
    const taxRow = find(host, (node) => node.tagName === 'TR' && node.textContent.includes('Drill tax'));
    const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
    const baseLink = find(taxRow, (node) => node.tagName === 'A' && props(node)?.href?.includes('taxKind=base'));
    assert.ok(baseLink, 'tax base amount links to journal items');
    globalThis.location = { hash: props(baseLink).href };
    await React.act(async () => root.render(React.createElement(JournalItems)));
    const body = find(host, (node) => node.tagName === 'TBODY');
    const rows = body.childNodes.filter((node) => node.tagName === 'TR');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].textContent.includes(read(db, 'account.move', bill.id).name));
  } finally { await React.act(async () => root.unmount()); }
});

test('aged detail displays currency, foreign amount, account and expected date', () => {
  const db = { records: { 'res.currency': [{ id: 1, name: 'USD', rounding: 0.01 }], 'account.account': [{ id: 2, code: '1100', name: 'Receivable' }] } };
  const row = AgedDetailRow({ db, buckets: [], money: String, detail: { move_id: 1, name: 'INV', currency_id: 1, amount_currency: 25, account_id: 2, expected_date: '2025-02-01', total: 25 } });
  const cells = row.props.children;
  assert.equal(cells[2].props.children, 'USD');
  assert.match(cells[3].props.children, /25/);
  assert.equal(cells[4].props.children, '1100 Receivable');
  assert.equal(cells[5].props.children, '2025-02-01');
});

test('partner ledger and general ledger page interactive details while print and export retain every row', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  const { PartnerLedger, partnerLedgerExportRows } = await import('./views/FinanceReports.jsx');
  const { Reports, generalLedgerExportRows } = await import('./views/Reports.jsx');
  const db = { records: {
    'res.company': [{ id: 1, name: 'Main Co', currency_id: 1 }], 'res.currency': [{ id: 1, name: 'USD', rounding: 0.01 }],
    'res.partner': [{ id: 1, name: 'Customer' }], 'account.account': [{ id: 1, code: '1100', name: 'Receivable', account_type: 'asset_receivable' }],
    'account.journal': [{ id: 1, name: 'Sales', code: 'SAL', type: 'sale', company_id: 1 }],
    'account.move': Array.from({ length: 81 }, (_, i) => ({ id: i + 1, name: `M${i + 1}`, state: 'posted', date: '2025-01-01', journal_id: 1, company_id: 1, line_ids: [{ account_id: 1, partner_id: 1, debit: 1 }] })),
  }, settings: { current_company_id: 1, allowed_company_ids: [1], base_currency_id: 1 } };
  await store.initStore();
  await store.commit(db);
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const all = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => all(child, predicate))];
  try {
    // 1. Interactive PartnerLedger mounts 0 detail rows when folded, 80 when expanded, 81 after Load more...
    await React.act(async () => root.render(React.createElement('table', null, React.createElement(PartnerLedger, { db, period: { from: '2025-01-01', to: '2025-01-31' }, companyId: 1, accountType: 'receivable' }))));
    assert.equal(all(host, (node) => node.tagName === 'TR' && node.className?.includes('rep-detail')).length, 0);
    assert.equal(all(host, (node) => node.className?.includes('report-folded-row')).length, 0);
    const section = find(host, (node) => node.className === 'rep-section');
    await React.act(async () => props(section).onClick());
    assert.equal(all(host, (node) => node.tagName === 'TR' && node.className === 'rep-detail').length, 80);
    const more = find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Load more...');
    assert.ok(more);
    await React.act(async () => props(more).onClick());
    assert.equal(all(host, (node) => node.tagName === 'TR' && node.className === 'rep-detail').length, 81);

    // Export retains all 81 rows regardless of collapsed/paged UI state
    const partnerExport = partnerLedgerExportRows(db, { period: { from: '2025-01-01', to: '2025-01-31' }, companyId: 1, accountType: 'receivable' });
    assert.equal(partnerExport.rows.filter((row) => row[0]?.includes('2025-01-01')).length, 81);
    const glExport = generalLedgerExportRows(db, { period: { from: '2025-01-01', to: '2025-01-31' }, companyId: 1 });
    assert.equal(glExport.rows.filter((row) => row[1] === '2025-01-01').length, 81);

    // 2. Reports Ledger folded in screen mode (0 detail rows), and Print expands all 81 rows
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'ledger', title: 'General Ledger' } })));
    const select = find(host, (node) => node.tagName === 'SELECT' && props(node)?.value && ['month', 'quarter', 'year', 'all', 'custom'].includes(props(node).value));
    await React.act(async () => props(select).onChange({ target: { value: 'all' } }));
    assert.equal(all(host, (node) => node.tagName === 'TR' && node.className?.includes('rep-detail')).length, 0);
    const ledgerSection = find(host, (node) => node.className === 'rep-section');
    await React.act(async () => props(ledgerSection).onClick());
    assert.equal(all(host, (node) => node.tagName === 'TR' && node.className === 'rep-detail').length, 81); // 1 initial + 80 lines
    const printBtn = find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Print');
    await React.act(async () => props(printBtn).onClick());
    assert.equal(all(host, (node) => node.tagName === 'TR' && node.className === 'rep-detail').length, 82); // 1 initial + 81 lines
  } finally { await React.act(async () => root.unmount()); }
});

test('Finding 2: unposted tax reports and tax drills include draft invoices without journal lines', async () => {
  let db = seed();
  const tax = create(db, 'account.tax', {
    name: 'Draft VAT 15%', amount: 15, amount_type: 'percent', type_tax_use: 'sale', company_id: 1,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: accountId(db, '251000') ?? accountId(db, '131000') },
    ],
  });
  db = tax.db;
  const draftInv = create(db, 'account.move', {
    name: 'INV/DRAFT/01', move_type: 'out_invoice', partner_id: 1, invoice_date: '2025-04-10', company_id: 1,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 200, ...taxSnapshot(read(db, 'account.tax', tax.id)) }],
  });
  db = draftInv.db;
  assert.equal((read(db, 'account.move', draftInv.id).line_ids ?? []).length, 0);

  const { taxesByTax, taxReport } = await import('./models/finance.js');
  assert.equal(taxesByTax(db, { from: '2025-04-01', to: '2025-04-30', company_id: 1 }).length, 0);
  assert.equal(taxReport(db, { from: '2025-04-01', to: '2025-04-30', company_id: 1 }).output, 0);

  const unpostedRows = taxesByTax(db, { from: '2025-04-01', to: '2025-04-30', company_id: 1, reviewMode: 'all' });
  const row = unpostedRows.find((r) => r.tax_id === tax.id);
  assert.ok(row);
  assert.equal(row.base, 200);
  assert.equal(row.tax, 30);
  assert.equal(taxReport(db, { from: '2025-04-01', to: '2025-04-30', company_id: 1, reviewMode: 'all' }).output, 30);

  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  const { Tax } = await import('./views/Reports.jsx');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await store.initStore();
  await store.commit(db);
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  try {
    await React.act(async () => root.render(React.createElement('table', null, React.createElement(Tax, { db, period: { from: '2025-04-01', to: '2025-04-30', reviewMode: 'all' }, companyId: 1, variant: 'generic' }))));
    const taxRow = find(host, (node) => node.tagName === 'TR' && node.textContent.includes('Draft VAT 15%'));
    const baseLink = find(taxRow, (node) => node.tagName === 'A' && props(node)?.href?.includes('taxKind=base'));
    globalThis.location = { hash: props(baseLink).href };
    await React.act(async () => root.render(React.createElement(JournalItems, { key: props(baseLink).href })));
    const tbody = find(host, (node) => node.tagName === 'TBODY');
    const rows = tbody.childNodes.filter((node) => node.tagName === 'TR');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].textContent.includes(read(db, 'account.move', draftInv.id).name));
  } finally { await React.act(async () => root.unmount()); }
});

test('Finding 3 & 6: aged details populate expected_date from date_maturity/due date and compute amount_currency in company currency', () => {
  const db = {
    records: {
      'res.company': [
        { id: 1, name: 'US Co', currency_id: 1 },
        { id: 2, name: 'EU Co', currency_id: 2 },
      ],
      'res.currency': [
        { id: 1, name: 'USD', rounding: 0.01 },
        { id: 2, name: 'EUR', rounding: 0.01, rate_ids: [{ company_id: 1, date: '2025-01-01', rate: 0.8 }] }, // 1 USD = 0.8 EUR => 1 EUR = 1.25 USD
        { id: 3, name: 'GBP', rounding: 0.01, rate_ids: [{ company_id: 2, date: '2025-01-01', rate: 0.8 }] },
      ],
      'res.partner': [{ id: 1, name: 'Euro Client' }],
      'account.account': [
        { id: 1, code: '1100', name: 'AR', account_type: 'asset_receivable', company_id: 2 },
        { id: 2, code: '4000', name: 'Rev', account_type: 'income', company_id: 2 },
      ],
      'account.move': [
        {
          id: 10, name: 'INV/EU/10', state: 'posted', move_type: 'out_invoice', company_id: 2, partner_id: 1,
          currency_id: 3, invoice_date: '2025-01-10', invoice_date_due: '2025-02-10', date: '2025-01-10',
          amount_total: 100,
          line_ids: [
            { account_id: 1, partner_id: 1, debit: 120, credit: 0, currency_id: 3, amount_currency: 100, date_maturity: '2025-02-15' },
            { account_id: 2, partner_id: 1, debit: 0, credit: 120, currency_id: 3, amount_currency: -100 },
          ],
          payments: [{ move_id: 11, date: '2025-01-20', amount: 50, company_amount: 60 }],
        },
        {
          id: 12, name: 'INV/EU/DRAFT', state: 'draft', move_type: 'out_invoice', company_id: 2, partner_id: 1,
          currency_id: 2, invoice_date: '2025-01-12', invoice_date_due: '2025-02-20', date: '2025-01-12',
          invoice_line_ids: [{ qty: 1, price_unit: 40 }], line_ids: [],
        },
      ],
      'account.payment': [],
    },
    settings: { current_company_id: 1, base_currency_id: 1 },
  };
  const aged = agedBalance(db, 'receivable', '2025-02-01', null, { reviewMode: 'all' });
  const details = aged.rows[0].invoices;
  const postedDetail = details.find((d) => d.move_id === 10);
  const draftDetail = details.find((d) => d.move_id === 12);
  assert.equal(postedDetail.expected_date, '2025-02-15');
  assert.equal(draftDetail.expected_date, '2025-02-20');
  // 60 EUR booked open * 1.25 = 75 USD reporting total, while foreign remainder in GBP is 60 * 100 / 120 = 50 GBP
  assert.equal(postedDetail.total, 75);
  assert.equal(postedDetail.currency_id, 3);
  assert.equal(postedDetail.amount_currency, 50);
});

test('Finding 4: general ledger initial and end drills apply trialOpening remap for P&L and earnings accounts', async () => {
  const db = {
    records: {
      'res.company': [{ id: 1, name: 'Co', currency_id: 1, current_year_earnings_account_id: 3 }],
      'res.currency': [{ id: 1, name: 'USD', rounding: 0.01 }],
      'res.partner': [{ id: 7, name: 'Alice' }],
      'account.account': [
        { id: 1, code: '1000', name: 'Cash', account_type: 'asset_cash', company_id: 1 },
        { id: 2, code: '4000', name: 'Sales', account_type: 'income', company_id: 1 },
        { id: 3, code: '3020', name: 'Undistributed', account_type: 'equity_unaffected', company_id: 1 },
      ],
      'account.move': [
        { id: 1, name: 'M2024', state: 'posted', move_type: 'entry', date: '2024-06-01', company_id: 1, line_ids: [{ account_id: 1, partner_id: 7, debit: 100 }, { account_id: 2, partner_id: 7, credit: 100 }] },
        { id: 2, name: 'M2025', state: 'posted', move_type: 'entry', date: '2025-02-01', company_id: 1, line_ids: [{ account_id: 1, partner_id: 7, debit: 50 }, { account_id: 2, partner_id: 7, credit: 50 }] },
      ],
    },
    settings: { current_company_id: 1, allowed_company_ids: [1], base_currency_id: 1 },
  };
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  const { REPORTS } = await import('./views/Reports.jsx');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await store.initStore();
  await store.commit(db);
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const all = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => all(child, predicate))];
  try {
    const Body = REPORTS.ledger.Body;
    await React.act(async () => root.render(React.createElement('table', null, React.createElement(Body, { db, period: { from: '2025-01-01', to: '2025-12-31' }, companyId: 1, groupByPartner: true }))));
    const salesRow = all(host, (node) => node.tagName === 'TR' && node.className === 'rep-section').find((tr) => tr.textContent.includes('4000 Sales'));
    const salesLinks = all(salesRow, (node) => node.tagName === 'A').map((a) => props(a).href);
    assert.ok(salesLinks[0].includes('trialOpening=2025-01-01'));
    assert.ok(salesLinks[3].includes('trialOpening=2025-01-01'));

    // Partner sub-row under Sales also carries trialOpening
    await React.act(async () => props(salesRow).onClick());
    const partnerRow = find(host, (node) => node.tagName === 'TR' && node.className?.includes('rep-partner'));
    const partnerInitialHref = props(all(partnerRow, (node) => node.tagName === 'A')[0]).href;
    assert.ok(partnerInitialHref.includes('trialOpening=2025-01-01'));

    // Drilling Sales initial balance shows 0 rows (2024 P&L remapped to earnings)
    globalThis.location = { hash: salesLinks[0] };
    await React.act(async () => root.render(React.createElement(JournalItems, { key: salesLinks[0] })));
    const salesInitBody = find(host, (node) => node.tagName === 'TBODY');
    assert.equal(salesInitBody.childNodes.filter((n) => n.tagName === 'TR' && all(n, (c) => c.tagName === 'A' && props(c)?.href?.startsWith('#/accounting/entries/')).length > 0).length, 0);

    // Drilling Sales end balance shows only M2025 (not M2024)
    globalThis.location = { hash: salesLinks[3] };
    await React.act(async () => root.render(React.createElement(JournalItems, { key: salesLinks[3] })));
    const salesEndMoves = all(host, (n) => n.tagName === 'A' && props(n)?.href?.startsWith('#/accounting/entries/')).map((n) => Number(props(n).href.split('/').pop()));
    assert.deepEqual(salesEndMoves, [2]);
  } finally { await React.act(async () => root.unmount()); }
});

test('Finding 5: analytic-filtered TrialBalance, FiscalReport, PartnerLedger, and Ledger open weighted matching items', async () => {
  const db = {
    records: {
      'res.company': [{ id: 1, name: 'Co', currency_id: 1 }],
      'res.currency': [{ id: 1, name: 'USD', rounding: 0.01 }],
      'res.partner': [{ id: 1, name: 'Pat' }],
      'account.analytic.account': [{ id: 10, name: 'Proj A' }, { id: 20, name: 'Proj B' }],
      'account.fiscal.category': [{ id: 1, name: 'Operating' }],
      'account.account': [
        { id: 1, code: '1100', name: 'AR', account_type: 'asset_receivable', company_id: 1, fiscal_category_id: 1 },
        { id: 2, code: '4000', name: 'Rev', account_type: 'income', company_id: 1, fiscal_category_id: 1 },
      ],
      'account.move': [
        {
          id: 1, name: 'M1', state: 'posted', move_type: 'entry', date: '2025-05-01', company_id: 1,
          line_ids: [
            { account_id: 1, partner_id: 1, debit: 100, analytic_distribution: { 10: 60, 20: 40 } },
            { account_id: 2, partner_id: 1, credit: 100, analytic_distribution: { 10: 60, 20: 40 } },
          ],
        },
        {
          id: 2, name: 'M2', state: 'posted', move_type: 'entry', date: '2025-05-02', company_id: 1,
          line_ids: [
            { account_id: 1, partner_id: 1, debit: 50, analytic_distribution: { 20: 100 } },
            { account_id: 2, partner_id: 1, credit: 50, analytic_distribution: { 20: 100 } },
          ],
        },
      ],
    },
    settings: { current_company_id: 1, allowed_company_ids: [1], base_currency_id: 1 },
  };
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  const { TrialBalance, FiscalReport, PartnerLedger } = await import('./views/FinanceReports.jsx');
  const { REPORTS } = await import('./views/Reports.jsx');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await store.initStore();
  await store.commit(db);
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const all = (node, predicate) => [...(predicate(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => all(child, predicate))];
  const period = { from: '2025-05-01', to: '2025-05-31' };
  try {
    for (const [Comp, extra] of [
      [TrialBalance, {}],
      [PartnerLedger, { accountType: 'receivable' }],
      [REPORTS.ledger.Body, {}],
    ]) {
      await React.act(async () => root.render(React.createElement('table', null, React.createElement(Comp, { db, period, companyId: 1, analyticAccountIds: [10], ...extra }))));
      const drillLinks = all(host, (n) => n.tagName === 'A' && props(n)?.href?.startsWith('#/accounting/journal-items?')).map((n) => props(n).href);
      assert.ok(drillLinks.length > 0 && drillLinks.every((href) => href.includes('analytics=10')));
    }
    await React.act(async () => root.render(React.createElement('table', null, React.createElement(FiscalReport, { db, period, companyId: 1, analyticAccountIds: [10] }))));
    await React.act(async () => props(find(host, (n) => n.tagName === 'BUTTON')).onClick());
    const fiscalLink = find(host, (n) => n.tagName === 'A' && props(n)?.href?.startsWith('#/accounting/journal-items?'));
    assert.ok(props(fiscalLink).href.includes('analytics=10'));

    // Opening the TrialBalance debit drill shows only M1 weighted at 60% (debit = 60, not 100 or 150)
    await React.act(async () => root.render(React.createElement('table', null, React.createElement(TrialBalance, { db, period, companyId: 1, analyticAccountIds: [10] }))));
    const debitLink = all(host, (n) => n.tagName === 'A' && props(n)?.href?.includes('account=1') && props(n)?.href?.includes('from=2025-05-01')).find((n) => props(n).href.includes('analytics=10'));
    globalThis.location = { hash: props(debitLink).href };
    await React.act(async () => root.render(React.createElement(JournalItems, { key: props(debitLink).href })));
    const entryLinks = all(host, (n) => n.tagName === 'A' && props(n)?.href?.startsWith('#/accounting/entries/'));
    assert.deepEqual(entryLinks.map((n) => Number(props(n).href.split('/').pop())), [1]);
    assert.ok(find(host, (n) => n.tagName === 'TBODY').textContent.includes('60.00'));
  } finally { await React.act(async () => root.unmount()); }
});

test('Finding 7: tax base drill matches zero-rated base lines and previously posted invoices lacking tax_ids', async () => {
  const db = {
    records: {
      'res.company': [{ id: 1, name: 'Co', currency_id: 1 }],
      'res.currency': [{ id: 1, name: 'USD', rounding: 0.01 }],
      'res.partner': [{ id: 1, name: 'Cust' }],
      'account.tax': [
        { id: 10, name: 'VAT 15%', amount: 15, amount_type: 'percent', type_tax_use: 'sale', company_id: 1 },
        { id: 11, name: 'Zero VAT', amount: 0, amount_type: 'percent', type_tax_use: 'sale', company_id: 1 },
      ],
      'account.account': [
        { id: 1, code: '1100', name: 'AR', account_type: 'asset_receivable', company_id: 1 },
        { id: 2, code: '4000', name: 'Sales', account_type: 'income', company_id: 1 },
        { id: 3, code: '2510', name: 'Tax Payable', account_type: 'liability_current', company_id: 1 },
      ],
      'account.move': [
        {
          id: 1, name: 'INV/LEGACY/1', state: 'posted', move_type: 'out_invoice', partner_id: 1, date: '2025-06-05', invoice_date: '2025-06-05', company_id: 1,
          line_ids: [
            { account_id: 1, partner_id: 1, debit: 230, credit: 0 },
            { account_id: 2, partner_id: 1, debit: 0, credit: 200, name: 'Sales' }, // legacy base line without tax_ids
            { account_id: 3, partner_id: 1, debit: 0, credit: 30, tax_id: 10, tax_name: 'VAT 15%', tax_base: 200, tax_side: 'sale' },
          ],
        },
        {
          id: 2, name: 'INV/ZERO/2', state: 'posted', move_type: 'out_invoice', partner_id: 1, date: '2025-06-06', invoice_date: '2025-06-06', company_id: 1,
          line_ids: [
            { account_id: 1, partner_id: 1, debit: 150, credit: 0 },
            { account_id: 2, partner_id: 1, debit: 0, credit: 150, tax_id: 11, tax_name: 'Zero VAT', tax_base: 150, tax_zero: true, tax_side: 'sale' },
          ],
        },
      ],
    },
    settings: { current_company_id: 1, allowed_company_ids: [1], base_currency_id: 1 },
  };
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  const { Tax } = await import('./views/Reports.jsx');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await store.initStore();
  await store.commit(db);
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  try {
    await React.act(async () => root.render(React.createElement('table', null, React.createElement(Tax, { db, period: { from: '2025-06-01', to: '2025-06-30' }, companyId: 1, variant: 'generic' }))));
    for (const [taxName, expectedMoveName] of [['VAT 15%', 'INV/LEGACY/1'], ['Zero VAT', 'INV/ZERO/2']]) {
      await React.act(async () => root.render(React.createElement('table', null, React.createElement(Tax, { db, period: { from: '2025-06-01', to: '2025-06-30' }, companyId: 1, variant: 'generic' }))));
      const taxRow = find(host, (n) => n.tagName === 'TR' && n.textContent.includes(taxName));
      const baseLink = find(taxRow, (n) => n.tagName === 'A' && props(n)?.href?.includes('taxKind=base'));
      globalThis.location = { hash: props(baseLink).href };
      await React.act(async () => root.render(React.createElement(JournalItems, { key: props(baseLink).href })));
      const tbody = find(host, (n) => n.tagName === 'TBODY');
      const rows = tbody.childNodes.filter((n) => n.tagName === 'TR');
      assert.equal(rows.length, 1);
      assert.ok(rows[0].textContent.includes(expectedMoveName));
      assert.ok(rows[0].textContent.includes('Sales'));
    }
  } finally { await React.act(async () => root.unmount()); }
});

test('Finding 9: aged bucket drill uses today cutoff when period.to is empty', async () => {
  const { today } = await import('./models/common.js');
  const db = {
    records: {
      'res.company': [{ id: 1, name: 'Co', currency_id: 1 }],
      'res.currency': [{ id: 1, name: 'USD', rounding: 0.01 }],
      'res.partner': [{ id: 1, name: 'Cust' }],
      'account.account': [{ id: 1, code: '1100', name: 'AR', account_type: 'asset_receivable', company_id: 1 }],
      'account.move': [
        { id: 1, name: 'M/TODAY', state: 'posted', move_type: 'entry', date: today(), company_id: 1, line_ids: [{ account_id: 1, partner_id: 1, debit: 80, date_maturity: today() }] },
      ],
      'account.payment': [],
    },
    settings: { current_company_id: 1, allowed_company_ids: [1], base_currency_id: 1 },
  };
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const store = await import('./store.js');
  const { REPORTS } = await import('./views/Reports.jsx');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await store.initStore();
  await store.commit(db);
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  try {
    const Body = REPORTS.agedReceivable.Body;
    await React.act(async () => root.render(React.createElement('table', null, React.createElement(Body, { db, period: {}, companyId: 1, agingOptions: {} }))));
    const bucketLink = find(host, (n) => n.tagName === 'A' && props(n)?.href?.includes('agedBucket=current'));
    assert.ok(bucketLink);
    assert.ok(props(bucketLink).href.includes(`to=${today()}`));
    // Also verify JournalItems handles an aged drill link even when `to` is omitted
    const hrefWithoutTo = props(bucketLink).href.replace(/&to=[^&]+/, '');
    globalThis.location = { hash: hrefWithoutTo };
    await React.act(async () => root.render(React.createElement(JournalItems, { key: hrefWithoutTo })));
    const tbody = find(host, (n) => n.tagName === 'TBODY');
    assert.ok(tbody.textContent.includes('M/TODAY'));
  } finally { await React.act(async () => root.unmount()); }
});
