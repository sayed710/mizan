import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { migrate } from './migrations.js';
import { createCompany, setCompanies } from './models/company.js';

/** Load an Arabic-configured `t` function cleanly with localStorage restored. */
async function arabicTranslator() {
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null) },
  });
  try {
    const { t } = await import(`./i18n.js?qodo117-ar=${Date.now()}`);
    return t;
  } finally {
    if (prevDescriptor) Object.defineProperty(globalThis, 'localStorage', prevDescriptor);
    else delete globalThis.localStorage;
  }
}
import {
  createCompanyWithDefaultInvoiceJournals,
  withDefaultBankJournal,
} from './test-support/accounting-company.js';
import {
  journalItemIdentity,
  paymentJournal,
  reconciledJournalItems,
} from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import {
  postPayment,
  reconcileJournalItems,
  unreconcileJournalItems,
  writeoffJournalItem,
} from './models/pay.js';
import {
  agedBalance,
  followUpLevel,
  followUps,
  logManualFollowUp,
  partnerFollowUp,
  runFollowUps,
} from './models/finance.js';
import { postAnalytic } from './models/analyticplus.js';
import { deliver, receive } from './models/valuation.js';
import { menusFor } from './models/index.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};
const findLeafByKey = (items, key) => {
  for (const item of items) {
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
      return child;
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
    getDb,
    commit,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

function makePostedInvoice(db, {
  partnerId,
  companyId = 1,
  invoiceDate = '2026-05-01',
  dueDate = '2026-05-10',
  amount = 500,
  paymentTermId = null,
} = {}) {
  const income = search(db, 'account.account').find((a) => a.account_type === 'income' && (a.company_id ?? 1) === companyId)
    ?? search(db, 'account.account').find((a) => a.account_type === 'income');
  const created = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerId,
    company_id: companyId,
    invoice_date: invoiceDate,
    invoice_date_due: dueDate,
    ...(paymentTermId ? { invoice_payment_term_id: paymentTermId } : {}),
    invoice_line_ids: [{ name: 'Service', account_id: income.id, qty: 1, price_unit: amount, tax_ids: [] }],
  });
  return { id: created.id, db: postMove(created.db, created.id) };
}

test('Finding 1: createCompanyWithDefaultInvoiceJournals and withDefaultBankJournal isolate company-1 accounts', () => {
  let db = seed();
  const bankAcc = create(db, 'account.account', { code: '101488', name: 'Co1 Scoped Bank', account_type: 'asset_cash', company_id: 1 });
  const suspenseAcc = create(bankAcc.db, 'account.account', { code: '101489', name: 'Co1 Scoped Suspense', account_type: 'asset_current', company_id: 1 });
  const partnerBank = create(suspenseAcc.db, 'res.partner.bank', {
    account_number: 'EG0010002000',
    partner_id: read(suspenseAcc.db, 'res.company', 1).partner_id ?? 1,
    company_id: 1,
  });
  db = partnerBank.db;
  const co1Bank = db.records['account.journal'].find((j) => j.company_id === 1 && j.default_for_payments === true);
  db = write(db, 'account.journal', co1Bank.id, {
    default_account_id: bankAcc.id,
    suspense_account_id: suspenseAcc.id,
    bank_account_id: partnerBank.id,
  });

  const co2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch Co' });
  const co2Bank = co2.db.records['account.journal'].find((j) => j.company_id === co2.id && j.default_for_payments === true);
  assert.ok(co2Bank, 'company 2 gets its own default bank journal');
  assert.equal(read(co2.db, 'account.account', co2Bank.default_account_id).company_id, co2.id);
  assert.equal(read(co2.db, 'account.account', co2Bank.suspense_account_id).company_id, co2.id);
  assert.equal(paymentJournal(co2.db, null, co2.id).id, co2Bank.id);

  // Direct withDefaultBankJournal call on another company also succeeds cleanly
  const co3 = createCompany(co2.db, { name: 'Third Co' });
  const withBank3 = withDefaultBankJournal(co3.db, co3.id);
  const co3Bank = withBank3.records['account.journal'].find((j) => j.company_id === co3.id && j.default_for_payments === true);
  assert.ok(co3Bank);
  assert.equal(read(withBank3, 'account.account', co3Bank.default_account_id).company_id, co3.id);
});

