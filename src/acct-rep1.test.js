import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { createCompany, setCompanies } from './models/company.js';
import { postMove } from './models/accounting.js';
import { today } from './models/common.js';
import { create, read, search, write } from './orm.js';
import { accountingCompany } from './test-support/accounting-company.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
const reactProps = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

async function render(report, db) {
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await commit(db);
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Reports } = await import('./views/Reports.jsx');
  return renderToStaticMarkup(React.createElement(Reports, { leaf: { report } }));
}

test('REP-1 aged reports offer as-of and partner filters', async () => {
  for (const report of ['agedReceivable', 'agedPayable']) {
    const html = await render(report, seed());
    assert.match(html, /As of/);
    assert.match(html, /aria-label="Partners"/);
    assert.doesNotMatch(html, /This Month/);
  }
});

test('REP-2 report company selectors appear for multiple allowed companies', async () => {
  const db = seed();
  const c = createCompany(db, { name: 'Branch', currency_id: read(db, 'res.company', 1).currency_id });
  const scoped = setCompanies(c.db, { current: 1, allowed: [1, c.id] });
  for (const report of ['ledger', 'trial', 'partnerReceivable', 'partnerPayable', 'agedReceivable', 'agedPayable', 'fiscal', 'analytic']) {
    assert.match(await render(report, scoped), /All companies/i, report);
  }
});

test('REP-3 trial balance offers period comparison', async () => {
  const html = await render('trial', seed());
  assert.match(html, /Previous Period/);
});

