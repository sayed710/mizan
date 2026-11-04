import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];

test('Working Files menu creates a working file and provisions its company audit type', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/working-files/new' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { create, read } = await import('./orm.js');
  const { seed } = await import('./seed.js');
  const { menusFor } = await import('./models/index.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  const company = create(seed(), 'res.company', { name: 'Second Company' });
  await commit(company.db);
  assert.equal((getDb().records['account.return.type'] ?? []).some((type) => type.category === 'audit'), false);
  const leaf = menusFor('accounting').find((menu) => menu.label === 'Review').children
    .find((menu) => menu.label === 'Audit').children.find((menu) => menu.key === 'working-files');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf, id: 'new', base: '#/accounting/working-files', params: new URLSearchParams(),
    })));
    assert.ok(find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Checks'));
    const setField = async (predicate, value) => {
      const input = find(host, predicate);
      assert.ok(input);
      await React.act(async () => props(input).onChange({ target: { value } }));
    };
    await setField((node) => node.tagName === 'INPUT' && props(node)?.['aria-label'] === 'Return', 'Annual audit');
    await setField((node) => props(node)?.id === 'f-date_from', '2026-01-01');
    await setField((node) => props(node)?.id === 'f-date_to', '2026-12-31');
    await setField((node) => props(node)?.id === 'f-company_id', String(company.id));
    const save = find(host, (node) => node.tagName === 'BUTTON' && node.textContent === 'Save');
    assert.ok(save);
    await React.act(async () => props(save).onClick());
    const alert = find(host, (node) => props(node)?.role === 'alert');
    assert.equal(alert?.textContent, undefined, `form save failed: ${alert?.textContent}`);
    assert.match(location.hash, /^#\/accounting\/working-files\/\d+\?view=/);
    const id = Number(location.hash.match(/working-files\/(\d+)/)[1]);
    const saved = read(getDb(), 'account.return', id);
    const type = read(getDb(), 'account.return.type', saved.type_id);
    assert.equal(saved.company_id, company.id);
    assert.equal(saved.audit_status, 'ongoing');
    assert.equal(type.category, 'audit');
    assert.equal(type.company_id, company.id);
    assert.ok(leaf.domain(saved, getDb()));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('working-file creation reuses the company type and leaves input untouched on validation failure', async () => {
  const { read } = await import('./orm.js');
  const { seed } = await import('./seed.js');
  const { menusFor } = await import('./models/index.js');
  const { saveFormRecord } = await import('./views/formSave.js');
  const { applyDiff, diffDb } = await import('./sync.js');
  const leaf = menusFor('accounting').find((menu) => menu.label === 'Review').children
    .find((menu) => menu.label === 'Audit').children.find((menu) => menu.key === 'working-files');
  const db = seed();
  const values = { ...leaf.defaults, name: 'Audit', date_from: '2026-01-01', date_to: '2026-12-31', company_id: 1 };
  assert.throws(() => saveFormRecord(db, leaf.model, null, { ...values, name: '' }), /Return is required/);
  assert.equal((db.records['account.return.type'] ?? []).filter((type) => type.category === 'audit').length, 0);
  const first = saveFormRecord(db, leaf.model, null, values);
  const synced = applyDiff(db, diffDb(db, first.db), { isAdmin: true });
  const syncedReturn = read(synced, leaf.model, first.id);
  assert.equal(read(synced, 'account.return.type', syncedReturn.type_id).category, 'audit');
  const second = saveFormRecord(first.db, leaf.model, null, { ...values, name: 'Another audit' });
  const firstType = read(second.db, leaf.model, first.id).type_id;
  assert.equal(read(second.db, leaf.model, second.id).type_id, firstType);
  assert.equal(second.db.records['account.return.type'].filter((type) => type.category === 'audit' && type.company_id === 1).length, 1);
  assert.equal((db.records[leaf.model] ?? []).some((record) => record.name === 'Audit'), false);
});
