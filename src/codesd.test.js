import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { invoiceLines, postEntry } from './models/ledger.js';
import { payMove, postMove } from './models/accounting.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { taxAccounts } from './models/finance.js';
import { payOrder, priceLines, startSession } from './models/pos.js';
import { postOpeningStock } from './models/valuation.js';
import { analyticLinesForMove } from './models/analyticplus.js';
import { migrate } from './migrations.js';

const run = (db, model, id, label) => models[model].form.buttons.find((button) => button.label === label).run(db, read(db, model, id)).db;
function setup() {
  let db = seed();
  // Every account, including all formerly hard-coded roles, has a different chart code.
  for (const account of search(db, 'account.account')) db = write(db, 'account.account', account.id, { code: `AUD-${account.id}` });
  return db;
}
function account(db, code, account_type = 'expense') {
  return create(db, 'account.account', { name: code, code, account_type, company_id: 1 });
}
function invoice(db, tax, values = {}) {
  return create(db, 'account.move', { move_type: 'out_invoice', company_id: 1, partner_id: 1, invoice_date: '2037-01-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, ...taxSnapshot(tax) }], ...values });
}

test('codesd 1: payroll rules and structure post explicit renamed accounts and reject missing configuration', () => {
  let db = setup();
  const structure = read(db, 'hr.payroll.structure', read(db, 'res.company', 1).default_payroll_structure_id);
  const slip = create(db, 'hr.payslip', { employee_id: 1, date_from: '2037-01-01', date_to: '2037-01-31' });
  db = run(slip.db, 'hr.payslip', slip.id, 'Compute Sheet');
  const before = db;
  const missing = write(db, 'hr.payroll.structure', structure.id, { salary_expense_account_id: null });
  assert.throws(() => run(missing, 'hr.payslip', slip.id, 'Confirm'), /Configure the debit account/);
  db = run(db, 'hr.payslip', slip.id, 'Confirm');
  const move = search(db, 'account.move').find((move) => move.ref?.startsWith(read(db, 'hr.payslip', slip.id).name));
  assert.ok(move.line_ids.some((line) => line.account_id === structure.salary_expense_account_id && line.debit > 0));
  assert.ok(move.line_ids.some((line) => line.account_id === structure.salary_payable_account_id && line.credit > 0));
  assert.equal(read(before, 'hr.payslip', slip.id).state, 'draft');
  assert.equal(read(run(db, 'hr.payslip', slip.id, 'Mark as Paid'), 'hr.payslip', slip.id).state, 'paid');
});

test('codesd 2: cash basis uses each tax transition id and repartition id after account renaming', () => {
  let db = setup();
  const transition = account(db, 'CUSTOM-TRANSITION', 'liability_current'); db = transition.db;
  const final = account(db, 'CUSTOM-TAX', 'liability_current'); db = final.db;
  const tax = create(db, 'account.tax', { name: 'Custom cash tax', company_id: 1, type_tax_use: 'sale', amount: 10, tax_exigibility: 'on_payment', cash_basis_transition_account_id: transition.id, ...defaultTaxRepartitionLines(final.id) });
  const draft = invoice(tax.db, read(tax.db, 'account.tax', tax.id));
  db = postMove(draft.db, draft.id);
  assert.equal(read(db, 'account.move', draft.id).line_ids.find((line) => line.account_id === transition.id).credit, 10);
  db = payMove(db, draft.id, 110, '2037-01-02');
  const release = search(db, 'account.move').find((move) => move.cash_basis_origin_move_id === draft.id);
  assert.equal(release.line_ids.find((line) => line.account_id === transition.id).debit, 10);
  assert.equal(release.line_ids.find((line) => line.account_id === final.id).credit, 10);
  assert.ok(taxAccounts(db, 1).sale.has(final.id));
  // Saving an on-payment tax without the account is refused (Qodo 16); legacy stored data still fails at posting.
  assert.throws(() => write(draft.db, 'account.tax', tax.id, { cash_basis_transition_account_id: null }), /Configure the cash basis transition account/);
  const missing = { ...draft.db, records: { ...draft.db.records, 'account.tax': draft.db.records['account.tax'].map((t) => (t.id === tax.id ? { ...t, cash_basis_transition_account_id: null } : t)) } };
  assert.throws(() => postMove(missing, draft.id), /Configure the cash basis transition account/);
});

test('codesd 3: rounding lines require explicit account ids and reject code strings and foreign accounts', () => {
  let db = setup();
  const profit = account(db, 'CUSTOM-PROFIT', 'income_other'); db = profit.db;
  const loss = account(db, 'CUSTOM-LOSS', 'expense_other'); db = loss.db;
  const rounding = create(db, 'account.cash.rounding', { name: 'Nickel', rounding: 0.05, strategy: 'add_invoice_line', profit_account_id: profit.id, loss_account_id: loss.id });
  db = rounding.db;
  const draft = invoice(db, null, { invoice_cash_rounding_id: rounding.id, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100.02, tax: 0 }] });
  const lines = invoiceLines(draft.db, read(draft.db, 'account.move', draft.id));
  assert.equal(lines.find((line) => line.name === 'Cash Rounding').account_id, loss.id);
  const missing = write(draft.db, 'account.cash.rounding', rounding.id, { loss_account_id: null });
  assert.throws(() => invoiceLines(missing, read(missing, 'account.move', draft.id)), /Configure the loss account/);
  assert.throws(() => write(db, 'account.cash.rounding', rounding.id, { loss_account_id: 'CUSTOM-LOSS' }), /Configure the loss account/);
});

