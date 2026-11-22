import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, updateSettings, write } from './orm.js';
import { menusFor, models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { creditWarning } from './models/finance.js';
import { addDays, today } from './models/common.js';
import { applyDiff, diffDb } from './sync.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { seed } from './seed.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, cls) => typeof classOf(node) === 'string' && classOf(node).split(/\s+/).includes(cls);

async function renderSettings(setupDb) {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { Settings } = await import('./views/Settings.jsx');
  await initStore();
  const initialDb = setupDb ? setupDb(seed()) : seed();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    await commit(initialDb);
    root.render(React.createElement(Settings));
  });
  return {
    React,
    host,
    getDb,
    control: (id) => find(host, (n) => props(n)?.id === id),
    cleanup: async () => {
      await React.act(async () => root.unmount());
    },
  };
}

async function mountForm({ leaf, id, db: initialDb, base }) {
  const prevStorage = globalThis.localStorage;
  const prevLocation = globalThis.location;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  globalThis.location = { hash: `${base}/${id}` };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const params = new URLSearchParams('view=form');
  await React.act(async () => root.render(React.createElement(FormView, {
    leaf,
    id,
    base,
    params,
  })));
  return {
    React,
    host,
    getDb,
    control: (ctrlId) => find(host, (n) => props(n)?.id === ctrlId),
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
      globalThis.location = prevLocation;
    },
  };
}

test('CL-1: company fields, dedicated Settings block, conditional Default Credit Limit, and admin/non-negative guards', async () => {
  const companyFields = models['res.company'].fields;
  assert.equal(companyFields.account_use_credit_limit?.type, 'boolean');
  assert.equal(companyFields.account_use_credit_limit?.label, 'Sales Credit Limit');
  assert.equal(companyFields.account_default_credit_limit?.type, 'monetary');
  assert.equal(companyFields.account_default_credit_limit?.label, 'Default Credit Limit');

  // Negative default credit limit is rejected by companyGuard (including over sync diffDb + applyDiff).
  const base = seed();
  assert.throws(
    () => write(base, 'res.company', 1, { account_use_credit_limit: true, account_default_credit_limit: -10 }),
    /non-negative/i,
  );
  const tamperedNeg = {
    ...base,
    records: {
      ...base.records,
      'res.company': base.records['res.company'].map((c) => (c.id === 1 ? { ...c, account_use_credit_limit: true, account_default_credit_limit: -1 } : c)),
    },
  };
  assert.throws(() => applyDiff(base, diffDb(base, tamperedNeg), { isAdmin: true }), /non-negative/i);

  // Non-admins cannot change credit limit settings over sync.
  const enabledByNonAdmin = write(base, 'res.company', 1, { account_use_credit_limit: true, account_default_credit_limit: 500 });
  assert.throws(
    () => applyDiff(base, diffDb(base, enabledByNonAdmin), { isAdmin: false }),
    /Only administrators/i,
  );
  const savedByAdmin = applyDiff(base, diffDb(base, enabledByNonAdmin), { isAdmin: true });
  assert.equal(read(savedByAdmin, 'res.company', 1).account_use_credit_limit, true);
  assert.equal(read(savedByAdmin, 'res.company', 1).account_default_credit_limit, 500);

  // Settings UI renders Sales Credit Limit in its own settings block; Default Credit Limit appears only when enabled.
  const ctx = await renderSettings();
  try {
    const accountingSection = find(ctx.host, (n) => n.tagName === 'SECTION' && props(n)?.className === 'settings-accounting');
    assert.ok(accountingSection);
    const useControl = ctx.control('account_use_credit_limit');
    assert.ok(useControl, 'account_use_credit_limit checkbox is rendered');
    const ownBlock = find(accountingSection, (n) => hasClass(n, 'settings-block') && find(n, (c) => props(c)?.id === 'account_use_credit_limit'));
    assert.ok(ownBlock, 'Sales Credit Limit has its own settings-block');
    assert.equal(props(ownBlock)?.['data-block'], 'credit_limit');
    assert.equal(ctx.control('account_default_credit_limit'), null, 'Default Credit Limit is hidden when disabled');

    await ctx.React.act(async () => props(useControl).onChange({ target: { checked: true } }));
    assert.equal(read(ctx.getDb(), 'res.company', 1).account_use_credit_limit, true);

    const defControl = ctx.control('account_default_credit_limit');
    assert.ok(defControl, 'Default Credit Limit appears once Sales Credit Limit is enabled');
    await ctx.React.act(async () => props(defControl).onChange({ target: { value: '2500' } }));
    assert.equal(read(ctx.getDb(), 'res.company', 1).account_default_credit_limit, 2500);

    await ctx.React.act(async () => props(ctx.control('account_use_credit_limit')).onChange({ target: { checked: false } }));
    assert.equal(read(ctx.getDb(), 'res.company', 1).account_use_credit_limit, false);
    assert.equal(ctx.control('account_default_credit_limit'), null, 'Default Credit Limit hides again when disabled');
  } finally {
    await ctx.cleanup();
  }
});

