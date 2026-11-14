import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, groupLabel, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models, viewsOf } from './models/index.js';
import { createCompany, setCompanies } from './models/company.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { followUpLevel, followUpLevelName, followUps, followUpSignedDelay, partnerFollowUp, runFollowUps } from './models/finance.js';
import { setActor } from './models/authority.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const textOf = (node) => node?.textContent ?? '';
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
  const render = async () => {
    await React.act(async () => root.render(renderElement(React)));
  };
  await render();
  return {
    React,
    host,
    getDb,
    render,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

function makePostedInvoice(db, { partnerId, companyId = 1, invoiceDate = '2026-05-01', dueDate = '2026-05-10', amount = 500, userId = null } = {}) {
  const income = search(db, 'account.account').find((a) => a.account_type === 'income' && (a.company_id ?? 1) === companyId);
  const created = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partnerId,
    company_id: companyId,
    invoice_date: invoiceDate,
    invoice_date_due: dueDate,
    ...(userId != null ? { invoice_user_id: userId } : {}),
    invoice_line_ids: [{ name: 'Service', account_id: income.id, qty: 1, price_unit: amount, tax_ids: [] }],
  });
  const confirm = models['account.move'].form.buttons.find((b) => b.label === 'Confirm');
  return { id: created.id, db: confirm.run(created.db, read(created.db, 'account.move', created.id)).db };
}

