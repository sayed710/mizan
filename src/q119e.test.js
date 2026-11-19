import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { applyDiff } from './sync.js';
import { payMove, postMove } from './models/accounting.js';
import { addDays, today } from './models/common.js';
import { rateAt } from './models/currency.js';
import { accountId, allocateJournalSources, journalItems, postEntry } from './models/ledger.js';
import { payOrder, refundOrder, startSession } from './models/pos.js';
import { reconcileLedgerItems } from './models/glReconcile.js';
import { taxSnapshot } from './models/taxes.js';
import { taxBaseTotal, taxReport, taxesByTax } from './models/finance.js';
import { taxReturnBoxes } from './models/taxExport.js';
import { companyCurrencyRecord, roundCurrency } from './money.js';

function miscJournal(db, companyId = 1) {
  return search(db, 'account.journal').find((j) => j.type === 'general' && (!j.company_id || j.company_id === companyId));
}

function arAccount(db, companyId = 1) {
  return read(db, 'res.company', companyId)?.account_default_receivable_id ?? accountId(db, '121000', companyId);
}

function itemSelection(db, moveId, account, predicate = () => true) {
  const rows = journalItems(db).filter((l) => l.move_id === moveId && l.account_id === account && predicate(l));
  assert.equal(rows.length, 1, `Expected 1 journal item on move ${moveId} account ${account}`);
  return { move_id: moveId, line_identity: rows[0].line_identity };
}

function postedInvoice(db, { partnerId, moveType = 'out_invoice', price = 500, date = '2026-04-10', currencyId = null, lines = null }) {
  const inv = create(db, 'account.move', {
    partner_id: partnerId,
    company_id: 1,
    move_type: moveType,
    invoice_date: date,
    ...(currencyId ? { currency_id: currencyId } : {}),
    invoice_line_ids: lines ?? [{ product_id: 5, qty: 1, price_unit: price, tax: 0 }],
  });
  return { db: postMove(inv.db, inv.id), id: inv.id };
}

function ensureReturnType(db) {
  if (search(db, 'account.return.type').some((t) => (t.company_id ?? 1) === 1 && t.category === 'account_return')) return db;
  return create(db, 'account.return.type', { name: 'VAT Return', category: 'account_return', company_id: 1 }).db;
}

function makeTax(db, { name, amount, type_tax_use, tax_scope, accountCode, cashBasis = false, ...extra }) {
  const acc = accountId(db, accountCode);
  return create(db, 'account.tax', {
    name,
    amount,
    amount_type: 'percent',
    type_tax_use,
    ...(tax_scope ? { tax_scope } : {}),
    ...(cashBasis ? { tax_exigibility: 'on_payment', cash_basis_transition_account_id: accountId(db, type_tax_use === 'sale' ? '251100' : '131100') } : {}),
    ...extra,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: acc },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100 },
      { repartition_type: 'tax', factor_percent: 100, account_id: acc },
    ],
  });
}

function combineTaxSnapshots(db, taxIds) {
  const snaps = taxIds.map((id) => taxSnapshot(read(db, 'account.tax', id)));
  return {
    tax_ids: taxIds,
    tax_breakdown: snaps,
  };
}

function makeReturn(db, { from = '2026-04-01', to = '2026-04-30', template = 'generic' } = {}) {
  const baseDb = ensureReturnType(db);
  const type = search(baseDb, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.category === 'account_return');
  const ret = create(baseDb, 'account.return', {
    name: `VAT ${template}`,
    type_id: type.id,
    date_from: from,
    date_to: to,
    company_id: 1,
    tax_return_template: template,
  });
  return { db: ret.db, ret: read(ret.db, 'account.return', ret.id) };
}

