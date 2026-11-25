import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { apps, findLeaf, menusFor, models } from './models/index.js';
import { appOpen } from './access.js';
import { postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

async function mountPartnerForm({ db: initialDb, id, leaf, base = '#/accounting/customers' }) {
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
  const store = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await store.initStore();
  await store.commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(React.createElement(FormView, {
    leaf,
    id,
    base,
    params: new URLSearchParams('view=form'),
  })));
  return {
    React,
    host,
    store,
    control: (ctrlId) => find(host, (n) => props(n)?.id === ctrlId),
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
      globalThis.location = prevLocation;
    },
  };
}

test('res.partner list columns, optional visibility, multi-company company_id, and complete_name', async () => {
  const { visibleListColumns } = await import('./views/List.jsx');
  const def = models['res.partner'];

  assert.deepEqual(def.list, [
    'complete_name', 'email', 'phone', 'user_id', 'city',
    'state_id', 'country_id', 'vat', 'tag_ids', 'company_id',
  ]);
  assert.equal(def.listLabels?.complete_name, 'Name');
  assert.equal(def.fields.complete_name.optional, undefined);
  assert.equal(def.fields.email.optional, 'show');
  assert.equal(def.fields.phone.optional, 'show');
  assert.equal(def.fields.country_id.optional, 'show');
  for (const col of ['user_id', 'city', 'state_id', 'vat', 'tag_ids', 'company_id']) {
    assert.equal(def.fields[col].optional, 'hide', `${col} must be optional=hide`);
  }
  assert.equal(def.fields.tag_ids.widget, 'many2many_tags');
  assert.equal(def.fields.company_id.multiCompanyOnly, true);

  let db = seed();
  const single = visibleListColumns(def, db);
  assert.deepEqual(single.cols, ['complete_name', 'email', 'phone', 'country_id']);
  assert.ok(!single.optionalCols.some(([k]) => k === 'company_id'), 'company_id omitted in single-company DB');

  db = create(db, 'res.company', { name: 'Branch Co' }).db;
  const multi = visibleListColumns(def, db);
  assert.deepEqual(multi.cols, ['complete_name', 'email', 'phone', 'country_id']);
  assert.ok(multi.optionalCols.some(([k]) => k === 'company_id'), 'company_id available in optional columns when multi-company');
  const toggled = visibleListColumns(def, db, { user_id: true, vat: true, company_id: true, city: false });
  assert.deepEqual(toggled.cols, ['complete_name', 'email', 'phone', 'user_id', 'country_id', 'vat', 'company_id']);

  const parent = create(db, 'res.partner', { name: 'Acme Holdings', is_company: true });
  const contact = create(parent.db, 'res.partner', { name: 'Layla Mansour', parent_id: parent.id, type: 'contact' });
  const delivery = create(contact.db, 'res.partner', { name: '', parent_id: parent.id, type: 'delivery' });
  assert.equal(read(delivery.db, 'res.partner', parent.id).complete_name, 'Acme Holdings');
  assert.equal(read(delivery.db, 'res.partner', contact.id).complete_name, 'Acme Holdings, Layla Mansour');
  assert.equal(read(delivery.db, 'res.partner', delivery.id).complete_name, 'Acme Holdings, Delivery');
});

