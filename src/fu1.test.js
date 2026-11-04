import { test } from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, read, messagesOf } from './orm.js';
import { seed } from './seed.js';
import { addDays, today } from './models/common.js';
import { postMove } from './models/accounting.js';
import { partnerFollowUp } from './models/finance.js';
import { runScheduledJobs } from './models/scheduler.js';

test('scheduler delivers follow-up email before marking sent and retries rejected delivery', async () => {
  const partner = create(seed(), 'res.partner', { name: 'Reminder recipient', email: 'recipient@example.test' });
  const invoice = create(partner.db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id,
    invoice_date: addDays(today(), -60), invoice_date_due: addDays(today(), -20),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }],
  });
  const db = postMove(invoice.db, invoice.id);
  const local = runScheduledJobs(db, today());
  assert.equal(partnerFollowUp(read(local, 'res.partner', partner.id), 1).followup_delivery_state, 'not_sent');
  const failed = await runScheduledJobs(local, today(), { deliverFollowUp: async () => { throw new Error('SMTP rejected'); } });
  assert.equal(partnerFollowUp(read(failed, 'res.partner', partner.id), 1).followup_level_delay, null);
  assert.ok(messagesOf(failed, 'res.partner', partner.id).some((m) => m.body.includes('SMTP rejected')));
  const delivered = [];
  const sent = await runScheduledJobs(failed, today(), { deliverFollowUp: async (message) => { delivered.push(message); } });
  const customerEmails = delivered.filter((message) => message.to === 'recipient@example.test');
  assert.equal(customerEmails.length, 1);
  assert.ok(customerEmails[0].text.includes(read(db, 'account.move', invoice.id).name));
  assert.equal(partnerFollowUp(read(sent, 'res.partner', partner.id), 1).followup_delivery_state, 'sent');
  assert.equal(partnerFollowUp(read(sent, 'res.partner', partner.id), 1).followup_level_delay, 15);
});
