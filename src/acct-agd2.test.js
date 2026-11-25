import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import './models/index.js';
import { BUCKETS, agedBalance, agedReportDate, resolveAgedAsOfDate } from './models/finance.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const reactProps = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const nodeText = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(nodeText).join(''));
const headersOf = (host) => {
  const ths = [];
  const walk = (node) => {
    if (!node) return;
    if (node.tagName === 'TH') ths.push(nodeText(node).trim());
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(host);
  return ths;
};

test('AGD-1: aged receivable and payable use canonical BUCKETS helper with At Date, four intervals, Older and Total', async () => {
  assert.deepEqual(
    BUCKETS().map(([key, label, from, to]) => [key, label, from, to]),
    [
      ['current', 'At Date', -Infinity, 0],
      ['1_30', '1-30', 1, 30],
      ['31_60', '31-60', 31, 60],
      ['61_90', '61-90', 61, 90],
      ['91_120', '91-120', 91, 120],
      ['older', 'Older', 121, Infinity],
    ],
  );
  assert.deepEqual(BUCKETS(10).map(([, label]) => label), ['At Date', '1-10', '11-20', '21-30', '31-40', 'Older']);

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    for (const report of ['agedReceivable', 'agedPayable']) {
      await React.act(async () => root.render(React.createElement(Reports, { key: report, leaf: { report } })));
      const headers = headersOf(host);
      assert.deepEqual(headers.slice(-7), ['At Date', '1-30', '31-60', '61-90', '91-120', 'Older', 'Total']);
      assert.ok(!headers.includes('Invoice Date'));
      assert.ok(!headers.includes('Not due'));
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('AGD-2: invalid or empty As of Date keeps last valid date, throws no silent fallback, and shows inline error in view', async () => {
  assert.deepEqual(resolveAgedAsOfDate('2025-05-15', '2025-01-01'), { input: '2025-05-15', date: '2025-05-15', error: '' });
  assert.deepEqual(resolveAgedAsOfDate('', '2025-05-15'), { input: '', date: '2025-05-15', error: 'As of Date is required' });
  assert.deepEqual(resolveAgedAsOfDate('   ', '2025-05-15'), { input: '   ', date: '2025-05-15', error: 'As of Date is required' });
  assert.deepEqual(resolveAgedAsOfDate('2025-02-30', '2025-05-15'), { input: '2025-02-30', date: '2025-05-15', error: 'Enter a valid As of Date' });
  assert.deepEqual(resolveAgedAsOfDate('not-a-date', '2025-05-15'), { input: 'not-a-date', date: '2025-05-15', error: 'Enter a valid As of Date' });
  assert.throws(() => resolveAgedAsOfDate('', ''), /Enter a valid As of Date/);
  assert.throws(() => agedReportDate('2025-02-30', '2025-05-15'), /Enter a valid As of Date/);
  assert.throws(() => agedBalance({ records: {}, settings: {} }, 'receivable', ''), /Enter a valid As of Date/);

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  await initStore();
  const base = getDb();
  const arAccount = base.records['account.account'].find((a) => a.account_type === 'asset_receivable');
  const data = {
    ...base,
    records: {
      ...base.records,
      'res.partner': [...base.records['res.partner'], { id: 881, name: 'AGD2 Customer' }],
      'account.move': [
        { id: 8810, name: 'AGD2-OLD', state: 'posted', move_type: 'entry', company_id: 1, date: '2025-01-10', line_ids: [{ account_id: arAccount.id, partner_id: 881, debit: 123, credit: 0 }] },
        { id: 8811, name: 'AGD2-LATE', state: 'posted', move_type: 'entry', company_id: 1, date: '2025-06-10', line_ids: [{ account_id: arAccount.id, partner_id: 881, debit: 456, credit: 0 }] },
      ],
    },
  };
  await React.act(async () => commit(data));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'agedReceivable' } })));
    const asOfInput = () => find(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.['aria-label'] === 'As of');
    const alertNode = () => find(host, (n) => reactProps(n)?.role === 'alert');

    await React.act(async () => reactProps(asOfInput()).onChange({ target: { value: '2025-02-01' } }));
    assert.equal(alertNode(), null);
    assert.match(nodeText(host), /123\.00/);
    assert.doesNotMatch(nodeText(host), /456\.00/);

    await React.act(async () => reactProps(asOfInput()).onChange({ target: { value: '' } }));
    assert.equal(reactProps(asOfInput()).value, '');
    assert.equal(reactProps(asOfInput())['aria-invalid'], true);
    assert.equal(nodeText(alertNode()), 'As of Date is required');
    assert.match(nodeText(host), /As of Date: 2025-02-01/);
    assert.match(nodeText(host), /123\.00/);
    assert.doesNotMatch(nodeText(host), /456\.00/);

    await React.act(async () => reactProps(asOfInput()).onChange({ target: { value: '2025-02-30' } }));
    assert.equal(reactProps(asOfInput()).value, '2025-02-30');
    assert.equal(nodeText(alertNode()), 'Enter a valid As of Date');
    assert.match(nodeText(host), /As of Date: 2025-02-01/);
    assert.doesNotMatch(nodeText(host), /456\.00/);

    await React.act(async () => reactProps(asOfInput()).onChange({ target: { value: '2025-07-01' } }));
    assert.equal(alertNode(), null);
    assert.equal(reactProps(asOfInput())['aria-invalid'], false);
    assert.match(nodeText(host), /As of Date: 2025-07-01/);
    assert.match(nodeText(host), /456\.00/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('AGD-2 regression: As of Date error associates a stable id with aria-describedby while error is present', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'agedReceivable' } })));
    const asOfInput = () => find(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.['aria-label'] === 'As of');
    const alertNode = () => find(host, (n) => reactProps(n)?.role === 'alert');

    assert.equal(alertNode(), null);
    assert.equal(reactProps(asOfInput())['aria-invalid'], false);
    assert.equal(reactProps(asOfInput())['aria-describedby'], undefined);

    await React.act(async () => reactProps(asOfInput()).onChange({ target: { value: '' } }));
    const firstAlert = alertNode();
    const errorId = reactProps(firstAlert)?.id;
    assert.ok(typeof errorId === 'string' && errorId.length > 0);
    assert.equal(reactProps(asOfInput())['aria-invalid'], true);
    assert.equal(reactProps(asOfInput())['aria-describedby'], errorId);

    await React.act(async () => reactProps(asOfInput()).onChange({ target: { value: '2025-02-30' } }));
    assert.equal(reactProps(alertNode())?.id, errorId);
    assert.equal(reactProps(asOfInput())['aria-describedby'], errorId);

    await React.act(async () => reactProps(asOfInput()).onChange({ target: { value: '2025-07-01' } }));
    assert.equal(alertNode(), null);
    assert.equal(reactProps(asOfInput())['aria-invalid'], false);
    assert.equal(reactProps(asOfInput())['aria-describedby'], undefined);

    await React.act(async () => reactProps(asOfInput()).onChange({ target: { value: '' } }));
    assert.equal(reactProps(alertNode())?.id, errorId);
    assert.equal(reactProps(asOfInput())['aria-describedby'], errorId);
  } finally {
    await React.act(async () => root.unmount());
  }
});
