import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { markSms } from './models/sms.js';
import { sendSmsCampaign } from '../server/integrations.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { postMove } from './models/accounting.js';
import { financeModels, runFollowUps, logManualFollowUp, levelChannels, isFollowUpSmsDiff } from './models/finance.js';
import { scopedWritableModels, writableModelsForApps, redactForApps } from './models/index.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));

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

function fixture(phone = '+201001112233', due = '2026-01-01') {
  const partner = create(seed(), 'res.partner', { name: 'SMS customer', email: 'sms@example.test', mobile: phone });
  const invoice = create(partner.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: partner.id, invoice_date: addDays(due, -31), invoice_date_due: due, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const level = create(postMove(invoice.db, invoice.id), 'account.followup.level', { delay: 19, send_email: true, send_sms: true, sms_message: 'Please pay' });
  return { db: level.db, partner: partner.id, level: level.id };
}

test('SMS field and independent automatic channels', async () => {
  const f = fixture();
  const field = financeModels['account.followup.level'].fields.sms_message;
  assert.equal(field.label, 'SMS Text');
  assert.equal(field.hideWhen({ send_sms: false }), true);
  const emails = [];
  const db = await runFollowUps(f.db, '2026-01-20', (m) => emails.push(m));
  assert.ok(emails.some((m) => m.to === 'sms@example.test'));
  assert.ok(search(db, 'sms.trace').some((t) => t.res_id === f.partner && t.state === 'outgoing'));
});

test('manual SMS queues the customer', () => {
  const f = fixture();
  const db = logManualFollowUp(f.db, f.partner, '2026-01-20', { channel: 'sms' });
  assert.ok(search(db, 'sms.trace').some((t) => t.res_id === f.partner && t.state === 'outgoing'));
});

test('missing phone records automatic failure', async () => {
  const f = fixture('');
  const db = await runFollowUps(f.db, '2026-01-20', () => ({ status: 'sent' }));
  assert.ok(db.messages.some((m) => m.res_id === f.partner && m.delivery_channel === 'sms' && /phone|number/i.test(m.delivery_error ?? m.body)));
  assert.ok(read(db, 'res.partner', f.partner));
});


test('SMS queue is targeted, carries configured text, and is not duplicated when email fails', async () => {
  const f = fixture();
  const emails = [];
  let db = await runFollowUps(f.db, '2026-01-20', (m) => { emails.push(m); throw new Error('SMTP down'); });
  const trace = search(db, 'sms.trace').find((t) => t.res_id === f.partner);
  assert.ok(trace);
  assert.equal(read(db, 'sms.campaign', trace.campaign_id).body, 'Please pay');
  assert.equal(search(db, 'sms.trace').filter((t) => t.campaign_id === trace.campaign_id).length, 1);
  db = await runFollowUps(db, '2026-01-20', () => ({ status: 'sent' }));
  assert.equal(search(db, 'sms.trace').filter((t) => t.res_id === f.partner).length, 1);
  assert.equal(emails.length, 1);
  const failed = markSms(db, trace.id, false, 'Provider refused');
  assert.equal(read(failed, 'sms.trace', trace.id).state, 'error');
  assert.equal(read(failed, 'sms.trace', trace.id).error, 'Provider refused');
});

test('SMS falls back to phone and rejects missing manual number', () => {
  const f = fixture('');
  const withPhone = write(f.db, 'res.partner', f.partner, { phone: '+201001112234' });
  const db = logManualFollowUp(withPhone, f.partner, '2026-01-20', { channel: 'sms' });
  assert.equal(search(db, 'sms.trace').find((t) => t.res_id === f.partner).phone, '+201001112234');
  assert.throws(() => logManualFollowUp(f.db, f.partner, '2026-01-20', { channel: 'sms' }), /phone number/i);
});

test('plain diffs cannot move a follow-up SMS to an inaccessible company', () => {
  const f = fixture();
  const next = logManualFollowUp(f.db, f.partner, '2026-01-20', { channel: 'sms' });
  const saved = applyDiff(f.db, diffDb(f.db, next), { companies: new Set([1]), isAdmin: false });
  assert.ok(search(saved, 'sms.trace').some((t) => t.res_id === f.partner));
  const campaign = search(next, 'sms.campaign').find((c) => c.followup_sms);
  const forged = write(next, 'sms.campaign', campaign.id, { company_id: 2 });
  assert.throws(() => applyDiff(next, diffDb(next, forged), { companies: new Set([1]), isAdmin: false }), /company/i);
});


test('SMS failure does not advance the level or resend a successful email after a plain diff', async () => {
  const f = fixture('');
  let emails = 0;
  const failed = await runFollowUps(f.db, '2026-01-20', () => { emails++; return { status: 'sent' }; });
  let db = applyDiff(f.db, diffDb(f.db, failed), { isAdmin: true });
  const line = read(db, 'res.partner', f.partner).followup_lines.find((l) => l.company_id === 1);
  assert.equal(line.followup_delivery_outcome, 'failed');
  assert.notEqual(line.followup_level, f.level);
  db = write(db, 'res.partner', f.partner, { mobile: '+201001112233' });
  db = await runFollowUps(db, '2026-01-20', () => { emails++; return { status: 'sent' }; });
  assert.equal(emails, 1);
  assert.ok(search(db, 'sms.trace').some((t) => t.res_id === f.partner));
});


test('the campaign transport records provider failures for a queued follow-up', async () => {
  const f = fixture();
  let db = logManualFollowUp(f.db, f.partner, '2026-01-20', { channel: 'sms' });
  const trace = search(db, 'sms.trace').find((t) => t.res_id === f.partner);
  const store = { get: () => db, commit: (next) => { db = next; } };
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('Denied', { status: 400 }); };
  try {
    await sendSmsCampaign({ MIZAN_TWILIO_SID: 'test', MIZAN_TWILIO_TOKEN: 'test', MIZAN_TWILIO_FROM: '+201001112200' }, store, { id: trace.campaign_id });
    assert.equal(requests, 1);
    assert.equal(read(db, 'sms.trace', trace.id).state, 'error');
    assert.match(read(db, 'sms.trace', trace.id).error, /400/);
    assert.equal(read(db, 'sms.campaign', trace.campaign_id).failed, 1);
  } finally { globalThis.fetch = original; }
});