test('Finding 2: new liquidity journals default to current company and single-company unscoped defaults resolve', () => {
  let db = seed();
  // 1. Newly created bank/cash/credit journal without company_id inherits currentCompany(db)
  const cashCo1 = create(db, 'account.journal', {
    name: 'Petty Cash 1',
    code: 'PC1',
    type: 'cash',
    default_account_id: search(db, 'account.account').find((a) => a.code === '101404').id,
    suspense_account_id: search(db, 'account.account').find((a) => a.code === '101401').id,
  });
  assert.equal(read(cashCo1.db, 'account.journal', cashCo1.id).company_id, 1);

  const co2 = createCompanyWithDefaultInvoiceJournals(cashCo1.db, { name: 'Company Two' });
  const multi = setCompanies(co2.db, { current: co2.id, allowed: [1, co2.id] });
  const co2CashAcc = create(multi, 'account.account', { code: '101498', name: 'Card Co2', account_type: 'asset_cash', company_id: co2.id });
  const co2SuspAcc = create(co2CashAcc.db, 'account.account', { code: '101499', name: 'Card Co2 Suspense', account_type: 'asset_cash', company_id: co2.id });
  const cardCo2 = create(co2SuspAcc.db, 'account.journal', {
    name: 'Corporate Card 2',
    code: 'CRD2',
    type: 'credit',
    default_account_id: co2CashAcc.id,
    suspense_account_id: co2SuspAcc.id,
  });
  assert.equal(read(cardCo2.db, 'account.journal', cardCo2.id).company_id, co2.id);

  // 2. Upgraded single-company DB with unscoped liquidity journal (shared accounts & no/unscoped moves) resolves to sole company
  const baseSingle = seed();
  const sharedAcc = create(baseSingle, 'account.account', { code: '101495', name: 'Shared Liq', account_type: 'asset_cash', company_id: null });
  const singleLegacy = {
    ...sharedAcc.db,
    schema_version: 48,
    records: {
      ...sharedAcc.db.records,
      'account.journal': [
        ...sharedAcc.db.records['account.journal'].map((j) => (j.default_for_payments ? { ...j, default_for_payments: false } : j)),
        { id: 980, name: 'Legacy Bank', code: 'LBNK', type: 'bank', active: true, default_for_payments: true, default_account_id: sharedAcc.id, suspense_account_id: sharedAcc.id },
      ],
      'account.move': [
        { id: 981, name: 'OLD/1', journal_id: 980, state: 'posted' },
      ],
    },
  };
  const migratedSingle = migrate(singleLegacy);
  assert.equal(read(migratedSingle, 'account.journal', 980).company_id, 1);
  assert.equal(paymentJournal(migratedSingle, null, 1).id, 980);

  // 3. Multi-company DB with unscoped journal keeps it unresolved with chatter note and never falls back silently
  const co2Bare = createCompany(baseSingle, { name: 'Second' });
  const sharedAccMulti = create(co2Bare.db, 'account.account', { code: '101496', name: 'Shared Multi Liq', account_type: 'asset_cash', company_id: null });
  const multiLegacy = {
    ...sharedAccMulti.db,
    schema_version: 48,
    records: {
      ...sharedAccMulti.db.records,
      'account.journal': [
        ...sharedAccMulti.db.records['account.journal'].filter((j) => !j.default_for_payments),
        { id: 982, name: 'Ambiguous Default Bank', code: 'ABNK', type: 'bank', active: true, default_for_payments: true, default_account_id: sharedAccMulti.id, suspense_account_id: sharedAccMulti.id },
      ],
    },
  };
  const migratedMulti = migrate(multiLegacy);
  assert.equal(read(migratedMulti, 'account.journal', 982).company_id ?? null, null);
  assert.ok((migratedMulti.messages ?? []).some((m) => m.model === 'account.journal' && m.res_id === 982));
  assert.throws(() => paymentJournal(migratedMulti, null, 1), /Select a payment journal/);
  assert.throws(() => paymentJournal(migratedMulti, null, co2Bare.id), /Select a payment journal/);
});