test('Requirement 1: applyDiff enforces partner compatibility and company-currency rules on account.partial.reconcile', () => {
  let db = seed();
  const partnerA = create(db, 'res.partner', { name: 'Partner A Co' });
  const partnerB = create(partnerA.db, 'res.partner', { name: 'Partner B Co' });
  const childA = create(partnerB.db, 'res.partner', { name: 'Partner A Branch', parent_id: partnerA.id });
  const eur = create(childA.db, 'res.currency', {
    name: 'EUR_Q119E',
    rounding: 0.01,
    rate_ids: [{ date: '2026-01-01', rate: 0.5 }],
  });
  db = eur.db;

  const ar = arAccount(db, 1);
  const rev = accountId(db, '400000', 1);
  const suspAcc = create(db, 'account.account', { code: '109901', name: 'Clearing Reconcilable', account_type: 'asset_current', reconcile: true, company_id: 1 });
  db = suspAcc.db;
  const susp = suspAcc.id;
  const misc = miscJournal(db, 1);

  const invA = postedInvoice(db, { partnerId: partnerA.id, price: 300, date: '2026-04-01' });
  const creditB = postEntry(invA.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-02', ref: 'Credit B',
    lines: [{ account_id: ar, partner_id: partnerB.id, credit: 300 }, { account_id: rev, debit: 300 }],
  });
  const creditA = postEntry(creditB.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-02', ref: 'Credit A',
    lines: [{ account_id: ar, partner_id: partnerA.id, credit: 150 }, { account_id: rev, debit: 150 }],
  });
  const creditChildA = postEntry(creditA.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-02', ref: 'Credit Child A',
    lines: [{ account_id: ar, partner_id: childA.id, credit: 100 }, { account_id: rev, debit: 100 }],
  });
  const creditNoPartner = postEntry(creditChildA.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-02', ref: 'Credit No Partner',
    lines: [{ account_id: ar, partner_id: null, credit: 100 }, { account_id: rev, debit: 100 }],
  });
  const debitNoPartner = postEntry(creditNoPartner.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-02', ref: 'Debit No Partner',
    lines: [{ account_id: ar, partner_id: null, debit: 100 }, { account_id: rev, credit: 100 }],
  });
  const foreignInvA = postedInvoice(debitNoPartner.db, { partnerId: partnerA.id, price: 100, date: '2026-04-03', currencyId: eur.id });
  const foreignLineEntry = postEntry(foreignInvA.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-03', ref: 'Foreign Currency Line',
    lines: [
      { account_id: ar, partner_id: partnerA.id, debit: 200, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 200 },
    ],
  });
  const suspDebitA = postEntry(foreignLineEntry.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-04', ref: 'Suspense Debit A',
    lines: [{ account_id: susp, partner_id: partnerA.id, debit: 100 }, { account_id: rev, credit: 100 }],
  });
  const suspCreditNoPartner = postEntry(suspDebitA.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-04-04', ref: 'Suspense Credit Blank',
    lines: [{ account_id: susp, partner_id: null, credit: 100 }, { account_id: rev, debit: 100 }],
  });
  db = suspCreditNoPartner.db;

  const invArIdx = read(db, 'account.move', invA.id).line_ids.findIndex((l) => l.account_id === ar);
  const foreignInvArIdx = read(db, 'account.move', foreignInvA.id).line_ids.findIndex((l) => l.account_id === ar);
  const linkTemplate = {
    id: 9101,
    debit_move_id: invA.id,
    debit_line_index: invArIdx,
    credit_move_id: creditA.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 100,
    date: '2026-04-05',
    active: true,
    reversed: false,
  };

  // 1a. Two different partners on receivable account: rejected by both reconcileLedgerItems and applyDiff; db unchanged.
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, invA.id, ar), itemSelection(db, creditB.id, ar)], { date: '2026-04-05' }),
    /Selected receivable or payable items must have the same partner/,
  );
  const diffPartnersSnapshot = structuredClone(db.records['account.partial.reconcile'] ?? []);
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...linkTemplate, credit_move_id: creditB.id, credit_line_index: 0 }] } }, { isAdmin: true }),
    /Selected receivable or payable items must have the same partner/,
  );
  assert.deepEqual(db.records['account.partial.reconcile'] ?? [], diffPartnersSnapshot);

  // 1b. Foreign currency (on invoice move OR directly on a journal line): rejected by both paths; db unchanged.
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, foreignInvA.id, ar), itemSelection(db, creditA.id, ar)], { date: '2026-04-05' }),
    /General-ledger reconciliation requires items in the company currency/,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...linkTemplate, debit_move_id: foreignInvA.id, debit_line_index: foreignInvArIdx }] } }, { isAdmin: true }),
    /General-ledger reconciliation requires items in the company currency/,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...linkTemplate, debit_move_id: foreignLineEntry.id, debit_line_index: 0 }] } }, { isAdmin: true }),
    /General-ledger reconciliation requires items in the company currency/,
  );
  assert.deepEqual(db.records['account.partial.reconcile'] ?? [], diffPartnersSnapshot);

  // 1c. Line with partner + line with no partner:
  // On AR/AP accounts, reconcileLedgerItems rejects mixed partner / no-partner; applyDiff must also reject it.
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, invA.id, ar), itemSelection(db, creditNoPartner.id, ar)], { date: '2026-04-05' }),
    /Selected receivable or payable items must have the same partner/,
  );
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...linkTemplate, credit_move_id: creditNoPartner.id, credit_line_index: 0 }] } }, { isAdmin: true }),
    /Selected receivable or payable items must have the same partner/,
  );
  assert.deepEqual(db.records['account.partial.reconcile'] ?? [], diffPartnersSnapshot);

  // On non-AR/AP reconcilable accounts, reconcileLedgerItems allows mixed partner / no-partner; applyDiff allows it too.
  const suspUiDb = reconcileLedgerItems(db, [itemSelection(db, suspDebitA.id, susp), itemSelection(db, suspCreditNoPartner.id, susp)], { date: '2026-04-05' });
  assert.equal((suspUiDb.records['account.partial.reconcile'] ?? []).length, 1);
  const suspSyncDb = applyDiff(db, {
    upserts: {
      'account.partial.reconcile': [{
        ...linkTemplate,
        id: 9102,
        debit_move_id: suspDebitA.id,
        debit_line_index: 0,
        credit_move_id: suspCreditNoPartner.id,
        credit_line_index: 0,
        account_id: susp,
      }],
    },
  }, { isAdmin: true });
  assert.equal((suspSyncDb.records['account.partial.reconcile'] ?? []).length, 1);

  // On AR/AP when BOTH lines have no partner, reconcileLedgerItems allows it; applyDiff allows it too.
  const bothBlankUiDb = reconcileLedgerItems(db, [itemSelection(db, debitNoPartner.id, ar), itemSelection(db, creditNoPartner.id, ar)], { date: '2026-04-05' });
  assert.equal((bothBlankUiDb.records['account.partial.reconcile'] ?? []).length, 1);
  const bothBlankSyncDb = applyDiff(db, {
    upserts: {
      'account.partial.reconcile': [{
        ...linkTemplate,
        id: 9103,
        debit_move_id: debitNoPartner.id,
        debit_line_index: 0,
        credit_move_id: creditNoPartner.id,
        credit_line_index: 0,
      }],
    },
  }, { isAdmin: true });
  assert.equal((bothBlankSyncDb.records['account.partial.reconcile'] ?? []).length, 1);

  // 1d. Valid same-partner (and commercial-parent child) company-currency links are accepted via applyDiff.
  const samePartnerDb = applyDiff(db, { upserts: { 'account.partial.reconcile': [linkTemplate] } }, { isAdmin: true });
  assert.equal((samePartnerDb.records['account.partial.reconcile'] ?? []).length, 1);
  const childPartnerDb = applyDiff(samePartnerDb, {
    upserts: {
      'account.partial.reconcile': [{
        ...linkTemplate,
        id: 9104,
        credit_move_id: creditChildA.id,
        credit_line_index: 0,
        amount: 50,
      }],
    },
  }, { isAdmin: true });
  assert.equal((childPartnerDb.records['account.partial.reconcile'] ?? []).length, 2);
});

