import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { apps, findLeaf, menusFor, models } from './models/index.js';
import { appOpen } from './access.js';
import { createPartnerInvoices, payMove, postMove, registerPartnerPayments, partnerRegisterPaymentWizard } from './models/accounting.js';
import { postPayment } from './models/pay.js';
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

async function mountScreen(renderElement, initialDb, { hash = '#/' } = {}) {
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
  globalThis.location = { hash };
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
  const store = await import('./store.js');
  await store.initStore();
  await store.commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(renderElement(React)));
  return {
    React,
    host,
    store,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
      globalThis.location = prevLocation;
    },
  };
}

test('PTN3-1: res.partner list renders Odoo column order, optional show/hide, multi-company company_id, and avatar in List', async () => {
  const def = models['res.partner'];
  assert.deepEqual(def.list, [
    'complete_name', 'email', 'phone', 'user_id', 'city',
    'state_id', 'country_id', 'vat', 'tag_ids', 'company_id',
  ]);
  assert.equal(def.fields.complete_name.avatar, true);
  assert.equal(def.listLabels.complete_name, 'Name');
  assert.equal(def.fields.email.optional, 'show');
  assert.equal(def.fields.phone.optional, 'show');
  assert.equal(def.fields.country_id.optional, 'show');
  for (const col of ['user_id', 'city', 'state_id', 'vat', 'tag_ids', 'company_id']) {
    assert.equal(def.fields[col].optional, 'hide');
  }
  assert.equal(def.fields.company_id.multiCompanyOnly, true);

  let db = seed();
  const p = create(db, 'res.partner', { name: 'Nile Traders', email: 'ar@nile.example', is_company: true, customer_rank: 1 });
  db = p.db;
  const customersLeaf = findLeaf(apps.find((a) => a.id === 'accounting'), 'customers');
  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountScreen(
    (React) => React.createElement(ActionView, {
      leaf: customersLeaf,
      base: '#/accounting/customers',
      params: new URLSearchParams('view=list'),
    }),
    db,
    { hash: '#/accounting/customers?view=list' },
  );
  try {
    const avatarCells = allFind(ctx.host, (n) => hasClass(n, 'list-avatar-cell'));
    assert.ok(avatarCells.length >= 1, 'partner list renders avatar beside complete_name');
    assert.ok(avatarCells.some((cell) => cell.textContent.includes('Nile Traders')));
  } finally {
    await ctx.done();
  }
});

