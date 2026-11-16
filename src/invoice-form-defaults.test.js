import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const { seed } = await import('./seed.js');
const { create, read, write } = await import('./orm.js');
const { models } = await import('./models/index.js');
const { newDefaults } = await import('./views/formDefaults.js');
const { postMove } = await import('./models/accounting.js');
const { FieldInput, display } = await import('./ui.jsx');
const { FormView } = await import('./views/FormView.jsx');
const { Checks } = await import('./views/Checks.jsx');
const { commit } = await import('./store.js');
const { applyDiff, diffDb } = await import('./sync.js');
const { createCompany } = await import('./models/company.js');
const { invoiceJournalDefaults } = await import('./test-support/accounting-company.js');

test('1. New invoice/bill defaults: Journal defaults to company default sales/purchase journal and currency displays company currency', () => {
  const db = seed();
  const company = read(db, 'res.company', 1);

  // Sales invoice defaults
  const salesDefaults = newDefaults(db, 'account.move', { defaults: { move_type: 'out_invoice' } }, new Map(), null);
  assert.equal(salesDefaults.journal_id, company.default_sale_journal_id, 'Sales invoice journal should default to default_sale_journal_id');

  // Credit note defaults
  const creditDefaults = newDefaults(db, 'account.move', { defaults: { move_type: 'out_refund' } }, new Map(), null);
  assert.equal(creditDefaults.journal_id, company.default_sale_journal_id, 'Credit note journal should default to default_sale_journal_id');

  // Vendor bill defaults
  const billDefaults = newDefaults(db, 'account.move', { defaults: { move_type: 'in_invoice' } }, new Map(), null);
  assert.equal(billDefaults.journal_id, company.default_purchase_journal_id, 'Vendor bill journal should default to default_purchase_journal_id');

  // Vendor refund defaults
  const refundDefaults = newDefaults(db, 'account.move', { defaults: { move_type: 'in_refund' } }, new Map(), null);
  assert.equal(refundDefaults.journal_id, company.default_purchase_journal_id, 'Vendor refund journal should default to default_purchase_journal_id');

  // Storage convention: currency_id remains null = company currency
  assert.equal(salesDefaults.currency_id ?? null, null, 'Storage convention preserves null for company currency');

  // Currency opt-in: only account.move.currency_id has emptyAsCompanyCurrency
  const moveCurrencyField = models['account.move'].fields.currency_id;
  const companyCurrencyField = models['res.company'].fields.currency_id;
  assert.equal(moveCurrencyField.emptyAsCompanyCurrency, true);
  assert.equal(companyCurrencyField.emptyAsCompanyCurrency, undefined);

  // Form display: on posted/readonly invoices where currency_id is null, display() shows company currency
  const postedInvoice = { id: 100, move_type: 'out_invoice', company_id: 1, currency_id: null, state: 'posted' };
  const displayed = display(db, moveCurrencyField, postedInvoice.currency_id, postedInvoice);
  const companyCurrency = read(db, 'res.currency', company.currency_id);
  assert.equal(displayed, companyCurrency.name, 'Readonly invoice displays company currency name instead of blank');

  // Non opt-in currency field display returns blank when null
  const displayedCompany = display(db, companyCurrencyField, null, { company_id: 1 });
  assert.equal(displayedCompany, '', 'res.company currency displays blank when null');

  // FieldInput edit mode: account.move dropdown selects company currency by default and omits empty option
  const moveHtml = renderToStaticMarkup(
    React.createElement(FieldInput, {
      db,
      model: 'account.move',
      fieldName: 'currency_id',
      field: moveCurrencyField,
      value: null,
      record: postedInvoice,
      onChange: () => {},
    }),
  );
  assert.match(moveHtml, new RegExp(`<option[^>]*value="${company.currency_id}"[^>]*selected`), 'Currency select defaults to company currency');
  assert.doesNotMatch(moveHtml, /<option value="">/, 'account.move currency does not have empty option');

  // FieldInput for res.company currency retains empty option
  const companyHtml = renderToStaticMarkup(
    React.createElement(FieldInput, {
      db,
      model: 'res.company',
      fieldName: 'currency_id',
      field: companyCurrencyField,
      value: null,
      record: { id: 1 },
      onChange: () => {},
    }),
  );
  assert.match(companyHtml, /<option value=""[^>]*>/, 'res.company currency retains empty option');
});

