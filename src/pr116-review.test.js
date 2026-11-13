import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { payMove, postMove } from './models/accounting.js';
import { total } from './models/common.js';
import { isBalanced, reconciledJournalItems } from './models/ledger.js';
import { MIGRATIONS } from './migrations.js';
import { handleApi } from '../server/api.js';
import { isValidBankBic } from './models/partnerbank.js';
import { invoiceTermNote } from './models/terms.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';

const rounding = (db, vals) => create(db, 'account.cash.rounding', { rounding: 0.05, rounding_method: 'HALF-UP', ...vals });

test('a BIC needs a letter country code in positions five and six', () => {
  assert.equal(isValidBankBic('DEUTDEFF'), true);
  assert.equal(isValidBankBic('DEUTDEFF500'), true);
  assert.equal(isValidBankBic('AAAA12BB'), false);
  assert.equal(isValidBankBic('AAAA12BB500'), false);
});

test('a currency-restricted rounding method is rejected and hidden on documents in another currency', () => {
  let db = seed();
  const cad = create(db, 'res.currency', { name: 'CAD', rate_ids: [{ date: '2026-01-01', rate: 1.4 }] });
  db = cad.db;
  const onlyCad = rounding(db, { name: 'CAD only', strategy: 'biggest_tax', currency_ids: [cad.id] });
  db = onlyCad.db;
  const field = models['account.move'].fields.invoice_cash_rounding_id;
  const lines = [{ name: 'Item', qty: 1, price_unit: 100.03, tax_ids: [1] }];

  assert.throws(() => create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_cash_rounding_id: onlyCad.id, invoice_line_ids: lines }), /does not apply to this currency/);
  assert.equal(field.domain(read(db, 'account.cash.rounding', onlyCad.id), { company_id: 1 }, db), false);

  const cadMove = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: cad.id, invoice_date: '2026-03-01', invoice_cash_rounding_id: onlyCad.id, invoice_line_ids: lines });
  assert.equal(field.domain(read(db, 'account.cash.rounding', onlyCad.id), { company_id: 1, currency_id: cad.id }, db), true);
  assert.equal(read(cadMove.db, 'account.move', cadMove.id).invoice_cash_rounding_id, onlyCad.id);
});

test("another company's rounding method is rejected on an invoice", () => {
  let db = seed();
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two' });
  db = c2.db;
  const own = rounding(db, { name: 'Company one', strategy: 'biggest_tax', company_id: 1 });
  db = own.db;
  assert.equal(models['account.move'].fields.invoice_cash_rounding_id.domain(read(db, 'account.cash.rounding', own.id), { company_id: c2.id }, db), false);
  assert.throws(() => create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, company_id: c2.id, invoice_date: '2026-03-01', invoice_cash_rounding_id: own.id, invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 10 }] }), /belongs to another company/);
});

test('a biggest-tax rounding leaves an untaxed invoice unrounded and posts it without rounding accounts', () => {
  let db = seed();
  const biggest = rounding(db, { name: 'Biggest tax', strategy: 'biggest_tax' });
  db = biggest.db;
  const move = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_cash_rounding_id: biggest.id, invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100.03, tax_ids: [] }] });
  assert.equal(total(read(move.db, 'account.move', move.id), move.db), 100.03);
  const posted = read(postMove(move.db, move.id), 'account.move', move.id);
  assert.equal(posted.state, 'posted');
  assert.ok(isBalanced(posted.line_ids));
  assert.equal(posted.line_ids.some((l) => l.name === 'Cash Rounding'), false);
});

test('the company currency keeps its Rates tab when it is not the base currency', () => {
  const db = seed();
  const own = db.records['res.company'].find((c) => c.id === 1).currency_id;
  const tabs = models['res.currency'].form.tabs;
  assert.deepEqual(tabs(read(db, 'res.currency', own), db), []);
  const otherBase = { ...db, settings: { ...db.settings, base_currency_id: db.records['res.currency'].find((c) => c.id !== own).id } };
  assert.deepEqual(tabs(read(otherBase, 'res.currency', own), otherBase).map((tab) => tab.label), ['Rates']);
});

test('the printed invoice shows the payment-term note or name unless the term is hidden from invoices', () => {
  let db = seed();
  const shown = create(db, 'account.payment.term', { name: '30 Days', note: 'Payment terms: 30 days', line_ids: [{ value: 'percent', value_amount: 100, nb_days: 30 }] });
  db = shown.db;
  const named = create(db, 'account.payment.term', { name: '45 Days', line_ids: [{ value: 'percent', value_amount: 100, nb_days: 45 }] });
  db = named.db;
  const hidden = create(db, 'account.payment.term', { name: 'Hidden', display_on_invoice: false, line_ids: [{ value: 'percent', value_amount: 100, nb_days: 10 }] });
  db = hidden.db;
  assert.equal(invoiceTermNote(db, { invoice_payment_term_id: shown.id }), 'Payment terms: 30 days');
  assert.equal(invoiceTermNote(db, { invoice_payment_term_id: named.id }), 'Payment Terms: 45 Days');
  assert.equal(invoiceTermNote(db, { invoice_payment_term_id: hidden.id }), null);
  assert.equal(invoiceTermNote(db, {}), null);
});