test('CL-2: Partner Limit and Credit Limit visibility and conditional editability on the partner form', async () => {
  const partnerFields = models['res.partner'].fields;
  assert.equal(partnerFields.use_partner_credit_limit?.type, 'boolean');
  assert.equal(partnerFields.use_partner_credit_limit?.label, 'Partner Limit');
  assert.equal(partnerFields.credit_limit?.type, 'monetary');

  const partnerLeaf = menusFor('contacts').find((m) => m.model === 'res.partner');
  const partnerCreated = create(seed(), 'res.partner', { name: 'Acme Partner' });

  // 1. Company setting OFF -> both fields hidden on partner form.
  const ctxOff = await mountForm({ leaf: partnerLeaf, id: partnerCreated.id, db: partnerCreated.db, base: '#/contacts/contacts' });
  try {
    assert.equal(ctxOff.control('f-use_partner_credit_limit'), null, 'use_partner_credit_limit hidden when setting is off');
    assert.equal(ctxOff.control('f-credit_limit'), null, 'credit_limit hidden when setting is off');
    assert.equal(find(ctxOff.host, (n) => n.tagName === 'LABEL' && n.textContent.includes('Partner Limit')), null);
    assert.equal(find(ctxOff.host, (n) => n.tagName === 'LABEL' && n.textContent.includes('Credit Limit')), null);
  } finally {
    await ctxOff.done();
  }

  // 2. Company setting ON -> both visible; credit_limit readonly (shows company default) until Partner Limit is checked.
  const enabledDb = write(partnerCreated.db, 'res.company', 1, {
    account_use_credit_limit: true,
    account_default_credit_limit: 1500,
  });
  const ctxOn = await mountForm({ leaf: partnerLeaf, id: partnerCreated.id, db: enabledDb, base: '#/contacts/contacts' });
  try {
    const toggle = ctxOn.control('f-use_partner_credit_limit');
    assert.ok(toggle, 'use_partner_credit_limit checkbox is shown when company setting is on');
    assert.equal(ctxOn.control('f-credit_limit'), null, 'credit_limit is readonly (no input) when Partner Limit is false');
    const roSpan = find(ctxOn.host, (n) => n.tagName === 'SPAN' && hasClass(n, 'readonly') && n.textContent.includes('1,500'));
    assert.ok(roSpan, 'readonly credit_limit displays company default 1,500');

    await ctxOn.React.act(async () => props(toggle).onChange({ target: { checked: true } }));
    const limitInput = ctxOn.control('f-credit_limit');
    assert.ok(limitInput, 'credit_limit becomes editable input once Partner Limit is checked');
  } finally {
    await ctxOn.done();
  }
});

