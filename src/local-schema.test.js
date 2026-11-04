import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { SCHEMA_VERSION } from './migrations.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('a newer local schema stops initialization and never overwrites saved data', async () => {
  const fetch = globalThis.fetch;
  const storage = globalThis.localStorage;
  const saved = JSON.stringify({ ...seed(), schema_version: SCHEMA_VERSION + 1 });
  let writes = 0;
  globalThis.fetch = async () => { throw new Error('Static hosting'); };
  globalThis.localStorage = { getItem: (key) => key === 'mizan-db-v32' ? saved : null, setItem: () => { writes++; } };
  try {
    const store = await import('./store.js?newer-schema');
    await assert.rejects(store.initStore(), /newer/);
    assert.equal(store.getDb(), null);
    assert.equal(writes, 0);
    assert.equal(localStorage.getItem('mizan-db-v32'), saved);
  } finally {
    globalThis.fetch = fetch;
    if (storage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = storage;
  }
});
