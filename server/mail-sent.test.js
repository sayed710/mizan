import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, postNote, read, search, write } from '../src/orm.js';
import { seed } from '../src/seed.js';
import { reconcileFollowUp, recordSent } from './mail.js';
import { postMove } from '../src/models/accounting.js';



test('a document changed during delivery keeps its newer state and still records the send', () => {
  const snapshot = seed();
  const order = search(snapshot, 'sale.order').find((o) => o.state === 'draft');
  assert.ok(order, 'seed has a draft order');
  // The mail step moved the order to "sent" and left a note.
  const sent = postNote(write(snapshot, 'sale.order', order.id, { state: 'sent' }), 'sale.order', order.id, 'Sent by email to x');
  // Meanwhile somebody confirmed it.
  const current = write(snapshot, 'sale.order', order.id, { state: 'sale' });
  const out = recordSent(current, snapshot, sent, { author: 'clerk', isAdmin: true });
  assert.equal(read(out.db, 'sale.order', order.id).state, 'sale');
  assert.ok(out.db.messages.some((m) => m.body === 'Sent by email to x'));
  assert.match(out.notice, /status was left as it is/);
  assert.equal(recordSent(snapshot, snapshot, sent, { author: 'clerk', isAdmin: true }).notice, undefined);
});


test('a reset during invoice delivery preserves draft and records the delivery notice', () => {
  const invoice = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }] });
  const snapshot = postMove(invoice.db, invoice.id);
  const sent = postNote(write(snapshot, 'account.move', invoice.id, { is_move_sent: true }), 'account.move', invoice.id, 'Sent by email to x');
  const current = write(snapshot, 'account.move', invoice.id, { state: 'draft', is_move_sent: false });
  const out = recordSent(current, snapshot, sent, { author: 'clerk', isAdmin: true }, { document: { model: 'account.move', id: invoice.id } });
  assert.equal(read(out.db, 'account.move', invoice.id).state, 'draft');
  assert.equal(read(out.db, 'account.move', invoice.id).is_move_sent, false);
  assert.match(out.notice, /status was left/);
  assert.ok(out.db.messages.some((m) => m.body === 'Sent by email to x'));
});

test('invoice delivery persists sent status and propagates recording errors', () => {
  const invoice = create(seed(), 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100 }] });
  const snapshot = postMove(invoice.db, invoice.id);
  const sent = postNote(write(snapshot, 'account.move', invoice.id, { is_move_sent: true }), 'account.move', invoice.id, 'Sent by email to x');
  const document = { model: 'account.move', id: invoice.id };
  const out = recordSent(snapshot, snapshot, sent, { author: 'clerk', isAdmin: true }, { document });
  assert.equal(read(out.db, 'account.move', invoice.id).is_move_sent, true);
  assert.throws(() => recordSent(snapshot, snapshot, sent, { author: 'clerk', allowed: new Set() }, { document }));
});

test('follow-up reconciliation preserves a newer plan and the delivered message', () => {
  const snapshot = seed();
  const partner = search(snapshot, 'res.partner')[0];
  const line = { company_id: 1, followup_next_action_date: '2026-12-01' };
  const sent = postNote(write(snapshot, 'res.partner', partner.id, { followup_lines: [{ company_id: 1, followup_date: '2026-11-22' }] }), 'res.partner', partner.id, 'Reminder sent');
  const current = write(snapshot, 'res.partner', partner.id, { followup_lines: [line] });
  const out = reconcileFollowUp(current, snapshot, sent, { isAdmin: true }, partner.id, 1);
  assert.deepEqual(read(out.db, 'res.partner', partner.id).followup_lines, [line]);
  assert.ok(out.db.messages.some((m) => m.body === 'Reminder sent'));
  assert.match(out.notice, /progression could not be recorded/);
});

test('concurrent company sends retain both activities when provisional IDs collide', () => {
  const company = create(seed(), 'res.company', { name: 'Second company' });
  const partner = search(company.db, 'res.partner')[0];
  const snapshot = write(company.db, 'res.partner', partner.id, { followup_lines: [] });
  const stage = (companyId, summary) => {
    const withLine = write(snapshot, 'res.partner', partner.id, { followup_lines: [{ company_id: companyId, followup_date: '2026-11-22' }] });
    const activity = create(withLine, 'mail.activity', { summary, date_deadline: '2026-12-01' });
    return postNote(activity.db, 'res.partner', partner.id, `Sent ${summary}`);
  };
  const first = stage(1, 'First');
  const second = stage(company.id, 'Second');
  const reconcile = (current, base, sent, opts) => reconcileFollowUp(current, base, sent, opts, partner.id, company.id);
  const out = recordSent(first, snapshot, second, { isAdmin: true }, { reconcile });
  assert.equal(out.notice, undefined);
  const activities = search(out.db, 'mail.activity').filter((a) => ['First', 'Second'].includes(a.summary));
  assert.equal(activities.length, 2);
  assert.notEqual(activities[0].id, activities[1].id);
  assert.ok(out.db.seq['mail.activity'] >= Math.max(...activities.map((a) => a.id)));
  assert.equal(read(out.db, 'res.partner', partner.id).followup_lines.length, 2);
});