test('Finding 3: configured follow-up activity is created even when notification channel fails or cannot deliver', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [] } };

  // Level 1: SMS + Activity (SMS cannot auto-deliver)
  const smsLvl = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: false,
    send_sms: true,
    create_activity: true,
    activity_type_id: 'call',
    activity_summary: 'SMS follow-up call',
  });
  // Level 2: Email + Activity (email delivery throws)
  const emailLvl = create(smsLvl.db, 'account.followup.level', {
    display_delay: 15,
    reminder_timing: 'after',
    send_email: true,
    send_sms: false,
    create_activity: true,
    activity_type_id: 'todo',
    activity_summary: 'Email fallback task',
  });
  const partner = create(emailLvl.db, 'res.partner', { name: 'Activity Check Partner', email: 'act@example.test', phone: '+201000000' });
  const inv = makePostedInvoice(partner.db, { partnerId: partner.id, invoiceDate: '2026-04-01', dueDate: '2026-04-10', amount: 250 });
  db = inv.db;

  // At 2026-04-16 (6 days overdue -> hits SMS + Activity level): activity must be created even though SMS cannot auto-send
  db = runFollowUps(db, '2026-04-16');
  let activities = search(db, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === partner.id);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].summary, 'SMS follow-up call');
  assert.equal(partnerFollowUp(read(db, 'res.partner', partner.id), 1)?.followup_level_delay ?? null, null);

  // Repeating while still in SMS level must not duplicate the activity
  db = runFollowUps(db, '2026-04-17');
  assert.equal(search(db, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === partner.id).length, 1);

  // At 2026-04-26 (16 days overdue -> hits Email + Activity level), email fails -> activity must still be created once
  db = await runFollowUps(db, '2026-04-26', async () => { throw new Error('SMTP unavailable'); });
  activities = search(db, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === partner.id);
  assert.equal(activities.length, 2);
  assert.equal(activities[1].summary, 'Email fallback task');
  assert.equal(partnerFollowUp(read(db, 'res.partner', partner.id), 1)?.followup_delivery_state, 'not_sent');
});

test('Finding 4: SMS-only follow-up level renders Confirm Sent without email and records SMS channel', async () => {
  let db = seed();
  db = {
    ...db,
    records: {
      ...db.records,
      'account.followup.level': [],
      'account.move': [],
    },
  };
  const smsLvl = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: false,
    send_sms: true,
  });
  const partner = create(smsLvl.db, 'res.partner', { name: 'SMS Only Customer', phone: '+20123456789' });
  const due = addDays(today(), -10);
  const inv = makePostedInvoice(partner.db, { partnerId: partner.id, invoiceDate: addDays(due, -10), dueDate: due, amount: 300 });
  db = inv.db;

  // Direct API call works without email
  const directSms = logManualFollowUp(db, partner.id, today(), { companyId: 1, channel: 'sms' });
  assert.equal(partnerFollowUp(read(directSms, 'res.partner', partner.id), 1)?.followup_channel, 'sms');

  // UI FollowUpActions renders Confirm Sent even without email and records channel 'sms'
  const { Reports } = await import('./views/Reports.jsx');
  const mounted = await mountView((React) => React.createElement(Reports, { leaf: { report: 'followups' } }), db);
  try {
    const mailLink = find(mounted.host, (n) => n.tagName === 'A' && props(n)?.href?.startsWith('mailto:'));
    assert.equal(mailLink, null, 'no mailto link without email');
    const confirmBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Confirm Sent');
    assert.ok(confirmBtn, 'Confirm Sent button rendered for SMS-only customer');
    await mounted.React.act(async () => props(confirmBtn).onClick());
    const saved = mounted.getDb();
    const progress = partnerFollowUp(read(saved, 'res.partner', partner.id), 1);
    assert.equal(progress?.followup_channel, 'sms');
    assert.equal(progress?.followup_delivery_state, 'sent');
    assert.match(saved.messages.at(-1).body, /sent by sms/);
  } finally {
    await mounted.done();
  }
});

