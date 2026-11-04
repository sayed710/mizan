import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Exercise the actual server closure without starting HTTP listeners or schedulers.
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const closure = source.match(/const writeSql = ([\s\S]*?);\nconst storage/)[1];
const writer = (sql, ownLease) => new Function('sql', 'ownLease', `return (${closure});`)(sql, ownLease);

test('direct SQL writes acquire the write lock before checking ownership', () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE sessions (id INTEGER)');
  let checked = 0;
  const write = writer(sql, () => { checked++; assert.equal(sql.isTransaction, true); });
  write('INSERT INTO sessions VALUES (?)', 1);
  assert.equal(checked, 1);
  assert.equal(sql.isTransaction, false);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
});

test('displaced writers roll back and audited callers keep their outer transaction', () => {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE sessions (id INTEGER)');
  const displaced = writer(sql, () => { assert.equal(sql.isTransaction, true); throw new Error('lease lost'); });
  assert.throws(() => displaced('INSERT INTO sessions VALUES (1)'), /lease lost/);
  assert.equal(sql.isTransaction, false);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  const write = writer(sql, () => assert.equal(sql.isTransaction, true));
  sql.exec('BEGIN IMMEDIATE');
  write('INSERT INTO sessions VALUES (2)');
  assert.equal(sql.isTransaction, true);
  sql.exec('ROLLBACK');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});