test('editing a rounding method later does not block writes on invoices that already use it', () => {
  let db = seed();
  const method = rounding(db, { name: 'Shared', strategy: 'biggest_tax' });
  db = method.db;
  const move = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_cash_rounding_id: method.id, invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 10, tax_ids: [1] }] });
  db = move.db;
  const other = db.records['res.currency'].find((c) => c.id !== db.records['res.company'][0].currency_id);
  db = write(db, 'account.cash.rounding', method.id, { currency_ids: [other.id] });
  assert.doesNotThrow(() => write(db, 'account.move', move.id, { ref: 'still editable' }));
  const cleared = write(db, 'account.move', move.id, { invoice_cash_rounding_id: false });
  assert.throws(() => write(cleared, 'account.move', move.id, { invoice_cash_rounding_id: method.id }), /does not apply to this currency/);
});

test('the base currency shows an implicit current rate of 1 against another company currency', () => {
  const db = seed();
  const own = db.records['res.company'].find((c) => c.id === 1).currency_id;
  const base = db.records['res.currency'].find((c) => c.id !== own && (c.rate_ids ?? []).length === 0) ?? db.records['res.currency'].find((c) => c.id !== own);
  const ownRec = db.records['res.currency'].find((c) => c.id === own);
  const setup = {
    ...db,
    settings: { ...db.settings, base_currency_id: base.id },
    records: { ...db.records, 'res.currency': db.records['res.currency'].map((c) => (c.id === base.id ? { ...c, rate_ids: [] } : c.id === own ? { ...ownRec, rate_ids: [{ date: '2020-01-01', rate: 4 }] } : c)) },
  };
  assert.equal(read(setup, 'res.currency', base.id).rate, 0.25);
});

test('a bank account saved with an old malformed BIC can still be edited without touching the BIC', () => {
  let db = seed();
  const bank = create(db, 'res.partner.bank', { partner_id: 1, account_number: 'OLD-BIC-1', bank_bic: 'DEUTDEFF' });
  db = bank.db;
  const legacy = { ...db, records: { ...db.records, 'res.partner.bank': db.records['res.partner.bank'].map((b) => (b.id === bank.id ? { ...b, bank_bic: 'DEUT DE FF' } : b)) } };
  assert.doesNotThrow(() => write(legacy, 'res.partner.bank', bank.id, { allow_out_payment: true }));
  assert.throws(() => write(legacy, 'res.partner.bank', bank.id, { bank_bic: 'AAAA12BB' }), /BIC\/SWIFT/);
});

test('migration 45 gives each company its own copy of a tax group their taxes shared', () => {
  const db = seed();
  const groupId = db.records['account.tax'][0].tax_group_id;
  const legacy = {
    ...db,
    records: {
      ...db.records,
      'res.company': [...db.records['res.company'], { id: 2, name: 'Branch', parent_id: 1 }],
      'account.tax.group': db.records['account.tax.group'].map((g) => (g.id === groupId ? { ...g, company_id: null } : g)),
      'account.tax': db.records['account.tax'].map((t, i) => (i === 1 ? { ...t, tax_group_id: groupId, company_id: 2 } : t.tax_group_id === groupId ? { ...t, company_id: 1 } : t)),
    },
  };
  const migrated = MIGRATIONS.find((m) => m.version === 45).up(legacy);
  const branchTax = migrated.records['account.tax'][1];
  const branchGroup = migrated.records['account.tax.group'].find((g) => g.id === branchTax.tax_group_id);
  assert.notEqual(branchTax.tax_group_id, groupId);
  assert.equal(branchGroup.company_id, 2);
  assert.equal(migrated.records['account.tax.group'].find((g) => g.id === groupId).company_id, 1);
  assert.equal(migrated.seq['account.tax.group'], branchTax.tax_group_id);
});

test('journal items of an invoice whose residual is unknown report an unknown residual too', () => {
  let db = seed();
  const move = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100, tax_ids: [] }] });
  db = postMove(move.db, move.id);
  const unconfigured = write(db, 'res.company', 1, { currency_id: null });
  const receivable = reconciledJournalItems(unconfigured, read(unconfigured, 'account.move', move.id))
    .find((l) => read(unconfigured, 'account.account', l.account_id)?.account_type === 'asset_receivable');
  assert.equal(receivable.amount_residual, null);
});

test('the API computes analytic balances only from the caller\'s companies', () => {
  let db = seed();
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two' });
  db = c2.db;
  const plan = create(db, 'account.analytic.plan', { name: 'Shared plan' });
  db = plan.db;
  const account = create(db, 'account.analytic.account', { name: 'Shared', plan_id: plan.id, company_id: null });
  db = account.db;
  db = create(db, 'account.analytic.line', { name: 'Own', account_id: account.id, amount: 30, company_id: 1, date: '2026-03-01' }).db;
  db = create(db, 'account.analytic.line', { name: 'Other', account_id: account.id, amount: 70, company_id: c2.id, date: '2026-03-01' }).db;
  const user = { name: 'Limited', isAdmin: false };
  const one = handleApi({ method: 'GET', path: `/api/v1/account.analytic.account/${account.id}`, query: new URLSearchParams(), db, user, companies: new Set([1]), company: 1 });
  assert.equal(one.body.balance, 30);
  const list = handleApi({ method: 'GET', path: '/api/v1/account.analytic.account', query: new URLSearchParams(), db, user, companies: new Set([1]), company: 1 });
  assert.equal(list.body.records.find((r) => r.id === account.id).balance, 30);
});

