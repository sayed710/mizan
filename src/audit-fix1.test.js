import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { createCompany } from './models/company.js';
import { isLiquidityJournal, paymentJournal } from './models/ledger.js';
import { intercompanyBill, payMove, postMove } from './models/accounting.js';
import { analyticLinesForMove, analyticMoveCategory, postAnalytic, removeAnalytic } from './models/analyticplus.js';
import { analyticActuals } from './models/finance.js';

/** Add income/expense accounts and default customer/supplier/misc journals scoped to a test company. */
function addCompanyInvoiceJournals(db, companyId, codePrefix = `C${companyId}`) {
  let next = db;
  let income = search(next, 'account.account').find((a) => a.company_id === companyId && a.account_type === 'income');
  if (!income) {
    const res = create(next, 'account.account', { code: `40${companyId}000`, name: `Income ${companyId}`, account_type: 'income', company_id: companyId });
    next = res.db;
    income = read(next, 'account.account', res.id);
  }
  let expense = search(next, 'account.account').find((a) => a.company_id === companyId && a.account_type === 'expense');
  if (!expense) {
    const res = create(next, 'account.account', { code: `60${companyId}000`, name: `Expense ${companyId}`, account_type: 'expense', company_id: companyId });
    next = res.db;
    expense = read(next, 'account.account', res.id);
  }
  const saleRes = create(next, 'account.journal', { name: `Sales ${companyId}`, code: `${codePrefix}S`, invoice_sequence_prefix: `${codePrefix}S/`, invoice_sequence_next_number: 1, type: 'sale', company_id: companyId, default_account_id: income.id });
  const purchRes = create(saleRes.db, 'account.journal', { name: `Purchase ${companyId}`, code: `${codePrefix}P`, invoice_sequence_prefix: `${codePrefix}P/`, invoice_sequence_next_number: 1, type: 'purchase', company_id: companyId, default_account_id: expense.id });
  const genRes = create(purchRes.db, 'account.journal', { name: `Misc ${companyId}`, code: `${codePrefix}M`, invoice_sequence_prefix: `${codePrefix}M/`, invoice_sequence_next_number: 1, type: 'general', company_id: companyId });
  return write(genRes.db, 'res.company', companyId, {
    default_sale_journal_id: saleRes.id,
    default_purchase_journal_id: purchRes.id,
    default_general_journal_id: genRes.id,
    intercompany_journal_id: purchRes.id,
    account_sale_account_id: income.id,
    account_expense_account_id: expense.id,
  });
}

test('PKG-01: seeded liquidity journals (BNK1, CSH1) belong to company 1', () => {
  const db = seed();
  const bnk1 = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const csh1 = search(db, 'account.journal').find((j) => j.code === 'CSH1');
  assert.ok(bnk1 && csh1);
  assert.equal(bnk1.company_id, 1);
  assert.equal(csh1.company_id, 1);
  for (const journal of search(db, 'account.journal').filter(isLiquidityJournal)) {
    assert.equal(journal.company_id, 1);
  }
});

test('PKG-01: Company 2 payment requires its own default payment journal and never posts to Company 1 bank', () => {
  let db = seed();
  const branch = createCompany(db, { name: 'Company 2' });
  db = addCompanyInvoiceJournals(branch.db, branch.id, 'C2');
  const partner = create(db, 'res.partner', { name: 'Co2 Customer', customer: true });
  db = partner.db;
  const product = search(db, 'product')[0];
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: branch.id,
    partner_id: partner.id,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{ product_id: product.id, name: product.name, qty: 1, price_unit: 100, discount: 0, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  assert.throws(
    () => paymentJournal(db, null, branch.id),
    /Select a payment journal or configure one default bank or cash journal/,
  );
  assert.throws(
    () => payMove(db, inv.id, 100, '2026-02-02'),
    /Select a payment journal or configure one default bank or cash journal/,
  );

  // Explicit Co1 journal is also rejected for Co2 payment
  const bnk1 = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  assert.throws(() => payMove(db, inv.id, 100, '2026-02-02', { journalId: bnk1.id }), /another company/);

  // Configure Company 2's own default bank journal and pay without specifying journalId
  const bank2Acc = create(db, 'account.account', { code: '101499', name: 'Co2 Bank', account_type: 'asset_cash', company_id: branch.id });
  const bank2Journal = create(bank2Acc.db, 'account.journal', {
    name: 'Co2 Bank',
    code: 'BNK2',
    type: 'bank',
    company_id: branch.id,
    default_for_payments: true,
    default_account_id: bank2Acc.id,
    suspense_account_id: bank2Acc.id,
  });
  db = bank2Journal.db;

  assert.equal(paymentJournal(db, null, branch.id).id, bank2Journal.id);
  const paidDb = payMove(db, inv.id, 100, '2026-02-02');
  const payments = search(paidDb, 'account.payment').filter((p) => p.invoice_id === inv.id);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].journal_id, bank2Journal.id);
  assert.equal(payments[0].company_id, branch.id);
  const payMoveRec = read(paidDb, 'account.move', payments[0].move_id);
  const bnk1AccountId = bnk1.default_account_id;
  assert.equal(payMoveRec.line_ids.some((l) => l.account_id === bnk1AccountId), false);
});

