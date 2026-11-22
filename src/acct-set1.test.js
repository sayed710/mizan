import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

function setup() {
  let db = seed();
  db = write(db, 'res.company', 1, { use_invoice_terms: true, invoice_terms: 'Company one terms', incoterm_id: 11 });
  const second = create(db, 'res.company', { name: 'Second company', currency_id: read(db, 'res.company', 1).currency_id, use_invoice_terms: true, invoice_terms: 'Company two terms', incoterm_id: 22 });
  return { db: second.db, companyId: second.id };
}

function invoice(db, vals) {
  const result = create(db, 'account.move', vals);
  return read(result.db, 'account.move', result.id);
}

test('default terms follow invoice company and respect document type and explicit narration', () => {
  const { db, companyId } = setup();
  assert.equal(invoice(db, { move_type: 'out_invoice', company_id: companyId }).narration, 'Company two terms');
  assert.equal(invoice(db, { move_type: 'out_refund', company_id: 1 }).narration, 'Company one terms');
  assert.equal(invoice(db, { move_type: 'out_invoice', company_id: companyId, narration: '' }).narration, '');
  assert.equal(invoice(db, { move_type: 'in_invoice', company_id: companyId }).narration, undefined);
  assert.equal(invoice({ ...db, settings: { ...db.settings, current_company_id: companyId } }, { move_type: 'out_invoice' }).narration, 'Company one terms');
  const disabled = write(db, 'res.company', companyId, { use_invoice_terms: false });
  assert.equal(invoice(disabled, { move_type: 'out_invoice', company_id: companyId }).narration, undefined);
  const changed = models['account.move'].onchange({ move_type: 'out_invoice', company_id: companyId, narration: 'Company one terms' }, 'company_id', db, { previous: { company_id: 1 } });
  assert.equal(changed.narration, 'Company two terms');
  assert.equal(models['account.move'].onchange({ move_type: 'out_invoice', company_id: companyId, narration: 'Custom' }, 'company_id', db, { previous: { company_id: 1 } }).narration, undefined);
});

test('default incoterm follows invoice company and respects explicit selection', () => {
  const { db, companyId } = setup();
  assert.equal(invoice(db, { move_type: 'out_invoice', company_id: companyId }).incoterm_id, 22);
  assert.equal(invoice(db, { move_type: 'out_invoice', company_id: 1 }).incoterm_id, 11);
  assert.equal(invoice(db, { move_type: 'out_invoice', company_id: companyId, incoterm_id: 33 }).incoterm_id, 33);
  assert.equal(invoice(db, { move_type: 'in_invoice', company_id: companyId }).incoterm_id, undefined);
  assert.equal(invoice({ ...db, settings: { ...db.settings, current_company_id: companyId } }, { move_type: 'out_invoice' }).incoterm_id, 11);
  const changed = models['account.move'].onchange({ move_type: 'out_invoice', company_id: companyId, incoterm_id: 11 }, 'company_id', db, { previous: { company_id: 1 } });
  assert.equal(changed.incoterm_id, 22);
  assert.equal(models['account.move'].onchange({ move_type: 'out_invoice', company_id: companyId, incoterm_id: 33 }, 'company_id', db, { previous: { company_id: 1 } }).incoterm_id, undefined);
});
