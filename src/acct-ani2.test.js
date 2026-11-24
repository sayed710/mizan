import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { apps, findLeaf, models } from './models/index.js';
import { moreModels } from './models/more.js';
import { validateTimesheets } from './models/timesheetplus.js';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { diffDb, applyDiff } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

async function mountAnalyticForm(db, id, extraProps = {}) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.insertBefore = (child, before) => {
      const idx = before ? el.childNodes.indexOf(before) : -1;
      if (idx >= 0) el.childNodes.splice(idx, 0, child);
      else el.childNodes.push(child);
      child.parentNode = el;
      if (child.tagName === 'OPTION') el.options.push(child);
      return el;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  await commit(db);
  const { FormView } = await import('./views/FormView.jsx');
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const accounting = leaf('accounting', 'analytic-items');
  const render = async (recordId = id) => {
    await React.act(async () => {
      root.render(React.createElement(FormView, {
        leaf: accounting,
        id: String(recordId),
        base: '#/accounting/analytic-items',
        params: new URLSearchParams('view=list'),
        ...extraProps,
      }));
    });
  };
  await render();
  return {
    React,
    host,
    getDb,
    render,
    done: async () => {
      await React.act(async () => root.unmount());
      if (prevStorage === undefined) delete globalThis.localStorage;
      else globalThis.localStorage = prevStorage;
    },
  };
}

const model = 'account.analytic.line';
const leaf = (app, key) => findLeaf(apps.find((item) => item.id === app), key);
const force = (db, id, vals) => ({ ...db, records: { ...db.records, [model]: db.records[model].map((r) => r.id === id ? { ...r, ...vals } : r) } });

test('ANI-1 accounting analytic views are distinct from the timesheet leaf', () => {
  const accounting = leaf('accounting', 'analytic-items');
  const timesheets = leaf('timesheets', 'timesheets');
  assert.deepEqual(accounting.list, ['date', 'name', 'account_id', 'company_id', 'amount']);
  assert.deepEqual(accounting.groupBy, ['account_id']);
  assert.ok(accounting.form.groups.flat().includes('general_account'));
  assert.equal(timesheets.form, undefined);
  assert.equal(timesheets.list, undefined);
  assert.deepEqual(models[model].list.slice(0, moreModels[model].list.length), moreModels[model].list);
  assert.deepEqual(models[model].form.groups.slice(0, moreModels[model].form.groups.length), moreModels[model].form.groups);
  assert.equal(timesheets.domain({ category: 'timesheet' }), true);
  assert.equal(timesheets.domain({ category: 'other' }), false);
});

test('ANI-2 manual amounts can be changed through sync while generated amounts cannot', () => {
  const a = create(seed(), 'account.analytic.account', { name: 'Analytic' });
  const manual = create(a.db, model, { name: 'Manual', category: 'other', account_id: a.id, amount: 10 });
  assert.equal(models[model].fields.amount.readonly(read(manual.db, model, manual.id)), false);
  const staged = write(manual.db, model, manual.id, { amount: 35 });
  const saved = applyDiff(manual.db, diffDb(manual.db, staged), { isAdmin: true });
  assert.equal(read(saved, model, manual.id).amount, 35);
  const generated = force(saved, manual.id, { move_id: 1, category: 'invoice' });
  assert.equal(models[model].fields.amount.readonly(read(generated, model, manual.id)), true);
  for (const vals of [{ amount: 50 }, { move_id: null }, { category: 'other' }]) {
    assert.throws(() => applyDiff(generated, diffDb(generated, force(generated, manual.id, vals)), { isAdmin: true }), /read-only/);
  }
});

