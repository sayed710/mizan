import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { models, menusFor } from './models/index.js';
import { seed } from './seed.js';
import { accountId, journalItems } from './models/ledger.js';
import { postMove } from './models/accounting.js';
import { postBatch, fillOpenInvoices, checkAmountDisplay } from './models/payments.js';
import { documentCompany } from './models/company.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { invoiceQrPayload, invoiceQrSettingsForCompany } from './models/qr.js';
import { duplicateBillWarning } from './models/finance.js';
import { documentCurrency } from './money.js';
import { today } from './models/common.js';

const button = (model, label) => models[model].form.buttons.find((item) => item.label === label);
function makeBankJournal(db, { code = 'BNK2', name = 'Bank B', companyId = null } = {}) {
  const journal = create(db, 'account.journal', {
    code,
    name,
    type: 'bank',
    ...(companyId ? { company_id: companyId } : {}),
    default_account_id: accountId(db, '101501', companyId),
    suspense_account_id: accountId(db, '101404', companyId),
    outstanding_receipts_account_id: accountId(db, '101402', companyId),
    outstanding_payments_account_id: accountId(db, '101403', companyId),
    check_next_number: 500,
  });
  return { db: journal.db, journal: read(journal.db, 'account.journal', journal.id) };
}

function postedMove(db, values) {
  const made = create(db, 'account.move', values);
  return { db: postMove(made.db, made.id), id: made.id };
}

const line = (price = 100) => [{ name: 'Service', qty: 1, price_unit: price, tax: 0 }];

test('Register Payment confirms the date and journal for payment and discount entries', () => {
  let db = seed();
  const discountTerm = search(db, 'account.payment.term').find((term) => term.early_discount);
  const invoice = postedMove(db, {
    move_type: 'out_invoice', partner_id: 3, company_id: 1, invoice_date: '2026-01-01',
    invoice_payment_term_id: discountTerm.id, invoice_line_ids: line(),
  });
  db = invoice.db;
  const bankB = makeBankJournal(db);
  db = bankB.db;
  const action = button('account.move', 'Register Payment');
  const record = read(db, 'account.move', invoice.id);
  const wizard = action.wizard(db, record);
  const fields = Object.fromEntries(wizard.fields.map((field) => [field.name, field]));
  assert.equal(fields.date.required, true);
  assert.equal(fields.journal_id.required, true);
  assert.equal(fields.journal_id.default, null);
  assert.equal(fields.journal_id.domain(bankB.journal), true);
  assert.throws(() => action.run(db, record, { amount: 98, date: '2026-01-02' }), /Select a payment journal/);

  db = action.run(db, record, { amount: 98, date: '2026-01-02', journal_id: bankB.journal.id }).db;
  const paid = read(db, 'account.move', invoice.id);
  const payment = search(db, 'account.payment').find((item) => item.invoice_id === invoice.id);
  assert.equal(payment.date, '2026-01-02');
  assert.equal(payment.journal_id, bankB.journal.id);
  assert.equal(read(db, 'account.move', payment.move_id).journal_id, bankB.journal.id);
  assert.equal(paid.payments.at(-1).date, '2026-01-02');
  const discount = paid.payments.find((item) => item.discount);
  assert.ok(discount);
  assert.equal(read(db, 'account.move', discount.move_id).date, '2026-01-02');
});

test('inbound batches post each payment through the selected journal', () => {
  let db = seed();
  const invoice = postedMove(db, { move_type: 'out_invoice', partner_id: 3, company_id: 1, invoice_date: '2026-01-01', invoice_line_ids: line() });
  db = invoice.db;
  const bankB = makeBankJournal(db);
  db = bankB.db;
  const batch = create(db, 'account.batch.payment', {
    batch_type: 'inbound', company_id: 1, journal_id: bankB.journal.id, date: '2026-01-02',
    lines: [{ move_id: invoice.id, amount: 100 }],
  });
  db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
  const posted = read(db, 'account.batch.payment', batch.id);
  const payment = read(db, 'account.payment', posted.lines[0].payment_id);
  const entry = read(db, 'account.move', payment.move_id);
  assert.equal(posted.journal_id, bankB.journal.id);
  assert.equal(payment.journal_id, bankB.journal.id);
  assert.equal(entry.journal_id, bankB.journal.id);
  assert.ok(entry.line_ids.some((item) => item.account_id === bankB.journal.outstanding_receipts_account_id));
});

