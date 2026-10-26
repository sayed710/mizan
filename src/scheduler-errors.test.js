import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, messagesOf, search, updateSettings, write } from './orm.js';
import { seed } from './seed.js';
import { invoiceDue } from './models/subscriptionplus.js';
import { runScheduledJobs } from './models/scheduler.js';

const model = 'sale.subscription';
const quiet = () => {
  const db = seed();
  return search(db, model).reduce((next, s) => write(next, model, s.id, { stage: 'draft' }), db);
};
const addSub = (db, vals) => create(db, model, { partner_id: 1, product_id: 12, plan: 'monthly', recurring_amount: 100, stage: 'progress', start_date: '2024-01-01', ...vals });
const invoices = (db, id) => search(db, 'account.move').filter((r) => r.subscription_id === id && r.move_type === 'out_invoice');

test('one contract stuck in a locked period no longer stops the others from being invoiced', () => {
  const a = addSub(quiet(), { next_invoice_date: '2024-01-01' });
  const b = addSub(a.db, { next_invoice_date: '2024-03-01' });
  const locked = updateSettings(b.db, { lock_date: '2024-02-15' });
  const once = invoiceDue(locked, '2024-03-01');
  assert.deepEqual(invoices(once, b.id).map((r) => r.invoice_date), ['2024-03-01']);
  assert.equal(invoices(once, a.id).length, 0);
  const notes = messagesOf(once, model, a.id).filter((m) => /Recurring invoicing failed: .*locked/.test(m.body));
  assert.equal(notes.length, 1);
  // The hourly run does not repeat the same note.
  assert.equal(invoiceDue(once, '2024-03-01'), once);
});

test('a failing scheduled job is reported instead of silently swallowed', () => {
  const db = seed();
  // A referral pointing at an applicant that no longer exists makes the referral sync throw.
  const broken = { ...db, records: { ...db.records, 'hr.referral': [...(db.records['hr.referral'] ?? []), { id: 999, applicant_id: 424242 }] } };
  const failures = [];
  const out = runScheduledJobs(broken, undefined, { onError: (job, e) => failures.push([job, e.message]) });
  assert.deepEqual(failures, [['syncFromApplicant', 'hr.applicant record not found']]);
  assert.ok(out.records['hr.referral'].some((r) => r.id === 999));
});
