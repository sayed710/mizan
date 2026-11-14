import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { MIGRATIONS, SCHEMA_VERSION, migrate } from './migrations.js';
import { payMove, postMove, creditNote, statusInPayment } from './models/accounting.js';
import { today } from './models/common.js';
import { conversionRate, rateAt, toCompany } from './models/currency.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';

function cleanMovesDb() {
  const base = seed();
  return {
    ...base,
    records: {
      ...base.records,
      'account.move': [],
      'account.payment': [],
      'account.bank.statement.line': [],
      'purchase.order': [],
    },
  };
}

function addOutstandingReceipts(db) {
  const acc = create(db, 'account.account', { code: 'Q116-OUT-REC', name: 'Outstanding Receipts', company_id: 1, account_type: 'asset_current', reconcile: true });
  return write(acc.db, 'res.company', 1, { outstanding_receipts_account_id: acc.id });
}

test('finding 1a: migration 45 splits a company-less tax group shared by a company-less tax and a company-2 tax', () => {
  let db = seed();
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch Two' });
  db = c2.db;
  const groupId = db.records['account.tax'][0].tax_group_id;
  const t1 = db.records['account.tax'][0];
  const t2 = db.records['account.tax'].find((t) => t.id !== t1.id);
  const { company_id: _drop1, ...t1CompanyLess } = t1;
  const legacy = {
    ...db,
    records: {
      ...db.records,
      'account.tax.group': db.records['account.tax.group'].map((g) => (g.id === groupId ? { ...g, company_id: null } : g)),
      'account.tax': db.records['account.tax'].map((t) => {
        if (t.id === t1.id) return { ...t1CompanyLess, tax_group_id: groupId };
        if (t.id === t2.id) return { ...t, tax_group_id: groupId, company_id: c2.id };
        return t;
      }),
    },
  };

  const migrated = MIGRATIONS.find((m) => m.version === 45).up(legacy);
  const migratedT1 = migrated.records['account.tax'].find((t) => t.id === t1.id);
  const migratedT2 = migrated.records['account.tax'].find((t) => t.id === t2.id);
  assert.equal(migratedT1.tax_group_id, groupId);
  assert.equal(migrated.records['account.tax.group'].find((g) => g.id === groupId).company_id, 1);
  assert.notEqual(migratedT2.tax_group_id, groupId);
  assert.equal(migrated.records['account.tax.group'].find((g) => g.id === migratedT2.tax_group_id).company_id, c2.id);

  const ready = { ...migrated, schema_version: SCHEMA_VERSION };
  assert.doesNotThrow(() => write(ready, 'account.tax', t1.id, { active: false }));
  assert.doesNotThrow(() => write(ready, 'account.tax', t2.id, { active: false }));
});

test('finding 1b: migration 52 repairs databases migrated by old 45 and reuses per-company copies', () => {
  let db = seed();
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Branch Two' });
  db = c2.db;
  const groupId = db.records['account.tax'][0].tax_group_id;
  const [t1, t2, t3] = db.records['account.tax'];
  const { company_id: _drop, ...t1NoCompany } = t1;

  // State left by old migration 45: group assigned to company 2 while company-less and company-1 taxes still point to it.
  const pre52 = {
    ...db,
    schema_version: 51,
    records: {
      ...db.records,
      'account.tax.group': db.records['account.tax.group'].map((g) => (g.id === groupId ? { ...g, company_id: c2.id } : g)),
      'account.tax': db.records['account.tax'].map((t) => {
        if (t.id === t1.id) return { ...t1NoCompany, tax_group_id: groupId };
        if (t.id === t2.id) return { ...t, company_id: 1, tax_group_id: groupId };
        if (t.id === t3.id) return { ...t, company_id: c2.id, tax_group_id: groupId };
        return t;
      }),
    },
  };

  const upgraded = migrate(pre52);
  assert.equal(upgraded.schema_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 53);

  const uT1 = read(upgraded, 'account.tax', t1.id);
  const uT2 = read(upgraded, 'account.tax', t2.id);
  const uT3 = read(upgraded, 'account.tax', t3.id);

  // Company-2 tax keeps the company-2 group; company-less and company-1 taxes share one new company-1 copy.
  assert.equal(uT3.tax_group_id, groupId);
  assert.notEqual(uT1.tax_group_id, groupId);
  assert.equal(uT1.tax_group_id, uT2.tax_group_id);
  const copyGroup = read(upgraded, 'account.tax.group', uT1.tax_group_id);
  assert.equal(copyGroup.company_id, 1);
  assert.equal(upgraded.seq['account.tax.group'], uT1.tax_group_id);

  // Editing/archiving repaired taxes succeeds and re-migrating is a no-op.
  assert.doesNotThrow(() => write(upgraded, 'account.tax', t1.id, { active: false }));
  assert.doesNotThrow(() => write(upgraded, 'account.tax', t2.id, { active: false }));
  assert.equal(migrate(upgraded), upgraded);
});