test('codesd 4: POS stock return COGS uses configured stock account with a nonstandard code', () => {
  let db = setup();
  const cogs = account(db, 'CUSTOM-COGS', 'expense_direct_cost'); db = cogs.db;
  db = write(db, 'res.company', 1, { account_cogs_id: cogs.id });
  const product = create(db, 'product', { name: 'Return item', type: 'goods', valuation: 'real_time', cost: 12, list_price: 20, qty_available: 0 });
  const preset = create(product.db, 'pos.preset', { name: 'Returns', is_return: true, identification: 'none' });
  const config = search(preset.db, 'pos.config')[0];
  db = write(preset.db, 'pos.config', config.id, { available_preset_ids: [preset.id], default_preset_id: preset.id });
  db = startSession(db, 0).db;
  const sale = payOrder(db, { lines: priceLines(db, [{ product_id: product.id, qty: -1 }]), method: 'cash', preset_id: preset.id });
  const layer = search(sale.db, 'stock.valuation.layer').find((layer) => layer.product_id === product.id && !layer.opening);
  assert.ok(layer);
  assert.ok(read(sale.db, 'account.move', layer.move_id).line_ids.some((line) => line.account_id === cogs.id && line.credit === 12));
});

test('codesd 5: analytic lines retain the actual booked account rather than a fallback chart code', () => {
  let db = setup();
  const expense = account(db, 'CUSTOM-ANALYTIC'); db = expense.db;
  const analytic = create(db, 'account.analytic.account', { name: 'Audit project' }); db = analytic.db;
  const draft = invoice(db, null, { move_type: 'in_invoice', invoice_line_ids: [{ name: 'Allocated', account_id: expense.id, qty: 1, price_unit: 100, tax: 0, analytic_distribution: { [analytic.id]: 100 } }] });
  db = postMove(draft.db, draft.id);
  const lines = analyticLinesForMove(db, read(db, 'account.move', draft.id));
  assert.equal(lines.find((line) => line.account_id === analytic.id).general_account, 'CUSTOM-ANALYTIC');
});

