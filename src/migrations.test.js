import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { seed } from './seed.js';
import { applyDiff } from './sync.js';
import { cleanRecord } from './validate.js';
import { create, search } from './orm.js';
import { mapTax } from './models/taxes.js';
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

test('legacy employees receive durable random referral tokens without changing employee identity', () => {
  const base = seed();
  const legacy = { ...base, schema_version: 3, records: { ...base.records, 'hr.employee': base.records['hr.employee'].map(({ referral_token, ...e }) => e) } };
  const migrated = migrate(legacy);
  for (const employee of migrated.records['hr.employee']) {
    assert.match(employee.referral_token, /^[0-9a-f]{32}$/);
    assert.equal(employee.name, legacy.records['hr.employee'].find((e) => e.id === employee.id).name);
  }
  assert.equal(new Set(migrated.records['hr.employee'].map((e) => e.referral_token)).size, migrated.records['hr.employee'].length);
  assert.equal(migrate(migrated), migrated);
  assert.equal(legacy.records['hr.employee'][0].referral_token, undefined);
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

test('migration 37 moves fiscal position tax_ids onto destination taxes and notes empty-destination removals', () => {
  const base = seed();
  const vatSale = base.records['account.tax'].find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const zeroExport = base.records['account.tax'].find((t) => t.name === '0% Exports');
  const stamp = base.records['account.tax'].find((t) => t.name === 'Stamp Duty');
  const exportFp = base.records['account.fiscal.position'].find((f) => f.name === 'Export');
  const legacy = {
    ...base,
    schema_version: 36,
    records: {
      ...base.records,
      'account.tax': base.records['account.tax'].map((t) => ({ ...t, fiscal_position_ids: [], original_tax_ids: [] })),
      'account.fiscal.position': base.records['account.fiscal.position'].map((fp) => (
        fp.id === exportFp.id
          ? {
              ...fp,
              tax_ids: [
                { tax_src_id: vatSale.id, tax_dest_id: zeroExport.id },
                { tax_src_id: stamp.id, tax_dest_id: null },
              ],
            }
          : { ...fp, tax_ids: [] }
      )),
    },
  };
  const beforeNotes = (legacy.messages ?? []).filter((m) => m.model === 'account.fiscal.position' && m.res_id === exportFp.id).length;
  const migrated = migrate(legacy);
  const migratedZero = migrated.records['account.tax'].find((t) => t.id === zeroExport.id);
  assert.deepEqual(migratedZero.fiscal_position_ids, [exportFp.id]);
  assert.deepEqual(migratedZero.original_tax_ids, [vatSale.id]);
  for (const fp of migrated.records['account.fiscal.position']) {
    assert.equal('tax_ids' in fp, false);
  }
  const removalNotes = (migrated.messages ?? []).filter(
    (m) => m.model === 'account.fiscal.position' && m.res_id === exportFp.id && m.body.includes('Stamp Duty'),
  );
  assert.equal(removalNotes.length, 1);
  assert.equal(
    (migrated.messages ?? []).filter((m) => m.model === 'account.fiscal.position' && m.res_id === exportFp.id).length - beforeNotes,
    1,
  );
});

test('migration 39 recovers removal rules from migration 37 notes for already-upgraded and legacy databases', () => {
  const base = seed();
  const stamp = base.records['account.tax'].find((t) => t.name === 'Stamp Duty');
  const exportFp = base.records['account.fiscal.position'].find((f) => f.name === 'Export');
  const domesticFp = base.records['account.fiscal.position'].find((f) => f.name === 'Domestic');

  // Case 1: database already at schema_version 38 (post-migration-37 chatter note)
  const post37 = {
    ...base,
    schema_version: 38,
    messages: [
      ...(base.messages ?? []),
      {
        id: 9001,
        model: 'account.fiscal.position',
        res_id: exportFp.id,
        kind: 'note',
        body: 'Upgrade: tax removal rule for "Stamp Duty" cannot be expressed in the new model; please redo it on the tax records.',
      },
    ],
  };
  const upgradedFrom38 = migrate(post37);
  assert.deepEqual(mapTax(upgradedFrom38, exportFp.id, stamp.id), []);
  assert.deepEqual(mapTax(upgradedFrom38, domesticFp.id, stamp.id), [stamp.id]);

  // Case 2: legacy schema_version 36 database with empty-destination tax_ids row
  const legacy36 = {
    ...base,
    schema_version: 36,
    records: {
      ...base.records,
      'account.tax': base.records['account.tax'].map((t) => ({ ...t, fiscal_position_ids: [], original_tax_ids: [] })),
      'account.fiscal.position': base.records['account.fiscal.position'].map((fp) => (
        fp.id === exportFp.id ? { ...fp, tax_ids: [{ tax_src_id: stamp.id, tax_dest_id: null }] } : { ...fp, tax_ids: [] }
      )),
    },
  };
  const upgradedFrom36 = migrate(legacy36);
  assert.deepEqual(mapTax(upgradedFrom36, exportFp.id, stamp.id), []);
  assert.deepEqual(mapTax(upgradedFrom36, domesticFp.id, stamp.id), [stamp.id]);
});

test('migration 39 keeps destination taxes usable directly when referenced by a product, company, or group', () => {
  let db = seed();
  const fpA = create(db, 'account.fiscal.position', { name: 'FP A' }); db = fpA.db;
  const fpB = create(db, 'account.fiscal.position', { name: 'FP B' }); db = fpB.db;
  const srcTax = create(db, 'account.tax', { name: 'Src 14%', type_tax_use: 'sale', amount: 14 }); db = srcTax.db;
  const destProdTax = create(db, 'account.tax', {
    name: 'Zero Prod Dest', type_tax_use: 'sale', amount: 0, fiscal_position_ids: [fpA.id], original_tax_ids: [srcTax.id],
  }); db = destProdTax.db;
  const destCompanyTax = create(db, 'account.tax', {
    name: 'Zero Company Dest', type_tax_use: 'sale', amount: 0, fiscal_position_ids: [fpA.id], original_tax_ids: [srcTax.id],
  }); db = destCompanyTax.db;
  const destChildTax = create(db, 'account.tax', {
    name: 'Zero Group Child Dest', type_tax_use: 'sale', amount: 0, fiscal_position_ids: [fpA.id], original_tax_ids: [srcTax.id],
  }); db = destChildTax.db;
  const groupTax = create(db, 'account.tax', {
    name: 'Composite Group', type_tax_use: 'sale', amount_type: 'group', children_tax_ids: [destChildTax.id],
  }); db = groupTax.db;
  const prod = create(db, 'product', { name: 'Direct Product', type: 'service', list_price: 100, tax_id: destProdTax.id }); db = prod.db;
  db = {
    ...db,
    schema_version: 38,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, account_sale_tax_id: destCompanyTax.id } : c)),
    },
  };

  const migrated = migrate(db);
  assert.deepEqual(mapTax(migrated, fpB.id, destProdTax.id), [destProdTax.id]);
  assert.deepEqual(mapTax(migrated, fpB.id, destCompanyTax.id), [destCompanyTax.id]);
  assert.deepEqual(mapTax(migrated, fpB.id, destChildTax.id), [destChildTax.id]);
  assert.ok(mapTax(migrated, fpA.id, srcTax.id).includes(destProdTax.id));
});