test('finding 2: signedDocumentAmount matches signedCompanyTotal sign for all invoice/bill/refund types and preserves zero/null', () => {
  let db = cleanMovesDb();
  let eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 0.5 }], active: true });
  eur = read(db, 'res.currency', eur.id);
  const d0 = today();

  const make = (moveType, partnerId, price) => {
    const res = create(db, 'account.move', {
      move_type: moveType,
      partner_id: partnerId,
      currency_id: eur.id,
      invoice_date: d0,
      invoice_date_due: d0,
      invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: price, tax: 10 }],
    });
    db = postMove(res.db, res.id);
    return read(db, 'account.move', res.id);
  };

  const outInv = make('out_invoice', 2, 100);
  const outRef = make('out_refund', 2, 40);
  const inBill = make('in_invoice', 7, 200);
  const inRef = make('in_refund', 7, 50);

  const signedFields = [
    'amount_untaxed_in_currency_signed',
    'amount_tax_in_currency_signed',
    'amount_total_in_currency_signed',
    'amount_residual_in_currency_signed',
  ];

  // Positive for customer invoice and vendor refund; negative for customer refund and vendor bill.
  assert.equal(outInv.amount_total_in_currency_signed, 110);
  assert.equal(outRef.amount_total_in_currency_signed, -44);
  assert.equal(inBill.amount_untaxed_in_currency_signed, -200);
  assert.equal(inBill.amount_tax_in_currency_signed, -20);
  assert.equal(inBill.amount_total_in_currency_signed, -220);
  assert.equal(inBill.amount_residual_in_currency_signed, -220);
  assert.equal(inRef.amount_untaxed_in_currency_signed, 50);
  assert.equal(inRef.amount_tax_in_currency_signed, 5);
  assert.equal(inRef.amount_total_in_currency_signed, 55);
  assert.equal(inRef.amount_residual_in_currency_signed, 55);

  for (const rec of [outInv, outRef, inBill, inRef]) {
    const expectedSign = Math.sign(rec.amount_total_signed);
    for (const f of signedFields) {
      assert.equal(Math.sign(rec[f]), expectedSign, `${rec.move_type} ${f} matches signedCompanyTotal sign`);
    }
  }

  // Zero avoids -0 even on outbound documents, and missing currency keeps null.
  const zeroBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 7,
    currency_id: eur.id,
    invoice_date: d0,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 0, tax: 0 }],
  });
  const zeroRec = read(zeroBill.db, 'account.move', zeroBill.id);
  for (const f of signedFields) {
    assert.ok(Object.is(zeroRec[f], 0), `${f} is +0, not -0`);
  }
  const unconfigured = write(zeroBill.db, 'res.company', 1, { currency_id: null });
  const rawZero = unconfigured.records['account.move'].find((m) => m.id === zeroBill.id);
  const noDocCurr = { ...rawZero, currency_id: null };
  for (const f of signedFields) {
    assert.equal(models['account.move'].fields[f].compute(noDocCurr, unconfigured), null, `${f} returns null when currency is unconfigured`);
  }
});

