import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, unlink, write } from './orm.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { applyDiff, diffDb } from './sync.js';
import { generateSepaFile } from './models/payments.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

test('BNK3-1: res.bank model, bank_id on partner bank form, diff-verifiable guards, SEPA BIC resolution, and exact name+BIC migration', async () => {
  const bankDef = models['res.bank'];
  assert.ok(bankDef, 'res.bank model is registered');
  for (const field of ['name', 'bic', 'street', 'city', 'country', 'email', 'phone']) {
    assert.ok(bankDef.fields[field], `res.bank declares ${field}`);
  }
  const pbDef = models['res.partner.bank'];
  assert.equal(pbDef.fields.bank_id?.type, 'many2one');
  assert.equal(pbDef.fields.bank_id?.relation, 'res.bank');

  // Form shows bank_id instead of free-text bank name/BIC
  const flatFormFields = pbDef.form.groups.flat();
  assert.ok(flatFormFields.includes('bank_id'), 'partner bank form includes bank_id');
  assert.equal(flatFormFields.includes('bank_bic'), false, 'partner bank form hides free-text bank_bic');
  assert.equal(flatFormFields.includes('bank_name'), false, 'partner bank form hides free-text bank_name');
  assert.equal(pbDef.form.tabs.some((tab) => tab.label === 'Bank Information'), false, 'free-text Bank Information tab removed');

  // Create res.bank and link via bank_id through diffDb + applyDiff
  let db = seed();
  assert.ok(search(db, 'res.bank').length >= 2, 'seed includes sample res.bank records');
  const partner = search(db, 'res.partner')[0];
  const createdBank = create(db, 'res.bank', {
    name: 'Commerzbank',
    bic: 'COBADEFFXXX',
    street: 'Kaiserplatz 1',
    city: 'Frankfurt',
    country: 'Germany',
    email: 'info@commerzbank.example',
    phone: '+49 69 13620',
  });
  db = applyDiff(db, diffDb(db, createdBank.db), { isAdmin: true });
  const bankRec = read(db, 'res.bank', createdBank.id);
  assert.equal(bankRec.name, 'Commerzbank');
  assert.equal(bankRec.bic, 'COBADEFFXXX');
  assert.equal(bankRec.street, 'Kaiserplatz 1');
  assert.equal(bankRec.city, 'Frankfurt');
  assert.equal(bankRec.country, 'Germany');
  assert.equal(bankRec.email, 'info@commerzbank.example');
  assert.equal(bankRec.phone, '+49 69 13620');
  assert.equal(bankRec.display_name, 'Commerzbank - COBADEFFXXX');

  // Guards on res.bank and dangling bank_id are diff-verifiable
  const badNameDiff = diffDb(db, {
    ...db,
    records: { ...db.records, 'res.bank': [...db.records['res.bank'], { id: createdBank.id + 1, name: '   ', bic: 'DEUTDEFF' }] },
  });
  assert.throws(() => applyDiff(db, badNameDiff, { isAdmin: true }), /Bank name is required/);

  const badBicDiff = diffDb(db, {
    ...db,
    records: { ...db.records, 'res.bank': [...db.records['res.bank'], { id: createdBank.id + 1, name: 'Bad BIC Bank', bic: 'BAD' }] },
  });
  assert.throws(() => applyDiff(db, badBicDiff, { isAdmin: true }), /8 or 11 alphanumeric/);

  const linked = create(db, 'res.partner.bank', {
    partner_id: partner.id,
    account_number: 'DE89370400440532013000',
    bank_id: createdBank.id,
    allow_out_payment: true,
  });
  db = applyDiff(db, diffDb(db, linked.db), { isAdmin: true });
  assert.equal(read(db, 'res.partner.bank', linked.id).bank_id, createdBank.id);

  // Dangling bank_id rejected via diff
  const danglingDiff = diffDb(db, {
    ...db,
    records: {
      ...db.records,
      'res.partner.bank': [...db.records['res.partner.bank'], { id: linked.id + 1, partner_id: partner.id, account_number: 'DE111', bank_id: 999999 }],
    },
  });
  assert.throws(() => applyDiff(db, danglingDiff, { isAdmin: true }), /Select an existing bank|does not exist/);

  // Referenced res.bank cannot be unlinked directly or via diff
  assert.throws(() => unlink(db, 'res.bank', [createdBank.id]), /still used/i);
  const deleteBankDiff = diffDb(db, {
    ...db,
    records: { ...db.records, 'res.bank': db.records['res.bank'].filter((b) => b.id !== createdBank.id) },
  });
  assert.throws(() => applyDiff(db, deleteBankDiff, { isAdmin: true }), /still used/i);

  // SEPA XML uses BIC from linked res.bank record
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  db = write(db, 'account.journal', bankJournal.id, {
    outbound_payment_method_line_ids: [
      ...read(db, 'account.journal', bankJournal.id).outbound_payment_method_line_ids,
      { name: sepa.name, payment_method_id: sepa.id },
    ],
  });
  const methodLine = db.records['account.payment.method.line'].find((l) => l.journal_id === bankJournal.id && l.payment_method_id === sepa.id);
  const recipientBank = create(db, 'res.partner.bank', { partner_id: partner.id, account_number: 'FR7630006000011234567890189', allow_out_payment: true });
  const sepaDb = {
    ...recipientBank.db,
    records: {
      ...recipientBank.db.records,
      'res.company': recipientBank.db.records['res.company'].map((c) => (c.id === 1 ? { ...c, currency_id: eur.id } : c)),
      'account.journal': recipientBank.db.records['account.journal'].map((j) => (j.id === bankJournal.id ? { ...j, bank_account_id: linked.id, currency_id: eur.id } : j)),
      'account.payment': [...(recipientBank.db.records['account.payment'] ?? []), { id: 901, payment_method_line_id: methodLine.id, partner_id: partner.id, partner_bank_id: recipientBank.id, amount: 25, memo: 'BNK3 SEPA', currency_id: eur.id }],
    },
  };
  const xml = generateSepaFile(sepaDb, { id: 901, name: 'BATCH-BNK3', date: '2026-11-22', journal_id: bankJournal.id, company_id: 1, lines: [{ payment_id: 901 }] }).content;
  assert.match(xml, /<BICFI>COBADEFFXXX<\/BICFI>/);

  // Partner bank FormView renders bank_id selector and omits free-text bank_name/bank_bic inputs
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() };
  setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  await commit(db);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const leaf = menusFor('accounting').find((m) => m.label === 'Configuration').children.find((m) => m.label === 'Accounting').children.find((m) => m.key === 'bank-accounts');
  try {
    await React.act(async () => root.render(React.createElement(FormView, { leaf, id: linked.id, base: '#/accounting/bank-accounts', params: new URLSearchParams() })));
    const bankSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-bank_id');
    assert.ok(bankSelect, 'FormView renders f-bank_id select');
    assert.ok(bankSelect.textContent.includes('Commerzbank - COBADEFFXXX'));
    assert.equal(find(host, (n) => props(n)?.id === 'f-bank_name'), null);
    assert.equal(find(host, (n) => props(n)?.id === 'f-bank_bic'), null);
  } finally {
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }

  // Migration creates banks from distinct exact name+BIC pairs and stays idempotent
  const legacy = {
    schema_version: SCHEMA_VERSION - 1,
    seq: { 'res.partner.bank': 5 },
    messages: [],
    records: {
      'res.partner': [{ id: 1, name: 'Vendor A' }],
      'res.partner.bank': [
        { id: 1, partner_id: 1, account_number: 'A1', bank_name: 'Alpha Bank', bank_bic: 'ALPHAEGCX', city: 'Cairo', country: 'Egypt' },
        { id: 2, partner_id: 1, account_number: 'A2', bank_name: 'Alpha Bank', bank_bic: 'ALPHAEGCX' },
        { id: 3, partner_id: 1, account_number: 'A3', bank_name: 'Alpha Bank', bank_bic: 'alphaegcx' },
        { id: 4, partner_id: 1, account_number: 'A4', bank_name: 'Alpha Bank', bank_bic: '' },
        { id: 5, partner_id: 1, account_number: 'A5', bank_name: '', bank_bic: 'ONLYBIC1' },
      ],
    },
  };
  const migrated = migrate(legacy);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.equal(migrated.records['res.bank'].length, 3, 'creates one bank per distinct exact (name, bic) pair');
  const pb1 = read(migrated, 'res.partner.bank', 1);
  const pb2 = read(migrated, 'res.partner.bank', 2);
  const pb3 = read(migrated, 'res.partner.bank', 3);
  const pb4 = read(migrated, 'res.partner.bank', 4);
  const pb5 = read(migrated, 'res.partner.bank', 5);
  assert.equal(pb1.bank_id, pb2.bank_id, 'identical exact name+BIC pairs share one bank record');
  assert.notEqual(pb1.bank_id, pb3.bank_id, 'exact BIC casing differentiates banks');
  assert.notEqual(pb1.bank_id, pb4.bank_id, 'empty BIC is distinct from non-empty BIC');
  assert.equal(pb5.bank_id ?? null, null, 'blank bank name does not invent a bank record');
  assert.equal(read(migrated, 'res.bank', pb1.bank_id).city, 'Cairo');
  assert.equal(migrated.seq['res.bank'], 3);
  assert.equal(migrate(migrated), migrated, 'migration is idempotent');
});