test('Requirement 2: multi-tax invoice lines keep per-tax bases while totals count each line base once across generic and template exports', () => {
  let db = seed();
  const vat14 = makeTax(db, { name: 'VAT 14% Multi', amount: 14, type_tax_use: 'sale', tax_scope: 'consu', accountCode: '251000' });
  const levy1 = makeTax(vat14.db, { name: 'Levy 1% Multi', amount: 1, type_tax_use: 'sale', tax_scope: 'consu', accountCode: '251000' });
  const purch10 = makeTax(levy1.db, { name: 'Input VAT 10% Multi', amount: 10, type_tax_use: 'purchase', tax_scope: 'service', accountCode: '131000' });
  const purch2 = makeTax(purch10.db, { name: 'Input Fee 2% Multi', amount: 2, type_tax_use: 'purchase', tax_scope: 'service', accountCode: '131000' });
  db = purch2.db;

  const period = { from: '2026-04-01', to: '2026-04-30', company_id: 1 };

  // Step 1: One sale line of 1000 carrying BOTH sale taxes.
  const sale1 = postedInvoice(db, {
    partnerId: 1,
    moveType: 'out_invoice',
    date: '2026-04-05',
    lines: [{ product_id: 5, qty: 1, price_unit: 1000, ...combineTaxSnapshots(db, [vat14.id, levy1.id]) }],
  });
  db = sale1.db;

  const byTax1 = taxesByTax(db, period).filter((r) => r.side === 'sale');
  assert.equal(byTax1.find((r) => r.tax_id === vat14.id)?.base, 1000);
  assert.equal(byTax1.find((r) => r.tax_id === vat14.id)?.tax, 140);
  assert.equal(byTax1.find((r) => r.tax_id === levy1.id)?.base, 1000);
  assert.equal(byTax1.find((r) => r.tax_id === levy1.id)?.tax, 10);

  const retGen1 = makeReturn(db, { template: 'generic' });
  const gen1 = taxReturnBoxes(retGen1.db, retGen1.ret);
  const rep1 = taxReport(retGen1.db, period);
  assert.deepEqual(gen1.totals, rep1);
  assert.equal(gen1.boxes.find((b) => b.code === 'TOTAL-OUT').base, 1000);
  assert.equal(gen1.boxes.find((b) => b.code === 'TOTAL-OUT').tax, 150);

  const retEg1 = makeReturn(db, { template: 'eg_vat' });
  const eg1 = taxReturnBoxes(retEg1.db, retEg1.ret);
  assert.deepEqual(eg1.totals, rep1);
  // Both taxes are tax_scope: 'consu', so BOX-1 combines their tax (150) while counting the 1000 line base once.
  assert.equal(eg1.boxes.find((b) => b.code === 'BOX-1').base, 1000);
  assert.equal(eg1.boxes.find((b) => b.code === 'BOX-1').tax, 150);
  assert.equal(eg1.boxes.find((b) => b.code === 'BOX-4').base, 1000);
  assert.equal(eg1.boxes.find((b) => b.code === 'BOX-4').tax, 150);

  // Step 2: Add a second sale line of 500 carrying ONLY vat14 -> total base becomes 1500, VAT base 1500, Levy base 1000.
  const sale2 = postedInvoice(db, {
    partnerId: 1,
    moveType: 'out_invoice',
    date: '2026-04-06',
    lines: [{ product_id: 5, qty: 1, price_unit: 500, ...combineTaxSnapshots(db, [vat14.id]) }],
  });
  db = sale2.db;

  const byTax2 = taxesByTax(db, period).filter((r) => r.side === 'sale');
  assert.equal(byTax2.find((r) => r.tax_id === vat14.id)?.base, 1500);
  assert.equal(byTax2.find((r) => r.tax_id === vat14.id)?.tax, 210);
  assert.equal(byTax2.find((r) => r.tax_id === levy1.id)?.base, 1000);
  assert.equal(byTax2.find((r) => r.tax_id === levy1.id)?.tax, 10);

  const retGen2 = makeReturn(db, { template: 'generic' });
  const gen2 = taxReturnBoxes(retGen2.db, retGen2.ret);
  const rep2 = taxReport(retGen2.db, period);
  assert.deepEqual(gen2.totals, rep2);
  assert.equal(gen2.boxes.find((b) => b.code === 'TOTAL-OUT').base, 1500);
  assert.equal(gen2.boxes.find((b) => b.code === 'TOTAL-OUT').tax, 220);

  // Step 3: Purchases: 1000 line with both purchase taxes + 500 line with one purchase tax -> TOTAL-IN.base 1500.
  const bill1 = postedInvoice(db, {
    partnerId: 2,
    moveType: 'in_invoice',
    date: '2026-04-07',
    lines: [
      { product_id: 5, qty: 1, price_unit: 1000, ...combineTaxSnapshots(db, [purch10.id, purch2.id]) },
      { product_id: 5, qty: 1, price_unit: 500, ...combineTaxSnapshots(db, [purch10.id]) },
    ],
  });
  db = bill1.db;

  const byTaxIn = taxesByTax(db, period).filter((r) => r.side === 'purchase');
  assert.equal(byTaxIn.find((r) => r.tax_id === purch10.id)?.base, 1500);
  assert.equal(byTaxIn.find((r) => r.tax_id === purch10.id)?.tax, 150);
  assert.equal(byTaxIn.find((r) => r.tax_id === purch2.id)?.base, 1000);
  assert.equal(byTaxIn.find((r) => r.tax_id === purch2.id)?.tax, 20);

  const retGen3 = makeReturn(db, { template: 'generic' });
  const gen3 = taxReturnBoxes(retGen3.db, retGen3.ret);
  const rep3 = taxReport(retGen3.db, period);
  assert.deepEqual(gen3.totals, rep3);
  assert.equal(gen3.boxes.find((b) => b.code === 'TOTAL-IN').base, 1500);
  assert.equal(gen3.boxes.find((b) => b.code === 'TOTAL-IN').tax, 170);

  // Step 4: Refunds carrying multiple taxes on one line reduce totals once (200 each).
  const outRef = postedInvoice(db, {
    partnerId: 1,
    moveType: 'out_refund',
    date: '2026-04-08',
    lines: [{ product_id: 5, qty: 1, price_unit: 200, ...combineTaxSnapshots(db, [vat14.id, levy1.id]) }],
  });
  const inRef = postedInvoice(outRef.db, {
    partnerId: 2,
    moveType: 'in_refund',
    date: '2026-04-09',
    lines: [{ product_id: 5, qty: 1, price_unit: 200, ...combineTaxSnapshots(db, [purch10.id, purch2.id]) }],
  });
  db = inRef.db;

  const rep4 = taxReport(db, period);
  const retGen4 = makeReturn(db, { template: 'generic' });
  const gen4 = taxReturnBoxes(retGen4.db, retGen4.ret);
  assert.deepEqual(gen4.totals, rep4);
  assert.equal(gen4.boxes.find((b) => b.code === 'TOTAL-OUT').base, 1300);
  assert.equal(gen4.boxes.find((b) => b.code === 'TOTAL-OUT').tax, rep4.output);
  assert.equal(gen4.boxes.find((b) => b.code === 'TOTAL-IN').base, 1300);
  assert.equal(gen4.boxes.find((b) => b.code === 'TOTAL-IN').tax, rep4.input);

  const retEg4 = makeReturn(db, { template: 'eg_vat' });
  const eg4 = taxReturnBoxes(retEg4.db, retEg4.ret);
  assert.deepEqual(eg4.totals, rep4);
  assert.equal(eg4.boxes.find((b) => b.code === 'BOX-1').base, 1300);
  assert.equal(eg4.boxes.find((b) => b.code === 'BOX-4').base, 1300);
  assert.equal(eg4.boxes.find((b) => b.code === 'BOX-4').tax, rep4.output);
  assert.equal(eg4.boxes.find((b) => b.code === 'BOX-6').base, 1300);
  assert.equal(eg4.boxes.find((b) => b.code === 'BOX-8').base, 1300);
  assert.equal(eg4.boxes.find((b) => b.code === 'BOX-8').tax, rep4.input);
});

