import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { seed } from './seed.js';
import { applyDiff } from './sync.js';
import { cleanRecord } from './validate.js';
import { search } from './orm.js';
import { migrate, MIGRATIONS, SCHEMA_VERSION } from './migrations.js';
import { openStorage } from '../server/storage.js';

test('migration versions are strictly increasing', () => {
  MIGRATIONS.forEach((m, i) => assert.equal(m.version, i + 1, m.name));
});

test('the shipped seed is current and every seeded record can be saved again unchanged', () => {
  const db = seed();
  assert.equal(db.schema_version, SCHEMA_VERSION);
  assert.equal(migrate(db), db);
  for (const [model, recs] of Object.entries(db.records)) {
    for (const r of recs) {
      assert.doesNotThrow(() => applyDiff(db, { upserts: { [model]: [r] } }, { isAdmin: true }), `${model} ${r.id}`);
      assert.deepEqual(Object.keys(r).filter((k) => !(k in cleanRecord(model, r))), [], `${model} ${r.id} loses fields on save`);
    }
  }
});

/** A database as an older version stored it: no schema_version, tag names, appointment hours and date + time. */
function legacyDb() {
  const db = seed();
  const { schema_version, ...old } = db;
  const tagged = old.records['documents.document'].map((d, i) => ({ ...d, tag_ids: i === 0 ? ['Tax', 'Archive'] : [] }));
  const type = old.records['appointment.type'][0];
  return {
    ...old,
    records: {
      ...old.records,
      'documents.document': tagged,
      'appointment.type': [{ ...type, duration: 1.5, user_id: 2, staff_ids: undefined }, ...old.records['appointment.type'].slice(1)],
      'appointment.booking': [{ id: 1, type_id: type.id, name: 'Old booking', date: '2026-01-05', time: '10:00', state: 'done' }],
    },
  };
}

test('older data is migrated once, then saves cleanly', () => {
  const old = legacyDb();
  const db = migrate(old);
  assert.equal(db.schema_version, SCHEMA_VERSION);
  assert.equal(migrate(db), db, 'a migrated database is left alone');

  const doc = db.records['documents.document'][0];
  const tagName = (line) => search(db, 'documents.tag').find((t) => t.id === line.tag_id)?.name;
  assert.deepEqual(doc.tag_ids.map(tagName), ['Tax', 'Archive']);
  assert.equal(search(db, 'documents.tag').filter((t) => t.name === 'Tax').length, 1, 'existing tags are reused');
  assert.doesNotThrow(() => applyDiff(db, { upserts: { 'documents.document': [doc] } }));

  const type = db.records['appointment.type'][0];
  assert.equal(type.duration, 90);
  assert.deepEqual(type.staff_ids, [{ employee_id: 2 }]);
  const booking = db.records['appointment.booking'][0];
  assert.equal(booking.start, '2026-01-05T10:00');
  assert.equal(booking.state, 'attended');
});

test('a database from a newer version is refused instead of being silently downgraded', () => {
  assert.throws(() => migrate({ ...seed(), schema_version: SCHEMA_VERSION + 1 }), /newer/);
});

test('legacy blank document tags are omitted without losing named tags', () => {
  const old = legacyDb();
  old.records['documents.document'][0].tag_ids = ['', '   ', 'Tax'];
  const db = migrate(old);
  const lines = db.records['documents.document'][0].tag_ids;
  assert.equal(lines.length, 1);
  assert.equal(search(db, 'documents.tag').find((t) => t.id === lines[0].tag_id).name, 'Tax');
});

test('legacy names reuse archived document tags', () => {
  const old = legacyDb();
  const tag = old.records['documents.tag'].find((t) => t.name === 'Tax');
  tag.active = false;
  old.records['sign.template'] = [{ id: 900, name: 'Legacy template', tag_ids: ['Tax'] }];
  const db = migrate(old);
  assert.equal(db.records['documents.document'][0].tag_ids[0].tag_id, tag.id);
  assert.equal(db.records['documents.tag'].filter((t) => t.name === 'Tax').length, 1);
  assert.equal(db.records['sign.template'][0].tag_ids[0].tag_id, tag.id);
});

test('the migrated data and its version are persisted', () => {
  const storage = openStorage(new DatabaseSync(':memory:'));
  const old = legacyDb();
  storage.save(null, old);
  const loaded = storage.load();
  assert.equal(loaded.schema_version, undefined);
  const db = migrate(loaded);
  storage.save(loaded, db);
  const again = storage.load();
  assert.equal(again.schema_version, SCHEMA_VERSION);
  assert.equal(migrate(again), again, 'nothing left to run after a restart');
  assert.deepEqual(again.records['documents.document'][0].tag_ids, db.records['documents.document'][0].tag_ids);
});
