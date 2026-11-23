import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { installments, termModels } from './models/terms.js';

const model = 'account.payment.term';
const sync = (db, next) => applyDiff(db, diffDb(db, next), { isAdmin: true });
const patch = (db, id, vals) => ({ ...db, records: { ...db.records, [model]: db.records[model].map((r) => r.id === id ? { ...r, ...vals } : r) } });

test('PTM-1 validates saved term lines and early discounts through sync', () => {
  const term = create(seed(), model, { name: 'Term' });
  const invalid = [
    [{ line_ids: [{ value_type: 'percent', value: 90 }] }, /sum of the percent/],
    [{ line_ids: [{ value_type: 'percent', value: 101 }] }, /between 0 and 100/],
    [{ line_ids: [{ value_type: 'percent', value: 50 }, { value_type: 'percent', value: 50 }], early_discount: true, discount_percent: 2, discount_days: 10 }, /single 100% line/],
    [{ early_discount: true, discount_percent: 0, discount_days: 10 }, /strictly positive/],
    [{ early_discount: true, discount_percent: 2, discount_days: 0 }, /days must be strictly positive/],
  ];
  for (const [vals, error] of invalid) assert.throws(() => sync(term.db, patch(term.db, term.id, vals)), error);
  assert.doesNotThrow(() => sync(term.db, patch(term.db, term.id, { line_ids: [{ value_type: 'percent', value: 30 }, { value_type: 'balance' }] })));
});

test('PTM-2 protects referenced terms while allowing archive through sync', () => {
  const term = create(seed(), model, { name: 'Term' });
  const db = { ...term.db, records: { ...term.db.records, 'account.move': [...term.db.records['account.move'], { id: 999999, invoice_payment_term_id: term.id }] } };
  const deleted = { ...db, records: { ...db.records, [model]: db.records[model].filter((r) => r.id !== term.id) } };
  assert.throws(() => sync(db, deleted), /can't be deleted/);
  assert.equal(read(sync(db, patch(db, term.id, { active: false })), model, term.id).active, false);
});

test('PTM-3 defaults discount tax mode from company country', () => {
  const base = seed();
  for (const [code, expected] of [['BE', 'mixed'], ['NL', 'excluded'], ['EG', 'included']]) {
    const db = { ...base, records: { ...base.records, 'res.company': base.records['res.company'].map((c) => c.id === 1 ? { ...c, country_code: code } : c) } };
    const term = create(db, model, { name: code });
    assert.equal(read(term.db, model, term.id).discount_tax_computation, expected);
  }
});

test('PTM-4 exposes note in kanban and archived search filter', () => {
  const def = termModels[model];
  assert.deepEqual(def.kanban.lines, ['note']);
  const filter = def.filters.flat().find((f) => f.id === 'archived');
  assert.equal(filter.includeArchived, true);
  assert.equal(filter.fn({ active: false }), true);
  assert.equal(filter.fn({ active: true }), false);
});

test('legacy invalid terms can only be archived without other changes', () => {
  const made = create(seed(), model, { name: 'Legacy' });
  const db = patch(made.db, made.id, { line_ids: [{ value_type: 'percent', value: 90 }] });
  const archived = write(db, model, made.id, { active: false });
  assert.equal(read(archived, model, made.id).active, false);
  assert.throws(() => write(archived, model, made.id, { active: true }), /sum of the percent/);
  assert.throws(() => write(db, model, made.id, { active: false, name: 'Changed' }), /sum of the percent/);
  assert.equal(read(sync(db, patch(db, made.id, { active: false })), model, made.id).active, false);
});

test('sync deletion uses surviving invoice references', () => {
  const term = create(seed(), model, { name: 'Referenced' });
  const invoice = create(term.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_payment_term_id: term.id });
  const db = invoice.db;
  const withoutTerm = { ...db, records: { ...db.records, [model]: db.records[model].filter((r) => r.id !== term.id) } };
  assert.throws(() => sync(db, withoutTerm), /can't be deleted/);
  const cleared = { ...withoutTerm, records: { ...withoutTerm.records, 'account.move': db.records['account.move'].map((r) => r.id === invoice.id ? { ...r, invoice_payment_term_id: null } : r) } };
  assert.equal(read(sync(db, cleared), model, term.id), undefined);
  const deleted = { ...withoutTerm, records: { ...withoutTerm.records, 'account.move': db.records['account.move'].filter((r) => r.id !== invoice.id) } };
  assert.equal(read(sync(db, deleted), model, term.id), undefined);
});

test('mixed schedules require 100 percent and balance-only discounts are rejected', () => {
  const lines = [{ value_type: 'fixed', value: 60 }, { value_type: 'percent', value: 50 }];
  assert.throws(() => installments({ line_ids: lines }, 100, '2026-01-01'), /allocate 100%/);
  assert.deepEqual(installments({ line_ids: [lines[0], { ...lines[1], value: 100 }] }, 100, '2026-01-01').map((r) => r.amount), [60, 40]);
  assert.throws(() => create(seed(), model, { name: 'Bad discount', early_discount: true, discount_percent: 2, discount_days: 10, line_ids: [{ value_type: 'balance' }] }), /single 100% line/);
});