test('PKG-01: migration 49 infers journal company_id only when provable and logs chatter note otherwise', async () => {
  let db = seed();
  const co2 = createCompany(db, { name: 'Second Co' });
  db = co2.db;
  const co1CashCreated = create(db, 'account.account', { code: '101497', name: 'Co1 Cash', account_type: 'asset_cash', company_id: 1 });
  const co2CashCreated = create(co1CashCreated.db, 'account.account', { code: '101498', name: 'Co2 Cash', account_type: 'asset_cash', company_id: co2.id });
  db = co2CashCreated.db;
  const co1Cash = read(db, 'account.account', co1CashCreated.id);
  const co2Cash = read(db, 'account.account', co2CashCreated.id);

  const synthetic = {
    ...db,
    schema_version: 48,
    records: {
      ...db.records,
      'account.journal': [
        { id: 901, name: 'Provable via account', code: 'PA1', type: 'bank', active: true, default_account_id: co2Cash.id },
        { id: 902, name: 'Provable via moves', code: 'PM1', type: 'bank', active: true, default_account_id: null },
        { id: 903, name: 'Company 2 Lookalike', code: 'CO2', type: 'bank', active: true, default_account_id: null },
        { id: 904, name: 'Conflicting accounts', code: 'CA1', type: 'bank', active: true, default_account_id: co1Cash.id, suspense_account_id: co2Cash.id },
        { id: 905, name: 'Conflicting moves', code: 'CM1', type: 'bank', active: true, default_account_id: null },
        { id: 906, name: 'Account vs Move conflict', code: 'AMC', type: 'bank', active: true, default_account_id: co1Cash.id },
        { id: 907, name: 'Draft only moves', code: 'DRF', type: 'bank', active: true, default_account_id: null },
      ],
      'account.move': [
        { id: 951, name: 'M1', journal_id: 902, company_id: co2.id, state: 'posted' },
        { id: 952, name: 'M2', journal_id: 902, company_id: co2.id, state: 'posted' },
        { id: 953, name: 'M3', journal_id: 905, company_id: 1, state: 'posted' },
        { id: 954, name: 'M4', journal_id: 905, company_id: co2.id, state: 'posted' },
        { id: 955, name: 'M5', journal_id: 906, company_id: co2.id, state: 'posted' },
        { id: 956, name: 'M6', journal_id: 907, company_id: co2.id, state: 'draft' },
      ],
    },
  };

  const migrated = migrate(synthetic);
  assert.equal(migrated.schema_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 50);

  assert.equal(read(migrated, 'account.journal', 901).company_id, co2.id);
  assert.equal(read(migrated, 'account.journal', 902).company_id, co2.id);

  // Arabic translation must exist and differ from English source
  const prevStorage = globalThis.localStorage;
  const storage = new Map([['mizan-lang', 'ar']]);
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  try {
    const { t: tAr } = await import(`./i18n.js?m47ar=${Date.now()}`);
    for (const unresolvedId of [903, 904, 905, 906, 907]) {
      assert.equal(read(migrated, 'account.journal', unresolvedId).company_id ?? null, null);
      const notes = (migrated.messages ?? []).filter((m) => m.model === 'account.journal' && m.res_id === unresolvedId);
      assert.equal(notes.length, 1);
      assert.ok(notes[0].body.includes('could not be proved'));
      assert.notEqual(tAr(notes[0].body), notes[0].body);
    }
  } finally {
    if (prevStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prevStorage;
  }
});

test('PKG-03 item 1: postAnalytic is idempotent on in_refund and keeps 120/80 across re-posts', () => {
  let db = seed();
  const a1 = create(db, 'account.analytic.account', { name: 'Plan Alpha' });
  const a2 = create(a1.db, 'account.analytic.account', { name: 'Plan Beta' });
  const vendor = create(a2.db, 'res.partner', { name: 'Analytic Vendor', supplier: true });
  db = vendor.db;
  const product = search(db, 'product')[0];

  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: vendor.id,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{
      product_id: product.id,
      name: product.name,
      qty: 2,
      price_unit: 100,
      discount: 0,
      tax: 0,
      analytic_distribution: { [a1.id]: 60, [a2.id]: 40 },
    }],
  });

  db = postMove(refund.db, refund.id);
  assert.equal(analyticMoveCategory(read(db, 'account.move', refund.id)), 'vendor_bill');
  assert.equal(analyticLinesForMove(db, read(db, 'account.move', refund.id))[0].category, 'vendor_bill');

  db = postAnalytic(db, refund.id);
  const lines = search(db, 'account.analytic.line').filter((l) => l.move_id === refund.id);
  assert.equal(lines.length, 2);
  const actuals = analyticActuals(db);
  assert.equal(actuals.get(a1.id), 120);
  assert.equal(actuals.get(a2.id), 80);

  db = removeAnalytic(db, refund.id);
  assert.equal(search(db, 'account.analytic.line').filter((l) => l.move_id === refund.id).length, 0);
});

