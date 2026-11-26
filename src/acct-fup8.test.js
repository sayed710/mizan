import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { find, setupDom } from './test-support/dom.js';
import { applyFilters, create, messagesOf, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { postMove } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';
import { apps, findLeaf } from './models/index.js';
import {
  financeModels,
  followUps,
  isPartnerFollowUpPostponed,
  partnerFollowUp,
  partnerFollowUpStatus,
  postponeFollowUp,
  processFollowUps,
  runFollowUps,
  updatePartnerFollowUp,
} from './models/finance.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));
const allFind = (node, pred) => [
  ...(pred(node) ? [node] : []),
  ...(node?.childNodes ?? []).flatMap((c) => allFind(c, pred)),
];

async function mountView(renderElement, initialDb) {
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

function makeOverdueInvoice(db, { partnerId, dueDate, amount = 100, companyId = 1 }) {
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: companyId,
    partner_id: partnerId,
    invoice_date: addDays(dueDate, -15),
    invoice_date_due: dueDate,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: amount, tax: 0 }],
  });
  return { db: postMove(inv.db, inv.id), id: inv.id };
}

test('auto_execute separates automatic vs manual follow-up levels while preserving processFollowUps', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [] } };
  assert.equal(financeModels['account.followup.level'].fields.automatic, undefined);
  assert.equal(financeModels['account.followup.level'].fields.auto_execute?.type, 'boolean');
  assert.equal(financeModels['account.followup.level'].defaults().auto_execute, true);

  const notifTab = financeModels['account.followup.level'].form.tabs.find((tab) => tab.label === 'Notification');
  assert.ok(notifTab.groups.some((g) => g.title === 'Options' && g.fields.includes('auto_execute')));

  const autoLvl = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: true,
    auto_execute: true,
  });
  const manualLvl = create(autoLvl.db, 'account.followup.level', {
    display_delay: 20,
    reminder_timing: 'after',
    send_email: true,
    auto_execute: false,
    create_activity: true,
    activity_type_id: 'call',
    activity_summary: 'Manual escalation call',
  });
  db = manualLvl.db;

  const p1 = create(db, 'res.partner', { name: 'Level Mode Customer', email: 'levelmode@example.test', customer_rank: 1 });
  const inv = makeOverdueInvoice(p1.db, { partnerId: p1.id, dueDate: '2026-03-01' });
  db = inv.db;

  // At 2026-03-10 (9 days overdue -> autoLvl): runFollowUps executes it automatically
  const sent = [];
  db = runFollowUps(db, '2026-03-10', (mail) => { sent.push(mail); return { status: 'sent' }; });
  assert.equal(sent.length, 1);
  assert.equal(partnerFollowUp(read(db, 'res.partner', p1.id), 1)?.followup_level, autoLvl.id);

  // At 2026-03-25 (24 days overdue -> manualLvl): runFollowUps skips auto_execute: false
  db = runFollowUps(db, '2026-03-25', (mail) => { sent.push(mail); return { status: 'sent' }; });
  assert.equal(sent.length, 1, 'manual level must not auto-execute in scheduler');
  assert.equal(partnerFollowUpStatus(db, read(db, 'res.partner', p1.id), 1, '2026-03-25'), 'in_need_of_action');

  // Batch processFollowUps executes the manual level and creates its activity
  const batch = await processFollowUps(db, [p1.id], {
    companyId: 1,
    at: '2026-03-25',
    deliverEmail: (mail) => { sent.push(mail); return { status: 'sent' }; },
  });
  assert.equal(sent.length, 2);
  assert.equal(batch.summary.processed, 1);
  assert.deepEqual(batch.results[0].actions, ['email', 'activity']);
  assert.equal(partnerFollowUp(read(batch.db, 'res.partner', p1.id), 1)?.followup_level, manualLvl.id);
  assert.ok(search(batch.db, 'mail.activity').some((a) => a.res_id === p1.id && a.summary === 'Manual escalation call'));
});

