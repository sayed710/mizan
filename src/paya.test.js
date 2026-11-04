import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { postBatch, checkRegisterRows } from './models/payments.js';
import { dueDate } from './models/terms.js';
import { accountId } from './models/ledger.js';

test('payment term due date is the latest maturity regardless of line order', () => {
  assert.equal(dueDate({ line_ids: [{ nb_days: 60 }, { nb_days: 30 }] }, '2025-01-01'), '2025-03-02');
});

test('reversed individual checks remain in the register with their void history', () => {
  const db = seed();
  const payment = { id: 9999, state: 'reversed', payment_type: 'outbound', check_number: 42, amount: 20, date: '2025-01-01', voided_check_numbers: [{ check_number: 41 }] };
  const rows = checkRegisterRows(db, [], [payment]);
  assert.deepEqual(rows.map((r) => [r.checkNumber, r.state]), [[41, 'Voided'], [42, 'Reversed']]);
});

test('batch rejects invoice currency different from fixed journal currency before posting', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const made = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, company_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(made.db, made.id);
  const j = create(db, 'account.journal', { name: 'Foreign bank', code: 'FBK', type: 'bank', company_id: 1, currency_id: eur.id, default_account_id: accountId(db, '101501', 1) });
  const b = create(j.db, 'account.batch.payment', { batch_type: 'inbound', company_id: 1, journal_id: j.id, date: '2026-01-02', lines: [{ move_id: made.id, amount: 100 }] });
  assert.throws(() => postBatch(b.db, read(b.db, 'account.batch.payment', b.id)), /currency must match/i);
  assert.equal(read(b.db, 'account.batch.payment', b.id).state, 'draft');
});
