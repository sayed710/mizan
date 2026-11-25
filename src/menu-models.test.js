import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { apps, models, viewsOf } from './models/index.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

// Matches PAGES in src/App.jsx: entries with these types render a dedicated page component instead of ActionView/FormView.
const PAGE_TYPES = new Set([
  'analysis', 'dashboard', 'settings', 'pos', 'discuss', 'report', 'barcode', 'shopfloor',
  'overview', 'website', 'appstore', 'kiosk', 'surveytake', 'surveyresults', 'studio',
  'kitchen', 'captable', 'knowledge', 'spreadsheet', 'bankReconcile',
]);

/** Walk every menu entry of an app recursively, including nested `children` groups. */
function walkMenuEntries(items, out = []) {
  for (const item of items ?? []) {
    out.push(item);
    if (Array.isArray(item.children)) walkMenuEntries(item.children, out);
  }
  return out;
}

/** Resolve the active view for a menu entry using the exact App.jsx + ActionView.jsx selection rules. */
function resolveMenuView(entry) {
  if (entry.type && PAGE_TYPES.has(entry.type)) return { kind: 'page', view: entry.type };
  const views = viewsOf(entry.model);
  const view = views.includes(entry.view) ? entry.view : views[0];
  return { kind: 'action', view, views };
}