test('filters and comparison update rendered report data', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Reports } = await import('./views/Reports.jsx');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(seed()));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const findLabel = (name) => find(host, (node) => props(node)?.['aria-label'] === name);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'agedReceivable' } })));
    const partners = findLabel('Partners');
    assert.ok(partners);
    const options = props(partners).children;
    assert.ok(options.length > 0);
    await React.act(async () => props(partners).onChange({ target: { selectedOptions: [{ value: '999999' }] } }));
    assert.equal(find(host, (node) => node.tagName === 'A' && props(node)?.href === '#/open/res.partner/3'), null);
    await React.act(async () => props(findLabel('As of')).onChange({ target: { value: '2000-01-01' } }));
    assert.equal(props(findLabel('As of')).value, '2000-01-01');
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'trial' } })));
    const comparison = find(host, (node) => node.tagName === 'SELECT' && props(node)?.value === 'none');
    assert.ok(comparison);
    await React.act(async () => props(comparison).onChange({ target: { value: 'previous' } }));
    assert.ok((host.textContent.match(/Initial Balance/g) ?? []).length >= 2);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('other-company reports compute and format in the selected company currency whether active company is 1 or not', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Reports } = await import('./views/Reports.jsx');
  const { money, setCurrency } = await import('./ui.jsx');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  let db = seed();
  const eurRaw = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  assert.ok(eurRaw && usd);
  // Ensure an exchange rate exists across all seeded dates (0.5 EUR per USD, so any accidental conversion doubles/halves figures).
  db = write(db, 'res.currency', eurRaw.id, { rate_ids: [{ date: '2020-01-01', rate: 0.5, company_id: null }] });
  const eur = read(db, 'res.currency', eurRaw.id);
  // Check ui.jsx money(n, null, currency) uses currency.name rather than activeCurrencyCode when currency has no symbol.
  setCurrency('USD', usd);
  assert.match(money(100, null, { id: 99, name: 'GBP', rounding: 0.01 }), /£100\.00/);

  const branch = accountingCompany(db);
  const rev2 = create(branch.db, 'account.account', { code: '400002', name: 'Branch Revenue', account_type: 'income', company_id: branch.id });
  const saleJournal2 = create(rev2.db, 'account.journal', { name: 'Branch sales journal', code: 'INV2', type: 'sale', company_id: branch.id, default_account_id: rev2.id, invoice_sequence_prefix: 'INV2/', invoice_sequence_next_number: 1 });
  db = write(saleJournal2.db, 'res.company', branch.id, { currency_id: eur.id, default_sale_journal_id: saleJournal2.id });
  const analytic2 = create(db, 'account.analytic.account', { name: 'Branch Project', company_id: branch.id, plan_id: db.records['account.analytic.plan'][0].id });
  const date = today();
  const move2 = create(analytic2.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    company_id: branch.id,
    journal_id: saleJournal2.id,
    currency_id: eur.id,
    invoice_date: date,
    invoice_date_due: date,
    invoice_line_ids: [
      { name: 'Branch Service', account_id: rev2.id, qty: 1, price_unit: 100, tax: 0, analytic_distribution: { [analytic2.id]: 100 } },
    ],
  });
  db = postMove(move2.db, move2.id);

  // Also ensure company 1 has a distinct USD entry on its own account/category/partner so selection changes are exact.
  const cat1 = create(db, 'account.fiscal.category', { name: 'Main Fiscal' });
  const rev1 = create(cat1.db, 'account.account', { code: '400001', name: 'Main USD Revenue', account_type: 'income', company_id: 1, fiscal_category_id: cat1.id });
  const p1 = create(rev1.db, 'res.partner', { name: 'Main USD Partner' });
  const move1 = create(p1.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: p1.id,
    company_id: 1,
    currency_id: usd.id,
    invoice_date: date,
    invoice_date_due: date,
    invoice_line_ids: [
      { name: 'Main Service', account_id: rev1.id, qty: 1, price_unit: 250, tax: 0 },
    ],
  });
  db = postMove(move1.db, move1.id);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    // Case A: Active company is 1 (USD), user selects company 2 (EUR).
    await React.act(async () => commit(setCompanies(db, { current: 1, allowed: [1, branch.id] })));
    for (const report of ['ledger', 'trial', 'partnerReceivable', 'agedReceivable', 'fiscal', 'analytic']) {
      await React.act(async () => root.render(React.createElement(Reports, { key: `a-${report}`, leaf: { report } })));
      const companySelect = find(host, (node) => node.tagName === 'SELECT' && reactProps(node)?.['aria-label'] === 'Company');
      assert.ok(companySelect, `${report} company selector`);
      await React.act(async () => reactProps(companySelect).onChange({ target: { value: String(branch.id) } }));
      const output = textOf(host);
      assert.match(output, /100\.00\s*€/, `${report} (active=1 -> select=2) should show 100.00 € without USD conversion, got: ${output}`);
      assert.doesNotMatch(output, /\$200\.00|\$100\.00|\$250\.00/, `${report} should not format in USD or include company 1 amounts`);
    }

    // Retained allowed-company check: attempting to select an unauthorized company must not expose it.
    await React.act(async () => commit(setCompanies(db, { current: 1, allowed: [1] })));
    await React.act(async () => root.render(React.createElement(Reports, { key: 'unauth', leaf: { report: 'agedReceivable' } })));
    assert.equal(find(host, (node) => node.tagName === 'SELECT' && reactProps(node)?.['aria-label'] === 'Company'), null);

    // Case B: Active company is 2 (EUR), user selects company 1 (USD).
    await React.act(async () => commit(setCompanies(db, { current: branch.id, allowed: [1, branch.id] })));
    for (const report of ['ledger', 'trial', 'partnerReceivable', 'agedReceivable', 'fiscal']) {
      await React.act(async () => root.render(React.createElement(Reports, { key: `b-${report}`, leaf: { report } })));
      const companySelect = find(host, (node) => node.tagName === 'SELECT' && reactProps(node)?.['aria-label'] === 'Company');
      assert.ok(companySelect, `${report} company selector (active=2)`);
      await React.act(async () => reactProps(companySelect).onChange({ target: { value: '1' } }));
      const output = textOf(host);
      assert.match(output, /\$250\.00/, `${report} (active=2 -> select=1) should show $250.00 without throwing, got: ${output}`);
      assert.doesNotMatch(output, /100\.00\s*€|125\.00\s*€|250\.00\s*€/, `${report} should not show EUR amounts when company 1 is selected`);
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('TrialBalance comparison avoids quadratic per-row array scans and keeps zero fallback', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { TrialBalance } = await import('./views/FinanceReports.jsx');
  let db = seed();
  const cash = search(db, 'account.account').find((a) => a.code === '101401');
  const accounts = [];
  for (let i = 0; i < 8; i++) {
    const acc = create(db, 'account.account', { code: `60090${i}`, name: `Test Expense ${i}`, account_type: 'expense' });
    db = acc.db;
    accounts.push(acc.id);
  }
  // Post in period 1 for accounts 0..5, and in period 2 for accounts 2..7 so both periods have missing accounts.
  const makeMove = (accId, date, amount) => {
    const m = create(db, 'account.move', {
      move_type: 'entry',
      company_id: 1,
      invoice_date: date,
      line_ids: [
        { account_id: accId, debit: amount, credit: 0 },
        { account_id: cash.id, debit: 0, credit: amount },
      ],
    });
    db = postMove(m.db, m.id);
  };
  for (let i = 0; i < 6; i++) makeMove(accounts[i], '2026-01-10', 10 + i);
  for (let i = 2; i < 8; i++) makeMove(accounts[i], '2026-02-10', 20 + i);

  const periods = [
    { from: '2026-01-01', to: '2026-01-31', label: 'Jan 2026' },
    { from: '2026-02-01', to: '2026-02-28', label: 'Feb 2026' },
  ];

  const origFind = Array.prototype.find;
  let reportRowScans = 0;
  Array.prototype.find = function patchedFind(...args) {
    if (this.length > 0 && this[0]?.account && 'initial' in this[0] && 'debit' in this[0]) {
      reportRowScans++;
    }
    return origFind.apply(this, args);
  };
  let html;
  try {
    html = renderToStaticMarkup(React.createElement('table', null, React.createElement(TrialBalance, {
      db,
      period: periods[1],
      periods,
      companyId: '1',
    })));
  } finally {
    Array.prototype.find = origFind;
  }
  assert.equal(reportRowScans, 0, 'TrialBalance should look up period rows by account map instead of scanning report.rows');
  assert.match(html, /600900 Test Expense 0/);
  assert.match(html, /600907 Test Expense 7/);
  assert.match(html, /\$0\.00/);
});