test('2. Due date with no payment term: onchange sets due date = invoice date, post enforces it on move and line date_maturity', () => {
  const db = seed();
  const moveModel = models['account.move'];

  // Onchange with no payment term: setting invoice_date updates invoice_date_due
  const initial = { move_type: 'out_invoice', invoice_date: '2026-11-01', invoice_date_due: null, invoice_payment_term_id: null };
  const changed = moveModel.onchange({ ...initial, invoice_date: '2026-11-20' }, 'invoice_date', db);
  assert.equal(changed.invoice_date_due, '2026-11-20', 'Onchange sets due date to invoice date when no term is set');

  // Posting an invoice with no term and null due date sets due date on move and line date_maturity
  const { db: db2, id: invId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-11-10',
    invoice_date_due: null,
    invoice_payment_term_id: null,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax_id: null, tax: 0 }],
  });
  const postedDb = postMove(db2, invId);
  const postedInv = read(postedDb, 'account.move', invId);
  assert.equal(postedInv.invoice_date_due, '2026-11-10', 'Posted invoice stores invoice_date_due = invoice_date');

  const receivableLine = postedInv.line_ids.find((l) => l.debit > 0);
  assert.ok(receivableLine, 'Receivable line must exist');
  assert.equal(receivableLine.date_maturity, '2026-11-10', 'Receivable line date_maturity equals invoice_date_due');

  // Also test for vendor bill
  const { db: db3, id: billId } = create(postedDb, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 1,
    invoice_date: '2026-11-12',
    invoice_date_due: null,
    invoice_payment_term_id: null,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax_id: null, tax: 0 }],
  });
  const postedBillDb = postMove(db3, billId);
  const postedBill = read(postedBillDb, 'account.move', billId);
  assert.equal(postedBill.invoice_date_due, '2026-11-12', 'Posted bill stores invoice_date_due = invoice_date');
  const payableLine = postedBill.line_ids.find((l) => l.credit > 0);
  assert.ok(payableLine, 'Payable line must exist');
  assert.equal(payableLine.date_maturity, '2026-11-12', 'Payable line date_maturity equals invoice_date_due');
});

test('3. Line taxes by document type: domain filters taxes and server-side validation rejects wrong-use tax', () => {
  const db = seed();
  const taxIdField = models['account.move'].fields.invoice_line_ids.fields.tax_id;
  assert.ok(typeof taxIdField.domain === 'function', 'tax_id must define a domain function');

  // Customer invoice line: offers only active sale taxes of document company
  const saleLine = { move_type: 'out_invoice', company_id: 1 };
  const taxes = db.records['account.tax'];
  const saleFiltered = taxes.filter((t) => taxIdField.domain(t, saleLine, db));
  assert.ok(saleFiltered.length > 0, 'Should find sale taxes');
  assert.ok(saleFiltered.every((t) => t.type_tax_use === 'sale' && t.active !== false), 'Only active sale taxes for sales docs');

  // Vendor bill line: offers only active purchase taxes of document company
  const purchaseLine = { move_type: 'in_invoice', company_id: 1 };
  const purchaseFiltered = taxes.filter((t) => taxIdField.domain(t, purchaseLine, db));
  assert.ok(purchaseFiltered.length > 0, 'Should find purchase taxes');
  assert.ok(purchaseFiltered.every((t) => t.type_tax_use === 'purchase' && t.active !== false), 'Only active purchase taxes for purchase docs');

  // Fallback to currentCompany(db) when line.company_id is missing
  const co2Tax = createCompany(db, { name: 'Tax Co2' });
  const dbWithCurrentCo2 = { ...co2Tax.db, settings: { ...co2Tax.db.settings, current_company_id: co2Tax.id } };
  const lineNoCo = { move_type: 'out_invoice' };
  const co2SaleTax = create(dbWithCurrentCo2, 'account.tax', { name: 'Co2 Sale Tax', amount: 15, type_tax_use: 'sale', company_id: co2Tax.id });
  const taxesCo2 = co2SaleTax.db.records['account.tax'];
  const fallbackFiltered = taxesCo2.filter((t) => taxIdField.domain(t, lineNoCo, co2SaleTax.db));
  assert.ok(fallbackFiltered.some((t) => t.id === co2SaleTax.id), 'Uses currentCompany(db) when line.company_id is null');
  assert.ok(fallbackFiltered.every((t) => !t.company_id || t.company_id === co2Tax.id), 'Filters to currentCompany(db)');

  // Server-side validation: reject wrong-use tax before writing
  const purchaseTax = taxes.find((t) => t.type_tax_use === 'purchase');
  const saleTax = taxes.find((t) => t.type_tax_use === 'sale');

  // Customer invoice with purchase tax must be rejected
  assert.throws(
    () => {
      create(db, 'account.move', {
        move_type: 'out_invoice',
        partner_id: 1,
        invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax_id: purchaseTax.id }],
      });
    },
    /tax/i,
    'Server validation rejects purchase tax on customer invoice',
  );

  // Vendor bill with sale tax must be rejected
  assert.throws(
    () => {
      create(db, 'account.move', {
        move_type: 'in_invoice',
        partner_id: 1,
        invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax_id: saleTax.id }],
      });
    },
    /tax/i,
    'Server validation rejects sale tax on vendor bill',
  );
});