test('finding 3: base currency displayed rate and inverse rate use implicit 1 and hide Rates tab even with a stored row when company currency differs', () => {
  const db = seed();
  const own = db.records['res.company'].find((c) => c.id === 1).currency_id;
  const base = db.records['res.currency'].find((c) => c.id !== own);
  const setup = {
    ...db,
    settings: { ...db.settings, base_currency_id: base.id },
    records: {
      ...db.records,
      'res.currency': db.records['res.currency'].map((c) => {
        if (c.id === base.id) return { ...c, rate_ids: [{ date: '2020-01-01', rate: 5 }] };
        if (c.id === own) return { ...c, rate_ids: [{ date: '2020-01-01', rate: 4 }] };
        return c;
      }),
    },
  };

  // Conversions ignore base's stored rate row (5) and use implicit 1 against own's 4 -> 0.25.
  assert.equal(conversionRate(setup, own, base.id, today(), 1), 0.25);
  assert.equal(rateAt(setup, base.id, today(), 1), 0.25);
  assert.equal(toCompany(setup, base.id, 100, today(), 1), 400);

  // Displayed rate, inverse_rate, and rate_date must match conversions (0.25, 4, null).
  const baseRec = read(setup, 'res.currency', base.id);
  assert.equal(baseRec.rate, 0.25);
  assert.equal(baseRec.current_rate, 0.25);
  assert.equal(baseRec.inverse_rate, 4);
  assert.equal(baseRec.rate_date, null);

  // Company currency keeps Rates tab when it is not base; base currency hides Rates tab so ignored rows aren't edited.
  const tabs = models['res.currency'].form.tabs;
  assert.deepEqual(tabs(read(setup, 'res.currency', base.id), setup), []);
  assert.deepEqual(tabs(read(setup, 'res.currency', own), setup).map((tab) => tab.label), ['Rates']);
});

test('finding 4: statusInPayment gives identical results for paid, in_payment, and reversed invoices across cached and updated snapshots', () => {
  let db = addOutstandingReceipts(cleanMovesDb());
  const d0 = today();

  const invInPay = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: d0, invoice_date_due: d0,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 80, tax: 0 }],
  });
  db = payMove(postMove(invInPay.db, invInPay.id), invInPay.id, 80, d0);

  const invPaid = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: d0, invoice_date_due: d0,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 90, tax: 0 }],
  });
  db = payMove(postMove(invPaid.db, invPaid.id), invPaid.id, 90, d0);
  const paidPayment = search(db, 'account.payment').find((p) => p.invoice_id === invPaid.id);
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const stmtLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id, date: d0, payment_ref: 'MATCH-Q116', amount: 90, state: 'to_check', partner_id: 2, payment_id: paidPayment.id,
  });
  const matchBtn = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment');
  db = matchBtn.run(stmtLine.db, read(stmtLine.db, 'account.bank.statement.line', stmtLine.id)).db;

  const invRev = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: d0, invoice_date_due: d0,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 70, tax: 0 }],
  });
  const revBase = postMove(invRev.db, invRev.id);
  const cnOut = creditNote(revBase, read(revBase, 'account.move', invRev.id));
  const cnId = Number(cnOut.go.split('/').at(-1));
  db = postMove(cnOut.db, cnId);

  // Repeated lookups on the same snapshot hit WeakMap caches and produce identical results.
  const recInPay = read(db, 'account.move', invInPay.id);
  const recPaid = read(db, 'account.move', invPaid.id);
  const recRev = read(db, 'account.move', invRev.id);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(statusInPayment(recInPay, db), 'in_payment');
    assert.equal(statusInPayment(recPaid, db), 'paid');
    assert.equal(statusInPayment(recRev, db), 'reversed');
  }

  // Matching the remaining payment on a new snapshot invalidates/refreshes statusInPayment to 'paid'.
  const inPayPayment = search(db, 'account.payment').find((p) => p.invoice_id === invInPay.id);
  const stmtLine2 = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id, date: d0, payment_ref: 'MATCH-Q116-2', amount: 80, state: 'to_check', partner_id: 2, payment_id: inPayPayment.id,
  });
  const matchedDb = matchBtn.run(stmtLine2.db, read(stmtLine2.db, 'account.bank.statement.line', stmtLine2.id)).db;
  assert.equal(statusInPayment(read(matchedDb, 'account.move', invInPay.id), matchedDb), 'paid');
});