test('CL-3: Draft customer invoice warning uses commercial entity receivable, company currency, exact message, and never blocks posting', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, {
    account_use_credit_limit: true,
    account_default_credit_limit: 1000,
  });

  // Commercial parent + billing child contact; verify parent_id survives applyDiff.
  const parent = create(db, 'res.partner', { name: 'Parent Holdings', is_company: true });
  const childA = create(parent.db, 'res.partner', { name: 'Child Branch A', parent_id: parent.id });
  const childB = create(childA.db, 'res.partner', { name: 'Child Branch B', parent_id: parent.id });
  db = applyDiff(db, diffDb(db, childB.db), { isAdmin: true });
  assert.equal(read(db, 'res.partner', childA.id).parent_id, parent.id);

  // Posted unpaid invoice on childA for $700.
  const postedA = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: childA.id,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 700, tax: 0 }],
  });
  db = postMove(postedA.db, postedA.id);

  // Draft invoice on childB for $500 -> commercial entity total = 700 + 500 = 1200 > 1000.
  const draftB = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: childB.id,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 500, tax: 0 }],
  });
  db = draftB.db;

  const expectedWarn = 'Parent Holdings has reached its credit limit of: $1,000.00. Total amount due (including this document): $1,200.00';
  assert.equal(models['account.move'].form.warning(read(db, 'account.move', draftB.id), db), expectedWarn);

  // Banner renders on FormView for draft invoice.
  const invLeaf = menusFor('accounting').find((m) => m.label === 'Customers').children.find((c) => c.key === 'invoices');
  const invCtx = await mountForm({ leaf: invLeaf, id: draftB.id, db, base: '#/accounting/invoices' });
  try {
    const banner = find(invCtx.host, (n) => hasClass(n, 'alert-warning'));
    assert.ok(banner, 'warning banner renders on draft invoice FormView');
    assert.equal(banner.textContent, expectedWarn);
  } finally {
    await invCtx.done();
  }

  // Posting is never blocked, and posted invoice no longer displays the draft warning.
  const postedDb = postMove(db, draftB.id);
  assert.equal(read(postedDb, 'account.move', draftB.id).state, 'posted');
  assert.equal(models['account.move'].form.warning(read(postedDb, 'account.move', draftB.id), postedDb), '');

  // Partner-specific override (use_partner_credit_limit: true) overrides company default (and 0 disables limit).
  const dbHigher = write(db, 'res.partner', parent.id, { use_partner_credit_limit: true, credit_limit: 1500 });
  assert.equal(models['account.move'].form.warning(read(dbHigher, 'account.move', draftB.id), dbHigher), '');
  const dbLower = write(db, 'res.partner', parent.id, { use_partner_credit_limit: true, credit_limit: 1100 });
  assert.equal(
    models['account.move'].form.warning(read(dbLower, 'account.move', draftB.id), dbLower),
    'Parent Holdings has reached its credit limit of: $1,100.00. Total amount due (including this document): $1,200.00',
  );
  const dbZero = write(db, 'res.partner', parent.id, { use_partner_credit_limit: true, credit_limit: 0 });
  assert.equal(models['account.move'].form.warning(read(dbZero, 'account.move', draftB.id), dbZero), '');

  // Turning off company setting (or leaving it off with partner credit_limit set) suppresses warning.
  const dbDisabled = write(dbLower, 'res.company', 1, { account_use_credit_limit: false });
  assert.equal(models['account.move'].form.warning(read(dbDisabled, 'account.move', draftB.id), dbDisabled), '');
  const dbOffPartnerLimit = write(seed(), 'res.partner', 2, { credit_limit: 10 });
  const draftOff = create(dbOffPartnerLimit, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 500, tax: 0 }],
  });
  assert.equal(models['account.move'].form.warning(read(draftOff.db, 'account.move', draftOff.id), draftOff.db), '');

  // Out_refund and in_invoice do not trigger the draft out_invoice credit warning.
  const refund = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: childB.id,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 500, tax: 0 }],
  });
  assert.equal(models['account.move'].form.warning(read(refund.db, 'account.move', refund.id), refund.db), '');

  // Invoice in a second company uses that second company's currency and setting.
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const branch = createCompanyWithDefaultInvoiceJournals(db, { name: 'Euro Co', currency_id: eur.id });
  let db2 = write(branch.db, 'res.company', branch.id, {
    account_use_credit_limit: true,
    account_default_credit_limit: 600,
  });
  db2 = updateSettings(db2, { current_company_id: branch.id, allowed_company_ids: [1, branch.id] });
  const branchInv = create(db2, 'account.move', {
    company_id: branch.id,
    move_type: 'out_invoice',
    partner_id: parent.id,
    currency_id: eur.id,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 700, tax: 0 }],
  });
  assert.equal(
    models['account.move'].form.warning(read(branchInv.db, 'account.move', branchInv.id), branchInv.db),
    'Parent Holdings has reached its credit limit of: 600.00 €. Total amount due (including this document): 700.00 €',
  );
});

