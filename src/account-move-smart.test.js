import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { models, apps, findLeaf } from './models/index.js';
import { actionRecords } from './companyView.js';
import { reconciledItemFilter, reconciledJournalItems } from './models/ledger.js';

const smart = models['account.move'].form.smart;
const named = (name) => smart.find((button) => button.label === name);
const dynamic = (name, move) => smart.find((button) => typeof button.label === 'function' && button.label(move) === name);
const fixture = () => {
  const db = seed();
  const ar = db.records['account.account'].find((a) => a.account_type === 'asset_receivable');
  const other = db.records['account.account'].find((a) => a.account_type !== 'asset_receivable' && a.account_type !== 'liability_payable');
  const moves = [
    { id: 90001, move_type: 'out_invoice', state: 'posted', company_id: 1, line_ids: [{ account_id: ar.id, debit: 100, credit: 0 }] },
    { id: 90002, move_type: 'out_refund', state: 'draft', company_id: 1, reversed_entry_id: 90001 },
    { id: 90003, move_type: 'in_invoice', state: 'posted', company_id: 1 },
    { id: 90004, move_type: 'in_refund', state: 'draft', company_id: 1, reversed_entry_id: 90003 },
    { id: 90005, move_type: 'entry', state: 'posted', company_id: 1, line_ids: [{ account_id: ar.id, debit: 0, credit: 100 }] },
    { id: 90006, move_type: 'entry', state: 'posted', company_id: 1, line_ids: [{ account_id: other.id, debit: 0, credit: 10 }] },
    { id: 90007, move_type: 'entry', state: 'posted', company_id: 1, cash_basis_origin_move_id: 90001 },
    { id: 90008, move_type: 'entry', state: 'posted', company_id: 1, deferred_adjustment_of_id: 90003 },
    { id: 90009, move_type: 'entry', state: 'draft', company_id: 1, reversed_entry_id: 90005 },
    { id: 90010, move_type: 'entry', state: 'posted', company_id: 1, line_ids: [{ account_id: ar.id, debit: 0, credit: 100 }] },
  ];
  const payments = [
    { id: 91001, move_id: 90005, partner_type: 'customer', company_id: 1 },
    { id: 91002, move_id: 90006, partner_type: 'customer', company_id: 1 },
    { id: 91003, move_id: 90010, partner_type: 'supplier', company_id: 1 },
  ];
  const links = [
    { id: 92001, debit_move_id: 90001, debit_line_index: 0, credit_move_id: 90005, credit_line_index: 0, account_id: ar.id, amount: 30 },
    { id: 92002, debit_move_id: 90001, debit_line_index: 0, credit_move_id: 90010, credit_line_index: 0, account_id: ar.id, amount: 20 },
    { id: 92003, debit_move_id: 90001, debit_line_index: 0, credit_move_id: 90006, credit_line_index: 0, amount: 10 },
    { id: 92004, debit_move_id: 90001, debit_line_index: 0, credit_move_id: 90006, credit_line_index: 0, amount: 10, reversed: true },
  ];
  return { ...db, records: { ...db.records, 'account.move': [...db.records['account.move'], ...moves], 'account.payment': [...db.records['account.payment'], ...payments], 'account.partial.reconcile': [...(db.records['account.partial.reconcile'] ?? []), ...links] } };
};
const move = (db, id) => db.records['account.move'].find((m) => m.id === id);

test('reversal and original buttons use Odoo labels and exact relationships for invoices, bills and entries', () => {
  const db = fixture();
  for (const [id, label, targetId] of [[90001, 'Credit Notes', 90002], [90003, 'Refunds', 90004], [90005, 'Reversal Entries', 90009]]) {
    const record = move(db, id); const button = dynamic(label, record);
    assert.equal(button.when(record, db), true);
    assert.equal(button.value(db, record), 1);
    assert.equal(button.target(record, db), `accounting/entries?view=list&rel=reversed_entry_id:${id}`);
    assert.deepEqual(actionRecords(db, { model: 'account.move' }, { field: 'reversed_entry_id', id }).map((r) => r.id), [targetId]);
  }
  for (const [id, label, original] of [[90002, 'Invoice', 90001], [90004, 'Vendor Bill', 90003], [90009, 'Journal Entry', 90005]]) {
    const record = move(db, id); const button = dynamic(label, record);
    assert.equal(button.when(record, db), true);
    assert.equal(button.target(record, db), `accounting/entries/${original}`);
  }
  assert.equal(dynamic('Invoice', move(db, 90002)).when({ move_type: 'out_refund' }), false);
});

