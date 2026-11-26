import test from 'node:test';
import assert from 'node:assert/strict';
import { customerPaymentView, postPayment, vendorPaymentView } from './models/pay.js';
import { buildSepaXml } from './models/sepa.js';
import { generateSepaFile } from './models/payments.js';
import { paymentStatementLines } from './models/ledger.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { create, read, search, unlink, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';

test('payment lists expose the optional payment method and search grouping', () => {
  for (const view of [customerPaymentView, vendorPaymentView]) {
    assert.ok(view.list.includes('payment_method_line_id'));
    assert.equal(view.listFields.payment_method_line_id.optional, 'hide');
    assert.ok(view.groupBys.includes('payment_method_line_id'));
    assert.equal(view.groupByLabels.payment_method_line_id, 'Payment Method Line');
  }
});

test('transaction smart button opens precisely the matched statement lines', () => {
  const base = seed();
  const payment = { id: 90001, state: 'posted', move_id: 90002 };
  const db = { ...base, records: { ...base.records,
    'account.payment': [...(base.records['account.payment'] ?? []), payment],
    'account.bank.statement.line': [
      { id: 90003, state: 'reconciled', payment_id: payment.id },
      { id: 90004, state: 'to_check', allocations: [{ payment_ids: [payment.id] }] },
      { id: 90005, state: 'to_check', payment_id: payment.id },
    ],
  } };
  const button = models['account.payment'].form.smart.find((item) => item.label === 'Transaction');
  assert.equal(button.when(payment, db), true);
  assert.equal(button.value(db, payment), 2);
  assert.equal(button.target(payment, db), 'accounting/bank?view=list&rel=id:90003,90004');
  assert.equal(button.when({ id: 90006 }, db), false);
  const cached = paymentStatementLines(db, payment);
  assert.strictEqual(paymentStatementLines(db, { ...payment }), cached);
  const changed = { ...db, records: { ...db.records, 'account.bank.statement.line': [] } };
  assert.deepEqual(paymentStatementLines(changed, payment), []);
  assert.notStrictEqual(paymentStatementLines(changed, payment), cached);
});