test('Finding 2: dual-channel reminder queues SMS and advances level when customer has no email', async () => {
  const f = fixture('+201001112233');
  const noEmailDb = write(f.db, 'res.partner', f.partner, { email: '' });
  let emails = 0;
  const db = await runFollowUps(noEmailDb, '2026-01-20', () => { emails++; return { status: 'sent' }; });
  assert.ok(search(db, 'sms.trace').some((t) => t.res_id === f.partner && t.state === 'outgoing'));
  const line = read(db, 'res.partner', f.partner).followup_lines.find((l) => l.company_id === 1);
  assert.equal(line.followup_level, f.level);
  assert.equal(line.followup_channel, 'sms');
  assert.equal(emails, 0);
  assert.ok(db.messages.some((m) => m.res_id === f.partner && m.delivery_channel === 'email' && /email/i.test(m.delivery_error ?? m.body)));
});

test('Finding 3: missing phone number does not flood duplicate notes on repeated scheduler runs', async () => {
  const f = fixture('');
  let db = await runFollowUps(f.db, '2026-01-20', () => ({ status: 'sent' }));
  const notesCount1 = db.messages.filter((m) => m.res_id === f.partner && m.delivery_channel === 'sms').length;
  assert.equal(notesCount1, 1);
  // Second scheduler run on same day with unchanged missing phone must not post duplicate note
  db = await runFollowUps(db, '2026-01-20', () => ({ status: 'sent' }));
  const notesCount2 = db.messages.filter((m) => m.res_id === f.partner && m.delivery_channel === 'sms').length;
  assert.equal(notesCount2, 1);
  // When phone is corrected, retry succeeds and queues SMS
  db = write(db, 'res.partner', f.partner, { mobile: '+201001112233' });
  db = await runFollowUps(db, '2026-01-20', () => ({ status: 'sent' }));
  assert.ok(search(db, 'sms.trace').some((t) => t.res_id === f.partner && t.state === 'outgoing'));
});