test('linked receipts have labeled reversal buttons in both directions', () => {
  const db = fixture();
  for (const [id, type] of [[93001, 'out_receipt'], [93003, 'in_receipt']]) {
    const source = { id, move_type: type, state: 'posted' };
    const reversal = { id: id + 1, move_type: type, state: 'posted', reversed_entry_id: id };
    db.records['account.move'].push(source, reversal);
    const forward = dynamic('Reversal Entries', source);
    const backward = dynamic('Journal Entry', reversal);
    assert.equal(forward.when(source, db), true);
    assert.equal(forward.value(db, source), 1);
    assert.equal(backward.when(reversal, db), true);
    assert.equal(backward.target(reversal, db), `accounting/entries/${id}`);
  }
});

test('reconciled item filter includes numbered and legacy settlements together', () => {
  const db = fixture();
  const invoice = move(db, 90001);
  invoice.payments = [{ move_id: 90010, amount: 100 }];
  db.records['account.partial.reconcile'] = db.records['account.partial.reconcile'].filter((link) => link.id !== 92002);
  const numbered = reconciledJournalItems(db, move(db, 90005), { partialMatching: true })[0];
  const legacy = reconciledJournalItems(db, move(db, 90010), { partialMatching: true })[0];
  assert.ok(numbered.matching_number);
  assert.equal(legacy.matching_number, undefined);
  assert.equal(legacy.reconciled, true);
  const filter = reconciledItemFilter(db, invoice);
  assert.equal(filter({ ...numbered, move_id: 90005 }), true);
  assert.equal(filter({ ...legacy, move_id: 90010 }), true);
  assert.equal(filter({ ...legacy, move_id: 90010, reconciled: false }), false);
  assert.equal(filter({ ...legacy, move_id: 90010, matching_number: 'other' }), false);
  assert.equal(filter({ ...legacy, move_id: 999999 }), false);
});

test('payments distinguish an originating payment from reconciled payments and select exact records', () => {
  const db = fixture(); const invoice = move(db, 90001); const entry = move(db, 90005);
  const origin = named('Payment'); const payments = named('Payments');
  assert.equal(origin.when(invoice, db), false);
  assert.equal(origin.when(entry, db), true);
  assert.equal(origin.target(entry, db), 'accounting/payments/91001');
  assert.equal(payments.when(invoice, db), true);
  assert.equal(payments.value(db, invoice), 2);
  assert.equal(payments.target(invoice, db), 'accounting/all-payments?view=list&rel=id:91001,91003');
  assert.equal(payments.when(entry, db), false);
  const accounting = apps.find((a) => a.id === 'accounting');
  const leaf = findLeaf(accounting, 'all-payments');
  assert.deepEqual(actionRecords(db, leaf, { field: 'id', ids: [91001, 91003] }).map((p) => p.id), [91001, 91003]);
  const legacy = { ...invoice, payments: [{ move_id: 90005 }, { move_id: 90005 }, { move_id: 90006, reversed: true }] };
  const withoutLinks = { ...db, records: { ...db.records, 'account.partial.reconcile': [] } };
  assert.equal(payments.value(withoutLinks, legacy), 1);
  assert.equal(payments.target(legacy, withoutLinks), 'accounting/payments/91001');
});

test('cash basis, adjusting entries and partial reconciliation obey relationship visibility', () => {
  const db = fixture(); const invoice = move(db, 90001); const bill = move(db, 90003); const entry = move(db, 90005);
  const cash = named('Cash Basis Entries'); const adjusting = named('Adjusting Entries'); const reconciled = named('Reconciled Items');
  assert.equal(cash.when(invoice, db), true);
  assert.equal(cash.target(invoice, db), 'accounting/entries?view=list&rel=id:90007');
  assert.equal(cash.when(bill, db), false);
  assert.equal(adjusting.when(bill, db), true);
  assert.equal(adjusting.value(db, bill), 1);
  assert.equal(adjusting.target(bill, db), 'accounting/entries?view=list&rel=deferred_adjustment_of_id:90003');
  assert.equal(adjusting.when(invoice, db), false);
  assert.equal(reconciled.when(entry, db), false, 'a partial match alone does not show the button');
  assert.equal(reconciled.when(invoice, db), false);
  const filter = reconciledItemFilter(db, entry);
  const related = reconciledJournalItems(db, invoice, { partialMatching: true })[0];
  assert.equal(filter({ ...related, move_id: invoice.id }), true, 'the matched partial line is included');
  assert.equal(filter({ move_id: invoice.id, matching_number: 'unrelated', reconciled: true }), false, 'an unrelated group in the same move is excluded');
  assert.equal(reconciled.target(entry, db), 'accounting/journal-items?reconciled_of=90005');
});

test('new smart button labels have Arabic translations', async () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => 'ar' };
  try {
    const { t } = await import('./i18n.js?smart-ar');
    for (const label of ['Cash Basis Entries', 'Reconciled Items']) assert.match(t(label), /[\u0600-\u06ff]/);
  } finally { globalThis.localStorage = previous; }
});