test('Requirement 2 edge case: two taxes of different scopes on one invoice line populate each detail box once and total box once', () => {
  let db = seed();
  const goodsTax = makeTax(db, { name: 'Goods VAT 14%', amount: 14, type_tax_use: 'sale', tax_scope: 'consu', accountCode: '251000' });
  const serviceTax = makeTax(goodsTax.db, { name: 'Service Levy 5%', amount: 5, type_tax_use: 'sale', tax_scope: 'service', accountCode: '251000' });
  db = serviceTax.db;

  const inv = postedInvoice(db, {
    partnerId: 1,
    moveType: 'out_invoice',
    date: '2026-04-15',
    lines: [{ product_id: 5, qty: 1, price_unit: 1000, ...combineTaxSnapshots(db, [goodsTax.id, serviceTax.id]) }],
  });
  db = inv.db;

  const { db: retDb, ret } = makeReturn(db, { template: 'eg_vat' });
  const out = taxReturnBoxes(retDb, ret);
  assert.equal(out.boxes.find((b) => b.code === 'BOX-1').base, 1000);
  assert.equal(out.boxes.find((b) => b.code === 'BOX-1').tax, 140);
  assert.equal(out.boxes.find((b) => b.code === 'BOX-2').base, 1000);
  assert.equal(out.boxes.find((b) => b.code === 'BOX-2').tax, 50);
  assert.equal(out.boxes.find((b) => b.code === 'BOX-4').base, 1000);
  assert.equal(out.boxes.find((b) => b.code === 'BOX-4').tax, 190);
});