test('Finding 1: accounting users can persist manual follow-up SMS diffs via scoped permission but not arbitrary campaigns', () => {
  const f = fixture(undefined, addDays(today(), -19));
  const next = logManualFollowUp(f.db, f.partner, today(), { channel: 'sms' });
  const acctApps = ['accounting'];
  const diff = diffDb(f.db, next);

  // Writable models for accounting does not include unrestricted sms.campaign
  const baseAllowed = writableModelsForApps(acctApps);
  assert.equal(baseAllowed.has('sms.campaign'), false);
  assert.equal(baseAllowed.has('sms.trace'), false);

  // But scoped permission recognizes validated follow-up SMS diff
  assert.equal(isFollowUpSmsDiff(diff, f.db), true);
  const scoped = scopedWritableModels(acctApps, diff, f.db);
  assert.equal(scoped.has('sms.campaign'), true);
  assert.equal(scoped.has('sms.trace'), true);

  // Applying diff with scoped permission succeeds
  const saved = applyDiff(f.db, diff, { allowed: scoped, author: 'Accountant' });
  assert.ok(search(saved, 'sms.trace').some((t) => t.res_id === f.partner));

  // An arbitrary marketing SMS campaign diff is rejected for accounting users
  const promo = create(f.db, 'sms.campaign', { name: 'Promo blast', body: '50% off', mailing_model: 'res.partner' });
  const promoDiff = diffDb(f.db, promo.db);
  assert.equal(isFollowUpSmsDiff(promoDiff, f.db), false);
  const promoScoped = scopedWritableModels(acctApps, promoDiff, f.db);
  assert.equal(promoScoped.has('sms.campaign'), false);
  assert.throws(() => applyDiff(f.db, promoDiff, { allowed: promoScoped, author: 'Accountant' }), /No access to sms\.campaign/);
});

test('accounting SMS permission validates current follow-up data for every campaign trace', async () => {
  const f = fixture(undefined, addDays(today(), -19));
  const accept = (next) => {
    const diff = diffDb(f.db, next);
    return applyDiff(f.db, diff, { allowed: scopedWritableModels(['accounting'], diff, f.db), author: 'Accountant' });
  };
  const manual = logManualFollowUp(f.db, f.partner, today(), { channel: 'sms' });
  const campaign = search(manual, 'sms.campaign').find((c) => c.followup_sms);
  const trace = search(manual, 'sms.trace').find((t) => t.campaign_id === campaign.id);
  assert.ok(read(accept(manual), 'sms.trace', trace.id));
  const scheduled = await runFollowUps(f.db, today(), () => ({ status: 'sent' }));
  assert.ok(search(accept(scheduled), 'sms.trace').some((t) => t.res_id === f.partner));

  const reject = (next) => assert.throws(() => accept(next), /No access to sms\.(campaign|trace)/);
  reject(write(manual, 'sms.campaign', campaign.id, { body: 'Custom promotion' }));
  reject(write(manual, 'sms.trace', trace.id, { phone: '+201999999999' }));
  const other = create(f.db, 'res.partner', { name: 'No overdue invoice', mobile: '+201111111111' });
  const otherManual = logManualFollowUp(other.db, f.partner, today(), { channel: 'sms' });
  const otherTrace = search(otherManual, 'sms.trace').find((t) => t.res_id === f.partner);
  const forged = write(otherManual, 'sms.trace', otherTrace.id, { res_id: other.id, phone: '+201111111111' });
  const forgedDiff = diffDb(other.db, forged);
  assert.throws(() => applyDiff(other.db, forgedDiff, { allowed: scopedWritableModels(['accounting'], forgedDiff, other.db) }), /No access to sms\.(campaign|trace)/);

  const existing = accept(manual);
  const disabled = write(existing, 'sms.campaign', campaign.id, { followup_sms: false });
  const disabledDiff = diffDb(existing, disabled);
  assert.throws(() => applyDiff(existing, disabledDiff, { allowed: scopedWritableModels(['accounting'], disabledDiff, existing) }), /No access to sms\.campaign/);
  const promo = create(f.db, 'sms.campaign', { name: 'Existing promotion', body: campaign.body, mailing_model: 'res.partner' });
  const reclassified = write(promo.db, 'sms.campaign', promo.id, { followup_sms: true });
  const reclassifiedDiff = diffDb(promo.db, reclassified);
  assert.throws(() => applyDiff(promo.db, reclassifiedDiff, { allowed: scopedWritableModels(['accounting'], reclassifiedDiff, promo.db) }), /No access to sms\.campaign/);
});

