import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './registry.js';
import { seed } from './seed.js';
import { addDays } from './models/common.js';
import { postMove } from './models/accounting.js';
import { apps, findLeaf } from './models/index.js';
import { logManualFollowUp, partnerFollowUp, partnerFollowUpStatus, processFollowUps, runFollowUps } from './models/finance.js';

const AT = '2026-03-31';

function overdue(db, partnerId, dueDate) {
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partnerId,
    invoice_date: addDays(dueDate, -15),
    invoice_date_due: dueDate,
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  return postMove(inv.db, inv.id);
}

function withLevels(levels) {
  let db = seed();
  db = { ...db, records: { ...db.records, 'account.followup.level': [] } };
  for (const level of levels) db = create(db, 'account.followup.level', { reminder_timing: 'after', ...level }).db;
  return db;
}

test('letters and calls stay pending until confirmed and are not recorded as delivered', async () => {
  let db = withLevels([{ display_delay: 5, send_email: false, channel: 'letter' }]);
  const p = create(db, 'res.partner', { name: 'Letter Pending', customer_rank: 1 });
  db = overdue(p.db, p.id, '2026-03-10');

  const first = await processFollowUps(db, [p.id], { companyId: 1, at: AT });
  assert.equal(first.results[0].status, 'processed');
  assert.deepEqual(first.results[0].pendingManual, ['letter']);
  assert.equal(partnerFollowUp(read(first.db, 'res.partner', p.id), 1)?.followup_delivery_state ?? null, null);
  assert.equal(partnerFollowUpStatus(first.db, read(first.db, 'res.partner', p.id), 1, AT), 'in_need_of_action');

  const again = await processFollowUps(first.db, [p.id], { companyId: 1, at: AT });
  assert.equal(again.results[0].status, 'processed', 'an unconfirmed letter is offered again');

  const confirmed = logManualFollowUp(first.db, p.id, AT, { companyId: 1, channel: 'letter' });
  const after = await processFollowUps(confirmed, [p.id], { companyId: 1, at: AT });
  assert.equal(after.results[0].status, 'skipped');
});

test('a failed email is retried without queuing the successful SMS again', async () => {
  let db = withLevels([{ display_delay: 5, send_email: true, send_sms: true, sms_message: 'Please pay' }]);
  const p = create(db, 'res.partner', { name: 'Sms And Email', email: 'x@example.test', mobile: '+201000000000', customer_rank: 1 });
  db = overdue(p.db, p.id, '2026-03-10');

  const first = await processFollowUps(db, [p.id], { companyId: 1, at: AT, deliverEmail: () => { throw new Error('SMTP down'); } });
  assert.equal(first.results[0].status, 'failed');
  assert.deepEqual(first.results[0].actions, ['sms']);
  const line = partnerFollowUp(read(first.db, 'res.partner', p.id), 1);
  assert.notEqual(line.followup_delivery_state, 'sent');
  assert.equal(line.followup_delivery_outcome, 'failed');
  assert.equal(search(first.db, 'sms.campaign').filter((c) => c.followup_sms).length, 1);

  const delivered = [];
  const retry = await processFollowUps(first.db, [p.id], { companyId: 1, at: AT, deliverEmail: (m) => { delivered.push(m); return { status: 'sent' }; } });
  assert.equal(retry.results[0].status, 'processed');
  assert.deepEqual(retry.results[0].actions, ['email']);
  assert.equal(delivered.length, 1);
  assert.equal(search(retry.db, 'sms.campaign').filter((c) => c.followup_sms).length, 1, 'SMS is not queued twice');
  assert.equal(partnerFollowUp(read(retry.db, 'res.partner', p.id), 1).followup_delivery_state, 'sent');
});

test('one partner failing in a manual action does not stop the batch', async () => {
  let db = withLevels([{ display_delay: 5, send_email: true }, { display_delay: 15, send_email: false, channel: 'letter' }]);
  const a = create(db, 'res.partner', { name: 'First Email', email: 'a@example.test', customer_rank: 1 });
  const b = create(a.db, 'res.partner', { name: 'Letter Victim', customer_rank: 1 });
  const c = create(b.db, 'res.partner', { name: 'Third Email', email: 'c@example.test', customer_rank: 1 });
  db = overdue(c.db, a.id, '2026-03-20');
  db = overdue(db, b.id, '2026-03-10');
  db = overdue(db, c.id, '2026-03-20');
  const delivered = [];
  const res = await processFollowUps(db, [a.id, b.id, c.id], {
    companyId: 1,
    at: AT,
    deliverEmail: (m) => {
      delivered.push(m.to);
      return { status: 'sent' };
    },
  });
  // Make the letter step fail for the middle partner by emptying its invoices after the reminder map was built.
  const broken = await processFollowUps(db, [a.id, b.id, c.id], {
    companyId: 1,
    at: AT,
    deliverEmail: (m, ctx) => {
      delivered.push(m.to);
      const moves = ctx.db.records['account.move'].filter((mv) => mv.partner_id !== b.id);
      return { serverHandled: true, db: { ...ctx.stagedDb, records: { ...ctx.stagedDb.records, 'account.move': moves } } };
    },
  });
  assert.equal(res.results.length, 3);
  assert.equal(broken.results.length, 3, 'every selected partner gets a result');
  assert.equal(broken.results.find((r) => r.partnerId === b.id).status, 'failed');
  assert.equal(broken.results.find((r) => r.partnerId === c.id).actions.includes('email'), true);
});

