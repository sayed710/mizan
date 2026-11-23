import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { models, menusFor } from './models/index.js';
import { create, read, emptyDb } from './orm.js';
import { diffDb, applyDiff } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { findAnalyticDistribution } from './models/analytic-distribution-models.js';

test('CAT-1: res.partner.category model, menu, partner tag_ids many2many, complete_name, inverse partner_ids, cycle guard and migration', () => {
  // 1. Model definition checks
  const catModel = models['res.partner.category'];
  assert.ok(catModel, 'res.partner.category model must exist');
  assert.equal(catModel.fields.name.type, 'char');
  assert.equal(catModel.fields.name.required, true);
  assert.equal(catModel.fields.color.type, 'integer');
  assert.equal(catModel.fields.parent_id.type, 'many2one');
  assert.equal(catModel.fields.parent_id.relation, 'res.partner.category');
  assert.equal(catModel.fields.active.type, 'boolean');
  assert.equal(catModel.fields.complete_name.type, 'char');
  assert.equal(typeof catModel.fields.complete_name.compute, 'function');
  assert.equal(catModel.fields.partner_ids.type, 'many2many');
  assert.equal(catModel.fields.partner_ids.relation, 'res.partner');
  assert.equal(typeof catModel.fields.partner_ids.compute, 'function');

  // 2. Partner tag_ids field is many2many to res.partner.category
  const partnerModel = models['res.partner'];
  assert.equal(partnerModel.fields.tag_ids.type, 'many2many');
  assert.equal(partnerModel.fields.tag_ids.relation, 'res.partner.category');

  // 3. Menu Contacts > Configuration > Tags
  const contactsMenus = menusFor('contacts');
  const configMenu = contactsMenus.find((m) => m.label === 'Configuration');
  assert.ok(configMenu, 'Contacts app must have a Configuration menu');
  const tagsLeaf = configMenu.children?.find((c) => c.label === 'Tags');
  assert.ok(tagsLeaf, 'Contacts > Configuration must have a Tags item');
  assert.equal(tagsLeaf.model, 'res.partner.category');

  // 4. Record creation and complete_name computation "Parent / Child"
  let db = emptyDb();
  const parentRes = create(db, 'res.partner.category', { name: 'Services', color: 1 });
  db = parentRes.db;
  const childRes = create(db, 'res.partner.category', { name: 'Consulting', parent_id: parentRes.id, color: 2 });
  db = childRes.db;
  const grandChildRes = create(db, 'res.partner.category', { name: 'IT Strategy', parent_id: childRes.id, color: 3 });
  db = grandChildRes.db;

  const parent = read(db, 'res.partner.category', parentRes.id);
  const child = read(db, 'res.partner.category', childRes.id);
  const grandChild = read(db, 'res.partner.category', grandChildRes.id);

  assert.equal(parent.complete_name, 'Services');
  assert.equal(child.complete_name, 'Services / Consulting');
  assert.equal(grandChild.complete_name, 'Services / Consulting / IT Strategy');
  assert.equal(parent.active, true);

  // 5. partner_ids inverse
  const partnerRes1 = create(db, 'res.partner', { name: 'ACME Corp', tag_ids: [child.id] });
  db = partnerRes1.db;
  const partnerRes2 = create(db, 'res.partner', { name: 'Global Tech', tag_ids: [child.id, grandChild.id] });
  db = partnerRes2.db;

  const childAfter = read(db, 'res.partner.category', child.id);
  const grandChildAfter = read(db, 'res.partner.category', grandChild.id);
  assert.deepEqual(childAfter.partner_ids.sort(), [partnerRes1.id, partnerRes2.id].sort());
  assert.deepEqual(grandChildAfter.partner_ids, [partnerRes2.id]);

  // 6. Guards diff-verifiable via diffDb + applyDiff (cycle detection)
  const baseDb = db;
  const forgedCycleDb = {
    ...baseDb,
    records: {
      ...baseDb.records,
      'res.partner.category': baseDb.records['res.partner.category'].map((c) =>
        c.id === parent.id ? { ...c, parent_id: grandChild.id } : c,
      ),
    },
  };
  const diff = diffDb(baseDb, forgedCycleDb);
  assert.throws(
    () => applyDiff(baseDb, diff),
    /Category hierarchy cannot contain a cycle/,
    'Cycle in partner category hierarchy must be rejected by applyDiff',
  );

  // 7. Migration 67: migrates existing free-text tag_ids into category records
  const legacyDb = {
    schema_version: 66,
    records: {
      'res.partner': [
        { id: 101, name: 'Client A', tag_ids: ['VIP', 'Wholesale'] },
        { id: 102, name: 'Client B', tag_ids: ['VIP', 'Retail'] },
        { id: 103, name: 'Client C', tag_ids: [] },
      ],
      'res.partner.category': [],
    },
    seq: { 'res.partner': 103 },
  };

  const migrated = migrate(legacyDb, SCHEMA_VERSION);
  assert.equal(migrated.schema_version, 68);
  const cats = migrated.records['res.partner.category'];
  assert.ok(cats.length >= 3, 'Must create res.partner.category records for VIP, Wholesale, Retail');
  const vipCat = cats.find((c) => c.name === 'VIP');
  const wholesaleCat = cats.find((c) => c.name === 'Wholesale');
  const retailCat = cats.find((c) => c.name === 'Retail');
  assert.ok(vipCat && wholesaleCat && retailCat);
  assert.equal(vipCat.active, true);

  const clientA = migrated.records['res.partner'].find((p) => p.id === 101);
  const clientB = migrated.records['res.partner'].find((p) => p.id === 102);
  const clientC = migrated.records['res.partner'].find((p) => p.id === 103);
  assert.deepEqual(clientA.tag_ids, [vipCat.id, wholesaleCat.id]);
  assert.deepEqual(clientB.tag_ids, [vipCat.id, retailCat.id]);
  assert.deepEqual(clientC.tag_ids, []);
  assert.ok(migrated.seq['res.partner.category'] >= Math.max(vipCat.id, wholesaleCat.id, retailCat.id));
});