test('Finding 4: dual-channel level provides levelChannels and distinct SMS manual action in Follow-ups screen', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  const lvl = create(db, 'account.followup.level', { delay: 10, reminder_timing: 'after', send_email: true, send_sms: true, sms_message: 'Pay now' });
  const partner = create(lvl.db, 'res.partner', { name: 'Dual Customer', email: 'dual@example.test', mobile: '+20123456789' });
  const due = addDays(today(), -15);
  const inv = create(partner.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: partner.id, invoice_date: addDays(due, -10), invoice_date_due: due, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);

  assert.deepEqual(levelChannels(read(db, 'account.followup.level', lvl.id)), ['email', 'sms']);

  const { FollowUps } = await import('./views/Reports.jsx');
  const mounted = await mountView((React) => React.createElement(FollowUps, { db }), db);
  try {
    const confirmBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Confirm Sent');
    assert.ok(confirmBtn, 'Confirm Sent button for email action exists');
    const smsBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Send SMS');
    assert.ok(smsBtn, 'distinct Send SMS action button exists for dual-channel level');
    await mounted.React.act(async () => props(smsBtn).onClick());
    const saved = mounted.getDb();
    const trace = search(saved, 'sms.trace').find((t) => t.res_id === partner.id);
    assert.ok(trace, 'SMS trace queued by clicking Send SMS');
    const line = read(saved, 'res.partner', partner.id).followup_lines.find((l) => l.company_id === 1);
    assert.equal(line?.followup_channel, 'sms');
  } finally {
    await mounted.done();
  }
});

test('Code Review Finding 1: accounting diffs cannot forge SMS delivery state, attempt metadata or counters', () => {
  const f = fixture(undefined, addDays(today(), -19));
  const manual = logManualFollowUp(f.db, f.partner, today(), { channel: 'sms' });
  const campaign = search(manual, 'sms.campaign').find((c) => c.followup_sms);
  const trace = search(manual, 'sms.trace').find((t) => t.campaign_id === campaign.id);

  // 1. Newly created trace marked 'sent' instead of 'outgoing' is rejected
  const forgedNewTrace = write(manual, 'sms.trace', trace.id, { state: 'sent', delivery_pending: false });
  const forgedNewDiff = diffDb(f.db, forgedNewTrace);
  assert.equal(isFollowUpSmsDiff(forgedNewDiff, f.db), false);

  // 2. Newly created trace with delivery_pending: false is rejected
  const notPending = write(manual, 'sms.trace', trace.id, { delivery_pending: false });
  assert.equal(isFollowUpSmsDiff(diffDb(f.db, notPending), f.db), false);

  // 3. Newly created trace with unpermitted field is rejected
  const extraField = write(manual, 'sms.trace', trace.id, { unpermitted_field: 'hack' });
  assert.equal(isFollowUpSmsDiff(diffDb(f.db, extraField), f.db), false);

  // 4. An existing trace in db cannot have its state forged to 'sent'
  const savedDb = applyDiff(f.db, diffDb(f.db, manual), { allowed: scopedWritableModels(['accounting'], diffDb(f.db, manual), f.db), author: 'Accountant' });
  const modifiedTrace = write(savedDb, 'sms.trace', trace.id, { state: 'sent', delivery_pending: false });
  const modifiedDiff = diffDb(savedDb, modifiedTrace);
  assert.equal(isFollowUpSmsDiff(modifiedDiff, savedDb), false);

  // 5. Existing campaign cannot have delivery counters incremented by client
  const counterModified = write(savedDb, 'sms.campaign', campaign.id, { delivered: 1 });
  assert.equal(isFollowUpSmsDiff(diffDb(savedDb, counterModified), savedDb), false);
});

