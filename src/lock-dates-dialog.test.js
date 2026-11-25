import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { waitFor } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const { apps, leavesOf } = await import('./models/index.js');
const { createCompany } = await import('./models/company.js');
const { read, write, updateSettings } = await import('./orm.js');
const { seed } = await import('./seed.js');
const { commit, getDb, initStore } = await import('./store.js');
const { LockDates, saveLockDates } = await import('./views/LockDates.jsx');

// Seeded before any session actor is set (seeding as a restricted user is refused).
const seeded = seed();

function setupDom() {
  const makeEl = (tag = 'div') => {
    const node = Object.assign(new EventTarget(), {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      nodeName: tag.toUpperCase(),
      childNodes: [],
      style: {},
      options: [],
      ownerDocument: globalThis.document,
      appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; },
      removeChild(child) {
        const idx = this.childNodes.indexOf(child);
        if (idx >= 0) this.childNodes.splice(idx, 1);
        child.parentNode = null;
        return child;
      },
      insertBefore(child, before) {
        const idx = this.childNodes.indexOf(before);
        if (idx >= 0) this.childNodes.splice(idx, 0, child);
        else this.childNodes.push(child);
        child.parentNode = this;
        return child;
      },
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
      querySelector(selector) {
        return find(this, (n) => {
          if (selector === '[role=dialog]' || selector === 'form[role=dialog]') return n.role === 'dialog';
          if (selector === '[role=alert]' || selector === '.alert') return n.role === 'alert' || n.className === 'alert';
          if (selector === 'h2' || selector === '#wizard-title') return n.tagName === 'H2' || n.id === 'wizard-title';
          if (selector.startsWith('#')) return n.id === selector.slice(1);
          return false;
        });
      },
      querySelectorAll(selector) {
        return findAll(this, (n) => {
          if (selector === 'input, select, textarea, button') return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(n.tagName);
          return false;
        });
      },
    });
    Object.defineProperty(node, 'textContent', {
      get() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join(''); },
      set(value) { this.childNodes = value ? [{ nodeType: 3, nodeValue: String(value) }] : []; },
    });
    return node;
  };
  globalThis.window = Object.assign(new EventTarget(), { HTMLIFrameElement: class {}, scrollTo() {} });
  globalThis.document = Object.assign(new EventTarget(), {
    nodeType: 9,
    nodeName: '#document',
    visibilityState: 'hidden',
    documentElement: makeEl('html'),
    createElement: makeEl,
    createElementNS: (namespace, tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: text }),
    createComment: () => ({ nodeType: 8 }),
  });
  globalThis.location = { hash: '#/accounting/lock-dates' };
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

function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) {
    findAll(child, predicate, out);
  }
  return out;
}

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

// Let React flush pending work (the lazy page import, an awaited commit) until `check` yields a value.
const until = (React, check) => waitFor(React, check);