test('CAT-2: account.analytic.distribution.model partner_category_id many2one and matching logic in findAnalyticDistribution', () => {
  // 1. Model field check
  const distDef = models['account.analytic.distribution.model'];
  assert.equal(distDef.fields.partner_category_id.type, 'many2one');
  assert.equal(distDef.fields.partner_category_id.relation, 'res.partner.category');

  // 2. findAnalyticDistribution matching against partner categories
  let db = emptyDb();
  const catRes = create(db, 'res.partner.category', { name: 'Enterprise' });
  db = catRes.db;
  const otherCatRes = create(db, 'res.partner.category', { name: 'SMB' });
  db = otherCatRes.db;

  const partnerTagged = create(db, 'res.partner', { name: 'BigCorp', tag_ids: [catRes.id] });
  db = partnerTagged.db;
  const partnerUntagged = create(db, 'res.partner', { name: 'SmallCo', tag_ids: [] });
  db = partnerUntagged.db;

  // Partner with legacy fallbacks (partner_category_id / category_id properties on the record)
  const partnerWithLegacyFallbacks = create(db, 'res.partner', {
    name: 'LegacyFallbackPartner',
    tag_ids: [],
  });
  db = {
    ...partnerWithLegacyFallbacks.db,
    records: {
      ...partnerWithLegacyFallbacks.db.records,
      'res.partner': partnerWithLegacyFallbacks.db.records['res.partner'].map((p) =>
        p.id === partnerWithLegacyFallbacks.id
          ? { ...p, partner_category_id: catRes.id, category_id: catRes.id }
          : p,
      ),
    },
  };

  const analyticAccRes = create(db, 'account.analytic.account', { name: 'Test Analytic' });
  db = analyticAccRes.db;
  const modelDist = { [analyticAccRes.id]: 100 };
  const distModel = create(db, 'account.analytic.distribution.model', {
    partner_category_id: catRes.id,
    analytic_distribution: modelDist,
    sequence: 10,
  });
  db = distModel.db;

  // Matching: partner with tag_ids containing the category matches
  const matchTagged = findAnalyticDistribution(db, { partner_id: partnerTagged.id, company_id: 1 });
  assert.deepEqual(matchTagged, modelDist);

  // Non-matching: partner without the category does not match
  const matchUntagged = findAnalyticDistribution(db, { partner_id: partnerUntagged.id, company_id: 1 });
  assert.deepEqual(matchUntagged, {});

  // Odoo parity: partner with partner_category_id / category_id fallbacks on the partner record does NOT match
  const matchFallback = findAnalyticDistribution(db, { partner_id: partnerWithLegacyFallbacks.id, company_id: 1 });
  assert.deepEqual(
    matchFallback,
    {},
    'partner.partner_category_id and partner.category_id fallbacks must not be used',
  );
});
