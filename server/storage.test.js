import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openStorage } from './storage.js';
import { create, postNote, unlink, write } from '../src/orm.js';
import { seed } from '../src/seed.js';

test('incremental saves round-trip exactly and only touch changed rows', () => {
  const sql = new DatabaseSync(':memory:');
  const storage = openStorage(sql);
  assert.equal(storage.load(), null);
  const db0 = seed();
  storage.save(null, db0);
  assert.deepEqual(storage.load(), db0);

  let db1 = write(db0, 'crm.lead', 1, { stage_id: 'won' });
  db1 = unlink(db1, 'crm.lead', [2]);
  db1 = create(db1, 'helpdesk.ticket', { name: 'Stored row by row' }).db;
  db1 = postNote(db1, 'crm.lead', 1, 'hello');
  const before = sql.prepare('SELECT data FROM records WHERE model = ? AND id = ?').get('product', 1).data;
  storage.save(db0, db1);
  const loaded = storage.load();
  assert.deepEqual(loaded.records['crm.lead'].find((r) => r.id === 1), db1.records['crm.lead'].find((r) => r.id === 1));
  assert.ok(!loaded.records['crm.lead'].some((r) => r.id === 2));
  assert.equal(loaded.messages.length, db1.messages.length);
  assert.equal(sql.prepare('SELECT data FROM records WHERE model = ? AND id = ?').get('product', 1).data, before);
  assert.deepEqual(loaded.seq, db1.seq);
});

test('the old single-blob format is migrated on load', () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const db0 = seed();
  sql.prepare("INSERT INTO kv (key, value) VALUES ('db', ?)").run(JSON.stringify(db0));
  const storage = openStorage(sql);
  assert.deepEqual(storage.load(), db0);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM kv WHERE key = 'db'").get().n, 0);
  assert.deepEqual(storage.load(), db0);
});

test('a failure in the work saved alongside rolls the records back too, for incremental and full saves', () => {
  const sql = new DatabaseSync(':memory:');
  const storage = openStorage(sql);
  const db0 = seed();
  storage.save(null, db0);
  const db1 = write(db0, 'crm.lead', 1, { stage_id: 'won' });
  const boom = () => { throw new Error('log write failed'); };
  assert.throws(() => storage.save(db0, db1, boom), /log write failed/);
  assert.deepEqual(storage.load(), db0);
  assert.throws(() => storage.save(null, db1, boom), /log write failed/);
  assert.deepEqual(storage.load(), db0);
});