test('Code Review Finding 2: dual-channel manual confirmation uses phone or letter fallback when customer has no email', async () => {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [], 'account.move': [] } };
  const lvl = create(db, 'account.followup.level', { delay: 10, reminder_timing: 'after', send_email: true, send_sms: true, sms_message: 'Pay now' });
  // Manual reminder customer with phone but NO email
  const partner = create(lvl.db, 'res.partner', { name: 'No Email Customer', email: '', phone: '+201112223344', followup_reminder_type: 'manual' });
  const due = addDays(today(), -15);
  const inv = create(partner.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: partner.id, invoice_date: addDays(due, -10), invoice_date_due: due, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);

  const { FollowUps } = await import('./views/Reports.jsx');
  const mounted = await mountView((React) => React.createElement(FollowUps, { db }), db);
  try {
    const confirmBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Confirm Sent');
    assert.ok(confirmBtn, 'Confirm Sent button exists');
    const smsBtn = find(mounted.host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Send SMS');
    assert.ok(smsBtn, 'Send SMS button exists because phone is available');

    // Clicking Confirm Sent must NOT throw "email required"; it confirms the phone fallback
    await mounted.React.act(async () => props(confirmBtn).onClick());
    const saved = mounted.getDb();
    const line = read(saved, 'res.partner', partner.id).followup_lines.find((l) => l.company_id === 1);
    assert.equal(line?.followup_channel, 'phone');
  } finally {
    await mounted.done();
  }

  // Customer with NEITHER email NOR phone: confirms letter, Send SMS button NOT rendered
  const letterPartner = create(db, 'res.partner', { name: 'Letter Only', email: '', phone: '', mobile: '', followup_reminder_type: 'manual' });
  const inv2 = create(letterPartner.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: letterPartner.id, invoice_date: addDays(due, -10), invoice_date_due: due, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 50, tax: 0 }] });
  db = postMove(inv2.db, inv2.id);

  const mountedLetter = await mountView((React) => React.createElement(FollowUps, { db }), db);
  try {
    const buttons = [];
    const collectButtons = (n) => {
      if (n.tagName === 'BUTTON') buttons.push(n);
      for (const child of n.childNodes ?? []) collectButtons(child);
    };
    collectButtons(mountedLetter.host);
    const smsButtons = buttons.filter((b) => textOf(b).trim() === 'Send SMS');
    assert.equal(smsButtons.length, 1, 'Only the phone customer has Send SMS, not the letter-only customer');
  } finally {
    await mountedLetter.done();
  }
});

