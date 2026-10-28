import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';

test('read finds records by id through the index, before and after writes', () => {
  let db = seed();
  const ids = search(db, 'res.partner').map((p) => p.id);
  for (let round = 0; round < 3; round++) for (const id of ids) assert.equal(read(db, 'res.partner', id).id, id);
  assert.equal(read(db, 'res.partner', 999999), undefined);
  db = write(db, 'res.partner', ids[0], { name: 'Renamed' });
  assert.equal(read(db, 'res.partner', ids[0]).name, 'Renamed');
  assert.equal(read(db, 'res.partner', ids[0]).name, 'Renamed');
  const made = create(db, 'res.partner', { name: 'New one' });
  assert.equal(read(made.db, 'res.partner', made.id).name, 'New one');
  assert.equal(read(made.db, 'res.partner', made.id).name, 'New one');
  assert.equal(read(made.db, 'res.partner', ids[1]).id, ids[1]);
  const gone = unlink(made.db, 'res.partner', [made.id]);
  assert.equal(read(gone, 'res.partner', made.id), undefined);
  assert.equal(read(gone, 'res.partner', made.id), undefined);
});

test('an array changed in place never returns a wrong or stale record', () => {
  const db = seed();
  const list = db.records['res.partner'];
  const [first] = list;
  read(db, 'res.partner', first.id);
  read(db, 'res.partner', first.id);
  const extra = { ...first, id: 777777, name: 'Pushed' };
  list.push(extra);
  assert.equal(read(db, 'res.partner', 777777).name, 'Pushed');
  list.reverse();
  assert.equal(read(db, 'res.partner', first.id).name, first.name);
  assert.equal(read(db, 'res.partner', 777777).name, 'Pushed');
});