test('an overpayment shows its unapplied amount open once across the payment lines', () => {
  let db = seed();
  const move = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-03-01', invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100, tax_ids: [] }] });
  db = payMove(postMove(move.db, move.id), move.id, 120, '2026-03-02');
  const payment = db.records['account.move'].find((m) => m.id !== move.id && m.state === 'posted' && (m.line_ids ?? []).some((l) => l.partner_id === 1) && m.move_type === 'entry' && m.date === '2026-03-02');
  const open = reconciledJournalItems(db, payment)
    .filter((l) => read(db, 'account.account', l.account_id)?.account_type === 'asset_receivable')
    .reduce((sum, l) => sum + Math.abs(l.amount_residual ?? 0), 0);
  assert.equal(open, 20);
});

test('archiving a legacy add-line rounding method without accounts is allowed, adding one without accounts is not', () => {
  let db = seed();
  const legacy = { id: 900, name: 'Legacy', rounding: 0.05, rounding_method: 'HALF-UP', strategy: 'add_invoice_line', active: true, sequence: 10, currency_ids: [] };
  db = { ...db, records: { ...db.records, 'account.cash.rounding': [...(db.records['account.cash.rounding'] ?? []), legacy] } };
  assert.doesNotThrow(() => write(db, 'account.cash.rounding', 900, { active: false }));
  assert.throws(() => rounding(db, { name: 'New', strategy: 'add_invoice_line' }));
});

test("a tax cannot use another company's tax group", () => {
  let db = seed();
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Company Two' });
  db = c2.db;
  const group = create(db, 'account.tax.group', { name: 'Main only', company_id: 1 });
  db = group.db;
  const field = models['account.tax'].fields.tax_group_id;
  assert.equal(field.domain(read(db, 'account.tax.group', group.id), { company_id: c2.id }, db), false);
  const tax = db.records['account.tax'].find((t) => t.company_id === c2.id) ?? null;
  if (tax) assert.throws(() => write(db, 'account.tax', tax.id, { tax_group_id: group.id }), /tax group must belong/);
  assert.throws(() => create(db, 'account.tax', { name: 'Branch tax', amount: 5, amount_type: 'percent', type_tax_use: 'sale', company_id: c2.id, tax_group_id: group.id }), /tax group must belong/);
});

test('miscellaneous and draft entries menus use the journal entries search, not invoice filters', () => {
  const leaves = menusFor('accounting');
  const flat = (items) => items.flatMap((i) => (i.children ? flat(i.children) : [i]));
  const all = flat(leaves);
  for (const key of ['misc', 'draft-entries']) {
    const leaf = all.find((l) => l.key === key);
    const ids = leaf.filters.flat().map((f) => f.id);
    assert.ok(!ids.includes('unpaid') && !ids.includes('overdue'), `${key} has no invoice filters`);
    assert.ok(ids.includes('posted'), `${key} keeps the entries filters`);
  }
});

test('a shared analytic account converts other-currency company lines before adding them', () => {
  let db = seed();
  const own = db.records['res.company'].find((c) => c.id === 1).currency_id;
  const other = db.records['res.currency'].find((c) => c.id !== own);
  const c2 = createCompanyWithDefaultInvoiceJournals(db, { name: 'Other currency co', currency_id: other.id });
  db = c2.db;
  db = { ...db, records: { ...db.records, 'res.currency': db.records['res.currency'].map((c) => (c.id === other.id ? { ...c, rate_ids: [{ date: '2020-01-01', rate: 2 }] } : c)) } };
  const plan = create(db, 'account.analytic.plan', { name: 'Shared plan' });
  db = plan.db;
  const account = create(db, 'account.analytic.account', { name: 'Shared', plan_id: plan.id, company_id: null });
  db = account.db;
  db = create(db, 'account.analytic.line', { name: 'Own', account_id: account.id, amount: 30, company_id: 1, date: '2026-03-01' }).db;
  db = create(db, 'account.analytic.line', { name: 'Other', account_id: account.id, amount: 40, company_id: c2.id, date: '2026-03-01' }).db;
  assert.equal(read(db, 'account.analytic.account', account.id).balance, 50);
});

test('the Analytic Items menu, which the Gross Margin button opens, includes timesheet lines as in Odoo', () => {
  const flat = (items) => items.flatMap((i) => (i.children ? flat(i.children) : [i]));
  const leaf = flat(menusFor('accounting')).find((l) => l.key === 'analytic-items');
  assert.equal(leaf.domain, undefined);
});
