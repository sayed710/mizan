import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

// The same minimal React DOM approach as formview-wizard.test.js, with real
// EventTargets so effect subscriptions and StrictMode cleanup are exercised.
function setupDom() {
  const makeEl = (tag = 'div') => {
    const node = Object.assign(new EventTarget(), {
      nodeType: 1, tagName: tag.toUpperCase(), nodeName: tag.toUpperCase(),
      childNodes: [], style: {}, options: [], ownerDocument: globalThis.document,
      appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; },
      removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child; },
      insertBefore(child, before) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; },
      setAttribute(name, value) { this[name] = String(value); },
      removeAttribute(name) { delete this[name]; },
      contains(child) { return child === this || this.childNodes.some((c) => c.contains?.(child)); },
      focus() { document.activeElement = this; },
      querySelector(selector) { return find(this, (n) => selector === '[role=menuitem]' ? n.role === 'menuitem' : n['aria-expanded'] != null); },
      querySelectorAll() { return []; },
    });
    Object.defineProperty(node, 'textContent', {
      get() { return this.childNodes.map((c) => c.nodeType === 3 ? c.nodeValue : c.textContent).join(''); },
      set(value) { this.childNodes = value ? [{ nodeType: 3, nodeValue: String(value) }] : []; },
    });
    return node;
  };
  globalThis.window = Object.assign(new EventTarget(), { HTMLIFrameElement: class {}, scrollTo() {} });
  globalThis.document = Object.assign(new EventTarget(), {
    nodeType: 9, nodeName: '#document', visibilityState: 'hidden',
    documentElement: makeEl('html'), createElement: makeEl,
    createElementNS: (namespace, tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: text }),
    createComment: () => ({ nodeType: 8 }),
  });
  globalThis.location = { hash: '#/inventory/transfers' };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return makeEl('div');
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

test('Operations → Receipts updates the page and closes both menus in StrictMode', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(App))));
    assert.ok(find(container, (n) => n.tagName === 'MAIN' && n.textContent.includes('Transfers')));
    const toggle = find(container, (n) => n.tagName === 'BUTTON' && n['aria-controls'] === 'nav-menus');
    await React.act(async () => props(toggle).onClick());
    const operations = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Operations');
    await React.act(async () => props(operations).onClick());
    const receipts = find(container, (n) => n.tagName === 'A' && n.role === 'menuitem' && n.textContent === 'Receipts');
    assert.ok(receipts);
    await React.act(async () => {
      // Invoke the React handler, then the anchor's native hash navigation.
      const event = { preventDefault() { this.defaultPrevented = true; } };
      props(receipts).onClick(event);
      assert.ok(!event.defaultPrevented);
      location.hash = props(receipts).href;
      window.dispatchEvent(new Event('hashchange'));
    });
    assert.equal(location.hash, '#/inventory/receipts');
    assert.ok(find(container, (n) => n.tagName === 'MAIN' && n.textContent.includes('Receipts')));
    assert.equal(operations['aria-expanded'], 'false');
    assert.equal(toggle['aria-expanded'], 'false');
    assert.equal(find(container, (n) => n.role === 'menu'), null);
  } finally {
    await React.act(async () => root.unmount());
  }
});
