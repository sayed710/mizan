import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read, undeclaredFields, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { migrateDocumentTags } from './models/signplus.js';
import { cleanRecord } from './validate.js';
import { applyDiff, diffDb } from './sync.js';

// What the server stores after a client change: the same diff the client would send.
const synced = (db, next) => applyDiff(db, diffDb(db, next));

test('every seeded record passes the server sanitizer with nothing stripped', () => {
  const db = seed();
  for (const [model, records] of Object.entries(db.records)) {
    for (const r of records) {
      assert.deepEqual(undeclaredFields(model, r), [], `${model} #${r.id}`);
      assert.doesNotThrow(() => cleanRecord(model, r), `${model} #${r.id}`);
    }
  }
});

test('workflow fields survive a sync: closing entries, POS costs, rented stock, used gift cards', () => {
  const db = seed();
  // Only fiscal closing may set this flag now; its persistence is also exercised by closing-sync.test.js.
  assert.equal(cleanRecord('account.move', { ...db.records['account.move'][0], is_closing: true }).is_closing, true);
  assert.throws(() => write(db, 'account.move', 1, { is_closing: true }), /closing/);
  const cases = [

    ['pos.order', 1, { stock_costs: [{ index: 0, unit_cost: 12.5 }] }],
    ['product', 1, { qty_rented: 2 }],
    ['sale.order', 1, { loyalty_uses: [{ programId: 1, cardCode: 'GIFT-1', gift: true, spent: 50 }] }],
  ];
  for (const [model, id, vals] of cases) {
    const stored = read(synced(db, write(db, model, id, vals)), model, id);
    for (const [key, value] of Object.entries(vals)) assert.deepEqual(stored[key], value, `${model}.${key}`);
  }
});

test('structured values are plain JSON of bounded size', () => {
  const db = seed();
  assert.throws(() => synced(db, write(db, 'pos.order', 1, { stock_costs: 'not json' })), /Invalid value for pos.order.stock_costs/);
  assert.throws(() => synced(db, write(db, 'pos.order', 1, { stock_costs: [{ blob: 'x'.repeat(200000) }] })), /Invalid value/);
});

test('structured values that JSON would silently alter are refused', () => {
  const db = seed();
  for (const stock_costs of [[{ a: NaN }], [{ a: undefined }], [{ a: [Infinity] }], [{ a: () => 1 }], [{ a: new Date() }]]) {
    assert.throws(() => synced(db, write(db, 'pos.order', 1, { stock_costs })), /Invalid value/);
  }
  assert.doesNotThrow(() => synced(db, write(db, 'pos.order', 1, { stock_costs: [{ a: 1, b: ['x', null, true], c: { d: 2.5 } }] })));
});

test('document tag names follow the referenced tag record', () => {
  const db = seed();
  const [first] = db.records['documents.document'];
  const tag = db.records['documents.tag'][0];
  const doc = { ...first, tag_ids: [{ tag_id: tag.id }] };
  const withDoc = { ...db, records: { ...db.records, 'documents.document': [doc, ...db.records['documents.document'].slice(1)] } };
  assert.deepEqual(read(withDoc, 'documents.document', doc.id).legacy_tags, [tag.name]);
  const renamed = { ...withDoc, records: { ...withDoc.records, 'documents.tag': withDoc.records['documents.tag'].map((t) => (t.id === tag.id ? { ...t, name: 'Renamed' } : t)) } };
  assert.deepEqual(read(renamed, 'documents.document', doc.id).legacy_tags, ['Renamed']);
});

test('text document tags from older data become tag lines the server accepts', () => {
  const db = seed();
  const old = { ...db, records: { ...db.records, 'documents.document': db.records['documents.document'].map((d, i) => (i === 0 ? { ...d, tag_ids: ['Tax', 'Archive'] } : d)) } };
  const migrated = migrateDocumentTags(old);
  const [first] = migrated.records['documents.document'];
  const tagName = (t) => read(migrated, 'documents.tag', t.tag_id).name;
  assert.deepEqual(first.tag_ids.map(tagName), ['Tax', 'Archive']);
  assert.equal(migrated.records['documents.tag'].filter((t) => t.name === 'Tax').length, 1); // reuses the existing tag
  assert.doesNotThrow(() => cleanRecord('documents.document', first));
  assert.deepEqual(read(migrated, 'documents.document', first.id).legacy_tags, ['Tax', 'Archive']);
  assert.equal(migrateDocumentTags(migrated), migrated);
});

test('the declared workflow fields are hidden from forms and graphs', () => {
  for (const [model, field] of [['account.move', 'is_closing'], ['product', 'qty_rented'], ['sale.order', 'loyalty_uses']]) {
    assert.equal(models[model].fields[field].hidden, true, `${model}.${field}`);
  }
});
