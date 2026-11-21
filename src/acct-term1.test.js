import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installments, termModels } from './models/terms.js';

const line = (value, nb_days) => ({ value_type: 'percent', value, nb_days, delay_type: 'days_after' });

test('installments allocate rounding in computed due-date order', () => {
  const term = { line_ids: [line(50, 30), line(50, 0)] };
  assert.deepEqual(installments(term, 0.01, '2026-01-01'), [
    { date: '2026-01-01', amount: 0.01 }, { date: '2026-01-31', amount: 0 },
  ]);
});

test('installments already in date order retain their allocation', () => {
  assert.deepEqual(installments({ line_ids: [line(50, 0), line(50, 30)] }, 0.01, '2026-01-01'), [
    { date: '2026-01-01', amount: 0.01 }, { date: '2026-01-31', amount: 0 },
  ]);
});

test('installment dates option is available on the term and used by the invoice print', () => {
  const model = termModels['account.payment.term'];
  assert.equal(model.fields.display_on_invoice.type, 'boolean');
  assert.equal(model.fields.display_on_invoice.label, 'Show installment dates');
  assert.equal(model.fields.show_installment_dates, undefined);
  assert.ok(model.form.groups({}).some((group) => group.fields.includes('display_on_invoice')));
  const print = readFileSync(new URL('./views/PrintDoc.jsx', import.meta.url), 'utf8');
  assert.match(print, /term\?\.display_on_invoice/);
  assert.doesNotMatch(print, /show_installment_dates/);
  assert.match(print, /installments\(/);
  assert.match(print, /<table/);
});

test('a balance line keeps the remainder even when its due date is earlier', () => {
  const term = { line_ids: [line(30, 30), { value_type: 'balance', nb_days: 0 }] };
  assert.deepEqual(installments(term, 100, '2026-01-01'), [
    { date: '2026-01-01', amount: 70 }, { date: '2026-01-31', amount: 30 },
  ]);
});
