import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { create, read, updateSettings } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('Studio fields appear in both dynamic Tax Return form layouts', async () => {
  const base = seed();
  const settings = updateSettings(base, { customFields: [
    { model: 'account.return', label: 'Reviewer Note', type: 'char' },
    { model: 'account.return', label: 'Audit Reference', type: 'char' },
  ] });
  const db = applyDiff(base, diffDb(base, settings), { isAdmin: true });
  const audit = create(db, 'account.return', {
    name: 'Audit', audit_status: 'ongoing', company_id: 1, date_from: '2026-01-01', date_to: '2026-12-31',
  });
  const ordinaryType = db.records['account.return.type'].find((type) => type.category === 'account_return');
  const tax = create(audit.db, 'account.return', {
    name: 'Tax', type_id: ordinaryType.id, company_id: 1, date_from: '2026-01-01', date_to: '2026-03-31',
  });
  const form = models['account.return'].form;
  const auditRecord = read(tax.db, 'account.return', audit.id);
  const taxRecord = read(tax.db, 'account.return', tax.id);
  assert.ok(form.groups(auditRecord, tax.db).some((group) => group.includes('audit_status')));
  assert.ok(form.groups(taxRecord, tax.db).some((group) => group.includes('total_amount_to_pay')));
  assert.equal(form.tabs(auditRecord, tax.db)[0].label, 'Checks');
  assert.equal(form.tabs(taxRecord, tax.db)[0].label, 'Tax Report');
  for (const id of [audit.id, tax.id]) {
    const record = read(tax.db, 'account.return', id);
    const groups = form.groups(record, tax.db);
    const custom = groups.filter((group) => group.custom);
    assert.equal(custom.length, 1);
    assert.deepEqual([...custom[0]], ['x_reviewer_note', 'x_audit_reference']);
    assert.ok(groups.some((group) => group.includes('type_id')));
    assert.ok(form.tabs(record, tax.db).length);
  }
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/tax-returns/new' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  await commit(tax.db);
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf: { model: 'account.return', label: 'Tax Returns' }, id: String(tax.id),
      base: '#/accounting/tax-returns', params: new URLSearchParams(),
    })));
    for (const name of ['x_reviewer_note', 'x_audit_reference']) {
      assert.ok(find(host, (node) => Object.keys(node).some((key) => key.startsWith('__reactProps$') && node[key]?.id === `f-${name}`)));
    }
  } finally {
    await React.act(async () => root.unmount());
  }
});