test('Finding 5: account.followup.level form exposes editable email message field and preserves stored message', async () => {
  let db = seed();
  const lvlRes = create(db, 'account.followup.level', {
    display_delay: 7,
    reminder_timing: 'after',
    send_email: true,
    message: 'Initial custom reminder text',
  });
  db = lvlRes.db;

  const { FormView } = await import('./views/FormView.jsx');
  const leaf = findLeafByKey(menusFor('accounting'), 'followup-levels');
  const mounted = await mountView((React) => React.createElement(FormView, {
    leaf,
    id: lvlRes.id,
    base: '#/accounting/followup-levels',
    params: new URLSearchParams(),
  }), db);
  try {
    const msgField = find(mounted.host, (n) => n.tagName === 'TEXTAREA' && props(n)?.id === 'f-message');
    assert.ok(msgField, 'editable email message field is present in Notification tab');
    assert.equal(props(msgField)?.value, 'Initial custom reminder text');
    await mounted.React.act(async () => props(msgField).onChange({ target: { value: 'Updated custom email text' } }));
    const saveBtn = allFind(mounted.host, (n) => n.tagName === 'BUTTON').find((b) => textOf(b).trim() === 'Save');
    await mounted.React.act(async () => props(saveBtn).onClick());
    assert.equal(read(mounted.getDb(), 'account.followup.level', lvlRes.id).message, 'Updated custom email text');

    const partner = create(mounted.getDb(), 'res.partner', { name: 'Email Body Customer', email: 'body@example.test' });
    const inv = makePostedInvoice(partner.db, { partnerId: partner.id, invoiceDate: '2026-04-01', dueDate: '2026-04-05', amount: 400 });
    const sentEmails = [];
    // 2026-04-13 is 8 days past dueDate 2026-04-05, so lvlRes (delay 7) matches ahead of seed's 15-day level.
    runFollowUps(inv.db, '2026-04-13', (m) => sentEmails.push(m));
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].text, /Updated custom email text/);
    const tAr = await arabicTranslator();
    assert.notEqual(tAr('Email Message'), 'Email Message');
    assert.notEqual(tAr('Optional email reminder message'), 'Optional email reminder message');
  } finally {
    await mounted.done();
  }
});

test('Finding 6: postAnalytic does not duplicate allocations on pre-upgrade in_refund moves', () => {
  let db = seed();
  const a1 = create(db, 'account.analytic.account', { name: 'Analytic One' });
  const a2 = create(a1.db, 'account.analytic.account', { name: 'Analytic Two' });
  const vendor = create(a2.db, 'res.partner', { name: 'Refund Vendor', supplier: true });
  const product = search(vendor.db, 'product')[0];
  const refund = create(vendor.db, 'account.move', {
    move_type: 'in_refund',
    partner_id: vendor.id,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{
      product_id: product.id,
      name: product.name,
      qty: 2,
      price_unit: 100,
      discount: 0,
      tax: 0,
      analytic_distribution: { [a1.id]: 60, [a2.id]: 40 },
    }],
  });
  db = postMove(refund.db, refund.id);

  // Simulate pre-PR117 analytic lines stored under legacy category 'invoice'
  const preUpgradeDb = {
    ...db,
    schema_version: 47,
    records: {
      ...db.records,
      'account.analytic.line': db.records['account.analytic.line'].map((l) => (
        l.move_id === refund.id ? { ...l, category: 'invoice' } : l
      )),
    },
  };

  // Direct retry without migration must not duplicate
  const directRetry = postAnalytic(preUpgradeDb, refund.id);
  assert.equal(directRetry.records['account.analytic.line'].filter((l) => l.move_id === refund.id).length, 2);

  // Migrated retry also preserves exact count
  const upgraded = migrate(preUpgradeDb);
  const upgradedRetry = postAnalytic(upgraded, refund.id);
  assert.equal(upgradedRetry.records['account.analytic.line'].filter((l) => l.move_id === refund.id).length, 2);
});