test('the menu resolves to the Lock Dates dialog (not general settings)', async () => {
  const accounting = apps.find((a) => a.id === 'accounting');
  assert.ok(accounting, 'Accounting app exists');

  const leaves = leavesOf(accounting);
  const lockDatesLeaf = leaves.find((l) => l.key === 'lock-dates');
  assert.ok(lockDatesLeaf, 'lock-dates menu leaf exists');
  assert.equal(lockDatesLeaf.label, 'Lock Dates…');
  assert.equal(lockDatesLeaf.type, 'lockDates', 'Menu resolves to dedicated lockDates type, not settings');

  const container = setupDom();
  globalThis.location.hash = '#/accounting/lock-dates';

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { App } = await import('./App.jsx');
  // Make sure the lazily imported page's module is loaded; React.lazy still resolves it asynchronously,
  // so wait for the dialog instead of asserting right after render.
  await import('./views/LockDates.jsx');

  await initStore();
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(App));
    });

    // Verify it opened the dialog
    const dialog = await until(React, () => find(container, (n) => n.role === 'dialog'));
    assert.ok(dialog, 'Dedicated dialog must be rendered');

    const title = find(dialog, (n) => n.tagName === 'H2');
    assert.ok(title, 'Dialog heading exists');
    assert.equal(title.textContent, 'Lock Dates');

    // Verify it does NOT render general settings
    assert.equal(find(container, (n) => n.textContent === 'General Settings'), null);
    assert.equal(find(container, (n) => n.tagName === 'LABEL' && n.textContent === 'Company Name'), null);
    assert.equal(find(container, (n) => n.tagName === 'LABEL' && n.textContent === 'Theme'), null);

    // Verify lock fields are present
    const labels = findAll(dialog, (n) => n.tagName === 'LABEL').map((l) => l.textContent.replaceAll('*', ''));
    assert.ok(labels.includes('Sales Lock Date'), 'Has Sales Lock Date');
    assert.ok(labels.includes('Purchase Lock Date'), 'Has Purchase Lock Date');
    assert.ok(labels.includes('Lock Date'), 'Has Lock Date');
    assert.ok(labels.includes('Tax Return Lock Date'), 'Has Tax Return Lock Date');
    assert.ok(labels.includes('Hard Lock Date'), 'Has Hard Lock Date');

    // Verify hard lock warning is rendered
    const warning = find(dialog, (n) => n.textContent?.includes('A hard lock cannot be undone.'));
    assert.ok(warning, 'Hard lock warning is displayed');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('saving sales/purchase/lock/tax dates persists on the current company only (multi-company: other company untouched)', async () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Sister Company' });
  db = c2.db;

  // Set Company 1 as current
  db = updateSettings(db, { current_company_id: 1 });
  commit(db);

  // Initially Company 1 and Company 2 have no lock dates
  const initialC1 = read(db, 'res.company', 1);
  const initialC2 = read(db, 'res.company', c2.id);
  assert.equal(initialC1.sale_lock_date ?? null, null);
  assert.equal(initialC2.sale_lock_date ?? null, null);

  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, { db }));
    });

    const dialog = find(container, (n) => n.tagName === 'FORM');
    assert.ok(dialog, 'LockDates dialog rendered');

    // Fill in dates for company 1
    const saleInput = find(dialog, (n) => n.id === 'w-sale_lock_date');
    const purchaseInput = find(dialog, (n) => n.id === 'w-purchase_lock_date');
    const lockInput = find(dialog, (n) => n.id === 'w-lock_date');
    const taxInput = find(dialog, (n) => n.id === 'w-tax_lock_date');

    await React.act(async () => {
      props(saleInput).onChange({ target: { value: '2026-03-31' } });
      props(purchaseInput).onChange({ target: { value: '2026-03-31' } });
      props(lockInput).onChange({ target: { value: '2026-02-28' } });
      props(taxInput).onChange({ target: { value: '2026-03-31' } });
    });

    // Confirm dialog
    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault: () => {} });
    });

    const updatedDb = getDb();
    const updatedC1 = read(updatedDb, 'res.company', 1);
    const updatedC2 = read(updatedDb, 'res.company', c2.id);

    // Company 1 has new lock dates
    assert.equal(updatedC1.sale_lock_date, '2026-03-31');
    assert.equal(updatedC1.purchase_lock_date, '2026-03-31');
    assert.equal(updatedC1.lock_date, '2026-02-28');
    assert.equal(updatedC1.tax_lock_date, '2026-03-31');

    // Company 2 is completely untouched
    assert.equal(updatedC2.sale_lock_date, initialC2.sale_lock_date);
    assert.equal(updatedC2.purchase_lock_date, initialC2.purchase_lock_date);
    assert.equal(updatedC2.lock_date, initialC2.lock_date);
    assert.equal(updatedC2.tax_lock_date, initialC2.tax_lock_date);
    assert.equal(updatedC2.hard_lock_date, initialC2.hard_lock_date);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('saving lock dates when Company 2 is active persists on Company 2 only (Company 1 untouched)', async () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Company Two' });
  db = c2.db;

  // Set Company 2 as current
  db = updateSettings(db, { current_company_id: c2.id });
  // Company 1 has some lock date already
  db = write(db, 'res.company', 1, { lock_date: '2026-01-01' });
  commit(db);

  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, { db }));
    });

    const dialog = find(container, (n) => n.tagName === 'FORM');
    const lockInput = find(dialog, (n) => n.id === 'w-lock_date');
    const saleInput = find(dialog, (n) => n.id === 'w-sale_lock_date');

    await React.act(async () => {
      props(lockInput).onChange({ target: { value: '2026-10-31' } });
      props(saleInput).onChange({ target: { value: '2026-10-15' } });
    });

    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault: () => {} });
    });

    const updatedDb = getDb();
    const updatedC1 = read(updatedDb, 'res.company', 1);
    const updatedC2 = read(updatedDb, 'res.company', c2.id);

    // Company 2 updated
    assert.equal(updatedC2.lock_date, '2026-10-31');
    assert.equal(updatedC2.sale_lock_date, '2026-10-15');

    // Company 1 untouched
    assert.equal(updatedC1.lock_date, '2026-01-01');
    assert.equal(updatedC1.sale_lock_date ?? null, null);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('moving the hard lock date back is rejected with the existing message', async () => {
  let db = seed();
  // Set hard lock date to 2026-06-30 on company 1
  db = write(db, 'res.company', 1, { hard_lock_date: '2026-06-30' });
  commit(db);

  // Direct ORM write path rejection
  assert.throws(
    () => saveLockDates(db, 1, { hard_lock_date: '2026-05-31' }),
    /The hard lock date cannot be moved back or removed/
  );
  assert.throws(
    () => saveLockDates(db, 1, { hard_lock_date: '' }),
    /The hard lock date cannot be moved back or removed/
  );

  // In the dialog component, verify error is surfaced in the alert
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, { db }));
    });

    const dialog = find(container, (n) => n.tagName === 'FORM');
    const hardLockInput = find(dialog, (n) => n.id === 'w-hard_lock_date');
    assert.ok(hardLockInput, 'hard lock input exists and is settable');

    // Try moving hard lock date back
    await React.act(async () => {
      props(hardLockInput).onChange({ target: { value: '2026-05-31' } });
    });

    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault: () => {} });
    });

    // Alert surfaces the guard error
    const alert = find(container, (n) => n.role === 'alert' || n.className === 'alert');
    assert.ok(alert, 'Alert must be displayed on error');
    assert.match(alert.textContent, /The hard lock date cannot be moved back or removed/);

    // Hard lock date on company remains 2026-06-30
    assert.equal(read(getDb(), 'res.company', 1).hard_lock_date, '2026-06-30');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('a non-admin is rejected by the server-side company guard', async () => {
  const db = seed();
  commit(db);

  const next = saveLockDates(db, 1, { lock_date: '2026-12-31' });
  const { applyDiff, diffDb } = await import('./sync.js');

  // The server applies the same guard Settings relies on; a non-admin cannot change lock dates.
  assert.throws(
    () => applyDiff(db, diffDb(db, next), { author: 'Clerk', isAdmin: false }),
    /Only administrators can change lock dates or the audit trail or other company accounting settings/
  );

  // An administrator can apply the same change.
  const saved = applyDiff(db, diffDb(db, next), { author: 'Admin', isAdmin: true });
  assert.equal(read(saved, 'res.company', 1).lock_date, '2026-12-31');
});

