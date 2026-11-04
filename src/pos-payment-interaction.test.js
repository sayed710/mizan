import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { startSession } from './models/pos.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

test('POS payment methods preview editable and removable split lines before validation', async () => {
  const saved = { fetch: globalThis.fetch, setInterval: globalThis.setInterval };
  const { makeEl } = setupDom();
  globalThis.location = { hash: '' };
  globalThis.setInterval = (...args) => { const timer = saved.setInterval(...args); timer.unref(); return timer; };
  let db = seed();
  const salePreset = create(db, 'pos.preset', { name: 'Sale preset', is_return: false, identification: 'none' }); db = salePreset.db;
  const returnPreset = create(db, 'pos.preset', { name: 'Return preset', is_return: true, identification: 'none' }); db = returnPreset.db;
  const config = search(db, 'pos.config')[0];
  db = write(db, 'pos.config', config.id, { available_preset_ids: [salePreset.id, returnPreset.id], default_preset_id: salePreset.id });
  db = startSession(db, 0).db;
  let calls = 0, payload;
  const response = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/session') return response({ name: 'Admin', isAdmin: true });
    if (url === '/api/db') return response(db);
    if (url === '/api/pos/pay') {
      calls++;
      payload = JSON.parse(opts.body);
      const { payCart } = await import('./models/pos.js');
      const result = payCart(db, { ...payload, cart: payload.lines });
      db = result.db;
      return response({ id: result.id, name: read(db, 'pos.order', result.id).name, total: read(db, 'pos.order', result.id).amount_total });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();
  const { Pos } = await import('./views/Pos.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const button = (label) => find(host, (n) => n.tagName === 'BUTTON' && n.textContent === label);
  const input = (label) => find(host, (n) => n.tagName === 'INPUT' && props(n)['aria-label'] === label);
  try {
    await React.act(async () => root.render(React.createElement(Pos)));
    const tile = find(host, (n) => n.tagName === 'BUTTON' && props(n).className === 'pos-tile');
    await React.act(async () => props(tile).onClick());
    await React.act(async () => props(button('Cash')).onClick());
    assert.equal(calls, 0, 'choosing a payment method must not pay');
    const cashAmount = input('Cash amount');
    const total = Number(props(cashAmount).value);
    assert.ok(total > 1);
    assert.equal(props(button('Validate')).disabled, false);
    await React.act(async () => props(cashAmount).onChange({ target: { value: '1' } }));
    assert.equal(props(button('Validate')).disabled, true);
    await React.act(async () => props(button('Card')).onClick());
    assert.equal(Number(props(input('Card amount')).value), total - 1);
    const removeCard = find(host, (n) => n.tagName === 'BUTTON' && props(n)['aria-label'] === 'Remove Card');
    await React.act(async () => props(removeCard).onClick());
    assert.equal(props(button('Validate')).disabled, true);
    await React.act(async () => props(button('Card')).onClick());
    assert.equal(Number(props(input('Card amount')).value), total - 1);
    await React.act(async () => props(button('Validate')).onClick());
    assert.equal(calls, 1);
    const order = read(db, 'pos.order', search(db, 'pos.order').at(-1).id);
    assert.equal(order.payment_ids.length, 2);
    assert.deepEqual(order.payment_ids.map((p) => p.amount), [1, total - 1]);
    assert.deepEqual(payload.payments.map((p) => p.amount), [1, total - 1]);
    assert.ok(find(host, (n) => n.textContent?.includes(order.name)));

    // Exercise both directions with an existing cart and two edited tenders.
    for (const [from, to, sign] of [['Sale preset', 'Return preset', -1], ['Return preset', 'Sale preset', 1]]) {
      await React.act(async () => props(button('New Order')).onClick());
      await React.act(async () => props(button(from)).onClick());
      const product = find(host, (n) => n.tagName === 'BUTTON' && props(n).className === 'pos-tile');
      await React.act(async () => props(product).onClick());
      await React.act(async () => props(button('Cash')).onClick());
      const initial = Number(props(input('Cash amount')).value);
      await React.act(async () => props(input('Cash amount')).onChange({ target: { value: String(initial / 2) } }));
      await React.act(async () => props(button('Card')).onClick());
      const before = [Number(props(input('Cash amount')).value), Number(props(input('Card amount')).value)];
      await React.act(async () => props(button(to)).onClick());
      assert.deepEqual([Number(props(input('Cash amount')).value), Number(props(input('Card amount')).value)], before.map((n) => -n));
      assert.equal(props(button('Validate')).disabled, false);
      await React.act(async () => props(button('Validate')).onClick());
      assert.equal(payload.lines[0].qty, sign);
      assert.deepEqual(payload.payments.map((p) => p.amount), before.map((n) => -n));
      const booked = read(db, 'pos.order', search(db, 'pos.order').at(-1).id);
      assert.equal(booked.lines[0].qty, sign);
      assert.equal(booked.preset_id, sign < 0 ? returnPreset.id : salePreset.id);
      assert.ok(find(host, (n) => n.textContent?.includes(booked.name)));
    }
    assert.equal(calls, 3);
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, saved);
  }
});