test('migration 39 separates cross-company position mappings sharing one destination tax', () => {
  let db = seed();
  const comp2 = create(db, 'res.company', { name: 'Second Co', currency_id: 1 }); db = comp2.db;
  const fpA = create(db, 'account.fiscal.position', { name: 'Co1 Pos', company_id: 1 }); db = fpA.db;
  const fpB = create(db, 'account.fiscal.position', { name: 'Co2 Pos', company_id: comp2.id }); db = fpB.db;
  const taxP = create(db, 'account.tax', { name: 'Co1 Source', type_tax_use: 'sale', amount: 14, company_id: 1 }); db = taxP.db;
  const taxQ = create(db, 'account.tax', { name: 'Co2 Source', type_tax_use: 'sale', amount: 10, company_id: comp2.id }); db = taxQ.db;
  const taxX = create(db, 'account.tax', {
    name: 'Shared Dest', type_tax_use: 'sale', amount: 0, company_id: null, fiscal_position_ids: [fpA.id, fpB.id], original_tax_ids: [taxP.id, taxQ.id],
  }); db = taxX.db;
  const post37 = { ...db, schema_version: 38 };

  const migrated = migrate(post37);
  assert.deepEqual(mapTax(migrated, fpA.id, taxP.id), [taxX.id]);
  assert.deepEqual(mapTax(migrated, fpA.id, taxQ.id), [taxQ.id]);
  assert.deepEqual(mapTax(migrated, fpB.id, taxQ.id), [taxX.id]);
  assert.deepEqual(mapTax(migrated, fpB.id, taxP.id), [taxP.id]);
});

test('migration 39 leaves a removal note for follow-up when its tax name matches several taxes', () => {
  const base = seed();
  const stamp = base.records['account.tax'].find((t) => t.name === 'Stamp Duty');
  const exportFp = base.records['account.fiscal.position'].find((f) => f.name === 'Export');
  const twin = { ...stamp, id: Math.max(...base.records['account.tax'].map((t) => t.id)) + 1 };
  const db = migrate({
    ...base,
    schema_version: 38,
    records: { ...base.records, 'account.tax': [...base.records['account.tax'], twin] },
    messages: [...(base.messages ?? []), { id: 9002, model: 'account.fiscal.position', res_id: exportFp.id, kind: 'note', body: 'Upgrade: tax removal rule for "Stamp Duty" cannot be expressed in the new model; please redo it on the tax records.' }],
  });
  assert.deepEqual(db.records['account.fiscal.position'].find((f) => f.id === exportFp.id).excluded_tax_ids, []);
  assert.deepEqual(mapTax(db, exportFp.id, stamp.id), [stamp.id]);
});