test('Finding 7: category upgrade preserves conflicting legacy income/expense accounts and posts chatter note', async () => {
  let db = seed();
  const legacyExp = create(db, 'account.account', { code: '609701', name: 'Legacy Expense', account_type: 'expense', company_id: 1 });
  const cogsAcc = create(legacyExp.db, 'account.account', { code: '509702', name: 'Existing COGS', account_type: 'expense_direct_cost', company_id: 1 });
  const legacyInc = create(cogsAcc.db, 'account.account', { code: '409701', name: 'Legacy Income', account_type: 'income', company_id: 1 });
  const categInc = create(legacyInc.db, 'account.account', { code: '409702', name: 'Existing Categ Income', account_type: 'income', company_id: 1 });
  const stockAcc = create(categInc.db, 'account.account', { code: '110701', name: 'Stock 7', account_type: 'asset_current', company_id: 1 });
  const inputAcc = create(stockAcc.db, 'account.account', { code: '110702', name: 'Input 7', account_type: 'asset_current', company_id: 1 });
  db = inputAcc.db;

  const legacyDb = {
    ...db,
    schema_version: 47,
    records: {
      ...db.records,
      'product.category': [
        ...(db.records['product.category'] ?? []),
        {
          id: 970,
          name: 'Conflicting Legacy Category',
          parent_id: null,
          property_valuation: 'real_time',
          property_cost_method: 'fifo',
          property_account_expense_id: legacyExp.id,
          property_account_expense_categ_id: cogsAcc.id,
          property_account_income_id: legacyInc.id,
          property_account_income_categ_id: categInc.id,
          property_stock_valuation_account_id: stockAcc.id,
          property_stock_account_input_categ_id: inputAcc.id,
        },
        {
          id: 972,
          name: 'Conflicting Periodic Category',
          parent_id: null,
          property_valuation: 'manual_periodic',
          property_cost_method: 'standard',
          property_account_expense_id: legacyExp.id,
          property_account_expense_categ_id: cogsAcc.id,
          property_account_income_id: legacyInc.id,
          property_account_income_categ_id: categInc.id,
        },
      ],
      product: [
        ...(db.records.product ?? []),
        {
          id: 971,
          name: 'Dual Account Goods',
          type: 'goods',
          categ_id: 970,
          list_price: 100,
          cost: 40,
          qty_available: 0,
          cost_method: null,
          valuation: null,
          sale_ok: true,
          purchase_ok: true,
        },
        {
          id: 973,
          name: 'Periodic Conflicted Goods',
          type: 'goods',
          categ_id: 972,
          list_price: 100,
          cost: 40,
          qty_available: 0,
          cost_method: null,
          valuation: null,
          sale_ok: true,
          purchase_ok: true,
        },
      ],
    },
  };

  const migrated = migrate(legacyDb);
  const cat = read(migrated, 'product.category', 970);
  // Legacy accounts must not be dropped silently when conflicting with existing categ fields
  assert.equal(cat.property_account_expense_id, legacyExp.id);
  assert.equal(cat.property_account_expense_categ_id, cogsAcc.id);
  assert.equal(cat.property_account_income_id, legacyInc.id);
  assert.equal(cat.property_account_income_categ_id, categInc.id);

  // Periodic vendor bill uses preserved legacy expense account, while real-time perpetual delivery still uses COGS
  const vendor = create(migrated, 'res.partner', { name: 'Vendor 7', supplier: true });
  const bill = create(vendor.db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: 973, qty: 1, price_unit: 40, tax: 0 }],
  });
  const postedBillDb = postMove(bill.db, bill.id);
  assert.ok(read(postedBillDb, 'account.move', bill.id).line_ids.some((l) => l.account_id === legacyExp.id && l.debit === 40));

  const received = receive(postedBillDb, 971, 2, 40, { date: '2026-06-02' });
  const delivered = deliver(received, 971, 1, { date: '2026-06-03' });
  const outLayer = search(delivered.db, 'stock.valuation.layer').find((l) => l.product_id === 971 && l.kind === 'out');
  assert.ok(read(delivered.db, 'account.move', outLayer.move_id).line_ids.some((l) => l.account_id === cogsAcc.id && l.debit === 40));

  // Chatter upgrade note posted (and idempotent on re-migrate, with Arabic translation)
  const notes = (migrated.messages ?? []).filter((m) => m.model === 'product.category' && m.res_id === 970);
  assert.equal(notes.length, 1);
  assert.equal((migrate(migrated).messages ?? []).filter((m) => m.model === 'product.category' && m.res_id === 970).length, 1);
  const tAr = await arabicTranslator();
  assert.notEqual(tAr(notes[0].body), notes[0].body);
});

