import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { apps, findLeaf, menusFor, models } from './models/index.js';
import { appOpen } from './access.js';
import { createPartnerInvoices, payMove, postMove, registerPartnerPayments, partnerRegisterPaymentWizard, salesInvoiceView } from './models/accounting.js';
import { today } from './models/common.js';
import { upsertCurrencyRate } from './models/currency.js';
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
  // Assigning an archived payment method line to another partner (who does not already hold it) must be rejected.
  assert.throws(() => applyDiff(archivedLineDb, diffDb(archivedLineDb, {
    ...archivedLineDb,
    records: {
      ...archivedLineDb.records,
      'res.partner': archivedLineDb.records['res.partner'].map((r) => (r.id === child.id ? { ...r, property_inbound_payment_method_line_id: cashIn.id } : r)),
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
    'Select a payment type',
    'Amount per partner',
    'Create Draft Payments',
    'Multi-partner payments are created as drafts for review before posting.',
  ]) {
    const translated = tAr(label);
    assert.ok(translated && translated !== label, `Missing Arabic translation for: ${label}`);
  }
});

test('PTN3-5: mixed Send batch partitions Email vs Download partners', async () => {
  let db = seed();
  const emailPartner = create(db, 'res.partner', { name: 'Email Partner', email: 'email@example.com', invoice_sending_method: 'email' });
  db = emailPartner.db;
  const manualPartner = create(db, 'res.partner', { name: 'Manual Partner', email: 'manual@example.com', invoice_sending_method: 'manual' });
  db = manualPartner.db;

  const invEmail = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: emailPartner.id,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, name: 'Email Item', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invEmail.db, invEmail.id);

  const invManual = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: manualPartner.id,
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, name: 'Manual Item', qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(invManual.db, invManual.id);

  const sendAction = salesInvoiceView.listActions.find((a) => a.label === 'Send');
  const spec = sendAction.wizard(db, [invEmail.id, invManual.id]);
  assert.equal(spec.fields.find((f) => f.name === 'email').default, true);
  assert.equal(spec.fields.find((f) => f.name === 'download').default, true);

  // Default mixed run sends email only to email-targeted invoice and downloads only manual invoice
  const defaultRes = sendAction.run(db, [invEmail.id, invManual.id], { email: true, download: true, live: true });
  assert.deepEqual(defaultRes.emailIds, [invEmail.id]);
  assert.equal(defaultRes.go, `#/print/account.move/${invManual.id}`);
  assert.equal(read(defaultRes.db, 'account.move', invManual.id).is_move_sent, true);
  assert.equal(read(defaultRes.db, 'account.move', invEmail.id).is_move_sent, false);

  // End-to-end ActionView live SMTP dispatch only hits /api/mail/document for email-targeted invoice
  const prevFetch = globalThis.fetch;
  const prevAlert = globalThis.alert;
  const prevConfirm = globalThis.confirm;
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => ({ unref() {} });
  globalThis.alert = () => {};
  globalThis.confirm = () => true;
  const mailedIds = [];
  let serverDb = db;
  globalThis.fetch = async (url, init) => {
    if (url === '/api/session') {
      return new Response(JSON.stringify({ name: 'Admin', isAdmin: true, integrations: { smtp: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/db') {
      return new Response(JSON.stringify(serverDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/diff') {
      serverDb = applyDiff(serverDb, JSON.parse(init.body), { isAdmin: true });
      return new Response(JSON.stringify(serverDb), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url === '/api/mail/document') {
      const body = JSON.parse(init.body);
      mailedIds.push(body.id);
      serverDb = write(serverDb, 'account.move', body.id, { is_move_sent: true });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const invoicesLeaf = findLeaf(apps.find((a) => a.id === 'accounting'), 'invoices');
  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountScreen(
    (React) => React.createElement(ActionView, { leaf: invoicesLeaf, base: '#/accounting/invoices', params: new URLSearchParams('view=list') }),
    db,
    { hash: '#/accounting/invoices?view=list' },
  );
  try {
    const checkboxes = () => allFind(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    const rowEmailIdx = checkboxes().findIndex((cb) => cb.parentNode?.parentNode?.textContent?.includes(read(db, 'account.move', invEmail.id).name));
    const rowManualIdx = checkboxes().findIndex((cb) => cb.parentNode?.parentNode?.textContent?.includes(read(db, 'account.move', invManual.id).name));
    assert.ok(rowEmailIdx > 0 && rowManualIdx > 0);
    await ctx.React.act(async () => props(checkboxes()[rowEmailIdx]).onChange());
    await ctx.React.act(async () => props(checkboxes()[rowManualIdx]).onChange());
    const sendBtn = allFind(ctx.host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Send');
    await ctx.React.act(async () => props(sendBtn).onClick());
    await ctx.React.act(async () => {
      const form = find(ctx.host, (n) => n.tagName === 'FORM' && hasClass(n, 'wizard'));
      await props(form).onSubmit({ preventDefault() {} });
    });
    assert.deepEqual(mailedIds, [invEmail.id], 'Download-only partner invoice must not be emailed in default mixed batch');
    assert.equal(globalThis.location.hash, `#/print/account.move/${invManual.id}`);
    assert.equal(read(ctx.store.getDb(), 'account.move', invManual.id).is_move_sent, true);
  } finally {
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    await ctx.done();
    globalThis.fetch = prevFetch;
    globalThis.alert = prevAlert;
    globalThis.confirm = prevConfirm;
    globalThis.setInterval = origSetInterval;
    await ctx.store.initStore();
  }
});

test('PTN3-6: createPartnerInvoices leaves bill bank unset when vendor only has untrusted banks', () => {
  let db = seed();
  const vendor = create(db, 'res.partner', { name: 'Untrusted Bank Vendor', supplier_rank: 1 });
  db = vendor.db;
  const untrusted = create(db, 'res.partner.bank', { partner_id: vendor.id, account_number: 'UNTRUST-1', allow_out_payment: false });
  db = untrusted.db;

  const billRes = createPartnerInvoices(db, [vendor.id], 'in_invoice');
  const bill = read(billRes.db, 'account.move', billRes.ids[0]);
  assert.equal(bill.partner_bank_id ?? null, null);

  // Bill created this way can be posted and paid normally without bank-trust rejection
  const withLine = write(billRes.db, 'account.move', bill.id, {
    invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, name: 'Supply', qty: 1, price_unit: 120, tax: 0 }],
  });
  const posted = postMove(withLine, bill.id);
  assert.doesNotThrow(() => payMove(posted, bill.id, 120));

  // Once a trusted bank exists, createPartnerInvoices selects the trusted one (not the untrusted one)
  const trusted = create(db, 'res.partner.bank', { partner_id: vendor.id, account_number: 'TRUST-2', allow_out_payment: true });
  const billRes2 = createPartnerInvoices(trusted.db, [vendor.id], 'in_invoice');
  assert.equal(read(billRes2.db, 'account.move', billRes2.ids[0]).partner_bank_id, trusted.id);
});

test('PTN3-7: partner Register Payment direction uses leaf defaults, infers outbound for vendor-only sets, and avoids silent inbound on ambiguity', async () => {
  let db = seed();
  const dual = create(db, 'res.partner', { name: 'Dual Role Partner', customer_rank: 1, supplier_rank: 1 });
  db = dual.db;
  const vendOnly1 = create(db, 'res.partner', { name: 'Vendor Only 1', supplier_rank: 1, customer_rank: 0 });
  db = vendOnly1.db;
  const vendOnly2 = create(db, 'res.partner', { name: 'Vendor Only 2', supplier_rank: 2, customer_rank: 0 });
  db = vendOnly2.db;

  // Purchase Vendors leaf also carries supplier_rank default
  const purchaseVendorsLeaf = findLeaf(apps.find((a) => a.id === 'purchase'), 'vendors');
  assert.equal(purchaseVendorsLeaf.defaults?.supplier_rank, 1);
  const accountingVendorsLeaf = findLeaf(apps.find((a) => a.id === 'accounting'), 'vendors');
  assert.equal(accountingVendorsLeaf.defaults?.supplier_rank, 1);

  // Dual-role partner from Vendors leaf defaults to outbound; without defaults requires explicit selection
  assert.equal(
    partnerRegisterPaymentWizard(db, [dual.id], { defaults: accountingVendorsLeaf.defaults }).fields.find((f) => f.name === 'payment_type').default,
    'outbound',
  );
  assert.equal(
    partnerRegisterPaymentWizard(db, [dual.id]).fields.find((f) => f.name === 'payment_type').default,
    null,
  );
  assert.throws(() => registerPartnerPayments(db, [dual.id], { amount: 50 }), /Select a payment type/);

  // Multi-partner vendor-only selection without leaf defaults infers outbound; mixed selection requires explicit direction
  assert.equal(
    partnerRegisterPaymentWizard(db, [vendOnly1.id, vendOnly2.id]).fields.find((f) => f.name === 'payment_type').default,
    'outbound',
  );
  assert.equal(
    partnerRegisterPaymentWizard(db, [vendOnly1.id, dual.id]).fields.find((f) => f.name === 'payment_type').default,
    null,
  );

  // FormView ActionsMenu passes leaf defaults into the wizard for a dual-role partner opened from Vendors
  const { FormView } = await import('./views/FormView.jsx');
  const ctx = await mountScreen(
    (React) => React.createElement(FormView, {
      leaf: accountingVendorsLeaf,
      id: dual.id,
      base: '#/accounting/vendors',
      params: new URLSearchParams('view=form'),
    }),
    db,
    { hash: `#/accounting/vendors/${dual.id}` },
  );
  try {
    const gear = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Actions');
    await ctx.React.act(async () => props(gear).onClick());
    const regItem = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitem').find((n) => n.textContent.trim() === 'Register Payment');
    await ctx.React.act(async () => props(regItem).onClick());
    const dialog = find(ctx.host, (n) => n.tagName === 'FORM' && hasClass(n, 'wizard'));
    const select = find(dialog, (n) => n.tagName === 'SELECT' && props(n)?.id === 'w-payment_type');
    assert.equal(props(select).value, 'outbound');
  } finally {
    await ctx.done();
  }
});

test('PTN3-8: archived or deleted preferred payment method line does not block unrelated partner edits', () => {
  let db = seed();
  const cash = search(db, 'account.journal').find((j) => j.code === 'CSH1');
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cashIn = cash.inbound_payment_method_line_ids[0];
  const checkOut = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing',
  );
  const manualOut = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'manual',
  );
  const partner = create(db, 'res.partner', {
    name: 'Legacy Pref Partner',
    email: 'old@example.com',
    property_inbound_payment_method_line_id: cashIn.id,
    property_outbound_payment_method_line_id: checkOut.id,
  });
  db = partner.db;
  const sync = (baseDb, mutated) => applyDiff(baseDb, diffDb(baseDb, mutated));

  // Archive the referenced inbound payment method line: unrelated edits succeed via write and diffDb+applyDiff
  const archivedLineDb = write(db, 'account.payment.method.line', cashIn.id, { active: false });
  const editedWrite = write(archivedLineDb, 'res.partner', partner.id, { email: 'new@example.com', phone: '555-0100' });
  assert.equal(read(editedWrite, 'res.partner', partner.id).property_inbound_payment_method_line_id, cashIn.id);
  const editedSync = sync(archivedLineDb, {
    ...archivedLineDb,
    records: {
      ...archivedLineDb.records,
      'res.partner': archivedLineDb.records['res.partner'].map((r) => (r.id === partner.id ? { ...r, email: 'sync@example.com' } : r)),
    },
  });
  assert.equal(read(editedSync, 'res.partner', partner.id).email, 'sync@example.com');

  // Changing the other preference still validates only the changed preference
  assert.doesNotThrow(() => write(archivedLineDb, 'res.partner', partner.id, { property_outbound_payment_method_line_id: manualOut.id }));

  // Clearing the archived preference succeeds, while assigning an archived line to another partner fails
  assert.doesNotThrow(() => write(archivedLineDb, 'res.partner', partner.id, { property_inbound_payment_method_line_id: null }));
  const other = create(archivedLineDb, 'res.partner', { name: 'Other Partner' });
  assert.throws(() => write(other.db, 'res.partner', other.id, { property_inbound_payment_method_line_id: cashIn.id }), /Select an active payment method/);

  // Archiving the referenced journal also allows unrelated partner edits
  const archivedJournalDb = write(db, 'account.journal', cash.id, { active: false });
  assert.doesNotThrow(() => write(archivedJournalDb, 'res.partner', partner.id, { street: '10 Nile St' }));

  // Deleting the referenced payment method line also allows unrelated partner edits
  const deletedLineDb = {
    ...db,
    records: {
      ...db.records,
      'account.payment.method.line': db.records['account.payment.method.line'].filter((l) => l.id !== cashIn.id),
    },
  };
  assert.doesNotThrow(() => write(deletedLineDb, 'res.partner', partner.id, { phone: '555-0200' }));
});

test('PTN3-9: partnerRegisterPaymentWizard converts foreign residuals by payment date, nets refunds/credit notes, and clears on missing rate', () => {
  let db = seed();
  const companyCurrId = read(db, 'res.company', 1).currency_id;
  const eur = db.records['res.currency'].find((c) => c.id !== companyCurrId);
  assert.ok(eur, 'seed has a foreign currency');
  // 1 USD = 0.8 EUR on 2026-04-01 (100 EUR = 125 USD); 1 USD = 0.5 EUR on 2026-05-01 (100 EUR = 200 USD)
  db = upsertCurrencyRate(db, eur.id, { date: '2026-04-01', rate: 0.8 });
  db = upsertCurrencyRate(db, eur.id, { date: '2026-05-01', rate: 0.5 });

  const cust = create(db, 'res.partner', { name: 'FX Customer', customer_rank: 1 });
  db = cust.db;

  const invEur = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: cust.id,
    currency_id: eur.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 1, name: 'EUR Service', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invEur.db, invEur.id);

  const invCo = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: cust.id,
    currency_id: companyCurrId,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 1, name: 'USD Service', qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(invCo.db, invCo.id);

  const cnEur = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: cust.id,
    currency_id: eur.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 1, name: 'EUR Credit', qty: 1, price_unit: 20, tax: 0 }],
  });
  db = postMove(cnEur.db, cnEur.id);

  const spec = partnerRegisterPaymentWizard(db, [cust.id], { defaults: { customer_rank: 1 } });
  // On 2026-04-01: 125 + 50 - 25 = 150; on 2026-05-01 (and today if >= 2026-05-01): 200 + 50 - 40 = 210
  assert.equal(spec.onchange({ payment_type: 'inbound', date: '2026-04-01' }, 'date').amount, '150');
  assert.equal(spec.onchange({ payment_type: 'inbound', date: '2026-05-01' }, 'date').amount, '210');
  // Before any EUR exchange rate exists, conversion is impossible so default amount is left empty
  assert.equal(spec.onchange({ payment_type: 'inbound', date: '2000-01-01' }, 'date').amount, '');

  // If the credit note exceeds open invoices, amount defaults to empty
  const bigCn = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: cust.id,
    currency_id: companyCurrId,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 1, name: 'Big Credit', qty: 1, price_unit: 500, tax: 0 }],
  });
  const bigCnDb = postMove(bigCn.db, bigCn.id);
  assert.equal(partnerRegisterPaymentWizard(bigCnDb, [cust.id], { defaults: { customer_rank: 1 } }).fields.find((f) => f.name === 'amount').default, '');

  // Outbound vendor bills and refunds in foreign currency convert and net properly too
  const vend = create(db, 'res.partner', { name: 'FX Vendor', supplier_rank: 1 });
  let vDb = vend.db;
  const billEur = create(vDb, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vend.id,
    currency_id: eur.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 1, name: 'EUR Bill', qty: 1, price_unit: 100, tax: 0 }],
  });
  vDb = postMove(billEur.db, billEur.id);
  const vRefEur = create(vDb, 'account.move', {
    move_type: 'in_refund',
    partner_id: vend.id,
    currency_id: eur.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 1, name: 'EUR Vendor Refund', qty: 1, price_unit: 20, tax: 0 }],
  });
  vDb = postMove(vRefEur.db, vRefEur.id);
  const vSpec = partnerRegisterPaymentWizard(vDb, [vend.id], { defaults: { supplier_rank: 1 } });
  // On 2026-04-01: 125 - 25 = 100 USD
  assert.equal(vSpec.onchange({ payment_type: 'outbound', date: '2026-04-01' }, 'date').amount, '100');
  // On 2026-05-01: 200 - 40 = 160 USD
  assert.equal(vSpec.onchange({ payment_type: 'outbound', date: '2026-05-01' }, 'date').amount, '160');
});