test('4. Product fills the label: fills name from product name when empty, without overwriting typed label', () => {
  let db = seed();
  const { db: dbWithProd, id: prodId } = create(db, 'product', {
    name: 'Desk Chair',
    description: 'Internal notes only - must not be used as label',
    list_price: 150,
    cost: 80,
  });
  db = dbWithProd;

  const lineField = models['account.move'].fields.invoice_line_ids;

  // On sales invoice: empty name is filled with product name
  const saleLine = lineField.onchange({ product_id: prodId, name: '' }, 'product_id', db, { move_type: 'out_invoice' });
  assert.equal(saleLine.name, 'Desk Chair', 'Sales line fills name with product name');

  // On purchase bill: empty name is filled with product name
  const billLine = lineField.onchange({ product_id: prodId, name: '' }, 'product_id', db, { move_type: 'in_invoice' });
  assert.equal(billLine.name, 'Desk Chair', 'Purchase line fills name with product name');

  // If user already typed a label, it is NOT overwritten
  const preservedLine = lineField.onchange({ product_id: prodId, name: 'Custom User Label' }, 'product_id', db, { move_type: 'out_invoice' });
  assert.equal(preservedLine.name, 'Custom User Label', 'Typed label is preserved');
});

test('4b. Tax-use validation: legacy posted invoice with purchase tax can be paid and reset to draft; adding/changing wrong-use tax is rejected', () => {
  let db = seed();
  const purchTax = db.records['account.tax'].find((t) => t.type_tax_use === 'purchase');
  const saleTax = db.records['account.tax'].find((t) => t.type_tax_use === 'sale');

  // Build legacy posted invoice by posting valid invoice then simulating legacy stored line with purchase tax
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ line_id: 'leg-line-1', product_id: 1, qty: 1, price_unit: 100, tax_id: saleTax.id }],
  });
  db = postMove(inv.db, inv.id);
  db = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (m.id === inv.id ? {
        ...m,
        invoice_line_ids: [{ ...m.invoice_line_ids[0], tax_id: purchTax.id }],
      } : m)),
    },
  };
  const legacyInv = read(db, 'account.move', inv.id);

  // 1. Register payment on legacy invoice succeeds without throwing tax-use validation
  const regBtn = models['account.move'].form.buttons.find((b) => b.label === 'Register Payment');
  const payResult = regBtn.run(db, legacyInv, {
    amount: '114',
    date: '2026-01-05',
    journal_id: 3,
  });
  assert.ok(payResult.db, 'Payment on legacy invoice with purchase tax succeeds');

  // 2. Reset to draft succeeds
  const resetBtn = models['account.move'].form.buttons.find((b) => b.label === 'Reset to Draft');
  const resetDb = resetBtn.run(db, legacyInv).db;
  assert.equal(read(resetDb, 'account.move', legacyInv.id).state, 'draft', 'Reset to draft on legacy invoice succeeds');

  // 3. Adding a new line with wrong-use tax via ORM write is rejected
  assert.throws(
    () => {
      write(resetDb, 'account.move', legacyInv.id, {
        invoice_line_ids: [
          ...legacyInv.invoice_line_ids,
          { line_id: 'new-line-2', product_id: 1, qty: 1, price_unit: 50, tax_id: purchTax.id },
        ],
      });
    },
    /Customer invoices and credit notes only accept sale taxes/i,
  );

  // 4. Changing an existing line's tax_id to a wrong-use tax via ORM write is rejected
  const { db: dbValid, id: validId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_line_ids: [{ line_id: 'val-line-1', product_id: 1, qty: 1, price_unit: 100, tax_id: saleTax.id }],
  });
  assert.throws(
    () => {
      write(dbValid, 'account.move', validId, {
        invoice_line_ids: [{ line_id: 'val-line-1', product_id: 1, qty: 1, price_unit: 100, tax_id: purchTax.id }],
      });
    },
    /Customer invoices and credit notes only accept sale taxes/i,
  );

  // 5. diffDb + applyDiff rejects wrong-use tax
  const mutatedDb = {
    ...dbValid,
    records: {
      ...dbValid.records,
      'account.move': dbValid.records['account.move'].map((m) => (m.id === validId ? {
        ...m,
        invoice_line_ids: [{ line_id: 'val-line-1', product_id: 1, qty: 1, price_unit: 100, tax_id: purchTax.id }],
      } : m)),
    },
  };
  const diff = diffDb(dbValid, mutatedDb);
  assert.throws(
    () => applyDiff(dbValid, diff, { author: 'test', isAdmin: true }),
    /Customer invoices and credit notes only accept sale taxes/i,
  );
});