test('multi-ledger list/form parity, emptyHelp, and company guard', async () => {
  const leaf = findLeafByKey(menusFor('accounting'), 'multi-ledger');
  assert.equal(leaf?.model, 'account.journal.group');
  assert.deepEqual(viewsOf('account.journal.group'), ['list']);

  const def = models['account.journal.group'];
  assert.equal(def.fields.name.label, 'Ledger group');
  assert.equal(def.fields.name.placeholder, 'e.g. CONSO, IFRS, ...');
  assert.equal(def.fields.journal_ids.label, 'Included Journals');
  assert.equal(def.emptyHelp?.title, 'Ledger group allows managing multiple accounting standards.');
  assert.equal(def.form.hideTitle, true);
  assert.deepEqual(def.form.groups, [['name', 'journal_ids']]);

  const { ActionView } = await import('./views/ActionView.jsx');
  const { FormView } = await import('./views/FormView.jsx');

  const emptyMount = await mountView((React) => React.createElement(ActionView, { leaf, base: '#/accounting/multi-ledger', params: new URLSearchParams() }), seed());
  try {
    assert.ok(textOf(emptyMount.host).includes('Ledger group allows managing multiple accounting standards.'));
    const headers = allFind(emptyMount.host, (n) => n.tagName === 'TH').map((th) => textOf(th).replace(/[▲▼]/g, '').trim());
    assert.ok(headers.includes('Ledger group'));
    assert.ok(headers.includes('Included Journals'));
  } finally {
    await emptyMount.done();
  }

  let db = seed();
  const saleJ = search(db, 'account.journal').find((j) => j.type === 'sale');
  const createdGroup = create(db, 'account.journal.group', { name: 'IFRS', journal_ids: [saleJ.id] });
  db = createdGroup.db;
  assert.equal(read(db, 'account.journal.group', createdGroup.id).company_id, 1);

  const comp2 = createCompany(db, { name: 'Branch Co', currency_id: 1 });
  const branchJournal = search(comp2.db, 'account.journal').find((j) => j.company_id === comp2.id);
  assert.throws(() => create(comp2.db, 'account.journal.group', { name: 'Bad', journal_ids: [branchJournal.id] }), /Select journals belonging to this company or shared journals/);

  const listMount = await mountView((React) => React.createElement(ActionView, { leaf, base: '#/accounting/multi-ledger', params: new URLSearchParams() }), db);
  try {
    const bodyText = textOf(listMount.host);
    assert.ok(bodyText.includes('IFRS'));
    assert.ok(bodyText.includes(saleJ.name));
  } finally {
    await listMount.done();
  }

  const formMount = await mountView((React) => React.createElement(FormView, {
    leaf,
    id: createdGroup.id,
    base: '#/accounting/multi-ledger',
    params: new URLSearchParams(),
  }), db);
  try {
    assert.equal(find(formMount.host, (n) => hasClass(n, 'title-field')), null, 'hideTitle hides separate title field');
    const labels = allFind(formMount.host, (n) => hasClass(n, 'field')).map((f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim());
    assert.deepEqual(labels, ['Ledger group', 'Included Journals']);
    const nameInput = find(formMount.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-name');
    assert.equal(props(nameInput)?.placeholder, 'e.g. CONSO, IFRS, ...');
  } finally {
    await formMount.done();
  }
});

test('invoice reminders list columns, conditional activity column, and multi-company column', async () => {
  const leaf = findLeafByKey(menusFor('accounting'), 'followup-levels');
  assert.equal(leaf?.model, 'account.followup.level');
  assert.equal(leaf?.label, 'Invoice Reminders');
  assert.deepEqual(viewsOf('account.followup.level'), ['list', 'kanban']);

  const { ActionView } = await import('./views/ActionView.jsx');
  let db = seed();
  db = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'before',
    send_email: false,
    send_sms: true,
    create_activity: true,
    activity_type_id: 'call',
    activity_summary: 'Call customer',
  }).db;
  const levels = search(db, 'account.followup.level').sort(models['account.followup.level'].sort);
  assert.equal(levels[0].display_name, '5 days before');

  const singleMount = await mountView((React) => React.createElement(ActionView, {
    leaf,
    base: '#/accounting/followup-levels',
    params: new URLSearchParams(),
  }), db);
  try {
    const headers = allFind(singleMount.host, (n) => n.tagName === 'TH').map((th) => textOf(th).replace(/[▲▼]/g, '').trim());
    assert.deepEqual(headers.filter(Boolean), ['Due Days', 'Reminder Timing', 'Email', 'SMS', 'Activity']);
    const rows = allFind(singleMount.host, (n) => n.tagName === 'TR').slice(1);
    const beforeRowCells = allFind(rows[0], (n) => n.tagName === 'TD').map((td) => textOf(td).trim());
    const afterRowCells = allFind(rows[1], (n) => n.tagName === 'TD').map((td) => textOf(td).trim());
    assert.ok(beforeRowCells.includes('Call'), 'Activity column shows activity type when create_activity is true');
    assert.equal(afterRowCells[afterRowCells.length - 1], '', 'Activity column stays blank when create_activity is false');
  } finally {
    await singleMount.done();
  }

  const branch = createCompany(db, { name: 'Second Co', currency_id: 1 });
  const multiDb = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const multiMount = await mountView((React) => React.createElement(ActionView, {
    leaf,
    base: '#/accounting/followup-levels',
    params: new URLSearchParams(),
  }), multiDb);
  try {
    const headers = allFind(multiMount.host, (n) => n.tagName === 'TH').map((th) => textOf(th).replace(/[▲▼]/g, '').trim());
    assert.deepEqual(headers.filter(Boolean), ['Due Days', 'Reminder Timing', 'Email', 'SMS', 'Activity', 'Company']);
  } finally {
    await multiMount.done();
  }
});