test('processFollowUps handles email, letter, SMS, activity-only, skips, and failures with accurate report', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [] } };

  const lvlEmail = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: true,
    create_activity: true,
    activity_type_id: 'todo',
    activity_summary: 'Verify payment',
  });
  const lvlLetter = create(lvlEmail.db, 'account.followup.level', {
    display_delay: 15,
    reminder_timing: 'after',
    send_email: false,
    channel: 'letter',
  });
  const lvlActivity = create(lvlLetter.db, 'account.followup.level', {
    display_delay: 30,
    reminder_timing: 'after',
    send_email: false,
    create_activity: true,
    activity_type_id: 'call',
    activity_summary: 'Final call',
  });
  db = lvlActivity.db;

  const pEmail = create(db, 'res.partner', { name: 'Email Partner', email: 'email@example.test', customer_rank: 1 });
  const pLetter = create(pEmail.db, 'res.partner', { name: 'Letter Partner', customer_rank: 1 });
  const pActivity = create(pLetter.db, 'res.partner', { name: 'Activity Partner', followup_reminder_type: 'manual', customer_rank: 1 });
  const pPostponed = create(pActivity.db, 'res.partner', { name: 'Postponed Partner', email: 'postponed@example.test', customer_rank: 1 });
  const pNoEmail = create(pPostponed.db, 'res.partner', { name: 'No Email Partner', email: '', customer_rank: 1 });
  const pNoDebt = create(pNoEmail.db, 'res.partner', { name: 'Clean Partner', customer_rank: 1 });

  db = makeOverdueInvoice(pNoDebt.db, { partnerId: pEmail.id, dueDate: '2026-03-20' }).db; // 11 days @ Mar 31 -> lvlEmail
  db = makeOverdueInvoice(db, { partnerId: pLetter.id, dueDate: '2026-03-10' }).db; // 21 days @ Mar 31 -> lvlLetter
  db = makeOverdueInvoice(db, { partnerId: pActivity.id, dueDate: '2026-02-20' }).db; // 39 days @ Mar 31 -> lvlActivity
  db = makeOverdueInvoice(db, { partnerId: pPostponed.id, dueDate: '2026-03-20' }).db; // postponed
  db = makeOverdueInvoice(db, { partnerId: pNoEmail.id, dueDate: '2026-03-20' }).db; // 11 days @ Mar 31 -> lvlEmail, missing email
  db = postponeFollowUp(db, [pPostponed.id], '2026-04-15', { companyId: 1, at: '2026-03-31' });

  const delivered = [];
  const res = await processFollowUps(
    db,
    [pEmail.id, pLetter.id, pActivity.id, pPostponed.id, pNoEmail.id, pNoDebt.id],
    {
      companyId: 1,
      at: '2026-03-31',
      deliverEmail: (mail) => { delivered.push(mail); return { status: 'sent' }; },
    },
  );

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].to, 'email@example.test');
  assert.deepEqual(res.summary, {
    total: 6,
    processed: 3,
    skipped: 2,
    failed: 1,
    emailed: 1,
    letters: 1,
    sms: 0,
    phone: 0,
    activities: 3, // pEmail + pActivity + pNoEmail fallback activity
    letterPartnerIds: [pLetter.id],
  });

  const byId = new Map(res.results.map((r) => [r.partnerId, r]));
  assert.equal(byId.get(pEmail.id).status, 'processed');
  assert.deepEqual(byId.get(pEmail.id).actions, ['email', 'activity']);
  assert.equal(byId.get(pLetter.id).status, 'processed');
  assert.deepEqual(byId.get(pLetter.id).actions, ['letter']);
  assert.equal(byId.get(pActivity.id).status, 'processed');
  assert.deepEqual(byId.get(pActivity.id).actions, ['activity']);
  assert.equal(byId.get(pPostponed.id).status, 'skipped');
  assert.equal(byId.get(pPostponed.id).reason, 'Postponed');
  assert.equal(byId.get(pPostponed.id).nextActionDate, '2026-04-15');
  assert.equal(byId.get(pNoDebt.id).status, 'skipped');
  assert.equal(byId.get(pNoEmail.id).status, 'failed');
  assert.match(byId.get(pNoEmail.id).reason, /email address/i);

  // Re-running on same date skips the emailed customer; the letter customer stays pending until the print is confirmed
  // (deliberate spec change: a generated batch report no longer records letters as delivered).
  const second = await processFollowUps(res.db, [pEmail.id, pLetter.id], { companyId: 1, at: '2026-03-31', deliverEmail: () => ({ status: 'sent' }) });
  assert.equal(second.summary.processed, 1);
  assert.equal(second.summary.skipped, 1);
  assert.equal(second.results.find((r) => r.partnerId === pEmail.id).status, 'skipped');
  assert.deepEqual(second.results.find((r) => r.partnerId === pLetter.id).pendingManual, ['letter']);
});

