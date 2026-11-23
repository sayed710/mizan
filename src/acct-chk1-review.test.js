import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { postPayment, printCheck, reprintCheck, nextCheckNumber } from './models/pay.js';
import { models } from './models/index.js';

const synced = (db, next, ctx = { isAdmin: true }) => applyDiff(db, diffDb(db, next), ctx);

function manualPayment() {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', bank.id, { check_manual_sequencing: true, check_next_number: 100 });
  const line = bank.outbound_payment_method_line_ids.find((l) => read(db, 'account.payment.method', l.payment_method_id)?.code === 'check_printing');
  const draft = create(db, 'account.payment', { payment_type: 'outbound', partner_type: 'supplier', partner_id: search(db, 'res.partner')[0].id, amount: 100, journal_id: bank.id, payment_method_line_id: line.id });
  db = postPayment(draft.db, read(draft.db, 'account.payment', draft.id));
  return { db, bank, id: draft.id };
}

test('unprinted manual numbers cannot be reprinted, and printed flags cannot be forged without a number or cleared', () => {
  let { db, id } = manualPayment();
  assert.throws(() => synced(db, write(db, 'account.payment', id, { check_printed: true })), /Issued check numbers/);
  db = synced(db, write(db, 'account.payment', id, { check_number: 51 }));
  assert.throws(() => reprintCheck(db, id, 52), /Only issued checks/);
  db = synced(db, printCheck(db, id));
  assert.throws(() => synced(db, write(db, 'account.payment', id, { check_printed: false })), /Issued check numbers/);
  assert.throws(() => synced(db, write(db, 'account.payment', id, { check_number: 52 })), /Issued check numbers/);
});

test('legacy numbered checks are locked and the configured next number is a floor', () => {
  const { db, bank, id } = manualPayment();
  const legacy = { ...read(db, 'account.payment', id), check_number: 77, check_printed: undefined };
  assert.equal(models['account.payment'].fields.check_number.readonly(legacy, db), true);
  assert.equal(models['account.payment'].form.unlockedFields(legacy, db).includes('check_number'), false);
  assert.equal(nextCheckNumber(db, bank.id, 1), 100);
});

test('company layout rejects invalid and non-admin sync writes', () => {
  const db = seed();
  const company = search(db, 'res.company')[0];
  assert.throws(() => synced(db, write(db, 'res.company', company.id, { account_check_printing_layout: 'invalid' })), /Select a valid check layout/);
  const changed = write(db, 'res.company', company.id, { account_check_printing_layout: 'bottom' });
  assert.throws(() => synced(db, changed, { isAdmin: false }), /Only administrators/);
});
