import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, SHARED_MODELS, write } from './orm.js';
import { ACCOUNTING_CONFIG, menusFor, models, targetOf, viewsOf } from './models/index.js';
import { ensureOnlinePaymentMethods } from './models/paymentmethod.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, cls) => typeof classOf(node) === 'string' && classOf(node).split(/\s+/).includes(cls);
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};

async function mountView(renderElement, initialDb = seed()) {
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
      return child;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(renderElement(React)));
  return {
    React,
    host,
    commit,
    getDb,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

test('account.payment.method stays technical and payment providers have one menu entry', () => {
  const apm = models['account.payment.method'];
  assert.deepEqual(viewsOf('account.payment.method'), ['list']);
  assert.equal(apm.form, undefined);
  assert.equal(apm.guard, undefined);
  assert.equal(apm.fields.active, undefined);
  assert.equal(Boolean(apm.fields.code.readonly), false);
  assert.equal(Boolean(apm.fields.payment_type.readonly), false);

  const configMenu = menusFor('accounting').find((m) => m.label === 'Configuration');
  const leaves = (items) => items.flatMap((c) => (c.children ? leaves(c.children) : [c]));
  // Odoo lists providers once, under Configuration > Payments.
  assert.deepEqual(leaves(configMenu.children).filter((c) => c.model === 'payment.provider').map((c) => c.key), ['payment-providers']);
});

test('Accounting > Configuration > Payments exposes Payment Providers then Payment Methods', () => {
  const configMenu = menusFor('accounting').find((m) => m.label === 'Configuration');
  const paymentsGroup = configMenu?.children?.find((c) => c.label === 'Payments');
  assert.ok(paymentsGroup, 'Accounting > Configuration has a Payments submenu');
  assert.deepEqual(
    paymentsGroup.children.map((c) => ({ key: c.key, label: c.label, model: c.model })),
    [
      { key: 'payment-providers', label: 'Payment Providers', model: 'payment.provider' },
      { key: 'payment-methods', label: 'Payment Methods', model: 'payment.method' },
    ],
  );
  assert.equal(targetOf('payment.provider'), '#/accounting/payment-providers');
  assert.equal(targetOf('payment.method'), '#/accounting/payment-methods');
});

test('payment.method has Odoo fields, views, configuration sets, and active seeded records for seeded providers', () => {
  const def = models['payment.method'];
  assert.ok(def, 'payment.method is registered');
  assert.equal(def.label, 'Payment Methods');
  assert.deepEqual(viewsOf('payment.method'), ['list', 'form']);
  assert.ok(SHARED_MODELS.has('payment.method'), 'payment.method is shared across companies');
  assert.ok(ACCOUNTING_CONFIG.includes('payment.method'), 'payment.method is in ACCOUNTING_CONFIG');

  assert.equal(def.fields.name.type, 'char');
  assert.equal(def.fields.name.required, true);
  assert.equal(def.fields.code.type, 'char');
  assert.equal(def.fields.code.required, true);
  assert.equal(def.fields.sequence.type, 'integer');
  assert.equal(def.fields.active.type, 'boolean');
  assert.equal(def.fields.primary_payment_method_id.type, 'many2one');
  assert.equal(def.fields.primary_payment_method_id.relation, 'payment.method');
  assert.equal(def.fields.provider_ids.type, 'many2many');
  assert.equal(def.fields.provider_ids.relation, 'payment.provider');
  assert.equal(def.fields.supported_country_ids.type, 'tags');
  assert.equal(def.fields.supported_currency_ids.type, 'many2many');
  assert.equal(def.fields.supported_currency_ids.relation, 'res.currency');

  const db = seed();
  const providersByCode = Object.fromEntries(search(db, 'payment.provider').map((p) => [p.code, p]));
  const methods = search(db, 'payment.method');
  assert.deepEqual(
    methods.map((m) => ({ code: m.code, name: m.name, active: m.active, provider_ids: m.provider_ids })),
    [
      { code: 'wire_transfer', name: 'Wire Transfer', active: true, provider_ids: [providersByCode.wire.id] },
      { code: 'cod', name: 'Cash on Delivery', active: true, provider_ids: [providersByCode.cod.id] },
      { code: 'demo', name: 'Demo', active: true, provider_ids: [providersByCode.demo.id] },
    ],
  );

  // Calling ensureOnlinePaymentMethods again is idempotent
  assert.equal(ensureOnlinePaymentMethods(db), db);

  // Primary payment method domain excludes brands and self
  const wireMethod = methods.find((m) => m.code === 'wire_transfer');
  const brandMethod = { id: 999, name: 'Sub Brand', primary_payment_method_id: wireMethod.id };
  assert.equal(def.fields.primary_payment_method_id.domain(wireMethod, { id: 500 }), true);
  assert.equal(def.fields.primary_payment_method_id.domain(wireMethod, wireMethod), false);
  assert.equal(def.fields.primary_payment_method_id.domain(brandMethod, { id: 500 }), false);
});

test('payment.method list, Archived filter, and form view render cleanly', async () => {
  let db = seed();
  const demo = search(db, 'payment.method').find((m) => m.code === 'demo');
  db = write(db, 'payment.method', demo.id, { active: false });

  const configMenu = menusFor('accounting').find((m) => m.label === 'Configuration');
  const leaf = configMenu.children.find((c) => c.label === 'Payments').children.find((c) => c.key === 'payment-methods');
  const { ActionView } = await import('./views/ActionView.jsx');
  const { FormView } = await import('./views/FormView.jsx');

  const listCtx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/payment-methods', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    const tbodyText = () => find(listCtx.host, (n) => n.tagName === 'TBODY').textContent;
    assert.ok(tbodyText().includes('Wire Transfer'));
    assert.ok(tbodyText().includes('Cash on Delivery'));
    assert.ok(!tbodyText().includes('Demo'), 'archived method hidden by default');

    const toggle = find(listCtx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    await listCtx.React.act(async () => { props(toggle).onClick(); });
    const panel = find(listCtx.host, (n) => hasClass(n, 'search-panel'));
    const archivedBtn = allFind(panel, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Archived');
    assert.ok(archivedBtn, 'SearchPanel provides an Archived filter');

    await listCtx.React.act(async () => { props(archivedBtn).onClick(); });
    assert.ok(tbodyText().includes('Demo'), 'Archived filter shows Demo');
    assert.ok(!tbodyText().includes('Wire Transfer'), 'Archived filter hides active methods');
  } finally {
    await listCtx.done();
  }

  const wire = search(db, 'payment.method').find((m) => m.code === 'wire_transfer');
  const formCtx = await mountView(
    (React) => React.createElement(FormView, { model: 'payment.method', id: wire.id, base: '#/accounting/payment-methods', leaf, params: new URLSearchParams() }),
    db,
  );
  try {
    const text = formCtx.host.textContent;
    assert.ok(text.includes('Providers'));
    assert.ok(text.includes('Configuration'));
    assert.ok(text.includes('Primary Payment Method'));
    assert.ok(text.includes('Wire Transfer'));
  } finally {
    await formCtx.done();
  }
});

test('PMM-2: archiving or deleting a payment.method linked to an enabled provider is rejected through diffDb + applyDiff', () => {
  const base = seed();
  const wireMethod = search(base, 'payment.method').find((m) => m.code === 'wire_transfer');
  const demoMethod = search(base, 'payment.method').find((m) => m.code === 'demo');
  const wireProvider = search(base, 'payment.provider').find((p) => p.code === 'wire');

  // 1. Archiving a method linked to an enabled provider fails via diffDb + applyDiff (even bypassing client guard)
  const clientBlocked = {
    ...base,
    records: {
      ...base.records,
      'payment.method': base.records['payment.method'].map((m) => (m.id === wireMethod.id ? { ...m, active: false } : m)),
    },
  };
  const archiveDiff = diffDb(base, clientBlocked);
  assert.throws(
    () => applyDiff(base, archiveDiff),
    /You can't deactivate a payment method that is linked to a provider in the enabled or test state\.\nLinked provider\(s\): Wire Transfer/,
  );

  // 2. Deleting a method linked to an enabled provider is also blocked via diffDb + applyDiff
  const deleteDiff = { ...diffDb(base, base), deletes: { 'payment.method': [wireMethod.id] } };
  assert.throws(
    () => applyDiff(base, deleteDiff),
    /You can't delete a payment method that is linked to a provider in the enabled or test state\.\nLinked provider\(s\): Wire Transfer/,
  );

  // 3. Archiving a method linked only to a disabled provider (Demo) succeeds via diffDb + applyDiff
  const clientDemoArchived = write(base, 'payment.method', demoMethod.id, { active: false });
  const afterDemo = applyDiff(base, diffDb(base, clientDemoArchived));
  assert.equal(read(afterDemo, 'payment.method', demoMethod.id, { includeArchived: true }).active, false);

  // 4. Disabling the provider first allows archiving Wire Transfer via diffDb + applyDiff
  const disabledWire = write(base, 'payment.provider', wireProvider.id, { state: 'disabled' });
  const clientWireArchived = write(disabledWire, 'payment.method', wireMethod.id, { active: false });
  const afterWire = applyDiff(base, diffDb(base, clientWireArchived));
  assert.equal(read(afterWire, 'payment.method', wireMethod.id, { includeArchived: true }).active, false);

  // 5. Unlinking the active provider from provider_ids also allows archiving via diffDb + applyDiff
  const clientUnlinkedArchived = write(base, 'payment.method', wireMethod.id, { provider_ids: [], active: false });
  const afterUnlinked = applyDiff(base, diffDb(base, clientUnlinkedArchived));
  assert.equal(read(afterUnlinked, 'payment.method', wireMethod.id, { includeArchived: true }).active, false);

  // 6. Creating a child brand with primary_payment_method_id, countries, and currencies round-trips via diffDb + applyDiff
  const eur = search(base, 'res.currency').find((c) => c.name === 'EUR');
  const brandRes = create(base, 'payment.method', {
    name: 'Instant Wire',
    code: 'instant_wire',
    sequence: 15,
    primary_payment_method_id: wireMethod.id,
    provider_ids: [],
    supported_country_ids: ['EG', 'AE'],
    supported_currency_ids: eur ? [eur.id] : [],
  });
  const afterBrand = applyDiff(base, diffDb(base, brandRes.db));
  const savedBrand = read(afterBrand, 'payment.method', brandRes.id);
  assert.equal(savedBrand.primary_payment_method_id, wireMethod.id);
  assert.deepEqual(savedBrand.supported_country_ids, ['EG', 'AE']);
  assert.deepEqual(savedBrand.supported_currency_ids, eur ? [eur.id] : []);
});

test('Arabic translations exist and contain no identity strings for payment.method UI and error messages', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-pmm1');
    const strings = [
      'Payment Methods',
      'Payment Providers',
      'Primary Payment Method',
      'Providers',
      'Supported Countries',
      'Supported Currencies',
      'Configuration',
      'Archived',
      'A payment method cannot be its own primary payment method',
      "You can't deactivate a payment method that is linked to a provider in the enabled or test state.\nLinked provider(s): Wire Transfer",
      "You can't delete a payment method that is linked to a provider in the enabled or test state.\nLinked provider(s): Wire Transfer",
    ];
    for (const s of strings) {
      const ar = t(s);
      assert.notEqual(ar, s, `Missing Arabic translation for: ${s}`);
      assert.match(ar, /[\u0600-\u06FF]/, `Expected Arabic characters for: ${s}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