test('res.partner form fields, Sales & Purchase page, Contacts & Addresses tab, and existing tabs', () => {
  const def = models['res.partner'];
  assert.equal(def.fields.function.type, 'char');
  assert.equal(def.fields.function.label, 'Job Position');
  assert.equal(def.fields.website.type, 'char');
  assert.equal(def.fields.website.label, 'Website');
  assert.equal(def.fields.lang.type, 'selection');
  assert.deepEqual(def.fields.lang.options, [['en', 'English'], ['ar', 'العربية']]);
  assert.equal(def.fields.ref.type, 'char');
  assert.equal(def.fields.industry_id.type, 'many2one');
  assert.equal(def.fields.industry_id.relation, 'res.partner.industry');
  assert.equal(def.fields.user_id.hidden, undefined);
  assert.equal(def.fields.state_id.type, 'many2one');
  assert.equal(def.fields.state_id.relation, 'res.country.state');
  assert.equal(def.fields.country_id.type, 'many2one');
  assert.equal(def.fields.country_id.relation, 'res.country');

  const topFields = new Set(def.form.groups.flat());
  for (const field of ['function', 'website', 'lang', 'tag_ids', 'state_id', 'country_id', 'zip', 'vat']) {
    assert.ok(topFields.has(field), `${field} must be in top form groups`);
  }

  const tabs = def.form.tabs;
  assert.deepEqual(tabs.map((tb) => tb.label), ['Accounting', 'Bank Accounts', 'Contacts & Addresses', 'Sales & Purchase']);
  const contactsTab = tabs.find((tb) => tb.label === 'Contacts & Addresses');
  assert.deepEqual(contactsTab.fields, ['child_ids']);

  const salesPurchase = tabs.find((tb) => tb.label === 'Sales & Purchase');
  const spFields = new Set(salesPurchase.groups.flatMap((g) => g.fields));
  for (const field of ['user_id', 'ref', 'industry_id', 'property_payment_term_id', 'property_supplier_payment_term_id', 'company_id']) {
    assert.ok(spFields.has(field), `${field} must be on Sales & Purchase page`);
  }

  // Industries model + menu + seed
  assert.ok(models['res.partner.industry'], 'res.partner.industry must be registered');
  const configMenu = menusFor('contacts').find((m) => m.label === 'Configuration');
  assert.ok(configMenu.children.some((c) => c.model === 'res.partner.industry'));
  assert.ok(search(seed(), 'res.partner.industry').length >= 21);
});

test('partner country_id/state_id sync, Contacts & Addresses child_ids sync, and diff-checkable guards', () => {
  let db = seed();
  const egypt = search(db, 'res.country').find((c) => c.code === 'EG');
  const saudi = search(db, 'res.country').find((c) => c.code === 'SA');
  const giza = search(db, 'res.country.state').find((s) => s.country_id === egypt.id && s.name === 'Giza');
  const riyadh = search(db, 'res.country.state').find((s) => s.country_id === saudi.id);
  const itIndustry = search(db, 'res.partner.industry').find((i) => i.name.includes('IT'));
  assert.ok(egypt && saudi && giza && riyadh && itIndustry);

  // Seeded partners automatically carry country_id synced from legacy country
  assert.equal(read(db, 'res.partner', 1).country_id, egypt.id);

  // Creating partner with state_id backfills country_id and text names
  const p = create(db, 'res.partner', {
    name: 'Oasis Tech',
    is_company: true,
    state_id: giza.id,
    function: 'Partner',
    website: 'https://oasistech.example',
    lang: 'ar',
    ref: 'OAS-01',
    industry_id: itIndustry.id,
    user_id: 2,
    child_ids: [
      { type: 'contact', name: 'Nour Adel', email: 'nour@oasistech.example', phone: '+201001112233', function: 'CFO' },
      { type: 'delivery', name: 'Warehouse Dock', city: 'Cairo', country_id: egypt.id },
    ],
  });
  db = p.db;
  const created = read(db, 'res.partner', p.id);
  assert.equal(created.country_id, egypt.id);
  assert.equal(created.country, 'Egypt');
  assert.equal(created.state, 'Giza');
  assert.equal(created.child_ids.length, 2);
  const childContacts = search(db, 'res.partner').filter((c) => c.parent_id === p.id);
  assert.equal(childContacts.length, 2);
  assert.equal(childContacts[0].complete_name, 'Oasis Tech, Nour Adel');
  assert.equal(childContacts[0].lang, 'ar');
  assert.equal(childContacts[0].user_id, 2);

  // Removing a line from child_ids archives that child contact
  db = write(db, 'res.partner', p.id, { child_ids: [created.child_ids[0]] });
  assert.equal(read(db, 'res.partner', p.id).child_ids.length, 1);
  assert.equal(read(db, 'res.partner', childContacts[1].id).active, false);

  // Changing country_id clears mismatched state_id
  db = write(db, 'res.partner', p.id, { country_id: saudi.id });
  assert.equal(read(db, 'res.partner', p.id).state_id, null);
  assert.equal(read(db, 'res.partner', p.id).country, 'Saudi Arabia');

  // Guards are enforceable from saved diff via diffDb + applyDiff
  const badStateMismatch = {
    ...db,
    records: {
      ...db.records,
      'res.partner': db.records['res.partner'].map((r) => (r.id === p.id ? { ...r, country_id: egypt.id, state_id: riyadh.id } : r)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, badStateMismatch)), /Select a state belonging to the selected country/);

  const badCountry = {
    ...db,
    records: {
      ...db.records,
      'res.partner': db.records['res.partner'].map((r) => (r.id === p.id ? { ...r, country_id: 999999 } : r)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, badCountry)), /Selected country does not exist/);

  const cycleDb = {
    ...db,
    records: {
      ...db.records,
      'res.partner': db.records['res.partner'].map((r) => (r.id === p.id ? { ...r, parent_id: childContacts[0].id } : r)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, cycleDb)), /Parent contact hierarchy cannot contain a cycle/);
});