test('Requirement 2 edge case: partial and full payments on multi-tax cash-basis invoice line count released base once', () => {
  let db = seed();
  const cb10 = makeTax(db, { name: 'CB VAT 10%', amount: 10, type_tax_use: 'sale', tax_scope: 'consu', accountCode: '251000', cashBasis: true });
  const cb5 = makeTax(cb10.db, { name: 'CB Levy 5%', amount: 5, type_tax_use: 'sale', tax_scope: 'consu', accountCode: '251000', cashBasis: true });
  db = cb5.db;

  const inv = postedInvoice(db, {
    partnerId: 1,
    moveType: 'out_invoice',
    date: '2026-04-02',
    lines: [{ product_id: 5, qty: 1, price_unit: 1000, ...combineTaxSnapshots(db, [cb10.id, cb5.id]) }],
  });
  db = payMove(inv.db, inv.id, 575, '2026-04-10');

  const period = { from: '2026-04-01', to: '2026-04-30', company_id: 1 };
  const retHalf = makeReturn(db, { template: 'generic' });
  const halfBoxes = taxReturnBoxes(retHalf.db, retHalf.ret);
  assert.deepEqual(halfBoxes.totals, taxReport(retHalf.db, period));
  assert.equal(halfBoxes.boxes.find((b) => b.label === 'CB VAT 10%').base, 500);
  assert.equal(halfBoxes.boxes.find((b) => b.label === 'CB Levy 5%').base, 500);
  assert.equal(halfBoxes.boxes.find((b) => b.code === 'TOTAL-OUT').base, 500);
  assert.equal(halfBoxes.boxes.find((b) => b.code === 'TOTAL-OUT').tax, 75);

  db = payMove(db, inv.id, 575, '2026-04-20');
  const retFull = makeReturn(db, { template: 'eg_vat' });
  const fullBoxes = taxReturnBoxes(retFull.db, retFull.ret);
  assert.deepEqual(fullBoxes.totals, taxReport(retFull.db, period));
  assert.equal(fullBoxes.boxes.find((b) => b.code === 'BOX-1').base, 1000);
  assert.equal(fullBoxes.boxes.find((b) => b.code === 'BOX-4').base, 1000);
  assert.equal(fullBoxes.boxes.find((b) => b.code === 'BOX-4').tax, 150);
});

test('Requirement 2 invariant (a): when no line carries multiple matching taxes, total equals exact sum of detail rows in EUR and company currency', () => {
  // EUR reproduction: 8 invoices with line 1 -> FA 14% only, line 2 -> FB 5% only.
  let db = seed();
  const fa = makeTax(db, { name: 'FA 14%', amount: 14, type_tax_use: 'sale', accountCode: '251000' });
  const fb = makeTax(fa.db, { name: 'FB 5%', amount: 5, type_tax_use: 'sale', accountCode: '251000' });
  db = fb.db;
  // Fixed dates before the seed's relative data, with their own EUR rate, keep this test independent of the current date.
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  assert.ok(eur, 'seed must provide EUR');
  db = { ...db, records: { ...db.records, 'res.currency': db.records['res.currency'].map((c) => (c.id === eur.id ? { ...c, rate_ids: [{ date: '2023-01-01', rate: 0.92, company_id: null }, ...c.rate_ids] } : c)) } };

  for (let k = 0; k < 8; k += 1) {
    const inv = postedInvoice(db, {
      partnerId: 1,
      moveType: 'out_invoice',
      date: '2023-10-05',
      currencyId: eur.id,
      lines: [
        { product_id: 5, qty: 1, price_unit: 10.01 + k * 3.33, ...combineTaxSnapshots(db, [fa.id]) },
        { product_id: 5, qty: 1, price_unit: 7.77 + k * 1.11, ...combineTaxSnapshots(db, [fb.id]) },
      ],
    });
    db = inv.db;
  }

  const periodEur = { from: '2023-10-04', to: '2023-10-06', company_id: 1 };
  const eurRows = taxesByTax(db, periodEur).filter((r) => r.side === 'sale');
  assert.equal(eurRows.find((r) => r.tax_id === fa.id)?.base, 188.40);
  assert.equal(eurRows.find((r) => r.tax_id === fb.id)?.base, 101.35);

  const retEur = makeReturn(db, { from: '2023-10-04', to: '2023-10-06', template: 'generic' });
  const boxesEur = taxReturnBoxes(retEur.db, retEur.ret);
  assert.equal(boxesEur.boxes.find((b) => b.code === 'TOTAL-OUT').base, 289.75);
  assert.equal(taxBaseTotal(db, { from: '2023-10-01', to: '2023-10-31', company_id: 1 }, (item) => item.side === 'sale' && [fa.id, fb.id].includes(item.tax_id)), 289.75);

  // Company-currency single-tax lines also match the exact sum of detail rows.
  let coDb = seed();
  const cfa = makeTax(coDb, { name: 'Co FA 14%', amount: 14, type_tax_use: 'sale', accountCode: '251000' });
  const cfb = makeTax(cfa.db, { name: 'Co FB 5%', amount: 5, type_tax_use: 'sale', accountCode: '251000' });
  coDb = cfb.db;
  coDb = postedInvoice(coDb, {
    partnerId: 1,
    moveType: 'out_invoice',
    date: '2023-04-05',
    lines: [
      { product_id: 5, qty: 1, price_unit: 123.45, ...combineTaxSnapshots(coDb, [cfa.id]) },
      { product_id: 5, qty: 1, price_unit: 67.89, ...combineTaxSnapshots(coDb, [cfb.id]) },
    ],
  }).db;
  const periodCo = { from: '2023-04-01', to: '2023-04-30', company_id: 1 };
  const coRows = taxesByTax(coDb, periodCo).filter((r) => r.side === 'sale');
  const coSum = Math.round(coRows.reduce((s, r) => s + r.base, 0) * 100) / 100;
  assert.equal(coSum, 191.34);
  assert.equal(taxBaseTotal(coDb, periodCo, (item) => item.side === 'sale'), coSum);
});