test('every menu entry with a model has a label, form, and valid list columns for its resolved view', () => {
  const failures = [];
  for (const app of apps) {
    for (const entry of walkMenuEntries(app.menus)) {
      if (!entry.model) continue;
      const where = `${app.id}/${entry.key ?? entry.label} (${entry.model})`;
      const def = models[entry.model];
      if (!def) {
        failures.push(`${where}: model is not registered`);
        continue;
      }
      if (typeof def.label !== 'string' || !def.label.trim()) {
        failures.push(`${where}: model is missing a label`);
      }
      const resolved = resolveMenuView(entry);
      if (resolved.kind === 'page') continue;
      if (!def.form) {
        failures.push(`${where}: model is missing a form definition`);
      } else if (def.form.title && !def.form.hideTitle && !Object.hasOwn(def.fields ?? {}, def.form.title)) {
        failures.push(`${where}: form title '${def.form.title}' is not a field of ${entry.model}`);
      }
      const listCols = entry.list ?? def.list;
      if (resolved.view === 'list' && (!Array.isArray(listCols) || !listCols.length)) {
        failures.push(`${where}: resolved view is 'list' but neither entry.list nor def.list is a non-empty array`);
      }
      for (const [source, cols] of [['entry.list', entry.list], ['def.list', def.list]]) {
        if (cols == null) continue;
        if (!Array.isArray(cols)) {
          failures.push(`${where}: ${source} is not an array`);
          continue;
        }
        for (const col of cols) {
          if (!Object.hasOwn(def.fields ?? {}, col)) {
            failures.push(`${where}: ${source} column '${col}' is not a key of ${entry.model}.fields`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('menu view resolution mirrors App.jsx page bypass and ActionView.jsx view fallback', () => {
  assert.deepEqual(resolveMenuView({ key: 'dashboard', type: 'dashboard' }), { kind: 'page', view: 'dashboard' });
  const inputTypeLeaf = walkMenuEntries(apps.find((a) => a.id === 'payroll').menus).find((m) => m.key === 'input-types');
  assert.equal(resolveMenuView(inputTypeLeaf).view, 'list');
  const invoiceAnalysisLeaf = walkMenuEntries(apps.find((a) => a.id === 'accounting').menus).find((m) => m.key === 'invoice-analysis');
  assert.equal(resolveMenuView(invoiceAnalysisLeaf).view, 'pivot');
  const stockReportLeaf = walkMenuEntries(apps.find((a) => a.id === 'inventory').menus).find((m) => m.key === 'report');
  assert.equal(resolveMenuView(stockReportLeaf).view, 'kanban');
});

test('Payroll > Configuration > Other Input Types (#/payroll/input-types) renders list and form without crashing', async () => {
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_, tag) => makeEl(tag);
  globalThis.location = { hash: '#/payroll/input-types' };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb } = await import('./store.js');
  const { search } = await import('./orm.js');
  await initStore();

  const { ActionView } = await import('./views/ActionView.jsx');
  const { FormView } = await import('./views/FormView.jsx');
  const payrollApp = apps.find((a) => a.id === 'payroll');
  const leaf = walkMenuEntries(payrollApp.menus).find((m) => m.key === 'input-types');
  assert.ok(leaf, 'Payroll > Configuration > Other Input Types menu leaf must exist');

  const listEl = makeEl('div');
  listEl.ownerDocument = globalThis.document;
  const listRoot = createRoot(listEl);
  try {
    await React.act(async () => {
      listRoot.render(React.createElement(React.StrictMode, null, React.createElement(ActionView, {
        leaf,
        base: '#/payroll/input-types',
        params: new URLSearchParams(),
      })));
    });
    assert.ok(listEl.textContent.includes('Other Input Types'));
    assert.ok(listEl.textContent.includes('Name'));
    assert.ok(listEl.textContent.includes('Code'));
  } finally {
    await React.act(async () => listRoot.unmount());
  }

  globalThis.location = { hash: '#/payroll/input-types/new' };
  const formEl = makeEl('div');
  formEl.ownerDocument = globalThis.document;
  const formRoot = createRoot(formEl);
  try {
    await React.act(async () => {
      formRoot.render(React.createElement(React.StrictMode, null, React.createElement(FormView, {
        leaf,
        id: 'new',
        base: '#/payroll/input-types',
        params: new URLSearchParams(),
      })));
    });
    const propsOf = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
    const nameInput = find(formEl, (n) => n.tagName === 'INPUT' && propsOf(n)?.id === 'f-name');
    const codeInput = find(formEl, (n) => n.tagName === 'INPUT' && propsOf(n)?.id === 'f-code');
    assert.ok(nameInput && codeInput, 'Form must render Name and Code inputs');
    await React.act(async () => {
      propsOf(nameInput).onChange({ target: { value: 'Bonus' } });
      propsOf(codeInput).onChange({ target: { value: 'BONUS' } });
    });
    const saveBtn = find(formEl, (n) => n.tagName === 'BUTTON' && n.textContent === 'Save');
    assert.ok(saveBtn, 'Save button must appear after editing');
    await React.act(async () => {
      propsOf(saveBtn).onClick();
    });
    const created = search(getDb(), 'hr.payslip.input.type');
    assert.equal(created.length, 1);
    assert.equal(created[0].name, 'Bonus');
    assert.equal(created[0].code, 'BONUS');

    await React.act(async () => {
      formRoot.render(React.createElement(React.StrictMode, null, React.createElement(FormView, {
        leaf,
        id: String(created[0].id),
        base: '#/payroll/input-types',
        params: new URLSearchParams(),
      })));
    });
    assert.ok(formEl.textContent.includes('Other Input Types'));
  } finally {
    await React.act(async () => formRoot.unmount());
  }
});

test('Accounting > Closing > Secure Entries (#/accounting/secure-entries/new) renders form without crashing', async () => {
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_, tag) => makeEl(tag);
  globalThis.location = { hash: '#/accounting/secure-entries/new' };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();

  const { FormView } = await import('./views/FormView.jsx');
  const accountingApp = apps.find((a) => a.id === 'accounting');
  const leaf = walkMenuEntries(accountingApp.menus).find((m) => m.key === 'secure-entries');
  assert.ok(leaf, 'Accounting > Secure Entries menu leaf must exist');

  const formEl = makeEl('div');
  formEl.ownerDocument = globalThis.document;
  const formRoot = createRoot(formEl);
  try {
    await React.act(async () => {
      formRoot.render(React.createElement(React.StrictMode, null, React.createElement(FormView, {
        leaf,
        id: 'new',
        base: '#/accounting/secure-entries',
        params: new URLSearchParams(),
      })));
    });
    assert.ok(formEl.textContent.includes('Secure Entries'));
    assert.ok(formEl.textContent.includes('Cancel'));
    assert.ok(formEl.textContent.includes('Secure entries up to'));
    assert.ok(formEl.textContent.includes('inclusive, to make them immutable'));
  } finally {
    await React.act(async () => formRoot.unmount());
  }
});
