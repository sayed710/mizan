import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id));

test('rental pickup takes stock out and return brings it back; invoice bills days × qty × price', () => {
  const db0 = seed();
  const rental = search(db0, 'sale.rental').find((r) => r.state === 'reserved');
  const before = read(db0, 'product', rental.product_id).qty_available;
  let db = run(db0, 'sale.rental', rental.id, 'Pickup').db;
  assert.equal(read(db, 'product', rental.product_id).qty_available, before - rental.qty);
  db = run(db, 'sale.rental', rental.id, 'Return').db;
  assert.equal(read(db, 'product', rental.product_id).qty_available, before);
  const res = run(db, 'sale.rental', rental.id, 'Create Invoice');
  const inv = search(res.db, 'account.move').find((m) => m.invoice_origin === rental.name);
  assert.equal(inv.amount_untaxed, rental.amount_total);
  assert.equal(rental.amount_total, 4 * 15 * 7);
});

test('sending a mailing counts only subscribed recipients', () => {
  const db = seed();
  const draft = search(db, 'mailing.mailing').find((m) => m.state === 'draft');
  const sent = read(run(db, 'mailing.mailing', draft.id, 'Send').db, 'mailing.mailing', draft.id);
  assert.equal(sent.state, 'sent');
  assert.equal(sent.sent, 2);
});

test('sending to an empty list fails clearly', () => {
  const { db, id: list } = create(seed(), 'mailing.list', { name: 'Empty' });
  const { db: db2, id } = create(db, 'mailing.mailing', { subject: 'Hi', list_id: list });
  assert.throws(() => run(db2, 'mailing.mailing', id, 'Send'), /no subscribed recipients/);
});

test('signing requires the typed signature (prompt) and locks the document', () => {
  const base = seed();
  const sent = search(base, 'sign.request').find((r) => r.state === 'sent');
  globalThis.prompt = () => 'Gulf Interiors';
  // Staff never sign for the customer; only a company signer signs in the app.
  assert.throws(() => run(base, 'sign.request', sent.id, 'Sign Now'), /own signing link|not available/);
  const db = write(base, 'sign.request', sent.id, { signer_ids: [{ partner_id: sent.partner_id, role: 'company', signed: false, token: 'a'.repeat(64) }] });
  const req = read(db, 'sign.request', sent.id);
  const signed = read(run(db, 'sign.request', req.id, 'Sign Now').db, 'sign.request', req.id);
  assert.equal(signed.state, 'signed');
  assert.equal(signed.signature, 'Gulf Interiors');
  assert.ok(models['sign.request'].form.lockedWhen(signed));
  delete globalThis.prompt;
  assert.ok(write(db, 'sign.request', req.id, { state: 'canceled' }));
});
