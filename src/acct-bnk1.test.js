import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, matches, read, search, write } from './orm.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { seed } from './seed.js';
import { menusFor, models, viewsOf } from './models/index.js';
import { postMove } from './models/accounting.js';
import { partnerBankBic, partnerBankName } from './models/partnerbank.js';
import { invoiceQrPayload, invoiceQrSettingsForCompany } from './models/qr.js';
import { applyDiff, diffDb } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, cls) => typeof classOf(node) === 'string' && classOf(node).split(/\s+/).includes(cls);
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};

const findLeafByKey = (items, key) => {
  for (const item of items ?? []) {
    if (item.key === key) return item;
    if (item.children) {
      const found = findLeafByKey(item.children, key);
      if (found) return found;
    }
  }
  return null;
};

async function mountView(renderElement, initialDb = seed()) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.insertBefore = (child, before) => {
      const idx = before ? el.childNodes.indexOf(before) : -1;
      if (idx >= 0) el.childNodes.splice(idx, 0, child);
      else el.childNodes.push(child);
      child.parentNode = el;
      if (child.tagName === 'OPTION') el.options.push(child);
      return el;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(renderElement(React)));
  return {
    React,
    host,
    commit,
    getDb,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

test('BK-1: res.bank model fields, views, search by name and BIC, and Contacts/Accounting Configuration menus', async () => {
  const def = models['res.bank'];
  assert.ok(def, 'res.bank model is registered');
  assert.equal(def.label, 'Banks');
  assert.equal(def.fields.name?.required, true);
  assert.equal(def.fields.bic?.label, 'Bank Identifier Code');
  for (const field of ['name', 'bic', 'street', 'street2', 'zip', 'city', 'state', 'country', 'email', 'phone', 'active']) {
    assert.ok(def.fields[field], `res.bank has field ${field}`);
  }
  assert.deepEqual(viewsOf('res.bank'), ['list']);
  assert.ok(def.form, 'res.bank has form view');
  assert.deepEqual(def.searchFields, ['name', 'bic']);

  // Menus: Contacts > Configuration > Banks and Accounting > Configuration > Banks
  const contactsConfig = menusFor('contacts').find((m) => m.label === 'Configuration');
  assert.ok(contactsConfig, 'Contacts has Configuration menu');
  const contactsBanks = findLeafByKey(contactsConfig.children, 'banks');
  assert.equal(contactsBanks?.label, 'Banks');
  assert.equal(contactsBanks?.model, 'res.bank');

  const accountingConfig = menusFor('accounting').find((m) => m.label === 'Configuration');
  assert.ok(accountingConfig, 'Accounting has Configuration menu');
  const accountingBanks = findLeafByKey(accountingConfig.children, 'banks');
  assert.equal(accountingBanks?.label, 'Banks');
  assert.equal(accountingBanks?.model, 'res.bank');

  // CRUD + search
  let db = seed();
  const created = create(db, 'res.bank', {
    name: 'Deutsche Bank',
    bic: 'DEUTDEFF',
    street: 'Taunusanlage 12',
    street2: 'Floor 4',
    zip: '60325',
    city: 'Frankfurt',
    state: 'Hesse',
    country: 'Germany',
    email: 'info@db.example',
    phone: '+49 69 91000',
  });
  db = created.db;
  const bank = read(db, 'res.bank', created.id);
  assert.equal(bank.active, true);
  assert.equal(matches(db, 'res.bank', bank, ['Deutsche']), true);
  assert.equal(matches(db, 'res.bank', bank, ['DEUTDEFF']), true);
  assert.equal(matches(db, 'res.bank', bank, ['Frankfurt']), false, 'searchFields limits search to name and bic');

  // Required name checked in ORM and plain diff
  assert.throws(() => create(db, 'res.bank', { name: '   ' }), /Name is required/);
  const blankDiff = {
    upserts: { 'res.bank': [{ id: created.id + 1, name: '   ', active: true }] },
    deletes: {},
    created: { 'res.bank': [created.id + 1] },
    bases: {},
  };
  assert.throws(() => applyDiff(db, blankDiff, { isAdmin: true }), /Name is required/);

  // List and Form views render res.bank
  const { ActionView } = await import('./views/ActionView.jsx');
  const listCtx = await mountView(
    (React) => React.createElement(ActionView, { leaf: contactsBanks, base: '#/contacts/banks', params: new URLSearchParams() }),
    db,
  );
  try {
    const tbody = find(listCtx.host, (n) => n.tagName === 'TBODY');
    assert.ok(tbody.textContent.includes('Deutsche Bank'));
    assert.ok(tbody.textContent.includes('DEUTDEFF'));
  } finally {
    await listCtx.done();
  }

  const { FormView } = await import('./views/FormView.jsx');
  const formCtx = await mountView(
    (React) => React.createElement(FormView, { leaf: accountingBanks, id: created.id, base: '#/accounting/banks', params: new URLSearchParams() }),
    db,
  );
  try {
    const labelText = (f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim();
    const labels = allFind(formCtx.host, (n) => hasClass(n, 'field')).map(labelText);
    for (const expected of ['Bank Identifier Code', 'Street', 'Street 2', 'City', 'State', 'ZIP', 'Country', 'Email', 'Phone', 'Active']) {
      assert.ok(labels.includes(expected), `res.bank form renders ${expected}`);
    }
    const nameInput = find(formCtx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-name');
    assert.equal(props(nameInput).value, 'Deutsche Bank');
  } finally {
    await formCtx.done();
  }
});

test('BK-2: res.partner.bank links to res.bank via bank_id, uses bank as BIC/name source when set, preserves unlinked accounts, and feeds SEPA/QR', async () => {
  const bankDef = models['res.partner.bank'];
  assert.deepEqual(
    { type: bankDef.fields.bank_id?.type, relation: bankDef.fields.bank_id?.relation, label: bankDef.fields.bank_id?.label },
    { type: 'many2one', relation: 'res.bank', label: 'Bank' },
  );

  // No data migration / guessing creates banks from existing partner bank records
  let db = seed();
  assert.equal(search(db, 'res.bank').length, 0, 'seed does not guess or create res.bank records');
  const partner = search(db, 'res.partner')[0];
  const unlinked = create(db, 'res.partner.bank', {
    partner_id: partner.id,
    account_number: 'DE89370400440532013000',
    bank_name: 'Legacy Char Bank',
    bank_bic: 'COBADEFF',
  });
  db = unlinked.db;
  const migrated = migrate({ ...db, schema_version: SCHEMA_VERSION });
  assert.equal(search(migrated, 'res.bank').length, 0, 'migrate does not infer banks from existing records');
  const kept = read(migrated, 'res.partner.bank', unlinked.id);
  assert.equal(kept.bank_id ?? null, null);
  assert.equal(partnerBankName(migrated, kept), 'Legacy Char Bank');
  assert.equal(partnerBankBic(migrated, kept), 'COBADEFF');

  // Linking bank_id makes res.bank the source for BIC and bank name
  const dirBank = create(db, 'res.bank', { name: 'BNP Paribas', bic: 'BNPAFRPP' });
  db = dirBank.db;
  const linked = create(db, 'res.partner.bank', {
    partner_id: partner.id,
    account_number: 'FR7630006000011234567890189',
    bank_id: dirBank.id,
  });
  db = linked.db;
  const linkedRec = read(db, 'res.partner.bank', linked.id);
  assert.equal(partnerBankName(db, linkedRec), 'BNP Paribas');
  assert.equal(partnerBankBic(db, linkedRec), 'BNPAFRPP');

  // Updating res.bank BIC (even via raw diff) flows through partnerBankBic
  const updatedBankDb = write(db, 'res.bank', dirBank.id, { bic: 'BNPAFRPPXXX' });
  const syncedUpdatedBankDb = applyDiff(db, diffDb(db, updatedBankDb), { isAdmin: true });
  assert.equal(partnerBankBic(syncedUpdatedBankDb, read(syncedUpdatedBankDb, 'res.partner.bank', linked.id)), 'BNPAFRPPXXX');

  // Direct diff changing only res.bank.bic still resolves the updated BIC via partnerBankBic
  const bankOnlyDiff = {
    upserts: { 'res.bank': [{ ...read(db, 'res.bank', dirBank.id), bic: 'DEUTDEFF' }] },
    deletes: {},
    created: {},
    bases: { 'res.bank': { [dirBank.id]: { bic: 'BNPAFRPP' } } },
  };
  const bankOnlyDb = applyDiff(db, bankOnlyDiff, { isAdmin: true });
  assert.equal(partnerBankBic(bankOnlyDb, read(bankOnlyDb, 'res.partner.bank', linked.id)), 'DEUTDEFF');

  // Guard rejects unknown or newly-linked inactive bank_id via diffDb + applyDiff
  assert.throws(
    () => applyDiff(db, {
      upserts: { 'res.partner.bank': [{ ...linkedRec, bank_id: 999999 }] },
      deletes: {},
      created: {},
      bases: { 'res.partner.bank': { [linkedRec.id]: { bank_id: dirBank.id } } },
    }, { isAdmin: true }),
    /existing bank/i,
  );
  const archivedBankDb = write(db, 'res.bank', dirBank.id, { active: false });
  assert.throws(
    () => applyDiff(archivedBankDb, {
      upserts: { 'res.partner.bank': [{ ...read(archivedBankDb, 'res.partner.bank', unlinked.id), bank_id: dirBank.id }] },
      deletes: {},
      created: {},
      bases: { 'res.partner.bank': { [unlinked.id]: { bank_id: null } } },
    }, { isAdmin: true }),
    /active bank/i,
  );

  // SEPA / EPC QR code path uses partnerBankBic (from res.bank when bank_id is set, else bank_bic)
  const company = { ...read(bankOnlyDb, 'res.company', 1), invoice_qr: 'epc', company_iban: 'FR7630006000011234567890189', currency: 'EUR' };
  const qrSettings = invoiceQrSettingsForCompany(bankOnlyDb, company);
  const moveWithBank = {
    move_type: 'out_invoice',
    state: 'posted',
    name: 'INV/2026/100',
    amount_residual: 50,
    partner_bank_id: linked.id,
  };
  const payloadWithBank = invoiceQrPayload(qrSettings, company, moveWithBank, 'EUR', bankOnlyDb);
  assert.equal(payloadWithBank.split('\n')[4], 'DEUTDEFF', 'EPC QR line 5 uses BIC from res.bank');

  const moveUnlinked = { ...moveWithBank, partner_bank_id: unlinked.id };
  const payloadUnlinked = invoiceQrPayload(qrSettings, company, moveUnlinked, 'EUR', bankOnlyDb);
  assert.equal(payloadUnlinked.split('\n')[4], 'COBADEFF', 'EPC QR line 5 uses bank_bic when bank_id is unset');

  // PrintDoc renders EPC QR using move.partner_bank_id BIC
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  const eur = search(bankOnlyDb, 'res.currency').find((c) => c.name === 'EUR');
  const incomeAccount = search(bankOnlyDb, 'account.account').find((a) => a.account_type === 'income');
  const printDbBase = write(bankOnlyDb, 'res.company', 1, { invoice_qr: 'epc', company_iban: 'FR7630006000011234567890189', currency_id: eur.id });
  const invRes = create(printDbBase, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    partner_bank_id: linked.id,
    currency_id: eur.id,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ name: 'Service', account_id: incomeAccount.id, qty: 1, price_unit: 50, tax: 0 }],
  });
  const printDb = postMove(invRes.db, invRes.id);
  const printCtx = await mountView(
    (React) => React.createElement(PrintDoc, { model: 'account.move', id: invRes.id }),
    printDb,
  );
  try {
    const svg = find(printCtx.host, (n) => n.tagName === 'SVG' && props(n)?.['aria-label'] === 'Payment QR code');
    assert.ok(svg, 'PrintDoc renders Payment QR code SVG for posted EUR invoice');
  } finally {
    await printCtx.done();
  }

  // Clearing bank_id via onchange clears linked bank_name/bank_bic and makes fields editable again
  const cleared = models['res.partner.bank'].onchange({ ...linkedRec, bank_id: null }, 'bank_id', bankOnlyDb);
  assert.deepEqual(cleared, { bank_name: '', bank_bic: '' });

  // FormView on res.partner.bank renders bank_id in Bank Information tab and keeps bank_name/bank_bic readonly when linked
  const { FormView } = await import('./views/FormView.jsx');
  const leaf = findLeafByKey(menusFor('accounting'), 'bank-accounts');
  const formCtx = await mountView(
    (React) => React.createElement(FormView, { leaf, id: linked.id, base: '#/accounting/bank-accounts', params: new URLSearchParams() }),
    bankOnlyDb,
  );
  try {
    const bicInput = find(formCtx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-bank_bic');
    assert.equal(bicInput, null, 'bank_bic is readonly when bank_id is set');
    assert.ok(formCtx.host.textContent.includes('DEUTDEFF'), 'FormView shows bank BIC from res.bank');
    const infoTabBtn = find(formCtx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Bank Information');
    await formCtx.React.act(async () => props(infoTabBtn).onClick());
    assert.ok(find(formCtx.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-bank_id'), 'bank_id select exists in Bank Information tab');
    assert.equal(find(formCtx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-bank_name'), null, 'bank_name is readonly when bank_id is set');
  } finally {
    await formCtx.done();
  }
});

test('BK-3: BIC must be 8 or 11 alphanumeric chars, stored upper-case, and enforced on plain diffs via diffDb + applyDiff', () => {
  let db = seed();

  // Lowercase valid BIC normalized to upper-case on create and write
  const createdLower = create(db, 'res.bank', { name: 'Commerzbank', bic: ' cobadeff ' });
  db = createdLower.db;
  assert.equal(read(db, 'res.bank', createdLower.id).bic, 'COBADEFF');

  const writtenLower = write(db, 'res.bank', createdLower.id, { bic: 'deutdeff500' });
  db = writtenLower;
  assert.equal(read(db, 'res.bank', createdLower.id).bic, 'DEUTDEFF500');

  // Empty BIC allowed
  const noBic = create(db, 'res.bank', { name: 'Local Bank', bic: '' });
  db = noBic.db;
  assert.equal(read(db, 'res.bank', noBic.id).bic, '');

  // Invalid BIC rejected on ORM and via diffDb + applyDiff
  for (const bad of ['SHORT', '1234567890', 'DEUT-EFF', 'DEUT DE FF', 'AAAA12BB']) {
    assert.throws(() => create(db, 'res.bank', { name: 'Bad', bic: bad }), /8 or 11 alphanumeric/i);
    const badId = (db.seq['res.bank'] ?? 0) + 1;
    assert.throws(
      () => applyDiff(db, {
        upserts: { 'res.bank': [{ id: badId, name: 'Bad', bic: bad, active: true }] },
        deletes: {},
        created: { 'res.bank': [badId] },
        bases: {},
      }, { isAdmin: true }),
      /8 or 11 alphanumeric/i,
    );
  }

  // Plain diff with lowercase or un-trimmed BIC rejected by guard
  const nextId = (db.seq['res.bank'] ?? 0) + 1;
  assert.throws(
    () => applyDiff(db, {
      upserts: { 'res.bank': [{ id: nextId, name: 'Lower Diff Bank', bic: 'deutdeff', active: true }] },
      deletes: {},
      created: { 'res.bank': [nextId] },
      bases: {},
    }, { isAdmin: true }),
    /upper-case/i,
  );
  assert.throws(
    () => applyDiff(db, {
      upserts: { 'res.bank': [{ ...read(db, 'res.bank', createdLower.id), bic: 'cobadeff' }] },
      deletes: {},
      created: {},
      bases: { 'res.bank': { [createdLower.id]: { bic: 'DEUTDEFF500' } } },
    }, { isAdmin: true }),
    /upper-case/i,
  );

  // res.partner.bank also normalizes bank_bic to upper-case and rejects lowercase in plain diffs
  const partner = search(db, 'res.partner')[0];
  const accLower = create(db, 'res.partner.bank', {
    partner_id: partner.id,
    account_number: 'ACC-LOWER',
    bank_bic: 'chAsus33',
  });
  db = accLower.db;
  assert.equal(read(db, 'res.partner.bank', accLower.id).bank_bic, 'CHASUS33');

  const syncedValid = applyDiff(accLower.db, diffDb(accLower.db, write(accLower.db, 'res.partner.bank', accLower.id, { bank_bic: 'bnpafrppxxx' })), { isAdmin: true });
  assert.equal(read(syncedValid, 'res.partner.bank', accLower.id).bank_bic, 'BNPAFRPPXXX');

  assert.throws(
    () => applyDiff(syncedValid, {
      upserts: { 'res.partner.bank': [{ ...read(syncedValid, 'res.partner.bank', accLower.id), bank_bic: 'deutdeff' }] },
      deletes: {},
      created: {},
      bases: { 'res.partner.bank': { [accLower.id]: { bank_bic: 'BNPAFRPPXXX' } } },
    }, { isAdmin: true }),
    /upper-case/i,
  );
});

test('Arabic translations exist for all new res.bank and BIC strings', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import('./i18n.js?bnk1-ar-test');
    const strings = [
      'Banks',
      'Bank Identifier Code',
      'BIC/SWIFT must be stored in upper-case',
      'Select an existing bank',
      'Select an active bank',
    ];
    for (const s of strings) {
      assert.notEqual(t(s), s, `missing Arabic translation for: ${s}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
