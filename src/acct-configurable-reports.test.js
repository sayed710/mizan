import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, write, updateSettings } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { postEntry, journalItems } from './models/ledger.js';
import { today } from './models/common.js';
import { configurableReport } from './models/configurableReports.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const press = (db, id) => models['account.report'].form.buttons.find((button) => button.label === 'Open Report').run(db, read(db, 'account.report', id));
const line = (code, formula, sequence = 10) => ({ code, name: code, formula, sequence });

test('report save rejects malformed formulas, missing codes and both formula and parent cycles', () => {
  const base = seed();
  for (const [lines, error] of [
    [[line('A', 'A + UNKNOWN')], /Unknown report line code/],
    [[line('A', 'B'), line('B', 'A')], /cycle/i],
    [[{ ...line('A', '12'), parent_code: 'B' }, { ...line('B', '13'), parent_code: 'A' }], /cycle/i],
    [[line('A', '12,,13')], /Malformed/],
    [[line('A', 'B +')], /Malformed/],
  ]) assert.throws(() => create(base, 'account.report', { name: 'Invalid', line_ids: lines }), error);
  const report = create(base, 'account.report', { name: 'Valid', line_ids: [line('A', '12')] });
  assert.throws(() => write(report.db, 'account.report', report.id, { line_ids: [line('A', 'NOPE')] }), /Unknown report line code/);
  assert.equal(read(report.db, 'account.report', report.id).line_ids[0].formula, '12');
});

test('accounting report menus and open button render selected-company ledger and grouped columns', async () => {
  const { makeEl } = setupDom();
  globalThis.window = Object.assign(new EventTarget(), { scrollTo() {}, HTMLIFrameElement: class {} });
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
  globalThis.location = { hash: '#/accounting/accounting-reports' };
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js'); await initStore();
  const other = createCompany(seed(), { name: 'Branch' });
  let db = updateSettings(other.db, { current_company_id: 1, allowed_company_ids: [1] });
  const tag = create(db, 'account.account.tag', { name: 'REPORT TAG', applicability: 'accounts' }); db = tag.db;
  const account = create(db, 'account.account', { name: 'Report Account', code: '879100', company_id: 1, account_type: 'expense', tag_ids: [tag.id] }); db = account.db;
  const excluded = create(db, 'account.account', { name: 'Excluded Account', code: '879200', company_id: 1, account_type: 'expense' }); db = excluded.db;
  const analytic = create(db, 'account.analytic.account', { name: 'ANALYTIC ONE', company_id: 1 }); db = analytic.db;
  const date = `${today().slice(0, 4)}-02-01`;
  db = postEntry(db, { journal: 'MISC', company: 1, date, lines: [{ account: account.id, debit: 100, partner_id: 1, analytic_distribution: { [analytic.id]: 60 } }, { account: excluded.id, debit: 20, partner_id: 2 }, { account: '301000', credit: 120 }] }).db;
  const otherAccount = create(db, 'account.account', { name: 'Branch Account', code: '879100', company_id: other.id, account_type: 'expense' }); db = otherAccount.db;
  db = postEntry(db, { journal: 'MISC', company: other.id, date, lines: [{ account: otherAccount.id, debit: 300, partner_id: 1 }, { account: '301000', credit: 300 }] }).db;
  const report = create(db, 'account.report', { name: 'CUSTOM REPORT', company_id: 1, show_debit: true, show_credit: true, line_ids: [line('A', '879'), line('B', '879,-8792'), line('C', 'tag:REPORT TAG'), line('TOTAL', 'A + B - C')] }); db = report.db;
  const group = create(db, 'account.report.horizontal.group', { name: 'PARTNERS', company_id: 1, report_ids: [report.id], rule_ids: [{ field: 'partner', ids: '1' }] }); db = group.db;
  const analyticGroup = create(db, 'account.report.horizontal.group', { name: 'ANALYTIC SPLIT', company_id: 1, report_ids: [report.id], rule_ids: [{ field: 'analytic', ids: String(analytic.id) }] }); db = analyticGroup.db;
  const baseline = configurableReport(db, read(db, 'account.report', report.id), { from: date, to: date });
  assert.deepEqual(baseline.rows.map((row) => row.values[0]), [420, 400, 100, 720]);
  assert.equal(baseline.rows.find((row) => row.code === 'A').values[0], journalItems(db, { from: date, to: date }).filter((item) => [account.id, excluded.id, otherAccount.id].includes(item.account_id)).reduce((sum, item) => sum + item.debit - item.credit, 0));
  await React.act(async () => commit(db));
  const { App } = await import('./App.jsx'); const host = makeEl('div'); host.ownerDocument = document; const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    assert.ok(host.textContent.includes('CUSTOM REPORT'));
    await React.act(async () => { location.hash = '#/accounting/horizontal-groups'; window.dispatchEvent(new Event('hashchange')); });
    assert.ok(host.textContent.includes('PARTNERS'), host.textContent);
    await React.act(async () => { location.hash = `#/accounting/accounting-reports/${report.id}`; window.dispatchEvent(new Event('hashchange')); });
    const button = find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Open Report'); assert.ok(button);
    await React.act(async () => props(button).onClick());
    assert.equal(location.hash, press(db, report.id).go);
    await React.act(async () => window.dispatchEvent(new Event('hashchange')));
    assert.ok(host.textContent.includes('CUSTOM REPORT'));
    assert.ok(host.textContent.includes('120.00')); assert.ok(!host.textContent.includes('420.00'));
    const select = find(host, (node) => node.tagName === 'SELECT' && props(node)?.value === ''); assert.ok(select);
    await React.act(async () => props(select).onChange({ target: { value: String(group.id) } }));
    assert.ok(host.textContent.includes('Others')); assert.ok(host.textContent.includes('100.00')); assert.ok(host.textContent.includes('20.00'));
    await React.act(async () => props(select).onChange({ target: { value: String(analyticGroup.id) } }));
    assert.ok(host.textContent.includes('ANALYTIC ONE')); assert.ok(host.textContent.includes('60.00'));
    const dates = []; const collect = (node) => { if (node.tagName === 'INPUT' && props(node)?.type === 'date') dates.push(node); for (const child of node.childNodes ?? []) collect(child); }; collect(host);
    await React.act(async () => props(dates[0]).onChange({ target: { value: `${today().slice(0, 4)}-03-01` } }));
    assert.ok(!host.textContent.includes('60.00'));
    await React.act(async () => props(dates[0]).onChange({ target: { value: `${today().slice(0, 4)}-01-01` } }));
    await React.act(async () => props(select).onChange({ target: { value: String(group.id) } }));
    await React.act(async () => commit(updateSettings(db, { current_company_id: 1, allowed_company_ids: [1, other.id] })));
    assert.ok(host.textContent.includes('400.00'));
  } finally { await React.act(async () => root.unmount()); }
});