test('BNK3-2: sanitized_account_number sanitization and (sanitized_account_number, partner_id) uniqueness are diff-verifiable', () => {
  let db = seed();
  const [p1, p2] = search(db, 'res.partner');

  const acc = create(db, 'res.partner.bank', {
    partner_id: p1.id,
    account_number: 'eg-12 34.56/78',
  });
  db = applyDiff(db, diffDb(db, acc.db), { isAdmin: true });
  const saved = read(db, 'res.partner.bank', acc.id);
  assert.equal(saved.account_number, 'eg-12 34.56/78');
  assert.equal(saved.sanitized_account_number, 'EG12345678');

  // Same partner, equivalent account after stripping punctuation/whitespace & uppercasing -> rejected through diffDb + applyDiff
  const dupId = (db.seq['res.partner.bank'] ?? 0) + 1;
  const samePartnerDupDiff = diffDb(db, {
    ...db,
    records: {
      ...db.records,
      'res.partner.bank': [
        ...db.records['res.partner.bank'],
        { id: dupId, partner_id: p1.id, account_number: 'EG 12-34 5678', sanitized_account_number: 'FORGEDDIFFERENT' },
      ],
    },
  });
  assert.throws(() => applyDiff(db, samePartnerDupDiff, { isAdmin: true }), /unique per partner/i);

  // Archived account still participates in (sanitized_account_number, partner_id) uniqueness via diff
  db = applyDiff(db, diffDb(db, write(db, 'res.partner.bank', acc.id, { active: false })), { isAdmin: true });
  const againstArchivedDiff = diffDb(db, {
    ...db,
    records: {
      ...db.records,
      'res.partner.bank': [...db.records['res.partner.bank'], { id: dupId, partner_id: p1.id, account_number: 'eg12345678' }],
    },
  });
  assert.throws(() => applyDiff(db, againstArchivedDiff, { isAdmin: true }), /unique per partner/i);

  // Different partner with the same sanitized_account_number succeeds through diffDb + applyDiff
  const otherPartnerAcc = create(db, 'res.partner.bank', {
    partner_id: p2.id,
    account_number: 'EG 12-34.56/78',
  });
  db = applyDiff(db, diffDb(db, otherPartnerAcc.db), { isAdmin: true });
  assert.equal(read(db, 'res.partner.bank', otherPartnerAcc.id).sanitized_account_number, 'EG12345678');

  // Reassigning partner_id to p1 via diffDb + applyDiff collides with p1's account and is rejected
  const moveOwnerDiff = diffDb(db, {
    ...db,
    records: {
      ...db.records,
      'res.partner.bank': db.records['res.partner.bank'].map((b) => (b.id === otherPartnerAcc.id ? { ...b, partner_id: p1.id } : b)),
    },
  });
  assert.throws(() => applyDiff(db, moveOwnerDiff, { isAdmin: true }), /unique per partner/i);
});