test('cancel / close discards changes', async () => {
  let db = seed();
  commit(db);
  const initialCompany = read(db, 'res.company', 1);

  let closed = false;
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, { db, onClose: () => { closed = true; } }));
    });

    const dialog = find(container, (n) => n.tagName === 'FORM');
    const saleInput = find(dialog, (n) => n.id === 'w-sale_lock_date');

    await React.act(async () => {
      props(saleInput).onChange({ target: { value: '2026-12-31' } });
    });

    const cancelBtn = find(dialog, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cancel');
    assert.ok(cancelBtn, 'Cancel button exists');

    await React.act(async () => {
      props(cancelBtn).onClick();
    });

    assert.equal(closed, true, 'Dialog close was triggered');
    assert.equal(read(getDb(), 'res.company', 1).sale_lock_date, initialCompany.sale_lock_date);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('only edited lock dates are written: a stale tax lock is not overwritten', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, { tax_lock_date: '2026-03-31' });
  db = updateSettings(db, { current_company_id: 1 });
  commit(db);

  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, { db }));
    });

    // While the dialog is open, another action raises the tax lock date.
    await React.act(async () => { commit(write(getDb(), 'res.company', 1, { tax_lock_date: '2026-06-30' })); });

    const dialog = find(container, (n) => n.tagName === 'FORM');
    const saleInput = find(dialog, (n) => n.id === 'w-sale_lock_date');
    await React.act(async () => {
      props(saleInput).onChange({ target: { value: '2026-04-30' } });
    });
    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault: () => {} });
    });

    const stored = read(getDb(), 'res.company', 1);
    assert.equal(stored.sale_lock_date, '2026-04-30', 'The field the user edited is saved');
    assert.equal(stored.tax_lock_date, '2026-06-30', 'The untouched tax lock keeps the newer stored value');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('an unchanged form closes without writing', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, { sale_lock_date: '2026-01-15' });
  db = updateSettings(db, { current_company_id: 1 });
  commit(db);
  const before = getDb();

  let closed = false;
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, { db, onClose: () => { closed = true; } }));
    });

    const dialog = find(container, (n) => n.tagName === 'FORM');
    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault: () => {} });
    });

    assert.equal(closed, true, 'The dialog closes');
    assert.equal(getDb(), before, 'No write happened');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('switching the selected company resets the form to that company values', async () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Sister Company' });
  db = c2.db;
  db = write(db, 'res.company', 1, { sale_lock_date: '2026-01-15', hard_lock_date: '2026-01-01' });
  db = write(db, 'res.company', c2.id, { sale_lock_date: '2026-09-20' });
  db = updateSettings(db, { current_company_id: 1 });
  commit(db);

  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, { db }));
    });

    const firstDialog = find(container, (n) => n.tagName === 'FORM');
    assert.equal(props(find(firstDialog, (n) => n.id === 'w-sale_lock_date')).value, '2026-01-15');

    // The selected company changes while the dialog is open.
    const switched = updateSettings(db, { current_company_id: c2.id });
    await React.act(async () => {
      root.render(React.createElement(LockDates, { db: switched }));
    });

    const dialog = find(container, (n) => n.tagName === 'FORM');
    assert.equal(props(find(dialog, (n) => n.id === 'w-sale_lock_date')).value, '2026-09-20');
    assert.equal(props(find(dialog, (n) => n.id === 'w-hard_lock_date')).value, '', 'Company 1 values are not applied to Company 2');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('moving the hard lock forward requires confirmation; cancel writes nothing', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, { hard_lock_date: '2026-01-01' });
  commit(db);

  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { t } = await import('./i18n.js');

  const calls = [];
  const prevConfirm = globalThis.confirm;
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, { db }));
    });

    const dialog = find(container, (n) => n.tagName === 'FORM');
    const hardLockInput = find(dialog, (n) => n.id === 'w-hard_lock_date');
    await React.act(async () => {
      props(hardLockInput).onChange({ target: { value: '2026-06-30' } });
    });

    globalThis.confirm = (message) => { calls.push(message); return false; };
    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault: () => {} });
    });

    assert.deepEqual(calls, [t('The hard lock date cannot be moved back or removed. Continue?')]);
    assert.ok(find(container, (n) => n.tagName === 'FORM'), 'The dialog stays open');
    assert.equal(read(getDb(), 'res.company', 1).hard_lock_date, '2026-01-01', 'Cancel wrote nothing');

    globalThis.confirm = (message) => { calls.push(message); return true; };
    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault: () => {} });
    });
    await until(React, () => read(getDb(), 'res.company', 1).hard_lock_date === '2026-06-30');
    assert.equal(read(getDb(), 'res.company', 1).hard_lock_date, '2026-06-30');
  } finally {
    globalThis.confirm = prevConfirm;
    await React.act(async () => root.unmount());
  }
});

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  headers: { get: (name) => ({ 'content-type': 'application/json', etag: '"1"' })[name.toLowerCase()] ?? null },
  json: async () => body,
});