test('Finding 8: before follow-up levels do not mix upcoming invoices into overdue reminders or use overdue wording', () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [] } };
  const beforeLvl = create(db, 'account.followup.level', { display_delay: 5, reminder_timing: 'before', send_email: true });
  const afterLvl = create(beforeLvl.db, 'account.followup.level', { display_delay: 15, reminder_timing: 'after', send_email: true });
  db = afterLvl.db;

  const pMixed = create(db, 'res.partner', { name: 'Mixed Overdue & Future', email: 'mixed@example.test' });
  const pUpcomingOnly = create(pMixed.db, 'res.partner', { name: 'Upcoming Only', email: 'upcoming@example.test' });
  const pOutside = create(pUpcomingOnly.db, 'res.partner', { name: 'Outside Window', email: 'outside@example.test' });
  db = pOutside.db;

  db = makePostedInvoice(db, { partnerId: pMixed.id, invoiceDate: '2026-04-01', dueDate: '2026-04-20', amount: 100 }).db;
  db = makePostedInvoice(db, { partnerId: pMixed.id, invoiceDate: '2026-05-01', dueDate: '2026-05-18', amount: 200 }).db;
  db = makePostedInvoice(db, { partnerId: pUpcomingOnly.id, invoiceDate: '2026-05-01', dueDate: '2026-05-18', amount: 500 }).db;
  db = makePostedInvoice(db, { partnerId: pOutside.id, invoiceDate: '2026-05-01', dueDate: '2026-05-25', amount: 400 }).db;

  const at = '2026-05-15';
  const groups = followUps(db, at);
  assert.equal(groups.find((g) => g.partner_id === pOutside.id), undefined, 'outside before-window excluded');

  const mixedGroup = groups.find((g) => g.partner_id === pMixed.id);
  assert.ok(mixedGroup);
  assert.equal(mixedGroup.total, 100, 'not-yet-due invoice excluded from overdue total');
  assert.equal(mixedGroup.invoices.length, 1);
  assert.equal(followUpLevel(db, mixedGroup, at)?.id, afterLvl.id);

  const upcomingGroup = groups.find((g) => g.partner_id === pUpcomingOnly.id);
  assert.ok(upcomingGroup);
  assert.equal(upcomingGroup.total, 500);
  assert.equal(followUpLevel(db, upcomingGroup, at)?.id, beforeLvl.id);

  const sent = [];
  const afterRun = runFollowUps(db, at, (m) => sent.push(m));
  assert.equal(sent.length, 2);
  const mixedEmail = sent.find((m) => m.to === 'mixed@example.test');
  assert.match(mixedEmail.text, /Total: 100\.00/);
  const upcomingNotes = (afterRun.messages ?? []).filter((m) => m.model === 'res.partner' && m.res_id === pUpcomingOnly.id).map((m) => m.body).join('\n');
  assert.doesNotMatch(upcomingNotes, /overdue/i);
});

