import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { markSms } from './models/sms.js';
import { sendSmsCampaign } from '../server/integrations.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { financeModels, runFollowUps, logManualFollowUp } from './models/finance.js';

function fixture(phone = '+201001112233') {
  const partner = create(seed(), 'res.partner', { name: 'SMS customer', email: 'sms@example.test', mobile: phone });
  const invoice = create(partner.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: partner.id, invoice_date: '2025-12-01', invoice_date_due: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
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