// Serve the store a signed-in server session without a real backend.
async function startServer({ db, user, diff }) {
  const prevFetch = globalThis.fetch;
  const prevInterval = globalThis.setInterval;
  let diffCalls = 0;
  globalThis.setInterval = () => 0;
  globalThis.fetch = async (path) => {
    if (path === '/api/session') return jsonResponse(user);
    if (path === '/api/db') return jsonResponse(db);
    if (path === '/api/diff') { diffCalls++; return diff ?? jsonResponse({ ok: true }); }
    return jsonResponse([]);
  };
  const { initStore } = await import('./store.js');
  await initStore();
  return {
    diffCalls: () => diffCalls,
    stop: () => {
      globalThis.fetch = prevFetch;
      globalThis.setInterval = prevInterval;
    },
  };
}

test('a refused server commit keeps the dialog open with its error and entered values', async () => {
  let db = structuredClone(seeded);
  db = updateSettings(db, { current_company_id: 1 });

  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const server = await startServer({
    db,
    user: { id: 1, login: 'admin', name: 'Admin', isAdmin: true, apps: ['accounting'] },
    diff: jsonResponse({ error: 'The server refused this change' }, { ok: false, status: 409 }),
  });
  let closed = false;
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates, { onClose: () => { closed = true; } }));
    });
    const dialog = await until(React, () => find(container, (n) => n.tagName === 'FORM'));
    assert.ok(dialog, 'LockDates dialog rendered');

    const saleInput = find(dialog, (n) => n.id === 'w-sale_lock_date');
    await React.act(async () => {
      props(saleInput).onChange({ target: { value: '2026-12-31' } });
    });
    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault: () => {} });
    });

    const alert = await until(React, () => find(container, (n) => n.role === 'alert' || n.className === 'alert'));
    assert.ok(alert, 'The refusal is shown in the dialog');
    assert.match(alert.textContent, /The server refused this change/);
    assert.ok(find(container, (n) => n.tagName === 'FORM'), 'The dialog stays open');
    assert.equal(closed, false, 'onClose was not called');
    assert.equal(props(find(container, (n) => n.id === 'w-sale_lock_date')).value, '2026-12-31', 'Entered values are kept');
  } finally {
    server.stop();
    await React.act(async () => root.unmount());
  }
});

