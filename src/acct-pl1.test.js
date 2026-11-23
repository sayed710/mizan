import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { partnerLedger } from './models/reports.js';
import { today, addDays } from './models/common.js';
import { apps, leavesOf } from './models/index.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('PL-1 combines partner receivable and payable balances and filters the report', async () => {
  let db = seed();
  const date = today();
  const prior = addDays(date, -1);
  db = postEntry(db, { journal: 'MISC', date: prior, ref: 'PL1 opening', lines: [
    { account: '121000', debit: 100, partner_id: 3 }, { account: '211000', credit: 40, partner_id: 3 }, { account: '301000', credit: 60 },
  ] }).db;
  db = postEntry(db, { journal: 'MISC', date, ref: 'PL1 activity', lines: [
    { account: '121000', debit: 30, partner_id: 3 }, { account: '211000', credit: 20, partner_id: 3 }, { account: '301000', credit: 10 },
  ] }).db;
  const period = { from: date, to: date, partnerIds: [3] };
  const both = partnerLedger(db, period, 'both')[0];
  const ar = partnerLedger(db, period, 'receivable')[0];
  const ap = partnerLedger(db, period, 'payable')[0];
  for (const key of ['initial', 'debit', 'credit', 'end']) assert.equal(both[key], ar[key] + ap[key]);
  let balance = both.initial;
  for (const line of both.lines) { balance += line.debit - line.credit; assert.equal(line.balance, balance); }
  const app = apps.find((a) => a.id === 'accounting');
  assert.ok(leavesOf(app).some((l) => l.key === 'partner-ledger'));
  assert.ok(!leavesOf(app).some((l) => l.key === 'partner-ledger-payable'));
  const { initStore, commit } = await import('./store.js');
  await initStore(); await commit(db);
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Reports } = await import('./views/Reports.jsx');
  const html = renderToStaticMarkup(React.createElement(Reports, { leaf: { report: 'partnerReceivable' } }));
  assert.match(html, /aria-label="Account Type"/);
  assert.match(html, /value="both" selected/);
  const redirected = renderToStaticMarkup(React.createElement(Reports, { leaf: { report: 'partnerReceivable' }, params: new URLSearchParams('accountType=payable') }));
  assert.match(redirected, /value="payable" selected/);
});

test('PL-1 URL accountType accepts all three valid options (both, receivable, payable)', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Reports } = await import('./views/Reports.jsx');

  const arHtml = renderToStaticMarkup(React.createElement(Reports, {
    leaf: { report: 'partnerReceivable' },
    params: new URLSearchParams('accountType=receivable'),
  }));
  assert.match(arHtml, /value="receivable" selected/);

  const apHtml = renderToStaticMarkup(React.createElement(Reports, {
    leaf: { report: 'partnerReceivable' },
    params: new URLSearchParams('accountType=payable'),
  }));
  assert.match(apHtml, /value="payable" selected/);

  const bothHtml = renderToStaticMarkup(React.createElement(Reports, {
    leaf: { report: 'partnerReceivable' },
    params: new URLSearchParams('accountType=both'),
  }));
  assert.match(bothHtml, /value="both" selected/);
});

test('PL-1 selector updates URL accountType parameter preserving other parameters and filters without remount', async () => {
  const { setupDom, find } = await import('./test-support/dom.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Reports } = await import('./views/Reports.jsx');
  const { initStore } = await import('./store.js');
  await initStore();

  const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
  const reactProps = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

  globalThis.location = {
    hash: '#/accounting/partner-ledger?from=2026-01-01&to=2026-12-31&accountType=payable',
    replace(h) { this.hash = h; },
  };

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    const leaf = { key: 'partner-ledger', report: 'partnerReceivable' };
    const initialParams = new URLSearchParams('from=2026-01-01&to=2026-12-31&accountType=payable');

    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf, params: initialParams }));
    });

    const select = find(host, (n) => n.tagName === 'SELECT' && reactProps(n)?.['aria-label'] === 'Account Type');
    assert.ok(select, 'Account type selector exists');
    assert.equal(reactProps(select).value, 'payable');

    // Toggle unreconciledOnly checkbox to verify in-memory filter preservation
    const unreconciledBox = find(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'checkbox' && textOf(n.parentNode).includes('Unreconciled'));
    assert.ok(unreconciledBox, 'Unreconciled checkbox exists');
    assert.equal(reactProps(unreconciledBox).checked, false);

    await React.act(async () => {
      reactProps(unreconciledBox).onChange({ target: { checked: true } });
    });
    assert.equal(reactProps(unreconciledBox).checked, true);

    // Change Account Type to receivable
    await React.act(async () => {
      reactProps(select).onChange({ target: { value: 'receivable' } });
    });

    // In-memory filter remains checked (no remount that resets filter state)
    assert.equal(reactProps(unreconciledBox).checked, true, 'Filter preserved after selector change');
    assert.equal(reactProps(select).value, 'receivable');

    // URL is updated with accountType=receivable while preserving from and to
    const updatedQuery = new URLSearchParams(globalThis.location.hash.split('?')[1]);
    assert.equal(updatedQuery.get('accountType'), 'receivable');
    assert.equal(updatedQuery.get('from'), '2026-01-01');
    assert.equal(updatedQuery.get('to'), '2026-12-31');

    // Change Account Type to both
    await React.act(async () => {
      reactProps(select).onChange({ target: { value: 'both' } });
    });
    assert.equal(reactProps(unreconciledBox).checked, true, 'Filter preserved after second selector change');
    assert.equal(reactProps(select).value, 'both');
    const updatedQueryBoth = new URLSearchParams(globalThis.location.hash.split('?')[1]);
    assert.equal(updatedQueryBoth.get('accountType'), 'both');

    // Reopening with updated URL restores 'both', not the redirected 'payable'
    const reopened = renderToStaticMarkup(React.createElement(Reports, { leaf, params: updatedQueryBoth }));
    assert.match(reopened, /value="both" selected/);
    assert.doesNotMatch(reopened, /value="payable" selected/);
  } finally {
    await React.act(async () => root.unmount());
  }
});