test('5. Readonly due date row: in readonly mode never shows "or" separator', async () => {
  let db = seed();
  // Create a posted invoice without due date or payment term
  const { db: dbWithInv, id: invNoDueId } = create(db, 'account.move', {
    name: 'INV/2026/00001',
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-11-01',
    invoice_date_due: null,
    invoice_payment_term_id: null,
    company_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax_id: null, tax: 0 }],
  });
  // Post the invoice with no payment term and no due date
  // (In current unpatched code, this leaves invoice_date_due undefined)
  const postedDb = postMove(dbWithInv, invNoDueId);
  const dbWithoutDue = {
    ...postedDb,
    records: {
      ...postedDb.records,
      'account.move': postedDb.records['account.move'].map((m) => (m.id === invNoDueId ? { ...m, invoice_date_due: null, invoice_payment_term_id: null } : m)),
    },
  };
  await commit(dbWithoutDue);

  const html = renderToStaticMarkup(
    React.createElement(FormView, {
      id: invNoDueId,
      leaf: { model: 'account.move', defaults: { move_type: 'out_invoice' }, label: 'Invoices' },
      params: new URLSearchParams(),
    }),
  );

  // Must not contain stray "or" in due date field-pair
  assert.doesNotMatch(html, /<span class="field-join"[^>]*>\s*or\s*<\/span>/, 'No "or" separator on posted invoice without due date');

  // Posted invoice with due date shows due date and no "or"
  const dbWithDue = {
    ...postedDb,
    records: {
      ...postedDb.records,
      'account.move': postedDb.records['account.move'].map((m) => (m.id === invNoDueId ? { ...m, invoice_date_due: '2026-11-25', invoice_payment_term_id: null } : m)),
    },
  };
  await commit(dbWithDue);
  const htmlWithDue = renderToStaticMarkup(
    React.createElement(FormView, {
      id: invNoDueId,
      leaf: { model: 'account.move', defaults: { move_type: 'out_invoice' }, label: 'Invoices' },
      params: new URLSearchParams(),
    }),
  );
  assert.doesNotMatch(htmlWithDue, /<span class="field-join"[^>]*>\s*or\s*<\/span>/, 'No "or" separator when due date is present');
  assert.match(htmlWithDue, /Nov 25, 2026|2026-11-25|11\/25\/2026/, 'Shows due date in readonly mode');
});