test('a non-admin server user gets disabled lock dates and no Save action', async () => {
  let db = structuredClone(seeded);
  db = updateSettings(db, { current_company_id: 1 });

  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');

  const server = await startServer({
    db,
    user: { id: 2, login: 'clerk', name: 'Clerk', isAdmin: false, apps: ['accounting'] },
  });
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(LockDates));
    });
    const dialog = await until(React, () => find(container, (n) => n.tagName === 'FORM'));
    assert.ok(dialog, 'LockDates dialog rendered');

    for (const name of ['sale_lock_date', 'purchase_lock_date', 'lock_date', 'tax_lock_date', 'hard_lock_date']) {
      const input = find(dialog, (n) => n.id === `w-${name}`);
      // The fake DOM records a boolean attribute as true, 'true', or ''.
      assert.ok([true, 'true', ''].includes(input.disabled), `${name} is disabled`);
    }
    const save = find(dialog, (n) => n.tagName === 'BUTTON' && n.textContent === 'Save');
    assert.ok(save, 'Save button exists');
    assert.ok([true, 'true', ''].includes(save.disabled), 'Save is disabled');

    await React.act(async () => {
      props(dialog).onSubmit({ preventDefault: () => {} });
    });
    assert.equal(server.diffCalls(), 0, 'Nothing is sent');
  } finally {
    server.stop();
    await React.act(async () => root.unmount());
  }
});

