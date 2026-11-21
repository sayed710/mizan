import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { postEntry } from './models/ledger.js';
import { closableTaxPayable, taxReport } from './models/finance.js';

test('closing includes an unclosed tax line from an earlier period while the report stays in period', () => {
  let db = seed();
  db = postEntry(db, { journal: 'MISC', date: '2025-01-15', company: 1, lines: [
    { account: '101401', debit: 14 }, { account: '251000', credit: 14, tax_name: 'VAT' },
  ] }).db;
  const ret = { company_id: 1, date_from: '2025-02-01', date_to: '2025-02-28' };
  assert.equal(taxReport(db, { company_id: 1, from: ret.date_from, to: ret.date_to }).payable, 0);
  assert.equal(closableTaxPayable(db, ret), 14);
});
import { create, read, search } from './orm.js';
import { models } from './models/index.js';
import { applyDiff, diffDb } from './sync.js';

const runAction = (db, id, label) => {
  const action = models['account.return'].form.buttons.find((button) => button.label === label);
  const next = action.run(db, read(db, 'account.return', id)).db;
  return applyDiff(db, diffDb(db, next), { isAdmin: true });
};
const makeReturn = (db, name, from, to) => create(db, 'account.return', {
  name, type_id: search(db, 'account.return.type')[0].id, company_id: 1, date_from: from, date_to: to,
});
const taxEntry = (db, date, amount) => postEntry(db, { journal: 'MISC', date, company: 1, lines: [
  { account: '101401', debit: amount }, { account: '251000', credit: amount, tax_name: 'VAT' },
] });

test('a late line closes once and becomes available after reset, with guarded provenance', () => {
  let db = seed();
  db = taxEntry(db, '2025-01-10', 10).db;
  const first = makeReturn(db, 'January', '2025-01-01', '2025-01-31');
  db = runAction(first.db, first.id, 'Review');
  db = runAction(db, first.id, 'Submit');
  // Represent a late-arriving posted entry in the imported ledger after January was closed.
  const late = taxEntry(db, '2025-02-05', 14);
  db = { ...late.db, records: { ...late.db.records, 'account.move': late.db.records['account.move'].map((move) =>
    move.id === late.id ? { ...move, date: '2025-01-15', invoice_date: '2025-01-15' } : move) } };
  const second = makeReturn(db, 'February', '2025-02-01', '2025-02-28');
  db = runAction(second.db, second.id, 'Review');
  assert.equal(read(db, 'account.return', second.id).total_amount_to_pay, 14);
  const candidate = models['account.return'].form.buttons.find((button) => button.label === 'Submit')
    .run(db, read(db, 'account.return', second.id)).db;
  const candidateId = read(candidate, 'account.return', second.id).closing_move_ids[0];
  const tampered = { ...candidate, records: { ...candidate.records, 'account.move': candidate.records['account.move'].map((move) =>
    move.id === candidateId ? { ...move, tax_closing_lines: [] } : move) } };
  assert.throws(() => applyDiff(db, diffDb(db, tampered), { isAdmin: true }), /closing/i);
  db = applyDiff(db, diffDb(db, candidate), { isAdmin: true });
  const closing = read(db, 'account.return', second.id).closing_move_ids[0];
  const move = read(db, 'account.move', closing);
  assert.equal(closableTaxPayable(db, { company_id: 1, date_from: '2025-03-01', date_to: '2025-03-31' }), 0);
  const forged = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) =>
    m.id === closing ? { ...m, tax_closing_lines: [] } : m) } };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /posted|locked|edit|links/i);
  assert.ok(move.tax_closing_lines.length);
  db = runAction(db, second.id, 'Reset to Draft');
  assert.equal(closableTaxPayable(db, { company_id: 1, date_from: '2025-02-01', date_to: '2025-02-28' }), 14);
  db = runAction(db, second.id, 'Review');
  db = runAction(db, second.id, 'Submit');
  assert.equal(read(db, 'account.return', second.id).total_amount_to_pay, 14);
  assert.equal(closableTaxPayable(db, { company_id: 1, date_from: '2025-03-01', date_to: '2025-03-31' }), 0);
  const third = makeReturn(db, 'March', '2025-03-01', '2025-03-31');
  db = runAction(third.db, third.id, 'Review');
  db = runAction(db, third.id, 'Submit');
  assert.equal(read(db, 'account.return', third.id).total_amount_to_pay, 0);
});

test('historical posted closing without provenance covers its own period', () => {
  let db = seed();
  db = taxEntry(db, '2025-01-10', 10).db;
  const first = makeReturn(db, 'January', '2025-01-01', '2025-01-31');
  db = runAction(first.db, first.id, 'Review');
  db = runAction(db, first.id, 'Submit');
  const closing = read(db, 'account.return', first.id).closing_move_ids[0];
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((move) => {
    if (move.id !== closing) return move;
    const { tax_closing_lines: _old, ...legacy } = move;
    return legacy;
  }) } };
  db = taxEntry(db, '2025-02-05', 14).db;
  assert.equal(closableTaxPayable(db, { company_id: 1, date_from: '2025-02-01', date_to: '2025-02-28' }), 14);
});