test('batch totals and fill actions keep a single invoice currency', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((currency) => currency.name === 'EUR');
  const usdInvoice = postedMove(db, { move_type: 'out_invoice', partner_id: 3, company_id: 1, invoice_date: '2026-01-01', invoice_line_ids: line() });
  db = usdInvoice.db;
  const eurInvoice = postedMove(db, { move_type: 'out_invoice', partner_id: 3, company_id: 1, currency_id: eur.id, invoice_date: today(), invoice_line_ids: line() });
  db = eurInvoice.db;
  const mixed = create(db, 'account.batch.payment', {
    batch_type: 'inbound', company_id: 1, lines: [{ move_id: usdInvoice.id, amount: 100 }, { move_id: eurInvoice.id, amount: 100 }],
  });
  const record = read(mixed.db, 'account.batch.payment', mixed.id);
  assert.equal(models['account.batch.payment'].fields.amount_total.compute(record, mixed.db), null);
  assert.match(models['account.batch.payment'].fields.currency_warning.compute(record, mixed.db), /same currency/i);
  assert.throws(() => postBatch(mixed.db, record), /same currency/i);

  const empty = create(db, 'account.batch.payment', { batch_type: 'inbound', company_id: 1 });
  const filled = fillOpenInvoices(empty.db, read(empty.db, 'account.batch.payment', empty.id));
  const currencies = read(filled, 'account.batch.payment', empty.id).lines
    .map((item) => documentCurrency(filled, read(filled, 'account.move', item.move_id))?.name);
  assert.ok(currencies.length > 0);
  assert.deepEqual(new Set(currencies), new Set(['USD']));
});

test('vendor changes clear stale bank and payment term values without choosing a bank by order', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', { name: 'Vendor Net 60', line_ids: [{ value: 100, value_type: 'percent', nb_days: 60, delay_type: 'days_after' }] });
  db = term.db;
  const vendorA = create(db, 'res.partner', { name: 'Vendor A', is_company: true, property_payment_term_id: term.id });
  db = vendorA.db;
  const vendorB = create(db, 'res.partner', { name: 'Vendor B', is_company: true });
  db = vendorB.db;
  const bankA = create(db, 'res.partner.bank', { partner_id: vendorA.id, account_number: 'A-001', allow_out_payment: true });
  db = bankA.db;
  const bankB = create(db, 'res.partner.bank', { partner_id: vendorB.id, account_number: 'B-001', allow_out_payment: true });
  db = bankB.db;
  const old = {
    move_type: 'in_invoice', company_id: 1, partner_id: vendorA.id, partner_bank_id: bankA.id,
    invoice_payment_term_id: term.id, invoice_date: '2026-01-01', invoice_date_due: '2026-03-02',
    invoice_line_ids: [],
  };
  const changed = models['account.move'].onchange({ ...old, partner_id: vendorB.id }, 'partner_id', db);
  assert.equal(changed.partner_bank_id, null);
  assert.equal(changed.invoice_payment_term_id, null);
  assert.equal(changed.invoice_date_due, null);
  const explicit = models['account.move'].onchange({ ...old, partner_id: vendorB.id, partner_bank_id: bankB.id }, 'partner_id', db);
  assert.equal(explicit.partner_bank_id, bankB.id);
});

test('draft credit notes do not consume issued credit, and posting rechecks the total', () => {
  const db = seed();
  const invoice = postedMove(db, { move_type: 'out_invoice', partner_id: 3, company_id: 1, invoice_date: '2026-01-01', invoice_line_ids: line() });
  const action = button('account.move', 'Credit Note');
  const first = action.run(invoice.db, read(invoice.db, 'account.move', invoice.id), { refund_method: 'refund', date: '2026-01-02' });
  const firstDraft = search(first.db, 'account.move').find((move) => move.reversed_entry_id === invoice.id && move.state === 'draft');
  const second = action.run(first.db, read(first.db, 'account.move', invoice.id), { refund_method: 'refund', date: '2026-01-03' });
  const drafts = search(second.db, 'account.move').filter((move) => move.reversed_entry_id === invoice.id && move.state === 'draft');
  assert.equal(drafts.length, 2);
  const issued = postMove(second.db, firstDraft.id);
  assert.throws(() => postMove(issued, drafts.find((move) => move.id !== firstDraft.id).id), /exceed|credit/i);
});