test('CL-4: Sale orders (quotations) reuse the same helper and display the same non-blocking warning', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, {
    account_use_credit_limit: true,
    account_default_credit_limit: 1000,
  });
  const parent = create(db, 'res.partner', { name: 'Quotation Group', is_company: true });
  const contact = create(parent.db, 'res.partner', { name: 'Quotation Buyer', parent_id: parent.id });
  const inv = create(contact.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: parent.id,
    invoice_date: addDays(today(), -5),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 800, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const sale = create(db, 'sale.order', {
    partner_id: contact.id,
    date_order: today(),
    order_line: [{ product_id: 1, qty: 1, price_unit: 300, tax: 0 }],
  });
  db = sale.db;

  const expected = creditWarning(db, contact.id, 300, read(db, 'sale.order', sale.id));
  assert.equal(expected, 'Quotation Group has reached its credit limit of: $1,000.00. Total amount due (including this document): $1,100.00');
  assert.equal(models['sale.order'].form.warning(read(db, 'sale.order', sale.id), db), expected);

  // Renders on sale.order FormView.
  const saleLeaf = menusFor('sales').find((m) => m.label === 'Orders').children.find((c) => c.key === 'quotations');
  const saleCtx = await mountForm({ leaf: saleLeaf, id: sale.id, db, base: '#/sales/quotations' });
  try {
    const banner = find(saleCtx.host, (n) => hasClass(n, 'alert-warning'));
    assert.ok(banner, 'warning banner renders on quotation FormView');
    assert.equal(banner.textContent, expected);
  } finally {
    await saleCtx.done();
  }

  // Confirming the sale order is not blocked.
  const confirmedDb = models['sale.order'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'sale.order', sale.id)).db;
  assert.equal(read(confirmedDb, 'sale.order', sale.id).state, 'sale');

  // Disabling the company setting turns off the quotation warning.
  const disabledDb = write(db, 'res.company', 1, { account_use_credit_limit: false });
  assert.equal(models['sale.order'].form.warning(read(disabledDb, 'sale.order', sale.id), disabledDb), '');
});

test('migration 64: sets use_partner_credit_limit and account_use_credit_limit when partners have credit_limit > 0', () => {
  const base = seed();
  const legacyWithLimits = {
    ...base,
    schema_version: 63,
    records: {
      ...base.records,
      'res.company': [
        { ...base.records['res.company'][0] },
        { id: 2, name: 'Second Co', currency_id: base.records['res.company'][0].currency_id },
      ],
      'res.partner': [
        { id: 10, name: 'With Limit', credit_limit: 500 },
        { id: 11, name: 'Zero Limit', credit_limit: 0 },
        { id: 12, name: 'No Limit' },
      ],
    },
  };
  const migrated = migrate(legacyWithLimits);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.equal(read(migrated, 'res.partner', 10).use_partner_credit_limit, true);
  assert.equal(read(migrated, 'res.partner', 11).use_partner_credit_limit, undefined);
  assert.equal(read(migrated, 'res.partner', 12).use_partner_credit_limit, undefined);
  assert.equal(read(migrated, 'res.company', 1).account_use_credit_limit, true);
  assert.equal(read(migrated, 'res.company', 2).account_use_credit_limit, true);
  assert.equal(migrate(migrated), migrated);

  const legacyWithoutLimits = {
    ...base,
    schema_version: 63,
    records: {
      ...base.records,
      'res.partner': [{ id: 11, name: 'Zero Limit', credit_limit: 0 }],
    },
  };
  const migratedEmpty = migrate(legacyWithoutLimits);
  assert.equal(migratedEmpty.schema_version, SCHEMA_VERSION);
  assert.equal(read(migratedEmpty, 'res.company', 1).account_use_credit_limit, undefined);
  assert.equal(read(migratedEmpty, 'res.partner', 11).use_partner_credit_limit, undefined);
});

test('i18n: new Sales Credit Limit strings have Modern Standard Arabic translations', () => {
  const i18nSrc = fs.readFileSync('src/i18n.js', 'utf8');
  for (const key of [
    'Sales Credit Limit',
    'Default Credit Limit',
    'Partner Limit',
    'Default Credit Limit must be non-negative',
  ]) {
    assert.ok(i18nSrc.includes(`'${key}'`), `i18n includes "${key}"`);
  }
});
