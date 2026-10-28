import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { create } from './orm.js';
import { applyDiff, assignIds, diffDb } from './sync.js';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('three queued creates preserve references to both colliding local identities', async () => {
  const original = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, alert: globalThis.alert, setInterval: globalThis.setInterval };
  const base = seed();
  let server = create(base, 'hr.department', { name: 'Rival' }).db;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  const response = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'x-mizan-epoch': '1' } });
  Object.assign(globalThis, { document: { visibilityState: 'hidden' }, window: { dispatchEvent: () => {} }, alert: () => {}, setInterval: () => 0 });
  globalThis.fetch = async (url, opts) => {
    if (url === '/api/session') return response({ name: 'Admin', isAdmin: true });
    if (url === '/api/db') return response(base);
    if (url === '/api/diff') {
      if (++requests === 1) await gate;
      const assigned = assignIds(server, JSON.parse(opts.body));
      server = applyDiff(server, assigned.diff, { isAdmin: true });
      return response({ ...server, remapped: assigned.remapped });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const store = await import('./store.js');
    await store.initStore();
    const a = create(store.getDb(), 'hr.department', { name: 'A' });
    const one = store.commit(a.db, { quiet: true });
    const b = create(store.getDb(), 'hr.department', { name: 'B', parent_id: a.id });
    const two = store.commit(b.db, { quiet: true });
    const c = create(store.getDb(), 'hr.department', { name: 'C', parent_id: b.id });
    const d = create(c.db, 'hr.department', { name: 'D', parent_id: a.id });
    const three = store.commit(d.db, { quiet: true });
    release();
    for (const saved of await Promise.all([one, two, three])) assert.equal(saved.ok, true, saved.error);
    const department = (name) => server.records['hr.department'].find((r) => r.name === name);
    assert.equal(department('B').parent_id, department('A').id);
    assert.equal(department('C').parent_id, department('B').id);
    assert.equal(department('D').parent_id, department('A').id);
    assert.equal(new Set(['A', 'B', 'C', 'D'].map((name) => department(name).id)).size, 4);
  } finally { release(); Object.assign(globalThis, original); }
});