test('Requirement 2 invariant (b): when all matching taxes cover the same lines, document contributes exact posted base of one tax even in EUR', () => {
  let db = seed();
  const fa = makeTax(db, { name: 'Same FA 14%', amount: 14, type_tax_use: 'sale', accountCode: '251000' });
  const fb = makeTax(fa.db, { name: 'Same FB 5%', amount: 5, type_tax_use: 'sale', accountCode: '251000' });
  db = fb.db;

  const date = addDays(today(), -30);
  const taxes = combineTaxSnapshots(db, [fa.id, fb.id]);
  const inv = postedInvoice(db, {
    partnerId: 1,
    moveType: 'out_invoice',
    date,
    currencyId: 2,
    lines: [
      { product_id: 5, qty: 1, price_unit: 33.33, ...taxes },
      { product_id: 5, qty: 1, price_unit: 66.67, ...taxes },
      { product_id: 5, qty: 3, price_unit: 0.99, ...taxes },
    ],
  });
  db = inv.db;

  const period = { from: addDays(today(), -35), to: addDays(today(), -25), company_id: 1 };
  const rows = taxesByTax(db, period).filter((r) => r.side === 'sale');
  const faBase = rows.find((r) => r.tax_id === fa.id)?.base;
  const fbBase = rows.find((r) => r.tax_id === fb.id)?.base;
  assert.equal(faBase, fbBase);
  assert.equal(taxBaseTotal(db, period, (item) => item.side === 'sale'), faBase);
});

