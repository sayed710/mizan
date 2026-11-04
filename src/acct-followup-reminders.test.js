import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, messagesOf } from './orm.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { payMove, postMove } from './models/accounting.js';
import { followUps, logManualFollowUp, partnerFollowUp } from './models/finance.js';

test('manual reminders record the actual level and channel separately per company and schedule the next level', () => {
  const base = seed();
  const branch = createCompany(base, { name: 'Reminder branch', currency_id: base.records['res.company'][0].currency_id });
  const partner = create(branch.db, 'res.partner', { name: 'Shared reminder customer' });
  let db = partner.db;
  const invoices = [];
  for (const [companyId, due] of [[1, '2026-02-09'], [branch.id, '2026-01-20']]) {
    const invoice = create(db, 'account.move', { move_type: 'out_invoice', company_id: companyId, partner_id: partner.id, invoice_date: due, invoice_date_due: due, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
    db = postMove(invoice.db, invoice.id);
    invoices.push(invoice.id);
  }
  const levels = search(db, 'account.followup.level');
  const first = levels.find((level) => level.delay === 15);
  const second = levels.find((level) => level.delay === 30);
  db = logManualFollowUp(db, partner.id, '2026-03-01', { companyId: 1, channel: 'phone' });
  db = logManualFollowUp(db, partner.id, '2026-03-01', { companyId: branch.id, channel: 'email' });
  const contact = read(db, 'res.partner', partner.id);
  const local = partnerFollowUp(contact, 1);
  const foreign = partnerFollowUp(contact, branch.id);
  assert.deepEqual([local.followup_date, local.followup_last_level, local.followup_channel, local.followup_next_action_date], ['2026-03-01', first.id, 'phone', '2026-03-16']);
  assert.deepEqual([foreign.followup_date, foreign.followup_last_level, foreign.followup_channel, foreign.followup_next_action_date], ['2026-03-01', second.id, 'email', null]);
  assert.ok(messagesOf(db, 'res.partner', partner.id).some((message) => /sent by phone/.test(message.body)));
  const stale = followUps(db, '2026-03-01').find((row) => row.partner_id === partner.id);
  db = payMove(db, invoices[0], 100, '2026-03-02');
  assert.throws(() => logManualFollowUp(db, partner.id, '2026-03-02', { reminder: stale, companyId: 1 }), /no overdue/i);
});