test('analytic group splits a posted invoice journal item using its source allocations', async () => {
  const { makeEl } = setupDom();
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js'); await initStore();
  const first = create(seed(), 'account.analytic.account', { name: 'PROJECT ONE' });
  const second = create(first.db, 'account.analytic.account', { name: 'PROJECT TWO' });
  const invoice = create(second.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: today(), invoice_line_ids: [
    { qty: 1, price_unit: 30, tax: 0, analytic_distribution: { [first.id]: 100 } },
    { qty: 1, price_unit: 70, tax: 0, analytic_distribution: { [second.id]: 100 } },
  ] });
  const posted = models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(invoice.db, read(invoice.db, 'account.move', invoice.id)).db;
  const report = create(posted, 'account.report', { name: 'INVOICE ANALYTICS', line_ids: [line('A', '400')] });
  const group = create(report.db, 'account.report.horizontal.group', { name: 'PROJECTS', report_ids: [report.id], rule_ids: [{ field: 'analytic', ids: `${first.id},${second.id}` }] });
  await React.act(async () => commit(group.db));
  const { Reports } = await import('./views/Reports.jsx'); const host = makeEl('div'); host.ownerDocument = document; const root = createRoot(host);
  try {
    assert.match(press(group.db, report.id).go, /configurable-report-view/);
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'configurable' }, id: report.id })));
    const select = find(host, (node) => node.tagName === 'SELECT');
    await React.act(async () => props(select).onChange({ target: { value: String(group.id) } }));
    assert.ok(host.textContent.includes('PROJECT ONE')); assert.ok(host.textContent.includes('PROJECT TWO'));
    assert.ok(host.textContent.includes('-$30.00'), host.textContent); assert.ok(host.textContent.includes('-$70.00'), host.textContent);
  } finally { await React.act(async () => root.unmount()); }
});
