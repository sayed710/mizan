import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { installments, termModels } from './models/terms.js';
import { changeFormValue } from './views/formDefaults.js';
import { postMove } from './models/accounting.js';

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
  assert.equal(read(write(db, model, made.id, { active: false, name: 'Changed' }), model, made.id).name, 'Changed');
  assert.throws(() => write(db, model, made.id, { active: false, line_ids: [{ value_type: 'percent', value: 80 }] }), /sum of the percent/);
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

test('legacy mixed-term invoices can post when fixed plus percentage exactly cover total', () => {
  const base = seed();
  const mixedLines = [
    { value_type: 'fixed', value: 50, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'percent', value: 50, nb_days: 30, delay_type: 'days_after' },
  ];
  const term = create(base, model, { name: 'Legacy Mixed 50-50' });
  const dbWithTerm = patch(term.db, term.id, { line_ids: mixedLines });

  // 1) Post draft invoice for 100: exactly covered (50 fixed + 50% of 100 = 100)
  const inv = create(dbWithTerm, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const postedDb = postMove(inv.db, inv.id);
  const postedInv = read(postedDb, 'account.move', inv.id);
  assert.equal(postedInv.state, 'posted');
  assert.deepEqual(installments(read(postedDb, model, term.id), 100, '2026-03-01'), [
    { date: '2026-03-01', amount: 50 },
    { date: '2026-03-31', amount: 50 },
  ]);

  // 2) Underallocated schedule throws (e.g. 150 invoice: 50 + 75 = 125 != 150)
  const underInv = create(dbWithTerm, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 150, tax: 0 }],
  });
  assert.throws(() => postMove(underInv.db, underInv.id), /allocate 100%/);

  // 3) Overallocated schedule throws (e.g. 80 invoice: 50 + 40 = 90 != 80)
  const overInv = create(dbWithTerm, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-03-01',
    invoice_payment_term_id: term.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 80, tax: 0 }],
  });
  assert.throws(() => postMove(overInv.db, overInv.id), /allocate 100%/);

  // 4) Save-time requirement still rejects saving new mixed terms whose percents don't total 100%
  assert.throws(
    () => create(base, model, { name: 'New Mixed 50-50', line_ids: mixedLines }),
    /sum of the percent must be 100%/,
  );
});

test('changing company preserves explicitly selected discount tax mode', () => {
  const base = seed();
  const comp2 = create(base, 'res.company', { name: 'NL Co', country_code: 'NL' });
  const db = comp2.db;

  const initial = { name: 'Discount Term', early_discount: true, discount_percent: 2, discount_days: 10, company_id: 1, discount_tax_computation: 'included' };
  const editedFields = new Set();

  // User explicitly selects 'mixed' mode
  const change1 = changeFormValue(model, initial, {}, 'discount_tax_computation', 'mixed', db, false, editedFields);
  assert.equal(change1.discount_tax_computation, 'mixed');

  // User then changes company to Company 2 (NL)
  const change2 = changeFormValue(model, initial, change1, 'company_id', comp2.id, db, false, editedFields);
  assert.equal(change2.discount_tax_computation, 'mixed', 'explicitly selected mode is preserved when company changes');

  // Conversely, when discount_tax_computation was NOT explicitly edited, changing company updates the mode
  const untouchedFields = new Set();
  const changeCompanyOnly = changeFormValue(model, initial, {}, 'company_id', comp2.id, db, false, untouchedFields);
  assert.equal(changeCompanyOnly.discount_tax_computation, 'excluded', 'defaulted mode is recomputed on company change');
});

test('terms for company without country code default to included and do not inherit current company mode', () => {
  const base = seed();
  // Set current company (id: 1) to Belgium (country_code: 'BE', default 'mixed')
  const dbWithBE = {
    ...base,
    settings: { ...base.settings, current_company_id: 1 },
    records: {
      ...base.records,
      'res.company': base.records['res.company'].map((c) => (c.id === 1 ? { ...c, country_code: 'BE' } : c)),
    },
  };
  // Create Company 2 without a country code
  const compNoCountry = create(dbWithBE, 'res.company', { name: 'No Country Co', country_code: null });
  const db = compNoCountry.db;

  // 1) Creating a term explicitly selecting Company 2 derives 'included', NOT current company's 'mixed'
  const termForComp2 = create(db, model, { name: 'Term Co 2', company_id: compNoCountry.id });
  assert.equal(read(termForComp2.db, model, termForComp2.id).discount_tax_computation, 'included');

  // 2) Company onchange to Company 2 derives 'included'
  const onchangeResult = termModels[model].onchange({ company_id: compNoCountry.id }, 'company_id', db);
  assert.equal(onchangeResult.discount_tax_computation, 'included');

  // 3) Creating a term without selected company falls back to current company (BE -> 'mixed')
  const termNoComp = create(db, model, { name: 'Term Shared', company_id: null });
  assert.equal(read(termNoComp.db, model, termNoComp.id).discount_tax_computation, 'mixed');
});

test('programmatic write moving a term between companies updates defaulted discount tax mode and preserves explicit modes', () => {
  const base = seed();
  const currencyId = read(base, 'res.company', 1).currency_id;
  const be = create(base, 'res.company', { name: 'BE Co', country_code: 'BE', currency_id: currencyId });
  const nl = create(be.db, 'res.company', { name: 'NL Co', country_code: 'NL', currency_id: currencyId });
  const db = nl.db;

  // 1) Term created for BE inherits 'mixed'; moving to NL via write() recomputes to 'excluded'
  const defaultedTerm = create(db, model, {
    name: 'BE Defaulted Term',
    company_id: be.id,
    early_discount: true,
    discount_percent: 10,
    discount_days: 10,
  });
  assert.equal(read(defaultedTerm.db, model, defaultedTerm.id).discount_tax_computation, 'mixed');
  const movedToNl = write(defaultedTerm.db, model, defaultedTerm.id, { company_id: nl.id });
  assert.equal(read(movedToNl, model, defaultedTerm.id).discount_tax_computation, 'excluded');

  // Verify subsequent invoice tax calculation uses the updated NL ('excluded') mode rather than stale BE ('mixed')
  const inv = create(movedToNl, 'account.move', {
    move_type: 'out_invoice',
    company_id: nl.id,
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_payment_term_id: defaultedTerm.id,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 20 }],
  });
  assert.equal(read(inv.db, 'account.move', inv.id).amount_tax, 20);

  // 2) Term with custom mode ('included' on BE) keeps 'included' when moved via write()
  const customTerm = create(db, model, {
    name: 'BE Custom Term',
    company_id: be.id,
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'included',
  });
  const movedCustom = write(customTerm.db, model, customTerm.id, { company_id: nl.id });
  assert.equal(read(movedCustom, model, customTerm.id).discount_tax_computation, 'included');

  // 3) Explicitly supplying discount_tax_computation in the same write() is never overwritten
  const explicitMove = write(defaultedTerm.db, model, defaultedTerm.id, {
    company_id: nl.id,
    discount_tax_computation: 'mixed',
  });
  assert.equal(read(explicitMove, model, defaultedTerm.id).discount_tax_computation, 'mixed');

  // 4) Legacy term with unset discount_tax_computation gets the new company's default on move
  const unsetDb = patch(defaultedTerm.db, defaultedTerm.id, { discount_tax_computation: null });
  const movedUnset = write(unsetDb, model, defaultedTerm.id, { company_id: nl.id });
  assert.equal(read(movedUnset, model, defaultedTerm.id).discount_tax_computation, 'excluded');
});
