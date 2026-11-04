import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { seed } from './seed.js';
import { postPayment } from './models/pay.js';

test('standalone customer payment uses the partner receivable account', () => {
  const account = create(seed(), 'account.account', { name: 'Special receivable', code: '129999', account_type: 'asset_receivable', company_id: 1 });
  const partner = create(account.db, 'res.partner', { name: 'Customer', property_account_receivable_id: account.id });
  const payment = create(partner.db, 'account.payment', { partner_id: partner.id, partner_type: 'customer', payment_type: 'inbound', amount: 100, date: '2026-07-01' });
  const db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const entry = read(db, 'account.move', read(db, 'account.payment', payment.id).move_id);
  assert.ok(entry.line_ids.some((line) => line.account_id === account.id && line.credit === 100));
});
