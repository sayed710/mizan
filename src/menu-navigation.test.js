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
      closest(selector) {
        let cur = this;
        const targetTag = selector.toUpperCase();
        while (cur && cur.nodeType === 1) {
          if (cur.tagName === targetTag) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      dispatchEvent(event) {
        let cur = this;
        let canceled = false;
        Object.defineProperty(event, 'target', { value: this, configurable: true });
        while (cur) {
          Object.defineProperty(event, 'currentTarget', { value: cur, configurable: true });
          const ok = EventTarget.prototype.dispatchEvent.call(cur, event);
          if (!ok) canceled = true;
          if (!event.bubbles || event.cancelBubble) break;
          cur = cur.parentNode;
        }
        return !canceled;
      },
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

test('clicking a submenu button keeps the mobile panel open, while anchor clicks and same-hash navigation close it', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(App))));
    const toggle = find(container, (n) => n.tagName === 'BUTTON' && n['aria-controls'] === 'nav-menus');
    await React.act(async () => {
      toggle.dispatchEvent(new Event('click', { bubbles: true }));
    });
    assert.equal(toggle['aria-expanded'], 'true', 'mobile menu panel opened');

    const operations = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Operations');
    await React.act(async () => {
      operations.dispatchEvent(new Event('click', { bubbles: true }));
    });
    assert.equal(toggle['aria-expanded'], 'true', 'mobile menu panel must remain open when opening submenu');
    assert.equal(operations['aria-expanded'], 'true', 'submenu Operations opened');

    const appTitle = find(container, (n) => n.tagName === 'A' && n.textContent === 'Inventory');
    assert.ok(appTitle);
    await React.act(async () => {
      appTitle.dispatchEvent(new Event('click', { bubbles: true }));
    });
    assert.equal(toggle['aria-expanded'], 'false', 'app-title link closes panel on same-hash navigation');

    await React.act(async () => {
      toggle.dispatchEvent(new Event('click', { bubbles: true }));
    });
    assert.equal(toggle['aria-expanded'], 'true');
    const transfersLink = find(container, (n) => n.tagName === 'A' && n.textContent === 'Transfers');
    assert.ok(transfersLink);
    await React.act(async () => {
      transfersLink.dispatchEvent(new Event('click', { bubbles: true }));
    });
    assert.equal(toggle['aria-expanded'], 'false', 'menu link click closes panel');
  } finally {
    await React.act(async () => root.unmount());
  }
});
