import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadRepaired, openStorage } from './storage.js';
import { repairSeq } from '../src/sync.js';
import { seed } from '../src/seed.js';

test('counters repaired at startup are written back to SQLite', () => {
  const sql = new DatabaseSync(':memory:');
  const storage = openStorage(sql);
  const db = seed();
  storage.save(null, { ...db, seq: { ...db.seq, 'res.partner': 0 } });
  const repaired = loadRepaired(storage, repairSeq);
  const top = Math.max(...db.records['res.partner'].map((r) => r.id));
  assert.equal(repaired.seq['res.partner'], top);
  assert.equal(openStorage(sql).load().seq['res.partner'], top, 'the repair is stored, not only kept in memory');
});

test('an empty database stays empty', () => {
  assert.equal(loadRepaired(openStorage(new DatabaseSync(':memory:')), repairSeq), null);
});
