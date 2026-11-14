import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { postMove } from './models/accounting.js';
import { shouldBePaid } from './models/billcontrol.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { applyDiff } from './sync.js';

test('enabling three_way_matching in company A does not affect company B', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { three_way_matching: true });

  const compB = createCompany(db, { name: 'Company B' });
  db = compB.db;
  const compBId = compB.id;

  const vendor = search(db, 'res.partner')[0];
  const prod = search(db, 'product').find((p) => p.type === 'goods') ?? search(db, 'product')[0];
  db = write(db, 'product', prod.id, { purchase_method: 'receive', type: 'goods' });

  // Company A order and bill
  const poA = create(db, 'purchase.order', {
    company_id: 1,
    partner_id: vendor.id,
    state: 'purchase',
    order_line: [{ product_id: prod.id, qty: 10, qty_delivered: 2, price_unit: 50 }],
  });
  db = poA.db;

  const expenseAccount = search(db, 'account.account').find((a) => a.code === '600000');
  const billJournalA = search(db, 'account.journal').find((j) => j.type === 'purchase' && (j.company_id === 1 || !j.company_id));

  const billA = create(db, 'account.move', {
    company_id: 1,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: poA.id,
    journal_id: billJournalA.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: prod.id, qty: 10, price_unit: 50, account_id: expenseAccount.id }],
  });
  db = postMove(billA.db, billA.id);

  assert.equal(shouldBePaid(db, read(db, 'account.move', billA.id)), 'exception');

  // Company B order and bill
  const billJournalB = search(db, 'account.journal').find((j) => j.type === 'purchase' && (j.company_id === compBId || !j.company_id));
  const expenseAccountB = search(db, 'account.account').find((a) => a.code === '600000' && (a.company_id === compBId || !a.company_id)) ?? expenseAccount;

  const poB = create(db, 'purchase.order', {
    company_id: compBId,
    partner_id: vendor.id,
    state: 'purchase',
    order_line: [{ product_id: prod.id, qty: 10, qty_delivered: 2, price_unit: 50 }],
  });
  db = poB.db;

  const billB = create(db, 'account.move', {
    company_id: compBId,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: poB.id,
    journal_id: billJournalB.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: prod.id, qty: 10, price_unit: 50, account_id: expenseAccountB.id }],
  });
  db = postMove(billB.db, billB.id);

  assert.equal(shouldBePaid(db, read(db, 'account.move', billB.id)), 'yes');
});

test('enabling audit_trail in company A does not affect company B', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { audit_trail: true });

  const compB = createCompany(db, { name: 'Company B' });
  db = compB.db;
  const compBId = compB.id;

  const partner = search(db, 'res.partner')[0];
  const saleJournalA = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id === 1 || !j.company_id));
  const incomeAccountA = search(db, 'account.account').find((a) => a.code === '400000' && (a.company_id === 1 || !a.company_id));

  // Company A: move with audit trail
  const invA = create(db, 'account.move', {
    company_id: 1,
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJournalA.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ name: 'Service A', qty: 1, price_unit: 100, account_id: incomeAccountA.id }],
  });
  db = postMove(invA.db, invA.id);
  const postedA = read(db, 'account.move', invA.id);

  // In company A, renaming posted entry fails under audit trail
  assert.throws(() => {
    write(db, 'account.move', postedA.id, { name: 'INV/2026/FORGED' });
  }, /audit trail/i);

  // In company A, numbered entry cannot be deleted
  assert.throws(() => {
    unlink(db, 'account.move', [postedA.id]);
  }, /audit trail/i);

  // In company A, field changes record tracking message
  const updatedA = write(db, 'account.move', postedA.id, { ref: 'REF-A-99' });
  assert.ok(updatedA.messages.some((m) => m.model === 'account.move' && m.res_id === postedA.id && m.body.includes('REF-A-99')));

  // Company B: move without audit trail
  const saleJournalB = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id === compBId || !j.company_id));
  const incomeAccountB = search(db, 'account.account').find((a) => a.code === '400000' && (a.company_id === compBId || !a.company_id)) ?? incomeAccountA;

  const invB = create(db, 'account.move', {
    company_id: compBId,
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJournalB.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ name: 'Service B', qty: 1, price_unit: 100, account_id: incomeAccountB.id }],
  });
  db = postMove(invB.db, invB.id);
  const postedB = read(db, 'account.move', invB.id);

  // Reset to draft in company B
  const draftB = write(db, 'account.move', postedB.id, { state: 'draft' });
  // In company B, numbered draft/cancelled entry CAN be deleted because audit_trail is not active for company B
  assert.doesNotThrow(() => {
    unlink(draftB, 'account.move', [postedB.id]);
  });
});

test('audit trail is irreversible per company via res.company guard', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { audit_trail: true });
  assert.equal(read(db, 'res.company', 1).audit_trail, true);

  // Disabling via write throws
  assert.throws(() => {
    write(db, 'res.company', 1, { audit_trail: false });
  }, /audit trail cannot be disabled/i);

  assert.throws(() => {
    write(db, 'res.company', 1, { audit_trail: null });
  }, /audit trail cannot be disabled/i);

  // Disabling via applyDiff throws
  assert.throws(() => {
    applyDiff(db, { upserts: { 'res.company': [{ id: 1, name: read(db, 'res.company', 1).name, audit_trail: false }] } });
  }, /audit trail cannot be disabled/i);

  // Modifying other fields on company succeeds
  assert.doesNotThrow(() => {
    write(db, 'res.company', 1, { name: 'Mizan Co Renamed' });
  });

  // Company B can enable audit trail independently and then cannot disable it
  const compB = createCompany(db, { name: 'Company B' });
  db = compB.db;
  assert.equal(read(db, 'res.company', compB.id).audit_trail ?? false, false);

  db = write(db, 'res.company', compB.id, { audit_trail: true });
  assert.equal(read(db, 'res.company', compB.id).audit_trail, true);

  assert.throws(() => {
    write(db, 'res.company', compB.id, { audit_trail: false });
  }, /audit trail cannot be disabled/i);
});

test('migration 27 copies global three_way_matching and audit_trail to all companies and deletes settings keys', () => {
  let db = seed();
  const compB = createCompany(db, { name: 'Company B' });
  db = compB.db;
  const compBId = compB.id;

  const legacyDb = {
    ...db,
    schema_version: 26,
    settings: {
      ...db.settings,
      three_way_matching: true,
      audit_trail: true,
    },
  };

  assert.equal(read(legacyDb, 'res.company', 1).three_way_matching ?? null, null);
  assert.equal(read(legacyDb, 'res.company', 1).audit_trail ?? null, null);
  assert.equal(read(legacyDb, 'res.company', compBId).three_way_matching ?? null, null);
  assert.equal(read(legacyDb, 'res.company', compBId).audit_trail ?? null, null);

  const migrated = migrate(legacyDb);
  assert.equal(SCHEMA_VERSION, 51);
  assert.equal(migrated.schema_version, 51);

  // Keys deleted from settings
  assert.equal('three_way_matching' in migrated.settings, false);
  assert.equal('audit_trail' in migrated.settings, false);

  // Values copied to every company
  assert.equal(read(migrated, 'res.company', 1).three_way_matching, true);
  assert.equal(read(migrated, 'res.company', 1).audit_trail, true);
  assert.equal(read(migrated, 'res.company', compBId).three_way_matching, true);
  assert.equal(read(migrated, 'res.company', compBId).audit_trail, true);
});
