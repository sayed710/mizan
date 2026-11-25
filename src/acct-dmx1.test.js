import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { create, read, search } from './orm.js';
import { models } from './registry.js';
import { postMove, payMove } from './models/accounting.js';
import { taxSnapshot } from './models/taxes.js';
import { diffDb, applyDiff } from './sync.js';

test('dmx1: mixed early-payment discount rounds each tax separately (3 x 0.12 = 0.36)', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const incomeAcc = search(db, 'account.account').find((a) => a.code === '400000');
  const taxAcc = search(db, 'account.account').find((a) => a.code === '251000');

  // Payment term with early_discount, discount_percent 2, discount_tax_computation 'mixed', single 100% line
  let termId;
  ({ db, id: termId } = create(db, 'account.payment.term', {
    name: '2% 10 Net 30 Mixed',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'mixed',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  }));

  // Invoice with three lines of 1.00, each with a different 12% tax (Tax A/B/C)
  let moveId;
  ({ db, id: moveId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-04-01',
    invoice_payment_term_id: termId,
    invoice_line_ids: [
      { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, tax: 12, tax_name: 'Tax A 12%', tax_account_id: taxAcc.id },
      { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, tax: 12, tax_name: 'Tax B 12%', tax_account_id: taxAcc.id },
      { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, tax: 12, tax_name: 'Tax C 12%', tax_account_id: taxAcc.id },
    ],
  }));

  // Draft invoice checks: amount_tax must be 0.36 (3 x round(0.12 * 0.98) = 0.36, not aggregate round(0.3528) = 0.35)
  const draft = read(db, 'account.move', moveId);
  assert.equal(models['account.move'].fields.amount_tax.compute(draft, db), 0.36);
  assert.equal(models['account.move'].fields.amount_total.compute(draft, db), 3.36);

  // Post invoice
  db = postMove(db, moveId);
  const posted = read(db, 'account.move', moveId);
  const receivable = posted.line_ids
    .filter((l) => l.name === posted.name)
    .reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);

  // Parity check: posted receivable = amount_total = amount_residual
  assert.equal(receivable, 3.36);
  assert.equal(models['account.move'].fields.amount_total.compute(posted, db), receivable);
  assert.equal(models['account.move'].fields.amount_residual.compute(posted, db), receivable);
  assert.equal(posted.amount_total, receivable);
  assert.equal(posted.amount_residual, receivable);
  assert.equal(posted.amount_tax, 0.36);

  // Three separate tax lines exist on the posted move with 0.12 each
  const taxLines = posted.line_ids.filter((l) => l.tax_name && !l.tax_zero);
  assert.equal(taxLines.length, 3);
  const taxAmounts = taxLines.map((l) => Number(l.credit) || 0).sort();
  assert.deepEqual(taxAmounts, [0.12, 0.12, 0.12]);

  // Paying the posted receivable settles the invoice completely with 0 residual
  db = payMove(db, moveId, receivable, '2026-04-20');
  const settled = read(db, 'account.move', moveId);
  assert.equal(models['account.move'].fields.amount_residual.compute(settled, db), 0);
  assert.equal(models['account.move'].fields.payment_state.compute(settled, db), 'paid');
});

test('dmx1: included and excluded modes preserve their standard tax calculations without regression', () => {
  for (const mode of ['included', 'excluded']) {
    let db = seed();
    const partner = search(db, 'res.partner')[0];
    const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
    const incomeAcc = search(db, 'account.account').find((a) => a.code === '400000');
    const taxAcc = search(db, 'account.account').find((a) => a.code === '251000');

    let termId;
    ({ db, id: termId } = create(db, 'account.payment.term', {
      name: `2% 10 Net 30 ${mode}`,
      early_discount: true,
      discount_percent: 2,
      discount_days: 10,
      discount_tax_computation: mode,
      line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
    }));

    let moveId;
    ({ db, id: moveId } = create(db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: partner.id,
      journal_id: saleJournal.id,
      invoice_date: '2026-04-01',
      invoice_payment_term_id: termId,
      invoice_line_ids: [
        { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, tax: 12, tax_name: 'Tax A 12%', tax_account_id: taxAcc.id },
        { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, tax: 12, tax_name: 'Tax B 12%', tax_account_id: taxAcc.id },
        { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, tax: 12, tax_name: 'Tax C 12%', tax_account_id: taxAcc.id },
      ],
    }));

    const draft = read(db, 'account.move', moveId);
    assert.equal(models['account.move'].fields.amount_tax.compute(draft, db), 0.36);
    assert.equal(models['account.move'].fields.amount_total.compute(draft, db), 3.36);

    db = postMove(db, moveId);
    const posted = read(db, 'account.move', moveId);
    const receivable = posted.line_ids
      .filter((l) => l.name === posted.name)
      .reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);

    assert.equal(receivable, 3.36);
    assert.equal(models['account.move'].fields.amount_total.compute(posted, db), receivable);
    assert.equal(models['account.move'].fields.amount_residual.compute(posted, db), receivable);
  }
});

test('dmx1: mixed early discount with registered account.tax records and sync diff verification', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const incomeAcc = search(db, 'account.account').find((a) => a.code === '400000');

  let taxAId, taxBId, taxCId;
  ({ db, id: taxAId } = create(db, 'account.tax', { name: 'Tax A 12%', type_tax_use: 'sale', amount_type: 'percent', amount: 12 }));
  ({ db, id: taxBId } = create(db, 'account.tax', { name: 'Tax B 12%', type_tax_use: 'sale', amount_type: 'percent', amount: 12 }));
  ({ db, id: taxCId } = create(db, 'account.tax', { name: 'Tax C 12%', type_tax_use: 'sale', amount_type: 'percent', amount: 12 }));

  const taxA = read(db, 'account.tax', taxAId);
  const taxB = read(db, 'account.tax', taxBId);
  const taxC = read(db, 'account.tax', taxCId);

  let termId;
  ({ db, id: termId } = create(db, 'account.payment.term', {
    name: '2% 10 Net 30 Mixed Registered',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    discount_tax_computation: 'mixed',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  }));

  let moveId;
  ({ db, id: moveId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJournal.id,
    invoice_date: '2026-04-01',
    invoice_payment_term_id: termId,
    invoice_line_ids: [
      { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, ...taxSnapshot(taxA) },
      { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, ...taxSnapshot(taxB) },
      { account_id: incomeAcc.id, qty: 1, price_unit: 1.00, ...taxSnapshot(taxC) },
    ],
  }));

  const draft = read(db, 'account.move', moveId);
  assert.equal(models['account.move'].fields.amount_tax.compute(draft, db), 0.36);
  assert.equal(models['account.move'].fields.amount_total.compute(draft, db), 3.36);

  db = postMove(db, moveId);
  const posted = read(db, 'account.move', moveId);
  const receivable = posted.line_ids
    .filter((l) => l.name === posted.name)
    .reduce((s, l) => s + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0);

  assert.equal(receivable, 3.36);
  assert.equal(models['account.move'].fields.amount_total.compute(posted, db), receivable);
  assert.equal(models['account.move'].fields.amount_residual.compute(posted, db), receivable);

  // Sync diff verification: applying empty diff preserves all records
  const diff = diffDb(db, db);
  const applied = applyDiff(db, diff);
  assert.deepEqual(applied.records, db.records);
});