test('invoice reminders form sentence, tabs, conditional activity fields, and validation', async () => {
  const { FormView } = await import('./views/FormView.jsx');
  const leaf = findLeafByKey(menusFor('accounting'), 'followup-levels');
  let db = seed();
  const firstLevel = search(db, 'account.followup.level')[0];

  const m1 = await mountView((React) => React.createElement(FormView, {
    leaf,
    id: firstLevel.id,
    base: '#/accounting/followup-levels',
    params: new URLSearchParams(),
  }), db);
  try {
    assert.equal(find(m1.host, (n) => hasClass(n, 'title-field')), null);
    const inlineRow = find(m1.host, (n) => hasClass(n, 'field-inline'));
    assert.ok(inlineRow, 'inline sentence row present');
    assert.ok(textOf(inlineRow).includes('days'));
    const labels = allFind(m1.host, (n) => hasClass(n, 'field')).map((f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim());
    assert.ok(labels.includes('Remind'));
    assert.ok(labels.includes('Email'));
    assert.ok(labels.includes('SMS'));
    assert.ok(!labels.includes('Company'), 'single company hides Company');

    const tabButtons = allFind(m1.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab');
    assert.deepEqual(tabButtons.map((b) => textOf(b).trim()), ['Notification', 'Activity']);
    assert.ok(textOf(m1.host).includes('Actions'));

    // Switch to Activity tab while create_activity is false: conditional fields must stay hidden.
    await m1.React.act(async () => props(tabButtons[1]).onClick());
    const activityLabelsOff = allFind(m1.host, (n) => hasClass(n, 'field')).map((f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim());
    assert.ok(activityLabelsOff.includes('Schedule Activity'));
    assert.ok(!activityLabelsOff.includes('Responsible'));
    assert.ok(!activityLabelsOff.includes('Activity Type'));
    assert.ok(!activityLabelsOff.includes('Summary'));
    assert.ok(!activityLabelsOff.includes('Note'));

    // Check Schedule Activity -> conditional fields appear with placeholder.
    const cb = find(m1.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-create_activity');
    await m1.React.act(async () => props(cb).onChange({ target: { checked: true } }));
    const activityLabelsOn = allFind(m1.host, (n) => hasClass(n, 'field')).map((f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim());
    assert.ok(activityLabelsOn.includes('Responsible'));
    assert.ok(activityLabelsOn.includes('Activity Type'));
    assert.ok(activityLabelsOn.includes('Summary'));
    assert.ok(activityLabelsOn.includes('Note'));
    const noteEl = find(m1.host, (n) => n.tagName === 'TEXTAREA' && props(n)?.id === 'f-activity_note');
    assert.equal(props(noteEl)?.placeholder, 'Activity Notes');
  } finally {
    await m1.done();
  }

  assert.throws(() => create(db, 'account.followup.level', { display_delay: -1, reminder_timing: 'after' }), /Due Days must be a non-negative integer/);
  assert.throws(() => create(db, 'account.followup.level', { display_delay: 5, reminder_timing: 'after', create_activity: true }), /Activity Type.*required/i);
  assert.throws(() => write(db, 'account.followup.level', firstLevel.id, { create_activity: true }), /Activity Type and Summary are required/);
});

test('signed delay derivation, display name, groupLabel, and migration 47', async () => {
  const { display } = await import('./ui.jsx');
  assert.equal(followUpSignedDelay(15, 'after'), 15);
  assert.equal(followUpSignedDelay(5, 'before'), -5);
  const zeroBefore = followUpSignedDelay(0, 'before');
  assert.equal(zeroBefore, 0);
  assert.equal(Object.is(zeroBefore, -0), false);
  assert.equal(followUpSignedDelay(0, 'after'), 0);

  let db = seed();
  const seedLevels = search(db, 'account.followup.level');
  assert.deepEqual(seedLevels.map((l) => l.display_name), ['15 days after', '30 days after']);
  assert.equal(seedLevels[0].name, undefined);

  const before = create(db, 'account.followup.level', { display_delay: 7, reminder_timing: 'before' });
  db = before.db;
  const createdRec = read(db, 'account.followup.level', before.id);
  assert.equal(createdRec.delay, -7);
  assert.equal(createdRec.display_name, '7 days before');

  db = write(db, 'account.followup.level', before.id, { display_delay: 3, reminder_timing: 'after' });
  assert.equal(read(db, 'account.followup.level', before.id).delay, 3);
  assert.equal(read(db, 'account.followup.level', before.id).display_name, '3 days after');

  assert.equal(display(db, { type: 'many2one', relation: 'account.followup.level' }, before.id), '3 days after');
  assert.equal(groupLabel(db, { type: 'many2one', relation: 'account.followup.level' }, before.id), '3 days after');
  assert.equal(followUpLevelName({ display_delay: 0, reminder_timing: 'after' }), '0 days after');

  const legacy = {
    schema_version: 46,
    records: {
      'account.followup.level': [
        { id: 1, name: 'Early', delay: -4, channel: 'letter', message: 'Soon due' },
        { id: 2, name: 'Due', delay: 0, channel: 'phone', message: 'Today' },
        { id: 3, name: 'Late', delay: 20, channel: 'email', message: 'Pay now' },
      ],
    },
  };
  assert.equal(SCHEMA_VERSION, 50);
  const migrated = migrate(legacy);
  assert.equal(migrated.schema_version, 50);
  const mLevels = search(migrated, 'account.followup.level');
  assert.deepEqual(mLevels.map((l) => ({
    id: l.id,
    display_delay: l.display_delay,
    reminder_timing: l.reminder_timing,
    send_email: l.send_email,
    create_activity: l.create_activity,
    resp: l.activity_default_responsible_type,
    name: l.name,
    channel: l.channel,
    message: l.message,
    display_name: l.display_name,
  })), [
    { id: 1, display_delay: 4, reminder_timing: 'before', send_email: false, create_activity: false, resp: 'followup', name: 'Early', channel: 'letter', message: 'Soon due', display_name: '4 days before' },
    { id: 2, display_delay: 0, reminder_timing: 'after', send_email: false, create_activity: false, resp: 'followup', name: 'Due', channel: 'phone', message: 'Today', display_name: '0 days after' },
    { id: 3, display_delay: 20, reminder_timing: 'after', send_email: true, create_activity: false, resp: 'followup', name: 'Late', channel: 'email', message: 'Pay now', display_name: '20 days after' },
  ]);
  assert.equal(migrate(migrated), migrated);
});

test('before and after reminder timings trigger follow-ups and create activities per responsible type', () => {
  let db = seed();
  // Replace seed levels with explicit before (-5) and after (10) levels.
  db = { ...db, records: { ...db.records, 'account.followup.level': [] } };

  const empFollowup = create(db, 'hr.employee', { name: 'Followup User' });
  const empSales = create(empFollowup.db, 'hr.employee', { name: 'Invoice Salesperson' });
  const empAcctMgr = create(empSales.db, 'hr.employee', { name: 'Account Manager' });
  const empActor = create(empAcctMgr.db, 'hr.employee', { name: 'Current Actor', user_login: 'actor.user' });
  db = empActor.db;

  const beforeLvl = create(db, 'account.followup.level', {
    display_delay: 5,
    reminder_timing: 'before',
    send_email: false,
    create_activity: true,
    activity_default_responsible_type: 'followup',
    activity_type_id: 'call',
    activity_summary: 'Heads up before due date',
    activity_note: 'Verify payment schedule',
  });
  const afterLvl = create(beforeLvl.db, 'account.followup.level', {
    display_delay: 10,
    reminder_timing: 'after',
    send_email: true,
    create_activity: true,
    activity_default_responsible_type: 'salesperson',
    activity_type_id: 'todo',
    activity_summary: 'Escalate overdue invoice',
  });
  db = afterLvl.db;

  const p1 = create(db, 'res.partner', {
    name: 'Partner One',
    email: 'p1@example.com',
    followup_responsible_id: empFollowup.id,
    user_id: empAcctMgr.id,
  });
  const inv1 = makePostedInvoice(p1.db, { partnerId: p1.id, invoiceDate: '2026-05-01', dueDate: '2026-05-10', userId: empSales.id });
  db = inv1.db;

  // At 2026-05-04 (6 days before due), outside the 5-day before window.
  assert.equal(followUps(db, '2026-05-04').length, 0);

  // At 2026-05-05 (5 days before due), before reminder triggers activity-only level.
  const fBefore = followUps(db, '2026-05-05');
  assert.equal(fBefore.length, 1);
  assert.equal(followUpLevel(db, fBefore[0], '2026-05-05')?.id, beforeLvl.id);

  const delivered = [];
  db = runFollowUps(db, '2026-05-05', (m) => delivered.push(m));
  assert.equal(delivered.length, 0, 'before level has send_email: false');
  assert.equal(partnerFollowUp(read(db, 'res.partner', p1.id), 1)?.followup_level_delay, -5);
  let activities = search(db, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === p1.id);
  assert.equal(activities.length, 1);
  assert.equal(activities[0].activity_type, 'call');
  assert.equal(activities[0].summary, 'Heads up before due date');
  assert.equal(activities[0].note, 'Verify payment schedule');
  assert.equal(activities[0].user_id, empFollowup.id);

  // Repeating same day does not duplicate.
  db = runFollowUps(db, '2026-05-05', (m) => delivered.push(m));
  assert.equal(search(db, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === p1.id).length, 1);

  // At 2026-05-20 (10 days after due), escalates to after level -> sends email AND creates salesperson activity.
  db = runFollowUps(db, '2026-05-20', (m) => delivered.push(m));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].subject, '10 days after');
  assert.equal(partnerFollowUp(read(db, 'res.partner', p1.id), 1)?.followup_level_delay, 10);
  activities = search(db, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === p1.id);
  assert.equal(activities.length, 2);
  assert.equal(activities[1].user_id, empSales.id);
  assert.equal(activities[1].activity_type, 'todo');

  // Verify account_manager + missing responsible fallback to current actor (and null when no actor).
  const mgrLvl = create(db, 'account.followup.level', {
    display_delay: 20,
    reminder_timing: 'after',
    send_email: false,
    create_activity: true,
    activity_default_responsible_type: 'account_manager',
    activity_type_id: 'meeting',
    activity_summary: 'Account manager check-in',
  });
  db = mgrLvl.db;
  db = runFollowUps(db, '2026-05-30');
  activities = search(db, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === p1.id);
  assert.equal(activities.length, 3);
  assert.equal(activities[2].user_id, empAcctMgr.id);

  // Customer without user_id: falls back to current actor when signed in, or null (never defaults to employee 1).
  const p2 = create(db, 'res.partner', { name: 'Partner Two' });
  const inv2 = makePostedInvoice(p2.db, { partnerId: p2.id, invoiceDate: '2026-05-01', dueDate: '2026-05-05' });
  setActor({ login: 'actor.user', name: 'Current Actor' });
  try {
    const withActor = runFollowUps(inv2.db, '2026-05-26');
    const actWithActor = search(withActor, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === p2.id);
    assert.equal(actWithActor[0]?.user_id, empActor.id);

    setActor(null);
    const noActor = runFollowUps(inv2.db, '2026-05-26');
    const actNoActor = search(noActor, 'mail.activity').filter((a) => a.res_model === 'res.partner' && a.res_id === p2.id);
    assert.equal(actNoActor[0]?.user_id, null);
  } finally {
    setActor(null);
  }
});

test('Arabic translations resolve for all new multi-ledger and invoice reminder strings', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (k === 'mizan-lang' ? 'ar' : null),
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  };
  try {
    const { t } = await import(`./i18n.js?ar-rem=${Date.now()}`);
    for (const key of [
      'Ledger group',
      'e.g. CONSO, IFRS, ...',
      'Ledger group allows managing multiple accounting standards.',
      'Due Days',
      'Reminder Timing',
      'before',
      'after',
      'Remind',
      'Notification',
      'Reminder Responsible',
      'Account Manager',
      'Follow-up Responsible',
      'Activity Notes',
      'Due Days must be a non-negative integer',
      'Activity Type and Summary are required when Schedule Activity is enabled',
      'Schedule Activity',
      'Included Journals',
      'The number of days after or before the due date of the invoice to wait before sending the reminder.',
      'Indicates whether the reminder should be sent before or after the invoice due date.',
      'Determine who will be assigned to the activity:\n- Follow-up Responsible (default)\n- Salesperson: Sales Person defined on the invoice\n- Account Manager: Sales Person defined on the customer',
    ]) {
      assert.notEqual(t(key), key, `Expected Arabic translation for "${key}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