test('Code Review Finding 3: accounting sessions cannot read marketing SMS campaigns or recipient traces', () => {
  const f = fixture(undefined, addDays(today(), -19));
  const followUpDb = logManualFollowUp(f.db, f.partner, today(), { channel: 'sms' });
  const followUpCampaign = search(followUpDb, 'sms.campaign').find((c) => c.followup_sms);
  const followUpTrace = search(followUpDb, 'sms.trace').find((t) => t.campaign_id === followUpCampaign.id);

  // Add an unrelated marketing campaign and trace
  const promo = create(followUpDb, 'sms.campaign', { name: 'Summer Promo', body: '50% off everything', stage_id: 'sent' });
  const promoTrace = create(promo.db, 'sms.trace', { campaign_id: promo.id, phone: '+201999888777', name: 'Marketing Lead', state: 'sent' });
  const fullDb = promoTrace.db;

  // Redaction for Accounting-only user:
  const acctDb = redactForApps(fullDb, ['accounting']);
  const acctCampaigns = search(acctDb, 'sms.campaign');
  const acctTraces = search(acctDb, 'sms.trace');

  assert.equal(acctCampaigns.some((c) => c.id === followUpCampaign.id), true, 'Follow-up campaign is visible');
  assert.equal(acctCampaigns.some((c) => c.id === promo.id), false, 'Marketing campaign is filtered out');
  assert.equal(acctTraces.some((t) => t.id === followUpTrace.id), true, 'Follow-up trace is visible');
  assert.equal(acctTraces.some((t) => t.id === promoTrace.id), false, 'Marketing trace is filtered out');

  // Redaction for SMS Marketing user preserves full access:
  const smsDb = redactForApps(fullDb, ['sms']);
  assert.equal(search(smsDb, 'sms.campaign').some((c) => c.id === promo.id), true, 'Marketing campaign visible to SMS user');
  assert.equal(search(smsDb, 'sms.trace').some((t) => t.id === promoTrace.id), true, 'Marketing trace visible to SMS user');

  // Redaction for user with both apps preserves full access:
  const dualDb = redactForApps(fullDb, ['accounting', 'sms']);
  assert.equal(search(dualDb, 'sms.campaign').some((c) => c.id === promo.id), true);
  assert.equal(search(dualDb, 'sms.trace').some((t) => t.id === promoTrace.id), true);
});

test('Code Review Finding 4: blacklisted numbers are rejected in follow-up diffs and blocked at delivery', async () => {
  const phone = '+201009998877';
  const f = fixture(phone, addDays(today(), -19));
  // Blacklist the phone number
  const blacklistedDb = create(f.db, 'phone.blacklist', { number: phone, active: true }).db;

  // 1. A follow-up SMS diff for a blacklisted number is rejected
  const manual = logManualFollowUp(f.db, f.partner, today(), { channel: 'sms' });
  const diff = diffDb(f.db, manual);
  assert.equal(isFollowUpSmsDiff(diff, blacklistedDb), false, 'isFollowUpSmsDiff rejects blacklisted number');
  assert.equal(scopedWritableModels(['accounting'], diff, blacklistedDb).has('sms.campaign'), false);

  // 2. In server/integrations.js sendSmsCampaign: enforce opt-outs at delivery as a safeguard for persisted traces
  // Setup store with an already-persisted outgoing trace whose phone is now blacklisted
  const campaign = search(manual, 'sms.campaign').find((c) => c.followup_sms);
  const trace = search(manual, 'sms.trace').find((t) => t.campaign_id === campaign.id);
  let dbWithBlacklist = create(manual, 'phone.blacklist', { number: phone, active: true }).db;

  const store = { get: () => dbWithBlacklist, commit: (next) => { dbWithBlacklist = next; } };
  let gatewayCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { gatewayCalled = true; return new Response('OK', { status: 200 }); };
  try {
    const result = await sendSmsCampaign({ MIZAN_TWILIO_SID: 'test', MIZAN_TWILIO_TOKEN: 'test', MIZAN_TWILIO_FROM: '+201001112200' }, store, { id: campaign.id });
    assert.equal(gatewayCalled, false, 'Gateway was never called for blacklisted number');
    const updatedTrace = read(dbWithBlacklist, 'sms.trace', trace.id);
    assert.equal(updatedTrace.state, 'error');
    assert.equal(updatedTrace.error, 'Blacklisted phone number');
    assert.equal(updatedTrace.delivery_pending, false);
    assert.equal(read(dbWithBlacklist, 'sms.campaign', campaign.id).failed, 1);
    assert.match(result.message, /1 failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