test('codesd 6: single expenses use expenseDebits product and tax settings, with no category inference', () => {
  let db = setup();
  const expense = account(db, 'CUSTOM-EXPENSE'); db = expense.db;
  const input = account(db, 'CUSTOM-INPUT', 'asset_current'); db = input.db;
  const product = create(db, 'product', { name: 'Explicit expense', type: 'service', property_account_expense_id: expense.id }); db = product.db;
  const tax = create(db, 'account.tax', { name: 'Explicit input tax', company_id: 1, type_tax_use: 'purchase', amount: 10, ...defaultTaxRepartitionLines(input.id) }); db = tax.db;
  const claim = create(db, 'hr.expense', { name: 'Claim', employee_id: 1, product_id: product.id, tax_id: tax.id, tax: 10, total_amount: 110, state: 'approved', date: '2037-01-01' });
  const missing = write(claim.db, 'hr.expense', claim.id, { tax_id: null });
  assert.throws(() => run(missing, 'hr.expense', claim.id, 'Post Journal Entries'), /Configure the expense tax/);
  db = run(claim.db, 'hr.expense', claim.id, 'Post Journal Entries');
  const move = read(db, 'account.move', read(db, 'hr.expense', claim.id).move_id);
  assert.equal(move.line_ids.find((line) => line.account_id === expense.id).debit, 100);
  assert.equal(move.line_ids.find((line) => line.account_id === input.id).debit, 10);
});

test('codesd 7: opening stock uses the company opening balance equity account and fails atomically without it', () => {
  let db = setup();
  const equity = account(db, 'CUSTOM-OPENING', 'equity'); db = equity.db;
  db = write(db, 'res.company', 1, { opening_equity_account_id: equity.id });
  const product = create(db, 'product', { name: 'Opening item', type: 'goods', valuation: 'real_time', cost: 12, qty_available: 2 });
  const missing = write(product.db, 'res.company', 1, { opening_equity_account_id: null });
  const before = structuredClone(missing);
  assert.throws(() => postOpeningStock(missing, '2037-01-01'), /Configure the opening balance equity account/);
  assert.deepEqual(missing, before);
  db = postOpeningStock(product.db, '2037-01-01');
  const layer = search(db, 'stock.valuation.layer').find((layer) => layer.product_id === product.id);
  assert.equal(read(db, 'account.move', layer.move_id).line_ids.find((line) => line.account_id === equity.id).credit, 24);
});

test('codesd 8: generic entries post explicit renamed account ids', () => {
  const db = setup();
  const company = read(db, 'res.company', 1);
  const debit = read(db, 'account.journal', company.default_purchase_journal_id).default_account_id;
  const credit = company.current_year_earnings_account_id;
  const spec = { journal_id: company.default_general_journal_id, company: 1, date: '2037-01-01', lines: [{ account_id: debit, debit: 5 }, { account_id: credit, credit: 5 }] };
  assert.ok(postEntry(db, spec).id);
});

test('codesd migration 33 maps installer roles only on a unique company-owned code and type', () => {
  let db = seed();
  for (const a of search(db, 'account.account')) if (!a.company_id) db = write(db, 'account.account', a.id, { company_id: 1 });
  const company = read(db, 'res.company', 1);
  const old = { ...db, schema_version: 32, records: { ...db.records, 'res.company': [{ ...company, current_year_earnings_account_id: null }], 'account.tax': [{ id: 999, name: 'Cash', company_id: 1, type_tax_use: 'sale', tax_exigibility: 'on_payment' }] } };
  const migrated = migrate(old);
  assert.equal(migrated.schema_version, 36);
  const transition = read(migrated, 'account.tax', 999).cash_basis_transition_account_id;
  assert.equal(read(migrated, 'account.account', transition).code, '251100');
  const renamed = { ...old, records: { ...old.records, 'account.account': old.records['account.account'].map((a) => ({ ...a, code: `CUSTOM-${a.id}` })) } };
  assert.equal(read(migrate(renamed), 'account.tax', 999).cash_basis_transition_account_id, null);
});

test('runtime models never look an account up by a literal chart code', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('./models/', import.meta.url);
  const offenders = readdirSync(dir).filter((f) => f.endsWith('.js'))
    .filter((f) => /accountId\(\w+, '\d/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(offenders, []);
});