test('Requirement 2 invariant (c): mixed EUR documents total one share per line of posted tax bases, and each tax line-share sum equals its detail-row base', () => {
  let db = seed();
  const fa = makeTax(db, { name: 'Mix FA 14%', amount: 14, type_tax_use: 'sale', accountCode: '251000' });
  const fb = makeTax(fa.db, { name: 'Mix FB 5%', amount: 5, type_tax_use: 'sale', accountCode: '251000' });
  db = fb.db;

  const date = addDays(today(), -30);
  const inv1 = postedInvoice(db, {
    partnerId: 1,
    moveType: 'out_invoice',
    date,
    currencyId: 2,
    lines: [
      { product_id: 5, qty: 1, price_unit: 33.33, ...combineTaxSnapshots(db, [fa.id, fb.id]) },
      { product_id: 5, qty: 1, price_unit: 66.67, ...combineTaxSnapshots(db, [fa.id]) },
      { product_id: 5, qty: 3, price_unit: 0.99, ...combineTaxSnapshots(db, [fb.id]) },
    ],
  });
  const inv2 = postedInvoice(inv1.db, {
    partnerId: 1,
    moveType: 'out_invoice',
    date,
    currencyId: 2,
    lines: [
      { product_id: 5, qty: 1, price_unit: 33.33, ...combineTaxSnapshots(inv1.db, [fa.id, fb.id]) },
      { product_id: 5, qty: 1, price_unit: 66.67, ...combineTaxSnapshots(inv1.db, [fa.id]) },
      { product_id: 5, qty: 3, price_unit: 0.99, ...combineTaxSnapshots(inv1.db, [fa.id, fb.id]) },
    ],
  });
  db = inv2.db;

  const ownCurrency = companyCurrencyRecord(db, 1);
  const eurCurrency = read(db, 'res.currency', 2);
  const rate = rateAt(db, 2, date, 1);
  const roundingStep = Number(ownCurrency.rounding ?? 0.01);
  const moveIds = [inv1.id, inv2.id];

  const perTaxBaseTotal = new Map([
    [fa.id, 0],
    [fb.id, 0],
  ]);
  const perTaxShareSum = new Map([
    [fa.id, 0],
    [fb.id, 0],
  ]);
  let expectedLineShareTotal = 0;

  for (const moveId of moveIds) {
    const move = read(db, 'account.move', moveId);
    const sharesByTax = new Map();

    for (const taxId of [fa.id, fb.id]) {
      const sources = (move.invoice_line_ids ?? [])
        .map((l, index) => ({ l, index }))
        .filter(({ l }) => (l.tax_ids ?? []).includes(taxId))
        .map(({ l, index }) => ({ index, amount: roundCurrency(l.qty * l.price_unit, eurCurrency) }));
      const docTaxBase = roundCurrency(sources.reduce((s, src) => s + src.amount, 0), eurCurrency);
      const independentTaxBase = roundCurrency(docTaxBase / rate, ownCurrency);
      const postedTaxBase = move.line_ids.find((l) => l.tax_id === taxId)?.tax_base;
      assert.equal(postedTaxBase, independentTaxBase);

      const shares = allocateJournalSources(independentTaxBase, sources, independentTaxBase / docTaxBase, ownCurrency);
      const shareSum = roundCurrency(shares.reduce((s, sh) => s + sh.amount, 0), ownCurrency);
      assert.equal(shareSum, independentTaxBase);

      sharesByTax.set(taxId, new Map(shares.map((sh) => [sh.index, sh.amount])));
      perTaxBaseTotal.set(taxId, roundCurrency(perTaxBaseTotal.get(taxId) + independentTaxBase, ownCurrency));
      perTaxShareSum.set(taxId, roundCurrency(perTaxShareSum.get(taxId) + shareSum, ownCurrency));
    }

    for (const [idx, line] of (move.invoice_line_ids ?? []).entries()) {
      const repTaxId = (line.tax_ids ?? []).find((id) => sharesByTax.get(id)?.has(idx));
      assert.notEqual(repTaxId, undefined);
      expectedLineShareTotal = roundCurrency(expectedLineShareTotal + sharesByTax.get(repTaxId).get(idx), ownCurrency);
    }
  }

  const period = { from: addDays(today(), -35), to: addDays(today(), -25), company_id: 1 };
  const detailRows = taxesByTax(db, period).filter((r) => r.side === 'sale');
  for (const taxId of [fa.id, fb.id]) {
    const rowBase = detailRows.find((r) => r.tax_id === taxId)?.base;
    assert.equal(rowBase, perTaxBaseTotal.get(taxId));
    assert.equal(perTaxShareSum.get(taxId), rowBase);
  }

  const total = taxBaseTotal(db, period, (item) => item.side === 'sale');
  assert.equal(total, expectedLineShareTotal);
  assert.equal(total, 223.85);

  const sumPostedRevenue = (moveId) => {
    const move = read(db, 'account.move', moveId);
    return roundCurrency(
      move.line_ids
        .flatMap((l) => l.invoice_sources ?? [])
        .reduce((s, src) => s + (Number(src.amount) || 0), 0),
      ownCurrency,
    );
  };
  const postedRevenue = roundCurrency(moveIds.reduce((s, id) => s + sumPostedRevenue(id), 0), ownCurrency);
  assert.equal(postedRevenue, 223.84);

  // Tax bases are rounded per tax group at posting whereas revenue is rounded once per document,
  // so summing one share per line of posted tax bases can differ by up to 1 rounding unit per mixed document.
  assert.ok(roundCurrency(Math.abs(total - postedRevenue), ownCurrency) <= roundCurrency(moveIds.length * roundingStep, ownCurrency));
});

test('Requirement 2 invariant (d): include_base_amount keeps per-tax bases 1000 and 1100 while total counts untaxed base 1000', () => {
  let db = seed();
  const eco10 = makeTax(db, { name: 'Eco 10%', amount: 10, type_tax_use: 'sale', accountCode: '251000', include_base_amount: true, sequence: 1 });
  const vat5 = makeTax(eco10.db, { name: 'VAT 5% After Eco', amount: 5, type_tax_use: 'sale', accountCode: '251000', sequence: 2 });
  db = vat5.db;

  const inv = postedInvoice(db, {
    partnerId: 1,
    moveType: 'out_invoice',
    date: '2026-04-10',
    lines: [{ product_id: 5, qty: 1, price_unit: 1000, ...combineTaxSnapshots(db, [eco10.id, vat5.id]) }],
  });
  db = inv.db;

  const period = { from: '2026-04-01', to: '2026-04-30', company_id: 1 };
  const rows = taxesByTax(db, period).filter((r) => r.side === 'sale');
  assert.equal(rows.find((r) => r.tax_id === eco10.id)?.base, 1000);
  assert.equal(rows.find((r) => r.tax_id === eco10.id)?.tax, 100);
  assert.equal(rows.find((r) => r.tax_id === vat5.id)?.base, 1100);
  assert.equal(rows.find((r) => r.tax_id === vat5.id)?.tax, 55);

  const ret = makeReturn(db, { from: '2026-04-01', to: '2026-04-30', template: 'generic' });
  const boxes = taxReturnBoxes(ret.db, ret.ret);
  assert.equal(boxes.boxes.find((b) => b.code === 'TOTAL-OUT').base, 1000);
  assert.equal(boxes.boxes.find((b) => b.code === 'TOTAL-OUT').tax, 155);
});

