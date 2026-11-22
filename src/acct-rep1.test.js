import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { createCompany, setCompanies } from './models/company.js';
import { read } from './orm.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

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
