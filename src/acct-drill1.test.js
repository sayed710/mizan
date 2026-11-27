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

test('partner ledger pages details while export retains every row', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { tableToRows } = await import('./csv.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { PartnerLedger } = await import('./views/FinanceReports.jsx');
  const db = { records: {
    'res.company': [{ id: 1, currency_id: 1 }], 'res.currency': [{ id: 1, rounding: 0.01 }],
    'res.partner': [{ id: 1, name: 'Customer' }], 'account.account': [{ id: 1, account_type: 'asset_receivable' }],
    'account.move': Array.from({ length: 81 }, (_, i) => ({ id: i + 1, name: `M${i + 1}`, state: 'posted', date: '2025-01-01', company_id: 1, line_ids: [{ account_id: 1, partner_id: 1, debit: 1 }] })),
  }, settings: { current_company_id: 1, base_currency_id: 1 } };
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const all = (node, predicate) => [ ...(predicate(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => all(child, predicate)) ];
  try {
    await React.act(async () => root.render(React.createElement('table', null, React.createElement(PartnerLedger, { db, period: { from: '2025-01-01', to: '2025-01-31' }, companyId: 1, accountType: 'receivable' }))));
    const section = find(host, (node) => node.className === 'rep-section');
    await React.act(async () => props(section).onClick());
    assert.equal(all(host, (node) => node.tagName === 'TR' && node.className === 'rep-detail').length, 80);
    const table = find(host, (node) => node.tagName === 'TABLE');
    assert.equal(tableToRows(table).filter((row) => row[0]?.includes('2025-01-01')).length, 81);
    const more = find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Load more...');
    assert.ok(more);
    await React.act(async () => props(more).onClick());
    assert.equal(all(host, (node) => node.tagName === 'TR' && node.className === 'rep-detail').length, 81);
  } finally { await React.act(async () => root.unmount()); }
});