test('Finding 9: settling, writing off, or unreconciling one installment acts only on that line while full payMove keeps earliest-due order', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', {
    name: 'Split 30/70',
    line_ids: [
      { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
      { value_type: 'percent', value: 70, nb_days: 60, delay_type: 'days_after' },
    ],
  });
  db = term.db;
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && j.default_for_payments);
  const arCounterparts = (m) => (m.line_ids ?? []).filter((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable');

  // 1. Reconciling 300 installment against 400 credit applies only 300 (100 remains unapplied)
  const p1 = create(db, 'res.partner', { name: 'Inst 1 Client' });
  const inv1 = makePostedInvoice(p1.db, { partnerId: p1.id, invoiceDate: '2026-01-01', dueDate: '2026-03-02', paymentTermId: term.id, amount: 1000 });
  const pay1 = create(inv1.db, 'account.payment', {
    payment_type: 'inbound', partner_type: 'customer', partner_id: p1.id, amount: 400, date: '2025-12-20', journal_id: bank.id,
  });
  db = postPayment(pay1.db, read(pay1.db, 'account.payment', pay1.id));
  const inv1Move = read(db, 'account.move', inv1.id);
  const [inv1Line0] = arCounterparts(inv1Move);
  const pay1Move = read(db, 'account.move', read(db, 'account.payment', pay1.id).move_id);
  const pay1Line = pay1Move.line_ids.find((l) => l.account_id === inv1Line0.account_id && l.partner_id === p1.id);

  db = reconcileJournalItems(db, [
    { move_id: inv1Move.id, line_identity: journalItemIdentity(inv1Line0) },
    { move_id: pay1Move.id, line_identity: journalItemIdentity(pay1Line) },
  ], { date: '2026-02-10' });
  assert.equal(read(db, 'account.move', inv1.id).amount_residual, 700);
  assert.equal(read(db, 'account.payment', pay1.id).unapplied, 100);

  // 2. Settling or writing off line 1 (700) affects only line 1; line 0 (300) remains open in ledger and agedBalance
  const p2 = create(db, 'res.partner', { name: 'Inst 2 Client' });
  const inv2 = makePostedInvoice(p2.db, { partnerId: p2.id, invoiceDate: '2026-01-01', dueDate: '2026-03-02', paymentTermId: term.id, amount: 1000 });
  const expAcc = search(inv2.db, 'account.account').find((a) => a.account_type === 'expense');
  db = inv2.db;
  const inv2Move = read(db, 'account.move', inv2.id);
  const [inv2Line0, inv2Line1] = arCounterparts(inv2Move);

  assert.throws(
    () => writeoffJournalItem(db, [{ move_id: inv2Move.id, line_identity: journalItemIdentity(inv2Line0) }], {
      date: '2026-02-10', amount: 350, journalId: bank.id, accountId: expAcc.id, label: 'Too big for line 0',
    }),
    /remaining invoice/,
  );

  db = writeoffJournalItem(db, [{ move_id: inv2Move.id, line_identity: journalItemIdentity(inv2Line1) }], {
    date: '2026-02-10', amount: 150, journalId: bank.id, accountId: expAcc.id, label: 'Writeoff second installment',
  });
  const items2 = reconciledJournalItems(db, read(db, 'account.move', inv2.id)).filter((l) => l.date_maturity);
  assert.deepEqual(items2.map((l) => l.amount_residual), [300, 550]);
  const agedRow = agedBalance(db, 'receivable', '2026-02-15').rows.find((r) => r.partner_id === p2.id);
  assert.equal(agedRow['31_60'], 300);
  assert.equal(agedRow.current, 550);

  // 3. Unreconciling one installment removes only that installment's payment, keeping other installment settled
  const p3 = create(db, 'res.partner', { name: 'Two Payment Inst Client' });
  const inv3 = makePostedInvoice(p3.db, { partnerId: p3.id, invoiceDate: '2026-01-01', dueDate: '2026-03-02', paymentTermId: term.id, amount: 1000 });
  const payA = create(inv3.db, 'account.payment', { payment_type: 'inbound', partner_type: 'customer', partner_id: p3.id, amount: 300, date: '2025-12-20', journal_id: bank.id });
  let db3 = postPayment(payA.db, read(payA.db, 'account.payment', payA.id));
  const payB = create(db3, 'account.payment', { payment_type: 'inbound', partner_type: 'customer', partner_id: p3.id, amount: 700, date: '2025-12-21', journal_id: bank.id });
  db3 = postPayment(payB.db, read(payB.db, 'account.payment', payB.id));
  const inv3Move = read(db3, 'account.move', inv3.id);
  const [inv3L0, inv3L1] = (inv3Move.line_ids ?? []).filter((l) => read(db3, 'account.account', l.account_id)?.account_type === 'asset_receivable');
  const payAMove = read(db3, 'account.move', read(db3, 'account.payment', payA.id).move_id);
  const payBMove = read(db3, 'account.move', read(db3, 'account.payment', payB.id).move_id);
  db3 = reconcileJournalItems(db3, [
    { move_id: inv3Move.id, line_identity: journalItemIdentity(inv3L0) },
    { move_id: payAMove.id, line_identity: journalItemIdentity(payAMove.line_ids.find((l) => l.account_id === inv3L0.account_id && l.partner_id === p3.id)) },
  ], { date: '2026-02-10' });
  db3 = reconcileJournalItems(db3, [
    { move_id: inv3Move.id, line_identity: journalItemIdentity(inv3L1) },
    { move_id: payBMove.id, line_identity: journalItemIdentity(payBMove.line_ids.find((l) => l.account_id === inv3L1.account_id && l.partner_id === p3.id)) },
  ], { date: '2026-02-10' });
  assert.equal(read(db3, 'account.move', inv3.id).amount_residual, 0);

  db3 = unreconcileJournalItems(db3, [{ move_id: inv3Move.id, line_identity: journalItemIdentity(inv3L0) }], { date: '2026-02-12' });
  assert.equal(read(db3, 'account.move', inv3.id).amount_residual, 300);
  const items3 = reconciledJournalItems(db3, read(db3, 'account.move', inv3.id)).filter((l) => l.date_maturity);
  assert.deepEqual(items3.map((l) => l.amount_residual), [300, 0]);

  // 4. Full-invoice payMove preserves earliest-due order
  const p4 = create(db3, 'res.partner', { name: 'Full PayMove Client' });
  const inv4 = makePostedInvoice(p4.db, { partnerId: p4.id, invoiceDate: '2026-01-01', dueDate: '2026-03-02', paymentTermId: term.id, amount: 1000 });
  const db4 = payMove(inv4.db, inv4.id, 400, '2026-02-10');
  const items4 = reconciledJournalItems(db4, read(db4, 'account.move', inv4.id)).filter((l) => l.date_maturity);
  assert.deepEqual(items4.map((l) => l.amount_residual), [0, 600]);
  const inv4Move = read(db4, 'account.move', inv4.id);
  const [inv4Line0] = arCounterparts(inv4Move);
  assert.throws(
    () => unreconcileJournalItems(db4, [{ move_id: inv4Move.id, line_identity: journalItemIdentity(inv4Line0) }], { date: '2026-02-12' }),
    /multiple installments/,
  );
});
