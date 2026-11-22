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
import { scopedWritableModels, writableModelsForApps } from './models/index.js';

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