test('follow-up status is not computed on ordinary partner reads', () => {
  const db = seed();
  const partner = search(db, 'res.partner')[0];
  const field = models['res.partner'].fields.followup_status;
  const original = field.compute;
  let calls = 0;
  field.compute = (...args) => { calls++; return original(...args); };
  try {
    const read1 = read(db, 'res.partner', partner.id);
    search(db, 'res.partner');
    write(db, 'res.partner', partner.id, { name: 'Renamed' });
    assert.equal(calls, 0);
    assert.equal(Object.keys(read1).includes('followup_status'), false);
    assert.equal(read1.followup_status, 'no_action_needed');
    assert.equal(read1.followup_status, 'no_action_needed');
    assert.equal(calls, 1, 'evaluated once, on first access');
  } finally {
    field.compute = original;
  }
});

test('Process follow-ups has a single execution path through the batch runner', () => {
  const leaf = findLeaf(apps.find((a) => a.id === 'accounting'), 'customers');
  const action = leaf.listActions.find((a) => a.label === 'Process follow-ups');
  assert.equal(action.batchFollowUp, true);
  assert.equal(action.run, undefined);
});

test('a sent email with a failed refresh is reported as sent and pending reload, not as a failed send', async () => {
  let db = withLevels([{ display_delay: 5, send_email: true }]);
  const p = create(db, 'res.partner', { name: 'Refresh Pending', email: 'r@example.test', customer_rank: 1 });
  db = overdue(p.db, p.id, '2026-03-10');
  const res = await processFollowUps(db, [p.id], {
    companyId: 1,
    at: AT,
    deliverEmail: (_m, ctx) => ({ serverHandled: true, db: ctx.db, refreshError: 'Failed to fetch' }),
  });
  assert.equal(res.results[0].status, 'processed');
  assert.deepEqual(res.results[0].actions, ['email']);
  assert.equal(res.results[0].refreshError, 'Failed to fetch');
  assert.strictEqual(res.db, db, 'a stale client snapshot is not changed after delivery');
});


test('delivered but unrecorded email stops the batch without marking it unsent', async () => {
  let db = withLevels([{ display_delay: 5, send_email: true, send_sms: true }]);
  const a = create(db, 'res.partner', { name: 'A', email: 'a@example.test', mobile: '+201000000000', customer_rank: 1 });
  const b = create(a.db, 'res.partner', { name: 'B', email: 'b@example.test', mobile: '+201000000001', customer_rank: 1 });
  db = overdue(b.db, a.id, '2026-03-10');
  db = overdue(db, b.id, '2026-03-10');
  let calls = 0;
  const result = await processFollowUps(db, [a.id, b.id], { at: AT, deliverEmail: () => { calls++; throw Object.assign(new Error('Recording failed'), { delivered: true }); } });
  assert.equal(calls, 1);
  assert.equal(result.results[0].delivered, true);
  assert.equal(result.results.length, 1);
  assert.notEqual(partnerFollowUp(read(result.db, 'res.partner', a.id), 1)?.followup_delivery_state, 'not_sent');
});

test('scheduled run recognizes SMS queued by a failed batch email', async () => {
  let db = withLevels([{ display_delay: 5, send_email: true, send_sms: true, sms_message: 'Pay' }]);
  const p = create(db, 'res.partner', { name: 'Cross path', email: 'x@example.test', mobile: '+201000000000', customer_rank: 1 });
  db = overdue(p.db, p.id, '2026-03-10');
  const batch = await processFollowUps(db, [p.id], { at: AT, deliverEmail: () => { throw new Error('failed'); } });
  const scheduled = await runFollowUps(batch.db, AT, () => ({ status: 'sent' }));
  assert.equal(search(scheduled, 'sms.campaign').filter(c => c.followup_sms).length, 1);
});
