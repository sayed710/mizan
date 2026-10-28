import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { create, read, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { editableFields } from './models/locks.js';
import { closeFiscalYear } from './models/closing.js';
import { payMove, postMove } from './models/accounting.js';
import { sendRequest, signFields } from './models/signplus.js';

const user = { author: 'Sam', isAdmin: false };

test('a locked record keeps its editable fields on the server for non-admin users', () => {
  const db = seed();
  const year = create(db, 'account.fiscal.year', { name: 'FY 2031', date_from: '2031-01-01', date_to: '2031-12-31' });
  const closed = closeFiscalYear(year.db, year.id);
  const base = applyDiff(db, diffDb(db, closed), { author: 'Admin', isAdmin: true });
  const renamed = write(base, 'account.fiscal.year', year.id, { name: 'Renamed' });
  assert.throws(() => applyDiff(base, diffDb(base, renamed), user), /locked: Fiscal Year cannot change/);
  // Administrators may still correct it, and workflow fields stay writable.
  assert.equal(read(applyDiff(base, diffDb(base, renamed), { author: 'Admin', isAdmin: true }), 'account.fiscal.year', year.id).name, 'Renamed');
  const reopened = write(base, 'account.fiscal.year', year.id, { state: 'open' });
  assert.equal(read(applyDiff(base, diffDb(base, reopened), user), 'account.fiscal.year', year.id).state, 'open');
});

test('posted invoice lines and payment details stay locked while payment workflows work', () => {
  const draft = create(seed(), 'account.move', { partner_id: 1, invoice_date: '2031-04-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const base = postMove(draft.db, draft.id);
  const invoice = read(base, 'account.move', draft.id);
  assert.ok(editableFields(models['account.move'], invoice, base).includes('invoice_line_ids'));
  const edit = { upserts: { 'account.move': [{ ...invoice, invoice_line_ids: [{ ...invoice.invoice_line_ids[0], price_unit: 200 }] }] } };
  assert.throws(() => applyDiff(base, edit, user), /Posted entries cannot be edited/);
  const paid = payMove(base, draft.id, 40, '2031-04-02');
  const saved = applyDiff(base, diffDb(base, paid), user);
  assert.equal(read(saved, 'account.move', draft.id).amount_paid, 40);
  const payment = saved.records['account.payment'].at(-1);
  const altered = write(saved, 'account.payment', payment.id, { memo: 'Changed' });
  assert.throws(() => applyDiff(saved, diffDb(saved, altered), user), /locked/);
});

test('legacy partial updates preserve locked record state and still enforce locks', () => {
  const draft = create(seed(), 'account.move', { partner_id: 1, invoice_date: '2031-04-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  const base = postMove(draft.db, draft.id);
  const partial = { upserts: { 'account.move': [{ id: draft.id, ref: 'New reference' }] } };
  const saved = applyDiff(base, partial, user);
  const invoice = read(saved, 'account.move', draft.id);
  assert.equal(invoice.ref, 'New reference');
  assert.equal(invoice.state, 'posted');
  assert.deepEqual(invoice.invoice_line_ids, read(base, 'account.move', draft.id).invoice_line_ids);
  assert.throws(() => applyDiff(saved, { upserts: { 'account.move': [{ id: draft.id, partner_id: 2 }] } }, user), /Posted entries cannot be edited/);
});

test('signing remains possible while sent and completed signatures cannot change', () => {
  const draft = create(seed(), 'sign.request', { name: 'Agreement', partner_id: 1, deadline: '2031-12-31', signer_ids: [{ partner_id: 1, role: 'company', signed: false }] });
  const sent = sendRequest(draft.db, read(draft.db, 'sign.request', draft.id)).db;
  const signed = signFields(sent, read(sent, 'sign.request', draft.id), 0, {}, 'Sam');
  const base = applyDiff(sent, diffDb(sent, signed), user);
  const before = read(base, 'sign.request', draft.id);
  assert.equal(before.state, 'signed');
  for (const vals of [{ signature: 'Forged' }, { signer_ids: [{ ...before.signer_ids[0], signature: 'Forged' }] }, { field_values: [{ signer_index: 0, item_index: 0, value: 'Forged' }] }]) {
    const edited = write(base, 'sign.request', draft.id, vals);
    assert.throws(() => applyDiff(base, diffDb(base, edited), user), /locked/);
  }
  const reassigned = write(sent, 'sign.request', draft.id, { signer_ids: [{ ...read(sent, 'sign.request', draft.id).signer_ids[0], partner_id: 2 }] });
  assert.throws(() => applyDiff(sent, diffDb(sent, reassigned), user), /locked/);
});

test('order lines on a locked document only lock their user-entered columns', () => {
  const field = { type: 'one2many', fields: { product_id: { type: 'many2one' }, qty: { type: 'float' }, qty_invoiced: { type: 'float', readonly: true } } };
  const model = { fields: { lines: field, state: { type: 'selection' } }, form: { statusbar: 'state', groups: [['state']], tabs: [{ label: 'Lines', fields: ['lines'] }], lockedWhen: (r) => r.state === 'done' } };
  assert.deepEqual(editableFields(model), ['lines']);
  assert.deepEqual(editableFields({ ...model, form: { ...model.form, title: 'lines' } }), ['lines']);
});

test('every lockable model names at least one editable field it protects', () => {
  const lockable = Object.entries(models).filter(([, m]) => m.form?.lockedWhen);
  assert.ok(lockable.length > 30);
  for (const [name, m] of lockable) assert.ok(Array.isArray(editableFields(m)), name);
});
