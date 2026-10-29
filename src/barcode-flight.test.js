import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { seed } from './seed.js';
import { startSession } from './models/pos.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('POS payment blocks repeated clicks and renders the authoritative server receipt total', async () => {
  const saved = { fetch: globalThis.fetch, setInterval: globalThis.setInterval };
  const { makeEl } = setupDom();
  globalThis.location = { hash: '' };
  globalThis.setInterval = (...args) => { const timer = saved.setInterval(...args); timer.unref(); return timer; };
  const db = startSession(seed(), 0).db;
  let calls = 0, finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const response = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/session') return response({ name: 'Admin', isAdmin: true });
    if (url === '/api/db') return response(db);
    if (url === '/api/pos/pay') {
      calls++;
      assert.ok(JSON.parse(opts.body).request_key);
      await waiting;
      return response({ id: 999, name: 'POS/server', total: 123.45 });
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
  try {
    await React.act(async () => root.render(React.createElement(Pos)));
    const tile = find(host, (n) => Object.keys(n).some((k) => k.startsWith('__reactProps$')) && props(n).className === 'pos-tile');
    await React.act(async () => props(tile).onClick());
    const cash = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Cash');
    let first, second;
    await React.act(async () => { first = props(cash).onClick(); second = props(cash).onClick(); });
    assert.equal(props(cash).disabled, true);
    finish();
    await React.act(async () => { await Promise.all([first, second]); });
    assert.equal(calls, 1);
    assert.ok(find(host, (n) => n.textContent?.includes('123.45')), 'receipt shows the server total rather than the pre-request cart calculation');
  } finally {
    finish();
    await React.act(async () => root.unmount());
    Object.assign(globalThis, saved);
  }
});
const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

test('barcode count is single-flight, freezes scans and distinguishes saved counts from refresh failure', async () => {
  const saved = { fetch: globalThis.fetch, setInterval: globalThis.setInterval };
  const { makeEl } = setupDom();
  globalThis.location = { hash: '', reload() {} };
  globalThis.setInterval = (...args) => { const timer = saved.setInterval(...args); timer.unref(); return timer; };
  const db = seed();
  const products = db.records.product.filter((p) => p.type === 'goods').slice(0, 2);
  let calls = 0, failRefresh = false, finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url) => {
    if (url === '/api/session') return response({ name: 'Admin', isAdmin: true });
    if (url === '/api/db') return response(failRefresh ? { error: 'Refresh unavailable' } : db, failRefresh ? 503 : 200);
    if (url === '/api/barcode/count') { calls++; await waiting; return response({ message: 'Count applied' }); }
    throw new Error(`Unexpected request ${url}`);
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();
  const { Barcode } = await import('./views/Pages.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Barcode)));
    const input = find(host, (n) => n.tagName === 'INPUT');
    await React.act(async () => props(input).onChange({ target: { value: products[0].default_code } }));
    await React.act(async () => props(input).onKeyDown({ key: 'Enter' }));
    const apply = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Apply Count');
    let first, second;
    await React.act(async () => {
      first = props(apply).onClick();
      second = props(apply).onClick();
    });
    assert.equal(calls, 1, 'rapid double submit must produce one mutation');
    assert.equal(props(input).disabled, true, 'a second scan cannot replace the in-flight product');
    failRefresh = true;
    finish();
    await React.act(async () => { await Promise.all([first, second]); });
    assert.equal(calls, 1, 'the queued callback must not issue a duplicate count after the first completes');
    assert.ok(find(host, (n) => n.textContent?.includes('Stock of')));
    assert.ok(find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Reload'), 'saved-with-refresh-failure offers recovery, not another count');
  } finally {
    finish();
    await React.act(async () => root.unmount());
    Object.assign(globalThis, saved);
  }
});
