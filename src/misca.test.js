import './models/index.js';
import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { postMove, payMove } from './models/accounting.js';
import { followUps, partnerFollowUp, logManualFollowUp, followUpLevel } from './models/finance.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

function fixture(email = '') {
  const partner = create(seed(), 'res.partner', { name: 'Customer', email });
  const term = create(partner.db, 'account.payment.term', { name: 'Split', line_ids: [
    { value_type: 'percent', value: 50, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 50, nb_days: 30, delay_type: 'days_after' },
  ] });
  const move = create(term.db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: partner.id, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  return { db: postMove(move.db, move.id), partner: partner.id, move: move.id };
}

test('payments are allocated before blocked installments are excluded', () => {
  let { db, partner, move } = fixture();
  db = payMove(db, move, 50, '2026-01-02');
  const invoice = read(db, 'account.move', move);
  const lines = invoice.line_ids.map((line) => read(db, 'account.account', line.account_id)?.account_type === 'asset_receivable' && line.date_maturity === '2026-01-01' ? { ...line, blocked: true } : line);
  db = write(db, 'account.move', move, { line_ids: lines });
  const reminder = followUps(db, '2026-03-01').find((row) => row.partner_id === partner);
  assert.equal(reminder.total, 50);
  assert.equal(reminder.oldest, '2026-01-31');
});

test('phone and letter reminders can be confirmed without an email address', () => {
  for (const channel of ['phone', 'letter']) {
    let { db, partner } = fixture();
    db = { ...db, records: { ...db.records, 'account.followup.level': [{ id: 1, name: 'Manual', delay: 0, channel }] } };
    const reminder = followUps(db, '2026-03-01').find((row) => row.partner_id === partner);
    assert.equal(followUpLevel(db, reminder, '2026-03-01').channel, channel);
    const sent = logManualFollowUp(db, partner, '2026-03-01', { channel, companyId: 1 });
    assert.equal(partnerFollowUp(read(sent, 'res.partner', partner), 1).followup_channel, channel);
  }
});

test('follow-up report shows phone and letter confirmation without email', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { FollowUps } = await import('./views/Reports.jsx');
  for (const channel of ['phone', 'letter']) {
    let { db } = fixture();
    db = { ...db, records: { ...db.records, 'account.followup.level': [{ id: 1, name: 'Manual', delay: 0, channel }] } };
    const html = renderToStaticMarkup(React.createElement('table', null, React.createElement(FollowUps, { db, companyId: 1 })));
    const row = html.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?>Customer<\/a>(?:(?!<\/tr>)[\s\S])*<\/tr>/)?.[0];
    assert.ok(row);
    assert.match(row, /Confirm Sent/);
    assert.doesNotMatch(row, /mailto:/);
  }
});