test('PTN3-10: multi-partner registerPartnerPayments creates draft payments instead of posting N full amounts', () => {
  let db = seed();
  const c1 = create(db, 'res.partner', { name: 'Multi Cust 1', customer_rank: 1 });
  db = c1.db;
  const c2 = create(db, 'res.partner', { name: 'Multi Cust 2', customer_rank: 1 });
  db = c2.db;

  const wizard = partnerRegisterPaymentWizard(db, [c1.id, c2.id], { defaults: { customer_rank: 1 } });
  assert.equal(wizard.confirmLabel, 'Create Draft Payments');
  assert.equal(wizard.fields.find((f) => f.name === 'amount').label, 'Amount per partner');

  const movesBefore = (db.records['account.move'] ?? []).length;
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const res = registerPartnerPayments(db, [c1.id, c2.id], {
    payment_type: 'inbound',
    amount: 100,
    date: today(),
    journal_id: bankJournal.id,
  });
  assert.equal(res.ids.length, 2);
  for (const id of res.ids) {
    const p = read(res.db, 'account.payment', id);
    assert.equal(p.state, 'draft', 'multi-partner payment must stay draft so no duplicate cash is posted');
    assert.equal(p.move_id ?? null, null);
  }
  assert.equal((res.db.records['account.move'] ?? []).length, movesBefore);
  assert.equal(res.go, `#/accounting/payments?view=list&rel=id:${res.ids.join(',')}`);
});