test('PTN3-2: partner Action menu exposes Create Invoice, Create Bill, and Register Payment on list/form with accounting app gating', async () => {
  let db = seed();
  const term = search(db, 'account.payment.term')[0];
  const fp = create(db, 'account.fiscal.position', { name: 'Export FP' });
  db = fp.db;
  const cust = create(db, 'res.partner', {
    name: 'Delta Customer',
    customer_rank: 1,
    property_payment_term_id: term.id,
    property_account_position_id: fp.id,
  });
  db = cust.db;
  const vend = create(db, 'res.partner', {
    name: 'Omega Vendor',
    supplier_rank: 1,
    property_supplier_payment_term_id: term.id,
  });
  db = vend.db;
  const trustedBank = create(db, 'res.partner.bank', {
    partner_id: vend.id,
    account_number: 'OMEGA-TRUST-01',
    allow_out_payment: true,
  });
  db = trustedBank.db;

  // Model & leaf action wiring
  assert.deepEqual(
    models['res.partner'].menuActions.map((a) => a.label),
    ['Create Invoice', 'Create Bill', 'Register Payment'],
  );
  const accApp = apps.find((a) => a.id === 'accounting');
  const customersLeaf = findLeaf(accApp, 'customers');
  const vendorsLeaf = findLeaf(accApp, 'vendors');
  assert.ok(customersLeaf.listActions.some((a) => a.label === 'Create Invoice'));
  assert.ok(customersLeaf.listActions.some((a) => a.label === 'Register Payment'));
  assert.ok(vendorsLeaf.listActions.some((a) => a.label === 'Create Bill'));
  assert.ok(vendorsLeaf.listActions.some((a) => a.label === 'Register Payment'));
  assert.deepEqual(
    models['res.partner'].listActions.map((a) => a.label),
    ['Create Invoice', 'Create Bill', 'Register Payment'],
  );

  // Create Invoice & Create Bill behavior
  const invRes = createPartnerInvoices(db, [cust.id], 'out_invoice');
  const inv = read(invRes.db, 'account.move', invRes.ids[0]);
  assert.equal(inv.move_type, 'out_invoice');
  assert.equal(inv.state, 'draft');
  assert.equal(inv.partner_id, cust.id);
  assert.equal(inv.invoice_payment_term_id, term.id);
  assert.equal(inv.fiscal_position_id, fp.id);
  assert.equal(invRes.go, `#/accounting/invoices/${inv.id}`);

  const billRes = createPartnerInvoices(invRes.db, [vend.id], 'in_invoice');
  const bill = read(billRes.db, 'account.move', billRes.ids[0]);
  assert.equal(bill.move_type, 'in_invoice');
  assert.equal(bill.partner_id, vend.id);
  assert.equal(bill.partner_bank_id, trustedBank.id);
  assert.equal(billRes.go, `#/accounting/bills/${bill.id}`);

  const batchInvRes = createPartnerInvoices(billRes.db, [cust.id, vend.id], 'out_invoice');
  assert.equal(batchInvRes.ids.length, 2);
  assert.equal(batchInvRes.go, `#/accounting/invoices?view=list&rel=id:${batchInvRes.ids.join(',')}`);

  const archived = create(batchInvRes.db, 'res.partner', { name: 'Archived Partner', active: false });
  assert.throws(() => createPartnerInvoices(archived.db, [archived.id], 'out_invoice'), /Select active partners/);
  assert.throws(() => createPartnerInvoices(archived.db, [], 'out_invoice'), /Select at least one partner first/);
  assert.throws(() => createPartnerInvoices(archived.db, [cust.id], 'entry'), /Unsupported document type/);

  // Register Payment wizard defaults and execution on partner
  const openInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: cust.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 1, name: 'Service', qty: 1, price_unit: 350, tax: 0 }],
  });
  db = postMove(openInv.db, openInv.id);
  const custWizard = partnerRegisterPaymentWizard(db, [cust.id], { defaults: customersLeaf.defaults });
  assert.equal(custWizard.fields.find((f) => f.name === 'payment_type').default, 'inbound');
  assert.equal(custWizard.fields.find((f) => f.name === 'amount').default, '350');

  const vendWizard = partnerRegisterPaymentWizard(db, [vend.id], { defaults: vendorsLeaf.defaults });
  assert.equal(vendWizard.fields.find((f) => f.name === 'payment_type').default, 'outbound');
  assert.equal(vendWizard.fields.find((f) => f.name === 'partner_bank_id').default, trustedBank.id);

  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const payRes = registerPartnerPayments(db, [cust.id], {
    payment_type: 'inbound',
    amount: 350,
    date: '2026-04-05',
    journal_id: bankJournal.id,
    memo: 'Advance',
  });
  const payment = read(payRes.db, 'account.payment', payRes.ids[0]);
  assert.equal(payment.state, 'posted');
  assert.equal(payment.partner_id, cust.id);
  assert.equal(payment.payment_type, 'inbound');
  assert.equal(payment.amount, 350);
  assert.equal(payRes.go, `#/accounting/payments/${payment.id}`);

  // Anti-fraud rule also enforced when Register Payment targets an untrusted bank
  const untrustedBank = create(db, 'res.partner.bank', { partner_id: vend.id, account_number: 'UNTRUSTED-P', allow_out_payment: false });
  assert.throws(() => registerPartnerPayments(untrustedBank.db, [vend.id], {
    payment_type: 'outbound',
    amount: 100,
    journal_id: bankJournal.id,
    partner_bank_id: untrustedBank.id,
  }), /outbound payments/i);

  // FormView ActionsMenu respects app gating and hides on new unsaved records
  const { FormView } = await import('./views/FormView.jsx');
  const ctxAcc = await mountScreen(
    (React) => React.createElement(FormView, {
      leaf: customersLeaf,
      id: cust.id,
      base: '#/accounting/customers',
      params: new URLSearchParams('view=form'),
    }),
    db,
    { hash: `#/accounting/customers/${cust.id}` },
  );
  try {
    const gear = find(ctxAcc.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Actions');
    await ctxAcc.React.act(async () => props(gear).onClick());
    const menuItems = allFind(ctxAcc.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitem').map((n) => n.textContent.trim());
    assert.ok(menuItems.includes('Create Invoice'));
    assert.ok(menuItems.includes('Create Bill'));
    assert.ok(menuItems.includes('Register Payment'));
  } finally {
    await ctxAcc.done();
  }

  for (const action of [...models['res.partner'].menuActions, ...models['res.partner'].listActions]) {
    assert.equal(action.app, 'accounting');
    assert.equal(appOpen(db, { apps: ['contacts', 'crm'] }, action.app), false);
    assert.equal(appOpen(db, { apps: ['accounting'] }, action.app), true);
  }

  const contactsLeaf = menusFor('contacts').find((m) => m.model === 'res.partner');
  const dbNoAcct = { ...db, settings: { ...db.settings, uninstalled: ['accounting'] } };
  const ctxNoAcc = await mountScreen(
    (React) => React.createElement(FormView, {
      leaf: contactsLeaf,
      id: cust.id,
      base: '#/contacts/contacts',
      params: new URLSearchParams('view=form'),
    }),
    dbNoAcct,
    { hash: `#/contacts/contacts/${cust.id}` },
  );
  try {
    const gear = find(ctxNoAcc.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Actions');
    await ctxNoAcc.React.act(async () => props(gear).onClick());
    const menuItems = allFind(ctxNoAcc.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitem').map((n) => n.textContent.trim());
    assert.equal(menuItems.includes('Create Invoice'), false);
    assert.equal(menuItems.includes('Create Bill'), false);
    assert.equal(menuItems.includes('Register Payment'), false);
  } finally {
    await ctxNoAcc.done();
  }

  const ctxNew = await mountScreen(
    (React) => React.createElement(FormView, {
      leaf: customersLeaf,
      id: 'new',
      base: '#/accounting/customers',
      params: new URLSearchParams('view=form'),
    }),
    db,
    { hash: '#/accounting/customers/new' },
  );
  try {
    assert.equal(find(ctxNew.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Actions'), null);
  } finally {
    await ctxNew.done();
  }
});

test('PTN3-3: Invoicing page preferred payment methods, invoice sending method, bank allow_out_payment, and diffDb+applyDiff guards', () => {
  let db = seed();
  const cash = search(db, 'account.journal').find((j) => j.code === 'CSH1');
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cashIn = cash.inbound_payment_method_line_ids[0];
  const checkOut = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing',
  );
  assert.ok(cashIn && checkOut);

  const accTab = models['res.partner'].form.tabs.find((tb) => tb.label === 'Accounting');
  assert.ok(accTab.groups.some((g) => g.title === 'Customer Invoices' && g.fields.some((f) => (f.field ?? f) === 'property_inbound_payment_method_line_id') && g.fields.includes('invoice_sending_method')));
  assert.ok(accTab.groups.some((g) => g.title === 'Vendor Bills' && g.fields.some((f) => (f.field ?? f) === 'property_outbound_payment_method_line_id')));

  // Partner with preferred inbound (cash) & outbound (checks), manual (Download) invoice sending, and untrusted -> trusted bank
  const partner = create(db, 'res.partner', {
    name: 'Preferred Co',
    email: 'billing@preferred.example',
    is_company: true,
    property_inbound_payment_method_line_id: cashIn.id,
    property_outbound_payment_method_line_id: checkOut.id,
    invoice_sending_method: 'manual',
    bank_ids: [{ account_number: 'PREF-BANK-01', allow_out_payment: false }],
  });
  db = partner.db;
  const child = create(db, 'res.partner', { name: 'Branch Contact', parent_id: partner.id, email: 'branch@preferred.example' });
  db = child.db;

  // Standalone account.payment honors partner preferred payment method on createDefaults and onchange
  const inPay = create(db, 'account.payment', {
    partner_id: child.id,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 100,
  });
  const inPayRec = read(inPay.db, 'account.payment', inPay.id);
  assert.equal(inPayRec.journal_id, cash.id);
  assert.equal(inPayRec.payment_method_line_id, cashIn.id);

  const outOnchange = models['account.payment'].onchange(
    { partner_id: partner.id, payment_type: 'outbound', company_id: 1 },
    'partner_id',
    db,
  );
  assert.equal(outOnchange.journal_id, bank.id);
  assert.equal(outOnchange.payment_method_line_id, checkOut.id);

  // Register Payment wizard on invoice & payMove honor partner preferred payment method
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-04-02',
    invoice_line_ids: [{ product_id: 1, name: 'Item', qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const regBtn = models['account.move'].form.buttons.find((b) => b.label === 'Register Payment');
  const regSpec = regBtn.wizard(db, read(db, 'account.move', inv.id));
  assert.equal(regSpec.fields.find((f) => f.name === 'journal_id').default, cash.id);
  assert.equal(regSpec.fields.find((f) => f.name === 'payment_method_line_id').default, cashIn.id);

  const paidInvDb = payMove(db, inv.id, 200);
  const invPayment = search(paidInvDb, 'account.payment').find((p) => p.invoice_id === inv.id);
  assert.equal(invPayment.journal_id, cash.id);
  assert.equal(invPayment.payment_method_line_id, cashIn.id);

  // Send wizard honors invoice_sending_method ('manual' => Download checked, Email unchecked; 'email' => Email checked)
  const sendBtn = models['account.move'].form.buttons.find((b) => b.label === 'Send');
  const sendManual = sendBtn.wizard(db, read(db, 'account.move', inv.id));
  assert.equal(sendManual.fields.find((f) => f.name === 'email').default, false);
  assert.equal(sendManual.fields.find((f) => f.name === 'download').default, true);

  const emailDb = write(db, 'res.partner', partner.id, { invoice_sending_method: 'email' });
  const sendEmail = sendBtn.wizard(emailDb, read(emailDb, 'account.move', inv.id));
  assert.equal(sendEmail.fields.find((f) => f.name === 'email').default, true);
  assert.equal(sendEmail.fields.find((f) => f.name === 'download').default, false);

  // Anti-fraud bank rule: untrusted bank blocked on outbound payment until allow_out_payment=true
  const partnerBank = search(db, 'res.partner.bank').find((b) => b.partner_id === partner.id);
  assert.equal(partnerBank.allow_out_payment, false);
  const directOut = create(db, 'account.payment', {
    partner_id: partner.id,
    partner_type: 'supplier',
    payment_type: 'outbound',
    partner_bank_id: partnerBank.id,
    journal_id: bank.id,
    amount: 50,
  });
  assert.throws(() => postPayment(directOut.db, read(directOut.db, 'account.payment', directOut.id)), /outbound payments/i);

  // Guards are enforceable through diffDb + applyDiff
  const sync = (baseDb, mutated) => applyDiff(baseDb, diffDb(baseDb, mutated));
  const patchPartner = (patch) => ({
    ...db,
    records: {
      ...db.records,
      'res.partner': db.records['res.partner'].map((r) => (r.id === partner.id ? { ...r, ...patch } : r)),
    },
  });

  assert.throws(() => write(db, 'res.partner', partner.id, { invoice_sending_method: 'fax' }), /Invoice Sending must be Email or Download/);
  assert.throws(() => sync(db, patchPartner({ invoice_sending_method: 'fax' })), /Invalid value for res\.partner\.invoice_sending_method/);
  assert.throws(() => sync(db, patchPartner({ property_inbound_payment_method_line_id: checkOut.id })), /Customer preferred payment method must be inbound/);
  assert.throws(() => sync(db, patchPartner({ property_outbound_payment_method_line_id: cashIn.id })), /Vendor preferred payment method must be outbound/);

  const archivedLineDb = write(db, 'account.payment.method.line', cashIn.id, { active: false });
  assert.throws(() => applyDiff(archivedLineDb, diffDb(archivedLineDb, {
    ...archivedLineDb,
    records: {
      ...archivedLineDb.records,
      'res.partner': archivedLineDb.records['res.partner'].map((r) => (r.id === partner.id ? { ...r, property_inbound_payment_method_line_id: cashIn.id } : r)),
    },
  })), /Select an active payment method/);

  const secondCo = create(db, 'res.company', { name: 'Other Co', currency_id: read(db, 'res.company', 1).currency_id });
  const dbMulti = secondCo.db;
  const co2Partner = create(dbMulti, 'res.partner', { name: 'Co2 Partner', company_id: secondCo.id });
  assert.throws(() => applyDiff(co2Partner.db, diffDb(co2Partner.db, {
    ...co2Partner.db,
    records: {
      ...co2Partner.db.records,
      'res.partner': co2Partner.db.records['res.partner'].map((r) => (r.id === co2Partner.id ? { ...r, property_inbound_payment_method_line_id: cashIn.id } : r)),
    },
  })), /Preferred payment method must belong to the partner company/);
});

test('PTN3-4: Arabic translations exist for all new partner invoicing/action strings and errors', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  let tAr;
  try {
    ({ t: tAr } = await import(`./i18n.js?ptn3-ar=${Date.now()}`));
  } finally {
    globalThis.localStorage = prevStorage;
  }

  for (const label of [
    'Customer Payment Method', 'Vendor Payment Method', 'Invoice Sending',
    'Preferred Payment Method', 'Customer Invoices', 'Vendor Bills', 'Download',
    'Create Invoice', 'Create Bill', 'Register Payment',
    'Invoice Sending must be Email or Download',
    'Select an active payment method',
    'Customer preferred payment method must be inbound',
    'Vendor preferred payment method must be outbound',
    'Preferred payment method must belong to the partner company',
    'Unsupported document type',
    'Select at least one partner first',
    'Select active partners',
    'Unsupported payment type',
    'A valid payment date is required',
  ]) {
    const translated = tAr(label);
    assert.ok(translated && translated !== label, `Missing Arabic translation for: ${label}`);
  }
});