test('postponeFollowUp validates dates, persists per-company next reminder, and diff guard rejects invalid dates', () => {
  let db = seed();
  const p = create(db, 'res.partner', { name: 'Postpone Guard Partner', customer_rank: 1 });
  const due = addDays(today(), -20);
  db = makeOverdueInvoice(p.db, { partnerId: p.id, dueDate: due }).db;

  assert.throws(() => postponeFollowUp(db, [], addDays(today(), 10)), /Select at least one customer/);
  assert.throws(() => postponeFollowUp(db, [p.id], '2026-02-30'), /valid date/i);
  assert.throws(() => postponeFollowUp(db, [p.id], today()), /future date/i);

  const futureDate = addDays(today(), 10);
  const postponedDb = postponeFollowUp(db, [p.id], futureDate, { companyId: 1 });
  const partner = read(postponedDb, 'res.partner', p.id);
  assert.equal(partner.followup_next_action_date, futureDate);
  assert.equal(isPartnerFollowUpPostponed(postponedDb, partner, 1), true);
  assert.equal(partnerFollowUpStatus(postponedDb, partner, 1), 'with_overdue_invoices');
  assert.ok(messagesOf(postponedDb, 'res.partner', p.id).some((m) => m.body.includes(`postponed until ${futureDate}`)));

  // Filters on res.partner reflect status & postponement
  const allPartners = search(postponedDb, 'res.partner');
  assert.equal(applyFilters('res.partner', allPartners, ['in_need_of_action'], postponedDb).some((r) => r.id === p.id), false);
  assert.equal(applyFilters('res.partner', allPartners, ['overdue_invoices'], postponedDb).some((r) => r.id === p.id), true);
  assert.equal(applyFilters('res.partner', allPartners, ['postponed'], postponedDb).some((r) => r.id === p.id), true);

  // Sync guard checks impossible calendar date directly from saved diff
  const forged = {
    ...db,
    records: {
      ...db.records,
      'res.partner': db.records['res.partner'].map((r) => (
        r.id === p.id
          ? { ...r, followup_lines: updatePartnerFollowUp(r, 1, { followup_next_action_date: '2026-02-30' }).followup_lines }
          : r
      )),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /valid date/i);
});

test('Customers list exposes Process follow-ups and Postpone for accounting users and executes batch workflow', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  db = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: false,
    channel: 'letter',
    message: 'Letter batch reminder',
  }).db;

  const due = addDays(today(), -15);
  const p1 = create(db, 'res.partner', { name: 'AAA Batch List One', customer_rank: 1 });
  const p2 = create(p1.db, 'res.partner', { name: 'AAA Batch List Two', customer_rank: 1 });
  db = makeOverdueInvoice(p2.db, { partnerId: p1.id, dueDate: due }).db;
  db = makeOverdueInvoice(db, { partnerId: p2.id, dueDate: due }).db;
  db = { ...db, records: { ...db.records, 'res.partner': db.records['res.partner'].filter((r) => [p1.id, p2.id].includes(r.id)) } };

  const customersLeaf = findLeaf(apps.find((a) => a.id === 'accounting'), 'customers');
  const processAction = customersLeaf.listActions.find((a) => a.label === 'Process follow-ups');
  const postponeAction = customersLeaf.listActions.find((a) => a.label === 'Postpone');
  assert.ok(processAction);
  assert.ok(postponeAction);

  // Non-accounting user cannot access accounting follow-up actions
  const salesUser = { apps: ['sales'], isAdmin: false };
  assert.equal(processAction.when(db, salesUser), false);
  assert.equal(postponeAction.when(db, salesUser), false);

  const { ActionView } = await import('./views/ActionView.jsx');
  const acctMount = await mountView((React) => React.createElement(ActionView, {
    leaf: customersLeaf,
    base: '#/accounting/customers',
    params: new URLSearchParams('view=list'),
  }), db);
  try {
    const checkPartner = async (name) => {
      const cb = find(acctMount.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label'] === name);
      assert.ok(cb, `checkbox for ${name}`);
      await acctMount.React.act(async () => props(cb).onChange({ target: { checked: !props(cb).checked } }));
    };

    await checkPartner('AAA Batch List Two');
    const postponeBtn = find(acctMount.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Postpone');
    await acctMount.React.act(async () => props(postponeBtn).onClick());
    const dateInput = find(acctMount.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'w-date');
    assert.ok(dateInput, 'Postpone wizard opens');
    const futureDate = addDays(today(), 10);
    await acctMount.React.act(async () => props(dateInput).onChange({ target: { value: futureDate } }));
    const form = find(acctMount.host, (n) => n.tagName === 'FORM');
    assert.ok(form, 'Postpone wizard form present');
    await acctMount.React.act(async () => props(form).onSubmit({ preventDefault() {} }));
    assert.equal(read(acctMount.getDb(), 'res.partner', p2.id).followup_next_action_date, futureDate);

    // Select both p1 (due) and p2 (postponed) and click Process follow-ups
    await checkPartner('AAA Batch List One');
    await checkPartner('AAA Batch List Two');
    const processBtn = find(acctMount.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Process follow-ups');
    await acctMount.React.act(async () => props(processBtn).onClick());
    await acctMount.React.act(async () => Promise.resolve());

    const modal = find(acctMount.host, (n) => props(n)?.role === 'dialog');
    assert.ok(modal, 'Batch result modal rendered');
    const modalText = textOf(modal);
    assert.match(modalText, /Follow-up Processing Report/);
    assert.match(modalText, /Processed: 1/);
    assert.match(modalText, /Skipped: 1/);
    assert.match(modalText, /AAA Batch List One/);
    assert.match(modalText, /AAA Batch List Two/);
    assert.match(modalText, /Postponed/);
    assert.ok(find(modal, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Print Letters'));
  } finally {
    await acctMount.done();
  }
});

test('Follow-up report shows postponed partners, supports filtering, postponing, batch processing, and batch letters', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  db = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: false,
    channel: 'letter',
    message: 'Report letter message',
  }).db;

  const due = addDays(today(), -15);
  const pDue = create(db, 'res.partner', { name: 'Report Due Customer', customer_rank: 1 });
  const pWait = create(pDue.db, 'res.partner', { name: 'Report Postponed Customer', customer_rank: 1 });
  db = makeOverdueInvoice(pWait.db, { partnerId: pDue.id, dueDate: due }).db;
  db = makeOverdueInvoice(db, { partnerId: pWait.id, dueDate: due }).db;
  const futureDate = addDays(today(), 12);
  db = postponeFollowUp(db, [pWait.id], futureDate, { companyId: 1 });

  // followUps(db) default excludes postponed; Follow-up Report shows postponed partner with badge
  assert.equal(followUps(db).some((f) => f.partner_id === pWait.id), false);

  const { Reports } = await import('./views/Reports.jsx');
  const mounted = await mountView((React) => React.createElement(Reports, { leaf: { report: 'followups' } }), db);
  try {
    const fullText = textOf(mounted.host);
    assert.match(fullText, /Report Due Customer/);
    assert.match(fullText, /Report Postponed Customer/);
    assert.ok(fullText.includes(`Postponed (${futureDate})`), 'postponed partner shows Postponed badge and date');

    const statusSelect = find(mounted.host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Follow-up Status');
    assert.ok(statusSelect);
    await mounted.React.act(async () => props(statusSelect).onChange({ target: { value: 'in_need_of_action' } }));
    assert.match(textOf(mounted.host), /Report Due Customer/);
    assert.doesNotMatch(textOf(mounted.host), /Report Postponed Customer/);

    await mounted.React.act(async () => props(statusSelect).onChange({ target: { value: 'postponed' } }));
    assert.doesNotMatch(textOf(mounted.host), /Report Due Customer/);
    assert.match(textOf(mounted.host), /Report Postponed Customer/);

    await mounted.React.act(async () => props(statusSelect).onChange({ target: { value: 'all' } }));
    const selectAll = find(mounted.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Select all');
    assert.ok(selectAll);
    await mounted.React.act(async () => props(selectAll).onChange({ target: { checked: true } }));

    const processBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Process follow-ups');
    await mounted.React.act(async () => props(processBtn).onClick());
    await mounted.React.act(async () => Promise.resolve());

    const modal = find(mounted.host, (n) => props(n)?.role === 'dialog');
    assert.ok(modal);
    assert.match(textOf(modal), /Processed: 1/);
    assert.match(textOf(modal), /Skipped: 1/);

    // Batch FollowUpLetter prints comma-separated partner IDs
    const { FollowUpLetter } = await import('./views/FollowUpLetter.jsx');
    const letterMount = await mountView((React) => React.createElement(FollowUpLetter, { partnerId: `${pDue.id},${pWait.id}`, companyId: 1 }), mounted.getDb());
    try {
      const articles = allFind(letterMount.host, (n) => n.tagName === 'ARTICLE');
      assert.equal(articles.length, 2);
      assert.match(textOf(articles[0]), /Report Due Customer/);
      assert.match(textOf(articles[1]), /Report Postponed Customer/);
    } finally {
      await letterMount.done();
    }
  } finally {
    await mounted.done();
  }
});

test('Arabic translations cover new follow-up batch and postpone strings', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (k === 'mizan-lang' ? 'ar' : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
  try {
    const { t } = await import(`./i18n.js?ar-fup8=${Date.now()}`);
    for (const phrase of [
      'Process follow-ups',
      'Postpone',
      'Postpone Follow-ups',
      'Postponed',
      'All Overdue',
      'Skipped',
      'Print Letters',
      'Follow-up Processing Report',
      'Customer not found',
      'Excluded from follow-ups',
      'Select at least one customer first',
      'Next reminder date must be a valid date',
      'Choose a future date to postpone the reminder',
      'Already processed for current follow-up level',
      'Automatically execute this follow-up level when due.',
      'No delivery action is configured for this follow-up level.',
      'Automatic email delivery is not configured.',
    ]) {
      assert.notEqual(t(phrase), phrase, `missing Arabic translation for "${phrase}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('res.partner followup_status avoids recursion with 3-way matched bills, nets credits, and tolerates missing currency', () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [], 'account.payment': [] } };
  db = write(db, 'res.company', 1, { three_way_matching: true });
  db = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'after',
    send_email: false,
    channel: 'letter',
  }).db;

  const vendor = create(db, 'res.partner', { name: 'Matched Vendor', supplier_rank: 1 });
  const prod = create(vendor.db, 'product', { name: '3WM Product', type: 'goods', purchase_method: 'receive' });
  const po = create(prod.db, 'purchase.order', {
    company_id: 1,
    partner_id: vendor.id,
    state: 'purchase',
    order_line: [{ product_id: prod.id, qty: 1, qty_delivered: 0, price_unit: 50 }],
  });
  const bill = create(po.db, 'account.move', {
    company_id: 1,
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: po.id,
    invoice_line_ids: [{ product_id: prod.id, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = bill.db;

  const due = addDays(today(), -15);
  const custOverdue = create(db, 'res.partner', { name: 'Overdue Customer', customer_rank: 1 });
  const custNetted = create(custOverdue.db, 'res.partner', { name: 'Netted Customer', customer_rank: 1 });
  db = makeOverdueInvoice(custNetted.db, { partnerId: custOverdue.id, dueDate: due, amount: 100 }).db;
  db = makeOverdueInvoice(db, { partnerId: custNetted.id, dueDate: due, amount: 100 }).db;
  const cn = create(db, 'account.move', {
    move_type: 'out_refund',
    company_id: 1,
    partner_id: custNetted.id,
    invoice_date: addDays(due, -1),
    invoice_date_due: due,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(cn.db, cn.id);

  // Reading/searching res.partner with a 3-way matched vendor bill must not recurse
  const partners = search(db, 'res.partner');
  const byId = new Map(partners.map((p) => [p.id, p]));
  assert.equal(byId.get(vendor.id).followup_status, 'no_action_needed');
  assert.equal(byId.get(custOverdue.id).followup_status, 'in_need_of_action');
  assert.equal(byId.get(custNetted.id).followup_status, 'no_action_needed');
  assert.equal(read(db, 'res.partner', custOverdue.id).followup_status, 'in_need_of_action');

  // Unconfigured company currency must not crash res.partner reads or searches
  const noCurrDb = {
    ...db,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, currency_id: null } : c)),
    },
  };
  assert.equal(read(noCurrDb, 'res.partner', custOverdue.id).followup_status, 'no_action_needed');
  assert.ok(search(noCurrDb, 'res.partner').length > 0);
});