test('ANI-3 migration resolves exact company codes and reports unmatched or ambiguous values', () => {
  const base = seed();
  const accounts = [
    { id: 7001, code: 'SAME', name: 'First', company_id: 1 },
    { id: 7002, code: 'SAME', name: 'Second', company_id: 2 },
    { id: 7003, code: 'DUP', name: 'Duplicate A', company_id: 1 },
    { id: 7004, code: 'DUP', name: 'Duplicate B', company_id: 1 },
  ];
  const lines = [
    { id: 8001, name: 'First', date: '2026-01-01', company_id: 1, general_account: 'SAME' },
    { id: 8002, name: 'Second', date: '2026-01-01', company_id: 2, general_account: 'SAME' },
    { id: 8003, name: 'Missing', date: '2026-01-01', company_id: 1, general_account: 'UNKNOWN' },
    { id: 8004, name: 'Ambiguous', date: '2026-01-01', company_id: 1, general_account: 'DUP' },
  ];
  const old = { ...base, schema_version: 67, records: { ...base.records, 'account.account': [...base.records['account.account'], ...accounts], [model]: lines } };
  const db = migrate(old);
  assert.equal(SCHEMA_VERSION, 73);
  assert.deepEqual(db.records[model].map((r) => r.general_account), [7001, 7002, null, null]);
  assert.deepEqual(db.records[model].slice(2).map((r) => r.legacy_general_account), ['UNKNOWN', 'DUP']);
  assert.equal(db.messages.filter((m) => m.model === model && [8003, 8004].includes(m.res_id)).length, 2);
  assert.equal(migrate(db), db);
  assert.equal(models[model].fields.general_account.relation, 'account.account');
  const analytic = create(seed(), 'account.analytic.account', { name: 'Manual' });
  const line = create(analytic.db, model, { name: 'Manual', category: 'other', account_id: analytic.id });
  const foreign = { ...line.db, records: { ...line.db.records, 'account.account': [...line.db.records['account.account'], accounts[1]] } };
  const invalid = force(foreign, line.id, { general_account: 7002 });
  assert.throws(() => applyDiff(foreign, diffDb(foreign, invalid), { isAdmin: true }), /line company/);
  const valid = search(foreign, 'account.account').find((a) => (a.company_id ?? 1) === 1);
  const updated = applyDiff(foreign, diffDb(foreign, force(foreign, line.id, { general_account: valid.id })), { isAdmin: true });
  assert.equal(read(updated, model, line.id).general_account, valid.id);
});

test('ANI-4 accounting analytic-items form renders chatter with migration repair notes', async () => {
  const base = seed();
  const old = {
    ...base,
    schema_version: 67,
    records: {
      ...base.records,
      [model]: [{ id: 8101, name: 'Unresolved Line', date: '2026-01-01', company_id: 1, general_account: 'UNKNOWN' }],
    },
  };
  const migrated = migrate(old);
  const ctx = await mountAnalyticForm(migrated, 8101);
  try {
    const chatter = find(ctx.host, (n) => n.tagName === 'ASIDE' && props(n)?.className === 'chatter');
    assert.ok(chatter, 'accounting analytic-items form must render chatter');
    assert.ok(chatter.textContent.includes('Upgrade: general account code UNKNOWN could not be uniquely matched in the line company; select the account manually.'));
    assert.ok(ctx.host.textContent.includes('UNKNOWN'));
  } finally {
    await ctx.done();
  }
});

test('ANI-5 validated timesheet opened via accounting analytic-items is locked and offers Reset to Draft', async () => {
  const analytic = create(seed(), 'account.analytic.account', { name: 'Timesheet Analytic' });
  const ts = create(analytic.db, model, {
    name: 'Dev work',
    category: 'timesheet',
    employee_id: 1,
    project_id: 1,
    task_id: 1,
    account_id: analytic.id,
    unit_amount: 4,
    date: '2026-01-10',
  });
  const validated = validateTimesheets(ts.db, [ts.id], { user: 'Manager', date: '2026-01-11' });
  const ctx = await mountAnalyticForm(validated, ts.id);
  try {
    const nameInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-name');
    assert.ok(nameInput, 'title input must render');
    assert.equal(props(nameInput).readOnly, true, 'validated timesheet title must be read-only');

    const dateInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-date');
    assert.equal(dateInput, null, 'locked fields should render as read-only display rather than editable inputs');

    const resetBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Reset to Draft');
    assert.ok(resetBtn, 'Reset to Draft button must be rendered for validated timesheets');

    await ctx.React.act(async () => {
      props(resetBtn).onClick();
    });
    assert.equal(read(ctx.getDb(), model, ts.id).validated, false);

    const unlockedName = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-name');
    assert.equal(props(unlockedName).readOnly, false, 'title becomes editable after Reset to Draft');
    assert.ok(find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-date'), 'date input becomes editable after Reset to Draft');
    assert.ok(find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Validate'), 'Validate button appears after Reset to Draft');
  } finally {
    await ctx.done();
  }
});