test('PKG-03 item 3: intercompanyBill keeps untaxed Co1 invoice lines untaxed and postable when Co2 has no purchase tax', () => {
  let db = seed();
  const co2Partner = create(db, 'res.partner', { name: 'Untaxed Buyer Co', customer: true, supplier: true, company_id: null });
  db = co2Partner.db;
  const co1Partner = create(db, 'res.partner', { name: 'Main Co Vendor', supplier: true, company_id: null });
  db = co1Partner.db;
  db = write(db, 'res.company', 1, { partner_id: co1Partner.id });
  const buyer = createCompany(db, { name: 'Untaxed Buyer Co', partner_id: co2Partner.id, intercompany_rule: 'invoice_bill' });
  db = addCompanyInvoiceJournals(buyer.db, buyer.id, 'UB');
  db = write(db, 'res.company', buyer.id, { account_purchase_tax_id: null, account_sale_tax_id: null });
  const buyerExpense = search(db, 'account.account').find((a) => a.company_id === buyer.id && a.account_type === 'expense');
  const productRes = create(db, 'product', {
    name: 'Untaxed IC Item',
    sale_price: 100,
    cost: 60,
    supplier_tax_id: null,
    purchase_tax: 14,
    property_account_expense_id: buyerExpense.id,
  });
  db = productRes.db;
  const product = read(db, 'product', productRes.id);

  // Company 1 untaxed sale invoice to Company 2
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: co2Partner.id,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ product_id: product.id, name: product.name, qty: 2, price_unit: 100, discount: 0, tax: 0, tax_ids: [] }],
  });
  db = postMove(inv.db, inv.id);

  const postedInv = read(db, 'account.move', inv.id);
  const generated = postedInv.intercompany_move_id
    ? { db, id: postedInv.intercompany_move_id }
    : intercompanyBill(db, postedInv);
  assert.ok(generated);
  const bill = read(generated.db, 'account.move', generated.id);
  assert.equal(bill.company_id, buyer.id);
  assert.equal(bill.invoice_line_ids[0].tax ?? 0, 0);
  assert.equal(bill.invoice_line_ids[0].tax_id ?? null, null);

  const postedDb = postMove(generated.db, generated.id);
  assert.equal(read(postedDb, 'account.move', generated.id).state, 'posted');

  // Taxed source line still maps through buyer's configured purchase tax
  const co2Payable = read(postedDb, 'res.company', buyer.id).account_default_payable_id;
  const co2PurchaseTax = create(postedDb, 'account.tax', {
    name: 'Buyer VAT 14%',
    amount: 14,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: buyer.id,
  });
  const taxDb = write(co2PurchaseTax.db, 'res.company', buyer.id, { account_purchase_tax_id: co2PurchaseTax.id, account_default_payable_id: co2Payable });
  const saleTax1 = read(taxDb, 'account.tax', read(taxDb, 'res.company', 1).account_sale_tax_id);
  const taxedInv = create(taxDb, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: co2Partner.id,
    invoice_date: '2026-03-02',
    invoice_line_ids: [{ product_id: product.id, name: product.name, qty: 1, price_unit: 100, discount: 0, tax: saleTax1.amount, tax_id: saleTax1.id, tax_ids: [saleTax1.id] }],
  });
  const taxedPosted = postMove(taxedInv.db, taxedInv.id);
  const taxedBillId = read(taxedPosted, 'account.move', taxedInv.id).intercompany_move_id;
  assert.equal(read(taxedPosted, 'account.move', taxedBillId).invoice_line_ids[0].tax, saleTax1.amount);
});
