import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read } from './orm.js';
import { models } from './models/index.js';
import { round } from './money.js';
import { seed } from './seed.js';
import { applyDiff } from './sync.js';

test('payment confirmation rejects finite amounts whose rounding would overflow', () => {
  const draft = create(seed(), 'account.payment', { partner_id: 3, amount: 1e307, date: '2026-04-02' });
  const confirm = models['account.payment'].form.buttons.find((b) => b.label === 'Confirm');
  assert.throws(() => confirm.run(draft.db, read(draft.db, 'account.payment', draft.id)), /Unrepresentable monetary amount/);
  assert.equal(read(draft.db, 'account.payment', draft.id).state, 'draft');
  assert.equal(round(NaN), 0);
  assert.equal(round(Infinity), 0);
  assert.throws(() => round(Number.MAX_VALUE / 100), /Unrepresentable monetary amount/);
});

test('sync rejects finite monetary values that overflow cents, including nested values', () => {
  const base = seed();
  const draft = create(base, 'account.payment', { partner_id: 3, amount: 25 });
  const payment = read(draft.db, 'account.payment', draft.id);
  assert.throws(() => applyDiff(draft.db, { upserts: { 'account.payment': [{ ...payment, amount: 1e307 }] } }), /Invalid value.*amount/i);
  const batch = create(draft.db, 'account.batch.payment', { batch_type: 'outbound', lines: [{ move_id: 1, amount: 10 }] });
  const record = read(batch.db, 'account.batch.payment', batch.id);
  assert.throws(() => applyDiff(batch.db, { upserts: { 'account.batch.payment': [{ ...record, lines: [{ ...record.lines[0], amount: -1e307 }] }] } }), /Invalid value.*amount/i);
  assert.equal(read(batch.db, 'account.payment', payment.id).amount, 25);
});