test('aged report computes agedBalance once and partner filter changes do not rerun aging', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Reports } = await import('./views/Reports.jsx');
  const { initStore, commit } = await import('./store.js');
  await initStore();

  const db = seed();
  const invoice = db.records['account.move'].find((m) => m.state === 'posted' && m.move_type === 'out_invoice');
  assert.ok(invoice, 'seeded posted invoice exists');
  const basePayments = invoice.payments ?? [];
  let paymentReads = 0;
  Object.defineProperty(invoice, 'payments', {
    enumerable: true,
    configurable: true,
    get() {
      paymentReads++;
      return basePayments;
    },
  });

  await React.act(async () => commit(db));
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'agedReceivable' } })));
    const readsAfterInitial = paymentReads;
    assert.ok(readsAfterInitial > 0, 'agedBalance ran on initial render');

    // Before the fix, ReportPage ran agedBalance twice on initial render; with single-pass aging it runs once.
    // Even more critically, changing the partner filter must not rerun agedBalance at all.
    const partners = find(host, (node) => reactProps(node)?.['aria-label'] === 'Partners');
    assert.ok(partners);
    await React.act(async () => reactProps(partners).onChange({ target: { selectedOptions: [{ value: String(invoice.partner_id) }] } }));
    assert.equal(paymentReads, readsAfterInitial, 'changing partner filter must not rerun agedBalance');

    await React.act(async () => reactProps(partners).onChange({ target: { selectedOptions: [{ value: '999999' }] } }));
    assert.equal(paymentReads, readsAfterInitial, 'clearing/changing partner filter again must not rerun agedBalance');
  } finally {
    await React.act(async () => root.unmount());
  }
});
