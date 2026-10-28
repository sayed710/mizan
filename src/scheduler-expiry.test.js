import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { runScheduledJobs } from './models/scheduler.js';

test('the scheduler expires overdue signature requests and blanket orders', () => {
  let db = seed();
  const sign = create(db, 'sign.request', { name: 'Overdue NDA', partner_id: 4, state: 'sent', deadline: '2026-01-10', sent_date: '2026-01-01' });
  const open = create(sign.db, 'sign.request', { name: 'Open NDA', partner_id: 4, state: 'sent', deadline: '2026-03-01', sent_date: '2026-01-01' });
  const blanket = create(open.db, 'purchase.requisition', { name: 'BO/1', type: 'blanket', partner_id: 2, date_end: '2026-01-31' });
  db = write(blanket.db, 'purchase.requisition', blanket.id, { state: 'ongoing' });
  const next = runScheduledJobs(db, '2026-02-01');
  assert.equal(read(next, 'sign.request', sign.id).state, 'expired');
  assert.equal(read(next, 'sign.request', open.id).state, 'sent');
  assert.equal(read(next, 'purchase.requisition', blanket.id).state, 'done');
});

test('expiry leaves tenders open and cancels unresolved quotations before closing blankets', () => {
  const tender = create(seed(), 'purchase.requisition', { name: 'Tender', type: 'tender', partner_id: 2, date_end: '2026-01-31', state: 'ongoing' });
  const blanket = create(tender.db, 'purchase.requisition', { name: 'Blanket', type: 'blanket', partner_id: 2, date_end: '2026-01-31', state: 'ongoing' });
  const quote = create(blanket.db, 'purchase.order', { partner_id: 2, requisition_id: blanket.id });
  const next = runScheduledJobs(quote.db, '2026-02-01');
  assert.equal(read(next, 'purchase.requisition', tender.id).state, 'ongoing');
  assert.equal(read(next, 'purchase.requisition', blanket.id).state, 'done');
  assert.equal(read(next, 'purchase.order', quote.id).state, 'cancel');
});