test('Invoiced and Vendor Bills smart buttons count customer/supplier moves, include child contacts, and open filtered lists', async () => {
  let db = seed();
  const companyParent = create(db, 'res.partner', { name: 'Global Supply Co', is_company: true, customer_rank: 1, supplier_rank: 1 });
  const childContact = create(companyParent.db, 'res.partner', { name: 'Procurement Lead', parent_id: companyParent.id });
  db = childContact.db;

  // Initially no invoices or bills
  assert.equal(read(db, 'res.partner', companyParent.id).total_invoiced, 0);
  assert.equal(read(db, 'res.partner', companyParent.id).supplier_invoice_count, 0);

  const smart = models['res.partner'].form.smart;
  const invoicedBtn = smart.find((s) => s.label === 'Invoiced');
  const billsBtn = smart.find((s) => s.label === 'Vendor Bills');
  assert.ok(invoicedBtn && billsBtn);

  const parentRec0 = read(db, 'res.partner', companyParent.id);
  assert.equal(billsBtn.when(parentRec0, db), false, 'Vendor Bills hidden when supplier_invoice_count == 0');

  // Create a draft invoice (should NOT count in total_invoiced), a posted invoice, and a posted credit note on child
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: companyParent.id,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'Draft Item', qty: 1, price_unit: 999, tax: 0 }],
  });
  db = draftInv.db;

  const postedInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: companyParent.id,
    invoice_date: '2026-03-02',
    invoice_line_ids: [{ name: 'Posted Item', qty: 1, price_unit: 500, tax: 0 }],
  });
  db = postMove(postedInv.db, postedInv.id);

  const postedCredit = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: childContact.id,
    invoice_date: '2026-03-03',
    invoice_line_ids: [{ name: 'Return Item', qty: 1, price_unit: 120, tax: 0 }],
  });
  db = postMove(postedCredit.db, postedCredit.id);

  // Create vendor bill on parent (should NOT affect Invoiced total, SHOULD increment Vendor Bills count)
  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: companyParent.id,
    invoice_date: '2026-03-04',
    invoice_line_ids: [{ name: 'Vendor Supply', qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(bill1.db, bill1.id);

  const parentRec1 = read(db, 'res.partner', companyParent.id);
  assert.equal(parentRec1.total_invoiced, 380);
  assert.equal(parentRec1.account_move_count, 3);
  assert.equal(parentRec1.supplier_invoice_count, 1);
  assert.equal(invoicedBtn.value(db, parentRec1), 380);
  assert.equal(billsBtn.when(parentRec1, db), true);
  assert.equal(billsBtn.value(db, parentRec1), 1);
  assert.equal(billsBtn.target(parentRec1, db), `accounting/bills?view=list&rel=partner_id:${companyParent.id}`);

  // Adding a draft bill on child contact increases supplier_invoice_count to 2 and links both bills
  const bill2 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: childContact.id,
    invoice_date: '2026-03-05',
    invoice_line_ids: [{ name: 'Child Bill', qty: 1, price_unit: 80, tax: 0 }],
  });
  db = bill2.db;
  const parentRec2 = read(db, 'res.partner', companyParent.id);
  assert.equal(parentRec2.supplier_invoice_count, 2);
  assert.equal(billsBtn.value(db, parentRec2), 2);
  assert.equal(billsBtn.target(parentRec2, db), `accounting/bills?view=list&rel=id:${bill1.id},${bill2.id}`);

  // FormView renders smart buttons, new general fields, and tabs for accounting users
  const accApp = apps.find((a) => a.id === 'accounting');
  const vendLeaf = findLeaf(accApp, 'vendors');
  const ctxAcc = await mountPartnerForm({
    db,
    id: companyParent.id,
    leaf: vendLeaf,
    base: '#/accounting/vendors',
  });
  try {
    assert.ok(ctxAcc.control('f-function'));
    assert.ok(ctxAcc.control('f-website'));
    assert.ok(ctxAcc.control('f-lang'));
    assert.ok(ctxAcc.control('f-state_id'));
    assert.ok(ctxAcc.control('f-country_id'));
    assert.ok(ctxAcc.control('f-tag_ids'));

    const smartLinks = [];
    const walk = (n) => {
      if (!n) return;
      if (n.tagName === 'A' && props(n)?.className?.includes('smart')) smartLinks.push(n);
      for (const c of n.childNodes ?? []) walk(c);
    };
    walk(ctxAcc.host);
    const billsLink = smartLinks.find((a) => a.textContent.includes('Vendor Bills'));
    assert.ok(billsLink, 'Vendor Bills smart button must render on vendor form');
    assert.ok(billsLink.textContent.includes('2'));
    assert.equal(props(billsLink).href, `#/accounting/bills?view=list&rel=id:${bill1.id},${bill2.id}`);
    const invLink = smartLinks.find((a) => a.textContent.includes('Invoiced'));
    assert.ok(invLink, 'Invoiced smart button must render on partner form');
    assert.ok(invLink.textContent.includes('380'));

    // Click Sales & Purchase tab and verify fields appear
    const tabs = [];
    const walkTabs = (n) => {
      if (!n) return;
      if (n.tagName === 'BUTTON' && props(n)?.role === 'tab') tabs.push(n);
      for (const c of n.childNodes ?? []) walkTabs(c);
    };
    walkTabs(ctxAcc.host);
    const spTab = tabs.find((b) => b.textContent === 'Sales & Purchase');
    assert.ok(spTab, 'Sales & Purchase tab must render');
    await ctxAcc.React.act(async () => props(spTab).onClick());
    assert.ok(ctxAcc.control('f-user_id'));
    assert.ok(ctxAcc.control('f-ref'));
    assert.ok(ctxAcc.control('f-industry_id'));
    assert.ok(ctxAcc.control('f-property_payment_term_id'));
    assert.ok(ctxAcc.control('f-property_supplier_payment_term_id'));
  } finally {
    await ctxAcc.done();
  }

  // Accounting smart buttons require accounting access and hide when accounting is unavailable
  assert.equal(invoicedBtn.app, 'accounting');
  assert.equal(billsBtn.app, 'accounting');
  assert.equal(appOpen(db, { apps: ['crm', 'contacts'] }, invoicedBtn.app), false);
  assert.equal(appOpen(db, { apps: ['accounting'] }, billsBtn.app), true);

  const contactsLeaf = menusFor('contacts').find((m) => m.model === 'res.partner');
  const dbNoAcct = { ...db, settings: { ...db.settings, uninstalled: ['accounting'] } };
  const ctxCrm = await mountPartnerForm({
    db: dbNoAcct,
    id: companyParent.id,
    leaf: contactsLeaf,
    base: '#/contacts/contacts',
  });
  try {
    const smartLinks = [];
    const walk = (n) => {
      if (!n) return;
      if (n.tagName === 'A' && props(n)?.className?.includes('smart')) smartLinks.push(n);
      for (const c of n.childNodes ?? []) walk(c);
    };
    walk(ctxCrm.host);
    assert.equal(smartLinks.find((a) => a.textContent.includes('Vendor Bills')), undefined);
    assert.equal(smartLinks.find((a) => a.textContent.includes('Invoiced')), undefined);
  } finally {
    await ctxCrm.done();
  }
});

test('Arabic translations exist for new res.partner labels and errors', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null) };
  let tAr;
  try {
    ({ t: tAr } = await import(`./i18n.js?partner-ar=${Date.now()}`));
  } finally {
    globalThis.localStorage = prevStorage;
  }

  for (const label of [
    'Contacts & Addresses', 'Sales & Purchase', 'Industry', 'Industries',
    'Full Name', 'Address Type', 'Total Invoiced', 'Vendor Bills',
    'Job Position', 'Website', 'Language', 'Reference',
    'Select a state belonging to the selected country',
    'Parent contact hierarchy cannot contain a cycle',
    'Name is required for contact addresses',
  ]) {
    const translated = tAr(label);
    assert.ok(translated && translated !== label, `Missing Arabic translation for: ${label}`);
  }
});
