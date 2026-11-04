import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const originalFetch = globalThis.fetch;
const originalAlert = globalThis.alert;
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalSetInterval = globalThis.setInterval;

function setup() {
  globalThis.document = { visibilityState: 'hidden' };
  globalThis.window = { dispatchEvent: () => {} };
  globalThis.alert = () => {};
  globalThis.setInterval = (fn, ms) => {
    const t = originalSetInterval(fn, ms);
    t.unref?.();
    return t;
  };
}

function teardown() {
  globalThis.fetch = originalFetch;
  globalThis.alert = originalAlert;
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.setInterval = originalSetInterval;
}

test('serverAction keeps its refresh in the queue before the next action', async () => {
  setup();
  const base = seed();
  let actions = 0;
  let reads = 0;
  let release;
  let refreshing;
  const refreshStarted = new Promise((resolve) => { refreshing = resolve; });
  const response = (data) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url) => {
    if (url === '/api/session') return response({ name: 'Admin', isAdmin: true });
    if (url === '/api/db') {
      reads++;
      if (reads === 2) {
        refreshing();
        return new Promise((resolve) => { release = () => resolve(response({ ...base, settings: { ...base.settings, company: 'First' } })); });
      }
      return response({ ...base, settings: { ...base.settings, company: reads > 2 ? 'Second' : 'Initial' } });
    }
    actions++;
    return response({ done: true });
  };
  let first, second;
  try {
    const store = await import('./store.js?queued-refresh');
    await store.initStore();
    first = store.serverAction('/api/action', {});
    second = store.serverAction('/api/action', {});
    await refreshStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(actions, 1, 'a later action cannot overtake an outstanding refresh');
    release();
    await Promise.all([first, second]);
    assert.equal(store.getDb().settings.company, 'Second');
  } finally {
    release?.();
    await Promise.allSettled([first, second]);
    teardown();
  }
});

test('serverAction skips when a preceding queued save failed in the same generation', async () => {
  setup();

  const calls = [];
  const baseDb = seed();

  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
    if (url === '/api/session') {
      return new Response(JSON.stringify({ name: 'Admin', isAdmin: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/db') {
      return new Response(JSON.stringify(baseDb), {
        status: 200,
        headers: { 'Content-Type': 'application/json', etag: 'etag-1' },
      });
    }
    if (url === '/api/diff') {
      // Refused save
      return new Response(JSON.stringify({ error: 'Permission denied' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/action') {
      return new Response(JSON.stringify({ done: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const store = await import('./store.js');
    await store.initStore();

    // Call commit with a change that will fail
    const p1 = store.commit({ ...store.getDb(), settings: { ...store.getDb().settings, company: 'New Name' } }, { quiet: true });
    // Queue serverAction immediately behind commit
    const p2 = store.serverAction('/api/action', { model: 'sale.order', id: 1 });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, false);
    // serverAction should skip and resolve { ok: false, error }
    assert.equal(r2.ok, false);
    assert.ok(r2.error);
    // api('/api/action') should NOT have been called!
    assert.ok(!calls.some((c) => c.url === '/api/action'), 'api(/api/action) should not be sent');
  } finally {
    teardown();
  }
});

test('serverAction remaps body.id through remaps before sending', async () => {
  setup();

  const calls = [];
  const baseDb = seed();

  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
    if (url === '/api/session') {
      return new Response(JSON.stringify({ name: 'Admin', isAdmin: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/db') {
      return new Response(JSON.stringify(baseDb), {
        status: 200,
        headers: { 'Content-Type': 'application/json', etag: 'etag-1' },
      });
    }
    if (url === '/api/diff') {
      // Successful save that remapped temporary id 5 to server id 42
      return new Response(JSON.stringify({
        ...baseDb,
        remapped: { 'sale.order': { 5: 42 } },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url === '/api/action') {
      return new Response(JSON.stringify({ done: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const store = await import('./store.js');
    await store.initStore();

    // Call commit with a change that reallocates id 5 to 42
    const p1 = store.commit({ ...store.getDb(), settings: { ...store.getDb().settings, company: 'Company 42' } }, { quiet: true });
    // Queue serverAction with temporary id 5
    const p2 = store.serverAction('/api/action', { model: 'sale.order', id: 5 });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, true);
    assert.deepEqual(r2, { done: true });
    const actionCall = calls.find((c) => c.url === '/api/action');
    assert.ok(actionCall, '/api/action should have been called');
    assert.equal(actionCall.body.id, 42, 'body.id should be remapped from 5 to 42');
  } finally {
    teardown();
  }
});