test('printed issuer and QR settings follow the document company', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((currency) => currency.name === 'EUR');
  const madeCompany = createCompanyWithDefaultInvoiceJournals(db, {
    name: 'Document Company B', currency_id: eur.id, vat: 'B-TAX', company_iban: 'DE89370400440532013000', invoice_qr: 'epc',
  });
  db = { ...madeCompany.db, settings: { ...madeCompany.db.settings, current_company_id: 1, invoice_qr: 'epc', company_vat: 'A-TAX', company_iban: 'NOT-B-COMPANY-IBAN' } };
  const invoice = postedMove(db, {
    move_type: 'out_invoice', company_id: madeCompany.id, partner_id: 3, currency_id: eur.id, invoice_date: today(), invoice_line_ids: line(),
  });
  db = invoice.db;
  const company = documentCompany(db, read(db, 'account.move', invoice.id));
  const settings = invoiceQrSettingsForCompany(db, company);
  assert.equal(company.name, 'Document Company B');
  assert.equal(company.currency, 'EUR');
  assert.equal(settings.company_vat, 'B-TAX');
  assert.equal(settings.company_iban, 'DE89370400440532013000');
  const printedInvoice = read(db, 'account.move', invoice.id);
  const payload = invoiceQrPayload(settings, company, printedInvoice, documentCurrency(db, printedInvoice).name);
  assert.match(payload, /^BCD/);
  assert.match(payload, /Document Company B/);
  assert.match(payload, /EUR100\.00/);
});

test('EPC invoice QR accepts an explicitly selected EUR document currency', () => {
  const settings = { invoice_qr: 'epc', company_iban: 'DE89370400440532013000' };
  const company = { name: 'Invoice Issuer', currency: 'USD' };
  const invoice = { move_type: 'out_invoice', state: 'posted', currency_id: 42, amount_residual: 25, name: 'INV/42' };
  assert.match(invoiceQrPayload(settings, company, invoice, 'EUR'), /^BCD/);
  assert.equal(invoiceQrPayload(settings, company, invoice, 'USD'), null);
});

test('check amount display uses the payment currency unit and numeric format', () => {
  const db = seed();
  const eur = search(db, 'res.currency').find((currency) => currency.name === 'EUR');
  const displayed = checkAmountDisplay(db, { currency_id: eur.id }, { company_id: 1 }, 125.5);
  assert.equal(displayed.words, 'One Hundred Twenty-Five Euros and 50/100');
  assert.match(displayed.numeric, /€|EUR/);
  const unlabelled = create(db, 'res.currency', { name: 'TEST' });
  assert.throws(() => checkAmountDisplay(unlabelled.db, { currency_id: unlabelled.id }, {}, 1), /unit name/i);
});

test('duplicate warnings label amount and date matching as a heuristic', () => {
  let db = seed();
  const first = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 7, ref: '', invoice_date: '2026-05-01', invoice_line_ids: line(),
  });
  db = first.db;
  const second = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 7, ref: '', invoice_date: '2026-05-01', invoice_line_ids: line(),
  });
  const warning = duplicateBillWarning(second.db, read(second.db, 'account.move', second.id));
  assert.match(warning, /heuristic only/i);
  assert.match(warning, /do not establish document identity/i);
});

test('Review menus open To Check, Unreconciled, and Draft Entries with state filters', () => {
  const find = (entries, key) => {
    for (const entry of entries ?? []) {
      if (entry.key === key) return entry;
      const nested = find(entry.children, key);
      if (nested) return nested;
    }
    return null;
  };
  const menu = menusFor('accounting');
  const toCheck = find(menu, 'to-check');
  const unreconciled = find(menu, 'unreconciled');
  const drafts = find(menu, 'draft-entries');
  assert.equal(toCheck.model, 'account.bank.statement.line');
  assert.equal(toCheck.defaults.state, 'to_check');
  assert.equal(toCheck.domain({ state: 'to_check' }), true);
  assert.equal(toCheck.domain({ state: 'reconciled' }), false);
  assert.equal(unreconciled.report, 'unreconciledItems');
  assert.equal(unreconciled.reviewMode, 'unreconciled');
  assert.equal(drafts.model, 'account.move');
  assert.equal(drafts.defaults.state, 'draft');
  assert.equal(drafts.domain({ state: 'draft' }), true);
  assert.equal(drafts.domain({ state: 'posted' }), false);

  const db = seed();
  const invoice = postedMove(db, { move_type: 'out_invoice', partner_id: 3, company_id: 1, invoice_date: '2026-01-01', invoice_line_ids: line() });
  assert.ok(journalItems(invoice.db, { reviewMode: 'unreconciled' }).some((item) => item.move_id === invoice.id
    && ['asset_receivable', 'liability_payable'].includes(read(invoice.db, 'account.account', item.account_id)?.account_type)));
});