test('Requirement 2 invariant (e): price-included tax, line discount, and POS orders deduplicate multi-tax lines cleanly', () => {
  let db = seed();
  const incl14 = makeTax(db, { name: 'Incl 14%', amount: 14, type_tax_use: 'sale', accountCode: '251000', price_include: true });
  const incl5 = makeTax(incl14.db, { name: 'Incl 5%', amount: 5, type_tax_use: 'sale', accountCode: '251000', price_include: true });
  const disc14 = makeTax(incl5.db, { name: 'Disc 14%', amount: 14, type_tax_use: 'sale', accountCode: '251000' });
  const disc5 = makeTax(disc14.db, { name: 'Disc 5%', amount: 5, type_tax_use: 'sale', accountCode: '251000' });
  db = disc5.db;

  const inv = postedInvoice(db, {
    partnerId: 1,
    moveType: 'out_invoice',
    date: '2026-04-12',
    lines: [
      { product_id: 5, qty: 1, price_unit: 1190, ...combineTaxSnapshots(db, [incl14.id, incl5.id]) },
      { product_id: 5, qty: 1, price_unit: 1000, discount: 10, ...combineTaxSnapshots(db, [disc14.id, disc5.id]) },
    ],
  });
  db = inv.db;

  const periodInv = { from: '2026-04-01', to: '2026-04-30', company_id: 1 };
  assert.equal(taxBaseTotal(db, periodInv, (item) => item.side === 'sale'), 1900);

  // POS sale + mixed POS sale + POS refund
  let posDb = startSession(seed(), 0).db;
  const pos14 = makeTax(posDb, { name: 'POS 14%', amount: 14, type_tax_use: 'sale', accountCode: '251000' });
  const pos5 = makeTax(pos14.db, { name: 'POS 5%', amount: 5, type_tax_use: 'sale', accountCode: '251000' });
  posDb = pos5.db;
  const baseline = taxBaseTotal(posDb, {}, (item) => item.side === 'sale');

  const sale = payOrder(posDb, {
    lines: [
      { product_id: 1, qty: 1, price_unit: 1000, ...combineTaxSnapshots(posDb, [pos14.id, pos5.id]) },
      { product_id: 1, qty: 1, price_unit: 500, ...combineTaxSnapshots(posDb, [pos14.id]) },
    ],
    method: 'cash',
  });
  posDb = sale.db;
  assert.equal(taxBaseTotal(posDb, {}, (item) => item.side === 'sale' && [pos14.id, pos5.id].includes(item.tax_id)), 1500);
  assert.equal(taxBaseTotal(posDb, {}, (item) => item.side === 'sale'), baseline + 1500);

  const ref = refundOrder(posDb, read(posDb, 'pos.order', sale.id));
  posDb = ref.db;
  assert.equal(taxBaseTotal(posDb, {}, (item) => item.side === 'sale' && [pos14.id, pos5.id].includes(item.tax_id)), 0);
  assert.equal(taxBaseTotal(posDb, {}, (item) => item.side === 'sale'), baseline);
});

test('Requirement 2 edge case: mixed-sign lines (+1000 and -100) carrying the same two taxes deduplicate to 900', () => {
  let db = seed();
  const vat14 = makeTax(db, { name: 'MixSign VAT 14%', amount: 14, type_tax_use: 'sale', tax_scope: 'consu', accountCode: '251000' });
  const levy1 = makeTax(vat14.db, { name: 'MixSign Levy 1%', amount: 1, type_tax_use: 'sale', tax_scope: 'consu', accountCode: '251000' });
  db = levy1.db;

  const taxes = combineTaxSnapshots(db, [vat14.id, levy1.id]);
  const inv = postedInvoice(db, {
    partnerId: 1,
    moveType: 'out_invoice',
    date: '2026-04-18',
    lines: [
      { product_id: 5, qty: 1, price_unit: 1000, ...taxes },
      { product_id: 5, qty: 1, price_unit: -100, ...taxes },
    ],
  });
  db = inv.db;

  const period = { from: '2026-04-01', to: '2026-04-30', company_id: 1 };
  const rows = taxesByTax(db, period).filter((r) => r.side === 'sale');
  assert.equal(rows.find((r) => r.tax_id === vat14.id)?.base, 900);
  assert.equal(rows.find((r) => r.tax_id === levy1.id)?.base, 900);
  assert.equal(taxBaseTotal(db, period, (item) => item.side === 'sale'), 900);

  const ret = makeReturn(db, { from: '2026-04-01', to: '2026-04-30', template: 'generic' });
  const boxes = taxReturnBoxes(ret.db, ret.ret);
  assert.equal(boxes.boxes.find((b) => b.code === 'TOTAL-OUT').base, 900);
  assert.equal(boxes.boxes.find((b) => b.code === 'TOTAL-OUT').tax, 135);
});