test('6. Register Payment dialog: default payment journal and memo stored on payment', () => {
  const db = seed();
  const moveModel = models['account.move'];
  const regBtn = moveModel.form.buttons.find((b) => b.label === 'Register Payment');
  assert.ok(regBtn, 'Register Payment button must exist');

  const invoice = {
    id: 99,
    name: 'INV/2026/00099',
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    payment_reference: 'REF-INV-99',
    amount_residual: 500,
    amount_total: 500,
    state: 'posted',
  };

  const wiz = regBtn.wizard(db, invoice);
  assert.ok(wiz, 'Wizard definition returned');

  // Payment Journal default: unique default payment journal of the company
  const defaultBank = db.records['account.journal'].find((j) => j.default_for_payments === true && (j.company_id ?? 1) === 1);
  const journalField = wiz.fields.find((f) => f.name === 'journal_id');
  assert.equal(journalField.default, defaultBank.id, 'Payment Journal defaults to unique default payment journal');

  // Memo field: exists and defaults to payment_reference
  const memoField = wiz.fields.find((f) => f.name === 'memo');
  assert.ok(memoField, 'Memo field must exist in Register Payment wizard');
  assert.equal(memoField.default, 'REF-INV-99', 'Memo defaults to payment_reference');

  // If no payment_reference, defaults to invoice name
  const invoiceNoRef = { ...invoice, payment_reference: '' };
  const wizNoRef = regBtn.wizard(db, invoiceNoRef);
  const memoFieldNoRef = wizNoRef.fields.find((f) => f.name === 'memo');
  assert.equal(memoFieldNoRef.default, 'INV/2026/00099', 'Memo defaults to name when no payment_reference');

  // Registering payment writes the memo to created account.payment
  const { db: dbWithInv, id: newInvId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-11-01',
    payment_reference: 'CUST-PAY-REF-123',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 200, tax_id: null, tax: 0 }],
  });
  const postedDb = postMove(dbWithInv, newInvId);
  const postedInvoice = read(postedDb, 'account.move', newInvId);

  const payResult = regBtn.run(postedDb, postedInvoice, {
    amount: '200',
    date: '2026-11-05',
    journal_id: defaultBank.id,
    memo: 'Custom Check Memo #456',
  });

  const createdPayment = (payResult.db.records['account.payment'] ?? []).find((p) => p.invoice_id === newInvId);
  assert.ok(createdPayment, 'Payment was created');
  assert.equal(createdPayment.memo, 'Custom Check Memo #456', 'Custom memo is written to created payment');

  // Invoice in a company with no default payment journal: wizard fields build, journal default is null, run without journal still throws 'Select a payment journal'
  const noDefaultCo = createCompany(db, { ...invoiceJournalDefaults(db), name: 'No Default Co' });
  const { db: dbCo2, id: co2InvId } = create(noDefaultCo.db, 'account.move', {
    move_type: 'out_invoice',
    company_id: noDefaultCo.id,
    partner_id: 1,
    invoice_date: '2026-11-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax_id: null, tax: 0 }],
  });
  const postedCo2Db = postMove(dbCo2, co2InvId);
  const postedCo2Inv = read(postedCo2Db, 'account.move', co2InvId);
  const wizNoDefault = regBtn.wizard(postedCo2Db, postedCo2Inv);
  assert.ok(wizNoDefault, 'Wizard builds for company with no default payment journal');
  const journalFieldNoDefault = wizNoDefault.fields.find((f) => f.name === 'journal_id');
  assert.equal(journalFieldNoDefault.default, null, 'Journal default is null when company has no default payment journal');
  assert.throws(() => regBtn.run(postedCo2Db, postedCo2Inv, { amount: '100', date: '2026-11-05' }), /Select a payment journal/);
});

test('7. Vendors > Checks report shows styled empty-state message when no checks exist', async () => {
  let db = seed();
  // Clear any checks / payments to ensure empty
  db = {
    ...db,
    records: {
      ...db.records,
      'account.payment': [],
      'account.batch.payment': [],
    },
  };
  await commit(db);

  const html = renderToStaticMarkup(
    React.createElement(Checks),
  );

  assert.match(html, /<td colSpan="6" class="empty">/, 'Table includes empty-state cell spanning all 6 columns');
  assert.match(html, /No checks yet/, 'Displays "No checks yet" text');

  // Verify Arabic translation exists in i18n
  const storage = new Map([['mizan-lang', 'ar']]);
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  try {
    const { t: tAr } = await import(`./i18n.js?ar-checks=${Date.now()}`);
    assert.equal(tAr('No checks yet.'), 'لا توجد شيكات بعد.');
    assert.equal(tAr('Customer invoices and credit notes only accept sale taxes'), 'فواتير العملاء وإشعارات الدائن تقبل ضرائب المبيعات فقط');
    assert.equal(tAr('Vendor bills and refunds only accept purchase taxes'), 'فواتير الموردين وإشعارات الاسترداد تقبل ضرائب المشتريات فقط');
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});
