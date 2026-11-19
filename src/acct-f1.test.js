import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { executiveSummary } from './models/reports.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

function multiCompanyBooks() {
  let db = seed();
  const c1 = read(db, 'res.company', 1);

  // Second company with its own currency and default journal
  const comp2 = create(db, 'res.company', {
    name: 'Company Two',
    currency_id: c1.currency_id,
    default_general_journal_id: c1.default_general_journal_id,
  });
  db = comp2.db;

  const cash1 = search(db, 'account.account').find((a) => a.code === '101401');
  const rev1 = search(db, 'account.account').find((a) => a.code === '400000');
  const recv1 = search(db, 'account.account').find((a) => a.code === '121000');
  const pay1 = search(db, 'account.account').find((a) => a.code === '211000');

  // Create dedicated accounts for Company 2
  const cash2 = create(db, 'account.account', {
    code: '101402',
    name: 'Cash Co2',
    account_type: 'asset_cash',
    company_id: comp2.id,
  });
  const rev2 = create(cash2.db, 'account.account', {
    code: '400002',
    name: 'Revenue Co2',
    account_type: 'income',
    company_id: comp2.id,
  });
  const recv2 = create(rev2.db, 'account.account', {
    code: '121002',
    name: 'Receivable Co2',
    account_type: 'asset_receivable',
    company_id: comp2.id,
  });
  const exp2 = create(recv2.db, 'account.account', {
    code: '110202',
    name: 'Expense Co2',
    account_type: 'expense',
    company_id: comp2.id,
  });
  const pay2 = create(exp2.db, 'account.account', {
    code: '211002',
    name: 'Payable Co2',
    account_type: 'liability_payable',
    company_id: comp2.id,
  });
  db = pay2.db;

  // Post entry in Company 1: Revenue 10,000, Receivables 6,000, Cash 4,000, Payables 3,000, Expense 3,000
  const exp1 = search(db, 'account.account').find((a) => a.code === '600000'); // expense
  const move1a = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    invoice_date: '2026-06-01',
    line_ids: [
      { account_id: recv1.id, debit: 6000, credit: 0 },
      { account_id: cash1.id, debit: 4000, credit: 0 },
      { account_id: rev1.id, debit: 0, credit: 10000 },
    ],
  });
  db = postMove(move1a.db, move1a.id);

  const move1b = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    invoice_date: '2026-06-02',
    line_ids: [
      { account_id: exp1.id, debit: 3000, credit: 0 },
      { account_id: pay1.id, debit: 0, credit: 3000 },
    ],
  });
  db = postMove(move1b.db, move1b.id);

  // Post entry in Company 2: Revenue 25,000, Receivables 15,000, Cash 10,000, Expense 8,000, Payables 8,000
  const move2a = create(db, 'account.move', {
    move_type: 'entry',
    company_id: comp2.id,
    invoice_date: '2026-06-10',
    line_ids: [
      { account_id: recv2.id, debit: 15000, credit: 0 },
      { account_id: cash2.id, debit: 10000, credit: 0 },
      { account_id: rev2.id, debit: 0, credit: 25000 },
    ],
  });
  db = postMove(move2a.db, move2a.id);

  const move2b = create(db, 'account.move', {
    move_type: 'entry',
    company_id: comp2.id,
    invoice_date: '2026-06-11',
    line_ids: [
      { account_id: exp2.id, debit: 8000, credit: 0 },
      { account_id: pay2.id, debit: 0, credit: 8000 },
    ],
  });
  db = postMove(move2b.db, move2b.id);

  return { db, company1Id: 1, company2Id: comp2.id };
}

test('FIN-1: executiveSummary scopes figures to company_id without commingling', () => {
  const { db, company1Id, company2Id } = multiCompanyBooks();
  const period = { from: '2026-06-01', to: '2026-06-30' };

  // Company 2 specific summary
  const summaryCo2 = executiveSummary(db, { ...period, company_id: company2Id });
  assert.equal(summaryCo2.revenue, 25000, 'Company 2 revenue should be strictly 25,000');
  assert.equal(summaryCo2.receivables, 15000, 'Company 2 receivables should be 15,000');
  assert.equal(summaryCo2.payables, 8000, 'Company 2 payables should be 8,000');
  assert.equal(summaryCo2.cash, 10000, 'Company 2 cash should be 10,000');
  assert.equal(summaryCo2.grossProfit, 25000);
  assert.equal(summaryCo2.netProfit, 17000, 'Company 2 net profit should be 25,000 - 8,000 = 17,000');

  // Company 1 specific summary
  const summaryCo1 = executiveSummary(db, { ...period, company_id: company1Id });
  assert.equal(summaryCo1.revenue, 10000, 'Company 1 revenue should be strictly 10,000');
  assert.equal(summaryCo1.grossProfit, 10000);
  assert.equal(summaryCo1.netProfit, 7000);

  // Consolidated / all companies summary (when company_id is omitted)
  const summaryAll = executiveSummary(db, period);
  assert.equal(summaryAll.revenue, 35000, 'Consolidated revenue combines all companies');
  assert.equal(summaryAll.grossProfit, 35000);
  assert.equal(summaryAll.netProfit, 24000);
});

test('FIN-1: ExecutiveSummary view component respects companyId prop and period.company_id', async () => {
  const { db, company2Id } = multiCompanyBooks();
  const period = { from: '2026-06-01', to: '2026-06-30' };

  const { setupDom } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { ExecutiveSummary } = await import('./views/FinanceReports.jsx');

  const host = makeEl('table');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    // Render with companyId = company2Id
    await React.act(async () => {
      root.render(React.createElement(ExecutiveSummary, {
        db,
        period,
        companyId: String(company2Id),
      }));
    });
    const renderedText = textOf(host);
    // Company 2 revenue is 25,000.00; consolidated was 35,000.00
    assert.match(renderedText, /25,000\.00/, 'View should render Company 2 revenue');
    assert.doesNotMatch(renderedText, /35,000\.00/, 'View should not commingle Company 1 revenue');

    // Render with period.company_id fallback
    await React.act(async () => {
      root.render(React.createElement(ExecutiveSummary, {
        db,
        period: { ...period, company_id: company2Id },
      }));
    });
    assert.match(textOf(host), /25,000\.00/);
    assert.doesNotMatch(textOf(host), /35,000\.00/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('the Executive Summary report page offers a company selector that scopes the figures', async () => {
  const { db, company2Id } = multiCompanyBooks();
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/executive-summary' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit({ ...db, settings: { ...db.settings, allowed_company_ids: [1, company2Id] } }));
  const { Reports } = await import('./views/Reports.jsx');
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { label: 'Executive Summary', report: 'executive' } })));
    const select = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Company');
    assert.ok(select, 'Executive Summary shows a company selector in a multi-company database');
    await React.act(async () => props(select).onChange({ target: { value: String(company2Id) } }));
    assert.match(textOf(host), /25,000\.00/);
    assert.doesNotMatch(textOf(host), /35,000\.00/);
  } finally {
    await React.act(async () => root.unmount());
  }
});
