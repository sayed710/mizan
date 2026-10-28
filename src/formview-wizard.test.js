import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

function setupDom() {
  const listeners = new Map();
  const makeEl = (tag = 'div') => {
    let _text;
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      childNodes: [],
      children: [],
      style: {},
      options: [],
      ownerDocument: null,
      addEventListener: (type, fn) => {
        if (!listeners.has(node)) listeners.set(node, new Map());
        const m = listeners.get(node);
        if (!m.has(type)) m.set(type, []);
        m.get(type).push(fn);
      },
      removeEventListener: () => {},
      appendChild: (child) => {
        node.childNodes.push(child);
        child.parentNode = node;
        if (child.tagName === 'OPTION') node.options.push(child);
        return child;
      },
      removeChild: (child) => {
        const idx = node.childNodes.indexOf(child);
        if (idx >= 0) node.childNodes.splice(idx, 1);
        const optIdx = node.options.indexOf(child);
        if (optIdx >= 0) node.options.splice(optIdx, 1);
        return child;
      },
      insertBefore: (child) => {
        node.childNodes.push(child);
        child.parentNode = node;
        if (child.tagName === 'OPTION') node.options.push(child);
        return child;
      },
      setAttribute: () => {},
      removeAttribute: () => {},
      focus: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      get textContent() {
        if (_text !== undefined) return _text;
        return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join('');
      },
      set textContent(v) {
        _text = String(v);
        this.childNodes = [{ nodeType: 3, nodeValue: String(v) }];
      },
    };
    return node;
  };
  globalThis.HTMLIFrameElement = class HTMLIFrameElement {};
  globalThis.document = {
    nodeType: 9,
    nodeName: '#document',
    visibilityState: 'hidden',
    documentElement: makeEl('html'),
    createElement: (tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: text }),
    createComment: () => ({ nodeType: 8 }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.window = globalThis;
  globalThis.dispatchEvent = () => {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { makeEl };
}

function find(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const res = find(child, predicate);
    if (res) return res;
  }
  return null;
}

test('button with a wizard on an unsaved record drives the button -> wizard -> confirm flow', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/sales/orders/new' };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { create, read } = await import('./orm.js');
  await initStore();

  const tmpl = create(getDb(), 'sale.order.template', { name: 'Standard Template' });
  commit(tmpl.db);

  const { FormView } = await import('./views/FormView.jsx');
  const rootEl = makeEl('div');
  rootEl.ownerDocument = globalThis.document;
  const root = createRoot(rootEl);

  await React.act(async () => {
    root.render(React.createElement(FormView, {
      leaf: { model: 'sale.order', key: 'orders', label: 'Quotations' },
      id: 'new',
      base: '#/sales/orders',
      params: new URLSearchParams('default_partner_id=1'),
    }));
  });

  // Step 1: Click button with wizard on unsaved record
  const applyBtn = find(rootEl, (n) => n.tagName === 'BUTTON' && n.textContent === 'Apply Template');
  assert.ok(applyBtn, 'Apply Template button must exist');
  const btnPropsKey = Object.keys(applyBtn).find((k) => k.startsWith('__reactProps$'));
  await React.act(async () => {
    await applyBtn[btnPropsKey].onClick();
  });

  // Wizard opens and location.hash remains unchanged (did not navigate prematurely)
  assert.equal(globalThis.location.hash, '#/sales/orders/new', 'location.hash must not update before wizard confirmation');
  const form = find(rootEl, (n) => n.tagName === 'FORM');
  assert.ok(form, 'Wizard dialog must render');

  // Step 2: Choose template in wizard dialog
  const select = find(form, (n) => n.tagName === 'SELECT');
  assert.ok(select, 'Template select in wizard dialog must exist');
  const selectPropsKey = Object.keys(select).find((k) => k.startsWith('__reactProps$'));
  await React.act(async () => {
    select[selectPropsKey].onChange({ target: { value: String(tmpl.id) } });
  });

  // Step 3: Confirm wizard dialog
  const formPropsKey = Object.keys(form).find((k) => k.startsWith('__reactProps$'));
  await React.act(async () => {
    form[formPropsKey].onSubmit({ preventDefault: () => {} });
  });

  // After confirmation, save() persisted the record, hash updated, and wizard action applied
  assert.match(globalThis.location.hash, /^#\/sales\/orders\/(\d+)\?view=/, 'location.hash must update after wizard confirm');
  const newId = Number(globalThis.location.hash.match(/orders\/(\d+)/)[1]);
  const saved = read(getDb(), 'sale.order', newId);
  assert.equal(saved?.sale_order_template_id, tmpl.id, 'wizard action must have been applied to the saved record');
});

test('button without a wizard on an unsaved record saves and navigates immediately', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/sales/orders/new' };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();

  const { FormView } = await import('./views/FormView.jsx');
  const rootEl = makeEl('div');
  rootEl.ownerDocument = globalThis.document;
  const root = createRoot(rootEl);

  await React.act(async () => {
    root.render(React.createElement(FormView, {
      leaf: { model: 'sale.order', key: 'orders', label: 'Quotations' },
      id: 'new',
      base: '#/sales/orders',
      params: new URLSearchParams('default_partner_id=1'),
    }));
  });

  const confirmBtn = find(rootEl, (n) => n.tagName === 'BUTTON' && n.textContent === 'Confirm');
  assert.ok(confirmBtn, 'Confirm button must exist');
  const btnPropsKey = Object.keys(confirmBtn).find((k) => k.startsWith('__reactProps$'));
  await React.act(async () => {
    await confirmBtn[btnPropsKey].onClick();
  });

  assert.match(globalThis.location.hash, /^#\/sales\/orders\/\d+\?view=/, 'button without wizard saves and navigates immediately');
});