test('SEPA credit transfer always emits one payment-info SLEV regardless of bearer values', () => {
  assert.equal(models['account.payment'].defaults().iso20022_charge_bearer, 'SHAR');
  const input = { id: 'B1', createdAt: '2026-11-26T12:00:00Z', date: '2026-11-26',
    debtor: { name: 'Debtor', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
    payments: [{ id: '1', amount: 10, name: 'Creditor', iban: 'DE89370400440532013000', chargeBearer: 'DEBT' },
      { id: '2', amount: 20, name: 'Other', iban: 'DE89370400440532013000', chargeBearer: 'CRED' }] };
  const mixed = buildSepaXml(input);
  assert.equal((mixed.match(/<ChrgBr>SLEV<\/ChrgBr>/g) ?? []).length, 1);
  assert.ok(mixed.indexOf('<ChrgBr>SLEV</ChrgBr>') < mixed.indexOf('<CdtTrfTxInf>'));
  assert.equal((mixed.match(/<ChrgBr>/g) ?? []).length, 1);
  assert.match(buildSepaXml({ ...input, payments: [{ ...input.payments[0], chargeBearer: 'BAD' }] }), /<ChrgBr>SLEV<\/ChrgBr>/);
  const db = { records: {
    'account.journal': [{ id: 1, bank_account_id: 1, company_id: 1 }],
    'res.partner.bank': [{ id: 1, account_number: input.debtor.iban, bank_bic: input.debtor.bic }, { id: 2, account_number: input.debtor.iban, partner_id: 1, allow_out_payment: true }],
    'res.company': [{ id: 1, name: 'Company', currency_id: 1 }],
    'res.currency': [{ id: 1, name: 'EUR' }], 'res.partner': [{ id: 1, name: 'Creditor' }],
    'account.payment.method': [{ id: 1, code: 'sepa_ct', payment_type: 'outbound' }],
    'account.payment.method.line': [{ id: 1, payment_method_id: 1 }],
    'account.payment': [{ id: 1, payment_method_line_id: 1, partner_id: 1, partner_bank_id: 2, amount: 10, currency_id: 1, iso20022_charge_bearer: 'CRED' }],
  } };
  const batch = { id: 1, name: 'B1', date: input.date, company_id: 1, journal_id: 1, lines: [{ payment_id: 1 }] };
  for (const value of ['CRED', 'DEBT', 'SHAR', 'SLEV']) {
    db.records['account.payment'][0].iso20022_charge_bearer = value;
    const xml = generateSepaFile(db, batch, input.createdAt).content;
    assert.equal((xml.match(/<ChrgBr>SLEV<\/ChrgBr>/g) ?? []).length, 1);
    assert.equal((xml.match(/<ChrgBr>/g) ?? []).length, 1);
  }
});

test('charge bearer exists only on payments and defaults to shared', () => {
  assert.equal(models['account.payment'].defaults().iso20022_charge_bearer, 'SHAR');
  assert.ok(models['account.payment'].fields.iso20022_charge_bearer);
  assert.equal(models['account.batch.payment'].fields.iso20022_charge_bearer, undefined);
  assert.equal(models['account.batch.payment'].defaults().iso20022_charge_bearer, undefined);
  assert.ok(!models['account.batch.payment'].form.groups({}).flat().includes('iso20022_charge_bearer'));
});

test('posted payment charge bearer cannot change locally or through a diff', () => {
  const db = seed();
  const journal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const partner = search(db, 'res.partner')[0];
  const created = create(db, 'account.payment', { partner_id: partner.id, partner_type: 'customer', payment_type: 'inbound', amount: 10, journal_id: journal.id, company_id: 1 });
  const draft = write(created.db, 'account.payment', created.id, { iso20022_charge_bearer: 'DEBT' });
  const posted = postPayment(draft, read(draft, 'account.payment', created.id));
  assert.throws(() => write(posted, 'account.payment', created.id, { iso20022_charge_bearer: 'CRED' }), /charge bearer of a posted payment cannot be changed/i);
  const forged = { ...posted, records: { ...posted.records, 'account.payment': posted.records['account.payment'].map((p) => p.id === created.id ? { ...p, iso20022_charge_bearer: 'CRED' } : p) } };
  assert.throws(() => applyDiff(posted, diffDb(posted, forged), { isAdmin: true }), /charge bearer of a posted payment cannot be changed/i);
});

test('only draft batches may be deleted locally or through a diff', () => {
  const base = seed();
  for (const state of ['draft', 'posted', 'sent', 'reconciled']) {
    const batch = { id: 90001, name: 'Batch', state, batch_type: 'outbound', lines: [] };
    const db = { ...base, records: { ...base.records, 'account.batch.payment': [batch] } };
    const removed = { ...db, records: { ...db.records, 'account.batch.payment': [] } };
    if (state === 'draft') {
      assert.equal(unlink(db, 'account.batch.payment', [batch.id]).records['account.batch.payment'].length, 0);
      assert.equal(applyDiff(db, diffDb(db, removed), { isAdmin: true }).records['account.batch.payment'].length, 0);
    } else {
      assert.throws(() => unlink(db, 'account.batch.payment', [batch.id]), /Only draft batches can be deleted/);
      assert.throws(() => applyDiff(db, diffDb(db, removed), { isAdmin: true }), /Only draft batches can be deleted/);
    }
  }
});

test('payment list decorations follow paid matching and cancelled or rejected state', () => {
  for (const view of [customerPaymentView, vendorPaymentView]) {
    assert.equal(view.listDecoration({ state: 'cancel' }), 'muted');
    assert.equal(view.listDecoration({ state: 'rejected' }), 'muted');
    assert.equal(view.listDecoration({ state: 'posted', is_matched: false }), 'warning');
    assert.equal(view.listDecoration({ state: 'posted', is_matched: true }), null);
  }
});
