import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { round } from './money.js';
import { postMove } from './models/accounting.js';
import { ensureCurrencyRecord } from './models/company.js';
import { today } from './models/common.js';
import { journalItems, postEntry } from './models/ledger.js';
import { postPayment } from './models/pay.js';
import { taxSnapshot } from './models/taxes.js';
import { ensureReturnTypes, payReturn, reviewReturn, submitReturn } from './models/taxreturn.js';

function setupTaxUnitEnv({ memberCountry = 'Egypt', mainCountry = 'Egypt', memberCurrencyCode = null } = {}) {
  let db = seed();
  db = write(db, 'res.company', 1, { country: mainCountry });
  const mainCompany = read(db, 'res.company', 1);
  let currencyId = mainCompany.currency_id;
  if (memberCurrencyCode) {
    const curr = ensureCurrencyRecord(db, memberCurrencyCode);
    db = curr.db;
    currencyId = curr.id;
  }
  const member = createCompanyWithDefaultInvoiceJournals(db, {
    name: 'Member Co',
    country: memberCountry,
    currency_id: currencyId,
  });
  db = ensureReturnTypes(member.db);
  const mainType = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');
  const memberType = search(db, 'account.return.type').find((t) => t.company_id === member.id && t.name === 'VAT Return');
  const memberPayable = create(db, 'account.account', { code: '251000', name: 'Member Tax Payable', account_type: 'liability_current', company_id: member.id });
  db = memberPayable.db;
  const memberReceivable = create(db, 'account.account', { code: '131000', name: 'Member Tax Receivable', account_type: 'asset_current', company_id: member.id });
  db = memberReceivable.db;
  db = write(db, 'account.return.type', memberType.id, {
    tax_payable_account_id: memberPayable.id,
    tax_receivable_account_id: memberReceivable.id,
    payment_partner_id: mainType.payment_partner_id,
  });
  return { db, mainCompanyId: 1, memberId: member.id, mainType, memberType: read(db, 'account.return.type', memberType.id) };
}

function accountBalanceInCompany(db, companyId, accountId, partnerId = null) {
  const items = journalItems(db, { company_id: companyId }).filter(
    (l) => l.account_id === accountId && (partnerId == null || l.partner_id === partnerId),
  );
  return round(items.reduce((sum, l) => sum + (Number(l.debit) || 0) - (Number(l.credit) || 0), 0));
}

function assertAllMovesBalanced(db, companyIds) {
  for (const companyId of companyIds) {
    const moves = (db.records['account.move'] ?? []).filter((m) => (m.company_id ?? 1) === companyId && m.state === 'posted');
    assert.ok(moves.length > 0);
    for (const move of moves) {
      const debit = round((move.line_ids ?? []).reduce((s, l) => s + (Number(l.debit) || 0), 0));
      const credit = round((move.line_ids ?? []).reduce((s, l) => s + (Number(l.credit) || 0), 0));
      assert.equal(debit, credit, `Move ${move.name} in company ${companyId} must be balanced`);
    }
  }
}

test('tax unit guard rejects a member with a different country or currency through applyDiff', () => {
  // 1. Different country (unit/main Egypt vs member UAE)
  {
    const { db, memberId } = setupTaxUnitEnv({ mainCountry: 'Egypt', memberCountry: 'UAE' });
    const draft = {
      ...db,
      seq: { ...db.seq, 'account.tax.unit': (db.seq['account.tax.unit'] ?? 0) + 1 },
      records: {
        ...db.records,
        'account.tax.unit': [
          ...(db.records['account.tax.unit'] ?? []),
          {
            id: (db.seq['account.tax.unit'] ?? 0) + 1,
            name: 'Cross-border Unit',
            country: 'Egypt',
            company_ids: [1, memberId],
            main_company_id: 1,
            member_return_type_ids: [],
          },
        ],
      },
    };
    assert.throws(
      () => applyDiff(db, diffDb(db, draft), { isAdmin: true }),
      /country/i,
    );
  }

  // 2. Unit country differs from company countries (main & member Egypt vs unit Saudi Arabia)
  {
    const { db, memberId } = setupTaxUnitEnv({ mainCountry: 'Egypt', memberCountry: 'Egypt' });
    const nextId = (db.seq['account.tax.unit'] ?? 0) + 1;
    const draft = {
      ...db,
      seq: { ...db.seq, 'account.tax.unit': nextId },
      records: {
        ...db.records,
        'account.tax.unit': [
          ...(db.records['account.tax.unit'] ?? []),
          {
            id: nextId,
            name: 'Mismatched Unit Country',
            country: 'Saudi Arabia',
            company_ids: [1, memberId],
            main_company_id: 1,
            member_return_type_ids: [],
          },
        ],
      },
    };
    assert.throws(
      () => applyDiff(db, diffDb(db, draft), { isAdmin: true }),
      /country/i,
    );
  }

  // 3. Different currency (main USD vs member EUR)
  {
    const { db, memberId } = setupTaxUnitEnv({ mainCountry: 'Egypt', memberCountry: 'Egypt', memberCurrencyCode: 'EUR' });
    const nextId = (db.seq['account.tax.unit'] ?? 0) + 1;
    const draft = {
      ...db,
      seq: { ...db.seq, 'account.tax.unit': nextId },
      records: {
        ...db.records,
        'account.tax.unit': [
          ...(db.records['account.tax.unit'] ?? []),
          {
            id: nextId,
            name: 'Multi-currency Unit',
            country: 'Egypt',
            company_ids: [1, memberId],
            main_company_id: 1,
            member_return_type_ids: [],
          },
        ],
      },
    };
    assert.throws(
      () => applyDiff(db, diffDb(db, draft), { isAdmin: true }),
      /currency/i,
    );
  }

  // 4. Matching country and currency succeeds through applyDiff
  {
    const { db, memberId } = setupTaxUnitEnv({ mainCountry: 'Egypt', memberCountry: 'Egypt' });
    const created = create(db, 'account.tax.unit', {
      name: 'Egypt Unit',
      country: 'Egypt',
      company_ids: [1, memberId],
      main_company_id: 1,
    });
    const synced = applyDiff(db, diffDb(db, created.db), { isAdmin: true });
    assert.equal(read(synced, 'account.tax.unit', created.id).name, 'Egypt Unit');
  }
});

test('tax unit payReturn creates one payment in main company for net, clears member balances via inter-company entries, and passes applyDiff', () => {
  let { db, mainCompanyId, memberId, mainType, memberType } = setupTaxUnitEnv();

  // Configure explicit inter-company accounts on partner records to confirm they are respected
  const mainIcRec = create(db, 'account.account', { code: '121900', name: 'IC Receivable Main', account_type: 'asset_receivable', company_id: mainCompanyId, reconcile: true });
  db = mainIcRec.db;
  const memberIcPay = create(db, 'account.account', { code: '211900', name: 'IC Payable Member', account_type: 'liability_payable', company_id: memberId, reconcile: true });
  db = memberIcPay.db;
  const mainCo = read(db, 'res.company', mainCompanyId);
  const memberCo = read(db, 'res.company', memberId);
  db = write(db, 'res.partner', memberCo.partner_id, { property_account_receivable_id: mainIcRec.id });
  db = write(db, 'res.partner', mainCo.partner_id, { property_account_payable_id: memberIcPay.id });

  const unit = create(db, 'account.tax.unit', {
    name: 'Egypt Tax Unit',
    country: 'Egypt',
    company_ids: [mainCompanyId, memberId],
    main_company_id: mainCompanyId,
    member_return_type_ids: [{ company_id: memberId, type_id: memberType.id }],
  });
  db = unit.db;

  const saleTaxMain = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === mainCompanyId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const saleTaxMember = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === memberId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');

  const invMain = create(db, 'account.move', {
    company_id: mainCompanyId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ name: 'Main sale', qty: 1, price_unit: 100, ...taxSnapshot(saleTaxMain) }],
  });
  db = postMove(invMain.db, invMain.id);

  const invMember = create(db, 'account.move', {
    company_id: memberId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-12',
    invoice_line_ids: [{ name: 'Member sale', qty: 1, price_unit: 200, ...taxSnapshot(saleTaxMember) }],
  });
  db = postMove(invMember.db, invMember.id);

  const ret = create(db, 'account.return', {
    name: 'VAT Unit Jan 2026',
    type_id: mainType.id,
    company_id: mainCompanyId,
    tax_unit_id: unit.id,
    date_from: '2026-01-01',
    date_to: '2026-01-31',
  });
  db = reviewReturn(ret.db, ret.id);
  db = submitReturn(db, ret.id);
  assert.equal(read(db, 'account.return', ret.id).total_amount_to_pay, 42);

  const paymentsBefore = (db.records['account.payment'] ?? []).length;
  const paidDb = payReturn(db, ret.id);

  // Sync the payment and inter-company entries through applyDiff
  const synced = applyDiff(db, diffDb(db, paidDb), { isAdmin: true });
  const paidRet = read(synced, 'account.return', ret.id);
  assert.equal(paidRet.state, 'paid');
  assert.equal(paidRet.is_completed, true);

  // Exactly one payment created in total, in the main company, for the net (14 + 28 = 42)
  const createdPayments = (synced.records['account.payment'] ?? []).slice(paymentsBefore);
  assert.equal(createdPayments.length, 1);
  assert.equal(createdPayments[0].company_id, mainCompanyId);
  assert.equal(createdPayments[0].payment_type, 'outbound');
  assert.equal(createdPayments[0].amount, 42);
  assert.equal(createdPayments[0].destination_account_id, mainType.tax_payable_account_id);
  assert.equal(createdPayments[0].is_tax_payment, true);
  assert.equal(createdPayments[0].return_id, ret.id);
  assert.equal(paidRet.payment_id, createdPayments[0].id);
  assert.deepEqual(paidRet.payment_ids, [createdPayments[0].id]);
  assert.equal(createdPayments.filter((p) => p.company_id === memberId).length, 0);

  // Both companies' tax payable and receivable balances for the return are cleared to 0
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_payable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_receivable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_payable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_receivable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_payable_account_id, memberType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_receivable_account_id, memberType.payment_partner_id), 0);

  // Inter-company balances match: Main has +28 receivable from Member; Member has -28 (credit 28) payable to Main
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainIcRec.id, memberCo.partner_id), 28);
  assert.equal(accountBalanceInCompany(synced, memberId, memberIcPay.id, mainCo.partner_id), -28);

  // Member has one balanced inter-company settlement entry booked in Member's own company
  const memberSettlements = (synced.records['account.move'] ?? []).filter(
    (m) => (m.company_id ?? 1) === memberId && m.state === 'posted' && m.is_tax_payment && m.tax_return_id === ret.id,
  );
  assert.equal(memberSettlements.length, 1);

  // Every posted entry in every company is balanced
  assertAllMovesBalanced(synced, [mainCompanyId, memberId]);

  // Forged diff missing the member inter-company settlement entry is rejected by applyDiff
  const withoutMemberSettlement = {
    ...paidDb,
    records: {
      ...paidDb.records,
      'account.move': paidDb.records['account.move'].filter(
        (m) => !((m.company_id ?? 1) === memberId && m.is_tax_payment && m.tax_return_id === ret.id),
      ),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, withoutMemberSettlement), { isAdmin: true }),
    /payment/i,
  );
});

test('tax unit payReturn handles net refund (main payable + member refund) and clears balances', () => {
  let { db, mainCompanyId, memberId, mainType, memberType } = setupTaxUnitEnv();
  const unit = create(db, 'account.tax.unit', {
    name: 'Refund Unit',
    country: 'Egypt',
    company_ids: [mainCompanyId, memberId],
    main_company_id: mainCompanyId,
    member_return_type_ids: [{ company_id: memberId, type_id: memberType.id }],
  });
  db = unit.db;

  const saleTaxMain = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === mainCompanyId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const purchTaxMember = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === memberId) && t.name === 'VAT 14%' && t.type_tax_use === 'purchase');

  // Main payable: +14; Member input tax refund: -42 -> Net: -28 (inbound refund to main)
  const invMain = create(db, 'account.move', {
    company_id: mainCompanyId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-02-10',
    invoice_line_ids: [{ name: 'Main sale', qty: 1, price_unit: 100, ...taxSnapshot(saleTaxMain) }],
  });
  db = postMove(invMain.db, invMain.id);

  const billMember = create(db, 'account.move', {
    company_id: memberId,
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-02-12',
    invoice_line_ids: [{ name: 'Member purchase', qty: 1, price_unit: 300, ...taxSnapshot(purchTaxMember) }],
  });
  db = postMove(billMember.db, billMember.id);

  const ret = create(db, 'account.return', {
    name: 'VAT Unit Feb 2026',
    type_id: mainType.id,
    company_id: mainCompanyId,
    tax_unit_id: unit.id,
    date_from: '2026-02-01',
    date_to: '2026-02-28',
  });
  db = reviewReturn(ret.db, ret.id);
  db = submitReturn(db, ret.id);
  assert.equal(read(db, 'account.return', ret.id).total_amount_to_pay, -28);

  const paymentsBefore = (db.records['account.payment'] ?? []).length;
  const paidDb = payReturn(db, ret.id);
  const synced = applyDiff(db, diffDb(db, paidDb), { isAdmin: true });

  const createdPayments = (synced.records['account.payment'] ?? []).slice(paymentsBefore);
  assert.equal(createdPayments.length, 1);
  assert.equal(createdPayments[0].company_id, mainCompanyId);
  assert.equal(createdPayments[0].payment_type, 'inbound');
  assert.equal(createdPayments[0].amount, 28);
  assert.equal(createdPayments[0].destination_account_id, mainType.tax_receivable_account_id);
  assert.equal(createdPayments[0].is_tax_payment, true);
  assert.equal(createdPayments[0].return_id, ret.id);

  // Tax balances cleared in both companies
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_payable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_receivable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_payable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_receivable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_payable_account_id, memberType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_receivable_account_id, memberType.payment_partner_id), 0);

  // Inter-company balances match: Main owes Member (-42), Member has receivable from Main (+42)
  const mainCo = read(synced, 'res.company', mainCompanyId);
  const memberCo = read(synced, 'res.company', memberId);
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainCo.account_default_payable_id, memberCo.partner_id), -42);
  assert.equal(accountBalanceInCompany(synced, memberId, memberCo.account_default_receivable_id, mainCo.partner_id), 42);
  assertAllMovesBalanced(synced, [mainCompanyId, memberId]);
});

test('tax unit payReturn throws a clear error when inter-company account or contact is missing', () => {
  let { db, mainCompanyId, memberId, mainType, memberType } = setupTaxUnitEnv();
  const unit = create(db, 'account.tax.unit', {
    name: 'Unconfigured IC Unit',
    country: 'Egypt',
    company_ids: [mainCompanyId, memberId],
    main_company_id: mainCompanyId,
    member_return_type_ids: [{ company_id: memberId, type_id: memberType.id }],
  });
  db = unit.db;

  const saleTaxMember = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === memberId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const invMember = create(db, 'account.move', {
    company_id: memberId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-03-10',
    invoice_line_ids: [{ name: 'Member sale', qty: 1, price_unit: 100, ...taxSnapshot(saleTaxMember) }],
  });
  db = postMove(invMember.db, invMember.id);

  const ret = create(db, 'account.return', {
    name: 'VAT Unit Mar 2026',
    type_id: mainType.id,
    company_id: mainCompanyId,
    tax_unit_id: unit.id,
    date_from: '2026-03-01',
    date_to: '2026-03-31',
  });
  db = reviewReturn(ret.db, ret.id);
  db = submitReturn(db, ret.id);

  const noMemberPayable = write(db, 'res.company', memberId, { account_default_payable_id: null });
  assert.throws(
    () => payReturn(noMemberPayable, ret.id),
    /default payable account/i,
  );

  const noMainReceivable = write(db, 'res.company', mainCompanyId, { account_default_receivable_id: null });
  assert.throws(
    () => payReturn(noMainReceivable, ret.id),
    /default receivable account/i,
  );

  const noMemberPartner = write(db, 'res.company', memberId, { partner_id: null });
  assert.throws(
    () => payReturn(noMemberPartner, ret.id),
    /company contact/i,
  );
});

test('tax unit payReturn handles net zero (main payable equals member refund) without payments', () => {
  let { db, mainCompanyId, memberId, mainType, memberType } = setupTaxUnitEnv();
  const unit = create(db, 'account.tax.unit', {
    name: 'Zero Net Unit',
    country: 'Egypt',
    company_ids: [mainCompanyId, memberId],
    main_company_id: mainCompanyId,
    member_return_type_ids: [{ company_id: memberId, type_id: memberType.id }],
  });
  db = unit.db;

  const saleTaxMain = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === mainCompanyId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const purchTaxMember = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === memberId) && t.name === 'VAT 14%' && t.type_tax_use === 'purchase');

  // Main payable: +14; Member refund: -14 -> Net: 0
  const invMain = create(db, 'account.move', {
    company_id: mainCompanyId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-04-10',
    invoice_line_ids: [{ name: 'Main sale', qty: 1, price_unit: 100, ...taxSnapshot(saleTaxMain) }],
  });
  db = postMove(invMain.db, invMain.id);

  const billMember = create(db, 'account.move', {
    company_id: memberId,
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-04-12',
    invoice_line_ids: [{ name: 'Member purchase', qty: 1, price_unit: 100, ...taxSnapshot(purchTaxMember) }],
  });
  db = postMove(billMember.db, billMember.id);

  const ret = create(db, 'account.return', {
    name: 'VAT Unit Apr 2026',
    type_id: mainType.id,
    company_id: mainCompanyId,
    tax_unit_id: unit.id,
    date_from: '2026-04-01',
    date_to: '2026-04-30',
  });
  db = reviewReturn(ret.db, ret.id);
  db = submitReturn(db, ret.id);
  assert.equal(read(db, 'account.return', ret.id).total_amount_to_pay, 0);

  const paymentsBefore = (db.records['account.payment'] ?? []).length;
  const paidDb = payReturn(db, ret.id);
  const synced = applyDiff(db, diffDb(db, paidDb), { isAdmin: true });

  const createdPayments = (synced.records['account.payment'] ?? []).slice(paymentsBefore);
  assert.equal(createdPayments.length, 0);

  const paidRet = read(synced, 'account.return', ret.id);
  assert.equal(paidRet.state, 'paid');
  assert.equal(paidRet.is_completed, true);
  assert.equal(paidRet.payment_id ?? null, null);
  assert.deepEqual(paidRet.payment_ids, []);

  // Balances cleared
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_payable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_receivable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_payable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_receivable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_payable_account_id, memberType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_receivable_account_id, memberType.payment_partner_id), 0);

  // Inter-company balances match
  const mainCo = read(synced, 'res.company', mainCompanyId);
  const memberCo = read(synced, 'res.company', memberId);
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainCo.account_default_payable_id, memberCo.partner_id), -14);
  assert.equal(accountBalanceInCompany(synced, memberId, memberCo.account_default_receivable_id, mainCo.partner_id), 14);
  assertAllMovesBalanced(synced, [mainCompanyId, memberId]);
});

test('multi-member tax unit settlement creates exactly one payment for net and one balanced IC entry per member', () => {
  let { db, mainCompanyId, memberId: member1Id, mainType, memberType: member1Type } = setupTaxUnitEnv();

  // Create second member
  const member2 = createCompanyWithDefaultInvoiceJournals(db, {
    name: 'Member Co 2',
    country: 'Egypt',
    currency_id: read(db, 'res.company', mainCompanyId).currency_id,
  });
  db = ensureReturnTypes(member2.db);
  const member2Type = search(db, 'account.return.type').find((t) => t.company_id === member2.id && t.name === 'VAT Return');
  const member2Payable = create(db, 'account.account', { code: '251002', name: 'Member2 Tax Payable', account_type: 'liability_current', company_id: member2.id });
  db = member2Payable.db;
  const member2Receivable = create(db, 'account.account', { code: '131002', name: 'Member2 Tax Receivable', account_type: 'asset_current', company_id: member2.id });
  db = member2Receivable.db;
  db = write(db, 'account.return.type', member2Type.id, {
    tax_payable_account_id: member2Payable.id,
    tax_receivable_account_id: member2Receivable.id,
    payment_partner_id: mainType.payment_partner_id,
  });

  const unit = create(db, 'account.tax.unit', {
    name: 'Trio Tax Unit',
    country: 'Egypt',
    company_ids: [mainCompanyId, member1Id, member2.id],
    main_company_id: mainCompanyId,
    member_return_type_ids: [
      { company_id: member1Id, type_id: member1Type.id },
      { company_id: member2.id, type_id: member2Type.id },
    ],
  });
  db = unit.db;

  const saleTaxMain = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === mainCompanyId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const saleTaxMember1 = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === member1Id) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const purchTaxMember2 = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === member2.id) && t.name === 'VAT 14%' && t.type_tax_use === 'purchase');

  // Main payable: +14, Member 1 payable: +28, Member 2 refund: -14 -> Net: +28
  const invMain = create(db, 'account.move', {
    company_id: mainCompanyId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-05-10',
    invoice_line_ids: [{ name: 'Main sale', qty: 1, price_unit: 100, ...taxSnapshot(saleTaxMain) }],
  });
  db = postMove(invMain.db, invMain.id);

  const invMember1 = create(db, 'account.move', {
    company_id: member1Id,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-05-12',
    invoice_line_ids: [{ name: 'Member1 sale', qty: 1, price_unit: 200, ...taxSnapshot(saleTaxMember1) }],
  });
  db = postMove(invMember1.db, invMember1.id);

  const billMember2 = create(db, 'account.move', {
    company_id: member2.id,
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-05-14',
    invoice_line_ids: [{ name: 'Member2 purchase', qty: 1, price_unit: 100, ...taxSnapshot(purchTaxMember2) }],
  });
  db = postMove(billMember2.db, billMember2.id);

  const ret = create(db, 'account.return', {
    name: 'VAT Unit May 2026',
    type_id: mainType.id,
    company_id: mainCompanyId,
    tax_unit_id: unit.id,
    date_from: '2026-05-01',
    date_to: '2026-05-31',
  });
  db = reviewReturn(ret.db, ret.id);
  db = submitReturn(db, ret.id);
  assert.equal(read(db, 'account.return', ret.id).total_amount_to_pay, 28);

  const paymentsBefore = (db.records['account.payment'] ?? []).length;
  const paidDb = payReturn(db, ret.id);
  const synced = applyDiff(db, diffDb(db, paidDb), { isAdmin: true });

  // Exactly one payment in main company for net (28)
  const createdPayments = (synced.records['account.payment'] ?? []).slice(paymentsBefore);
  assert.equal(createdPayments.length, 1);
  assert.equal(createdPayments[0].company_id, mainCompanyId);
  assert.equal(createdPayments[0].amount, 28);
  assert.equal(createdPayments[0].payment_type, 'outbound');
  assert.equal(createdPayments[0].destination_account_id, mainType.tax_payable_account_id);
  assert.equal(createdPayments[0].is_tax_payment, true);
  assert.equal(createdPayments[0].return_id, ret.id);

  // All 3 companies' tax accounts are cleared
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_payable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_receivable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, member1Id, member1Type.tax_payable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, member1Id, member1Type.tax_receivable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, member1Id, member1Type.tax_payable_account_id, member1Type.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, member1Id, member1Type.tax_receivable_account_id, member1Type.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, member2.id, member2Type.tax_payable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, member2.id, member2Type.tax_receivable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, member2.id, member2Type.tax_payable_account_id, member2Type.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, member2.id, member2Type.tax_receivable_account_id, member2Type.payment_partner_id), 0);

  // Each member company has exactly one settlement entry booked in its own company
  const m1Settlement = (synced.records['account.move'] ?? []).filter(
    (m) => (m.company_id ?? 1) === member1Id && m.state === 'posted' && m.is_tax_payment && m.tax_return_id === ret.id,
  );
  assert.equal(m1Settlement.length, 1);

  const m2Settlement = (synced.records['account.move'] ?? []).filter(
    (m) => (m.company_id ?? 1) === member2.id && m.state === 'posted' && m.is_tax_payment && m.tax_return_id === ret.id,
  );
  assert.equal(m2Settlement.length, 1);

  assertAllMovesBalanced(synced, [mainCompanyId, member1Id, member2.id]);
});

test('tax unit payReturn handles mixed signs (main company refund, member larger payable) with all tax balances zeroed and balanced entries', () => {
  let { db, mainCompanyId, memberId, mainType, memberType } = setupTaxUnitEnv();

  const mainIcRec = create(db, 'account.account', { code: '121900', name: 'IC Receivable Main', account_type: 'asset_receivable', company_id: mainCompanyId, reconcile: true });
  db = mainIcRec.db;
  const memberIcPay = create(db, 'account.account', { code: '211900', name: 'IC Payable Member', account_type: 'liability_payable', company_id: memberId, reconcile: true });
  db = memberIcPay.db;
  const mainCo = read(db, 'res.company', mainCompanyId);
  const memberCo = read(db, 'res.company', memberId);
  db = write(db, 'res.partner', memberCo.partner_id, { property_account_receivable_id: mainIcRec.id });
  db = write(db, 'res.partner', mainCo.partner_id, { property_account_payable_id: memberIcPay.id });

  const unit = create(db, 'account.tax.unit', {
    name: 'Mixed Sign Unit',
    country: 'Egypt',
    company_ids: [mainCompanyId, memberId],
    main_company_id: mainCompanyId,
    member_return_type_ids: [{ company_id: memberId, type_id: memberType.id }],
  });
  db = unit.db;

  const purchTaxMain = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === mainCompanyId) && t.name === 'VAT 14%' && t.type_tax_use === 'purchase');
  const saleTaxMember = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === memberId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');

  // Main company has a refund of 14 (purchase of 100 with 14% VAT)
  const billMain = create(db, 'account.move', {
    company_id: mainCompanyId,
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-06-10',
    invoice_line_ids: [{ name: 'Main purchase', qty: 1, price_unit: 100, ...taxSnapshot(purchTaxMain) }],
  });
  db = postMove(billMain.db, billMain.id);

  // Member company has a larger payable of 42 (sale of 300 with 14% VAT)
  const invMember = create(db, 'account.move', {
    company_id: memberId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-06-12',
    invoice_line_ids: [{ name: 'Member sale', qty: 1, price_unit: 300, ...taxSnapshot(saleTaxMember) }],
  });
  db = postMove(invMember.db, invMember.id);

  // Net obligation for the unit is -14 + 42 = +28 (payable)
  const ret = create(db, 'account.return', {
    name: 'VAT Unit Jun 2026',
    type_id: mainType.id,
    company_id: mainCompanyId,
    tax_unit_id: unit.id,
    date_from: '2026-06-01',
    date_to: '2026-06-30',
  });
  db = reviewReturn(ret.db, ret.id);
  db = submitReturn(db, ret.id);
  assert.equal(read(db, 'account.return', ret.id).total_amount_to_pay, 28);

  const paymentsBefore = (db.records['account.payment'] ?? []).length;
  const paidDb = payReturn(db, ret.id);

  // Sync through applyDiff on plain diff
  const synced = applyDiff(db, diffDb(db, paidDb), { isAdmin: true });
  const paidRet = read(synced, 'account.return', ret.id);
  assert.equal(paidRet.state, 'paid');
  assert.equal(paidRet.is_completed, true);

  // Exactly one payment created in total, in the main company, for the net (28)
  const createdPayments = (synced.records['account.payment'] ?? []).slice(paymentsBefore);
  assert.equal(createdPayments.length, 1);
  assert.equal(createdPayments[0].company_id, mainCompanyId);
  assert.equal(createdPayments[0].payment_type, 'outbound');
  assert.equal(createdPayments[0].amount, 28);
  assert.equal(createdPayments[0].destination_account_id, mainType.tax_payable_account_id);
  assert.equal(createdPayments[0].is_tax_payment, true);
  assert.equal(createdPayments[0].return_id, ret.id);
  assert.equal(paidRet.payment_id, createdPayments[0].id);
  assert.deepEqual(paidRet.payment_ids, [createdPayments[0].id]);

  // Main company's tax payable and tax receivable accounts are both zero for the return
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_payable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_receivable_account_id, mainType.payment_partner_id), 0);

  // Member's tax payable and tax receivable accounts are both zero
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_payable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_receivable_account_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_payable_account_id, memberType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_receivable_account_id, memberType.payment_partner_id), 0);

  // Inter-company balances: Main has +42 receivable from Member; Member has -42 (credit 42) payable to Main
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainIcRec.id, memberCo.partner_id), 42);
  assert.equal(accountBalanceInCompany(synced, memberId, memberIcPay.id, mainCo.partner_id), -42);

  // Every entry is balanced
  assertAllMovesBalanced(synced, [mainCompanyId, memberId]);
});

test('tax unit payReturn pays via main tax authority partner while members keep their own partner on member settlement lines', () => {
  let { db, mainCompanyId, memberId, mainType, memberType } = setupTaxUnitEnv();
  const differentPartner = create(db, 'res.partner', { name: 'Other Tax Authority' });
  db = differentPartner.db;
  db = write(db, 'account.return.type', memberType.id, {
    payment_partner_id: differentPartner.id,
  });

  const unit = create(db, 'account.tax.unit', {
    name: 'Different Partner Unit',
    country: 'Egypt',
    company_ids: [mainCompanyId, memberId],
    main_company_id: mainCompanyId,
    member_return_type_ids: [{ company_id: memberId, type_id: memberType.id }],
  });
  db = unit.db;

  const saleTaxMain = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === mainCompanyId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const saleTaxMember = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === memberId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');

  const invMain = create(db, 'account.move', {
    company_id: mainCompanyId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-07-08',
    invoice_line_ids: [{ name: 'Main sale', qty: 1, price_unit: 100, ...taxSnapshot(saleTaxMain) }],
  });
  db = postMove(invMain.db, invMain.id);

  const invMember = create(db, 'account.move', {
    company_id: memberId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-07-10',
    invoice_line_ids: [{ name: 'Member sale', qty: 1, price_unit: 200, ...taxSnapshot(saleTaxMember) }],
  });
  db = postMove(invMember.db, invMember.id);

  const ret = create(db, 'account.return', {
    name: 'VAT Unit Jul 2026',
    type_id: mainType.id,
    company_id: mainCompanyId,
    tax_unit_id: unit.id,
    date_from: '2026-07-01',
    date_to: '2026-07-31',
  });
  db = reviewReturn(ret.db, ret.id);
  db = submitReturn(db, ret.id);

  const paidDb = payReturn(db, ret.id);
  const synced = applyDiff(db, diffDb(db, paidDb), { isAdmin: true });
  const paidRet = read(synced, 'account.return', ret.id);
  assert.equal(paidRet.state, 'paid');
  assert.equal(paidRet.payment_ids.length, 1);

  const payment = read(synced, 'account.payment', paidRet.payment_ids[0]);
  assert.equal(payment.company_id, mainCompanyId);
  assert.equal(payment.partner_id, mainType.payment_partner_id);
  assert.equal(payment.amount, 42);

  // Member settlement entry clears member payable on member's own tax authority partner
  const memberSettlement = (synced.records['account.move'] ?? []).find(
    (m) => (m.company_id ?? 1) === memberId && m.state === 'posted' && m.is_tax_payment && m.tax_return_id === ret.id,
  );
  assert.ok(memberSettlement);
  assert.ok(memberSettlement.line_ids.some(
    (l) => l.account_id === memberType.tax_payable_account_id && l.partner_id === differentPartner.id && l.debit === 28,
  ));
  assert.equal(accountBalanceInCompany(synced, mainCompanyId, mainType.tax_payable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(synced, memberId, memberType.tax_payable_account_id, differentPartner.id), 0);
  assertAllMovesBalanced(synced, [mainCompanyId, memberId]);
});

test('tax unit paid return replays through diffDb + applyDiff and rejects ordinary payments forged as unit tax payments', () => {
  let { db, mainCompanyId, memberId, mainType, memberType } = setupTaxUnitEnv();

  const mainIcRec = create(db, 'account.account', { code: '121900', name: 'IC Receivable Main', account_type: 'asset_receivable', company_id: mainCompanyId, reconcile: true });
  db = mainIcRec.db;
  const memberIcPay = create(db, 'account.account', { code: '211900', name: 'IC Payable Member', account_type: 'liability_payable', company_id: memberId, reconcile: true });
  db = memberIcPay.db;
  const mainCo = read(db, 'res.company', mainCompanyId);
  const memberCo = read(db, 'res.company', memberId);
  db = write(db, 'res.partner', memberCo.partner_id, { property_account_receivable_id: mainIcRec.id });
  db = write(db, 'res.partner', mainCo.partner_id, { property_account_payable_id: memberIcPay.id });

  const unit = create(db, 'account.tax.unit', {
    name: 'Replay Unit',
    country: 'Egypt',
    company_ids: [mainCompanyId, memberId],
    main_company_id: mainCompanyId,
    member_return_type_ids: [{ company_id: memberId, type_id: memberType.id }],
  });
  db = unit.db;

  const saleTaxMain = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === mainCompanyId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const saleTaxMember = search(db, 'account.tax').find((t) => (!t.company_id || t.company_id === memberId) && t.name === 'VAT 14%' && t.type_tax_use === 'sale');

  const invMain = create(db, 'account.move', {
    company_id: mainCompanyId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-08-10',
    invoice_line_ids: [{ name: 'Main sale', qty: 1, price_unit: 100, ...taxSnapshot(saleTaxMain) }],
  });
  db = postMove(invMain.db, invMain.id);

  const invMember = create(db, 'account.move', {
    company_id: memberId,
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-08-12',
    invoice_line_ids: [{ name: 'Member sale', qty: 1, price_unit: 200, ...taxSnapshot(saleTaxMember) }],
  });
  db = postMove(invMember.db, invMember.id);

  const ret = create(db, 'account.return', {
    name: 'VAT Unit Aug 2026',
    type_id: mainType.id,
    company_id: mainCompanyId,
    tax_unit_id: unit.id,
    date_from: '2026-08-01',
    date_to: '2026-08-31',
  });
  db = reviewReturn(ret.db, ret.id);
  db = submitReturn(db, ret.id);

  const submittedDb = db;
  const paidDb = payReturn(submittedDb, ret.id);

  // 1. Replay whole paid return diff on submittedDb through applyDiff with real invariants
  const replayDiff = diffDb(submittedDb, paidDb);
  const replayed = applyDiff(submittedDb, replayDiff, { isAdmin: true });

  const replayedRet = read(replayed, 'account.return', ret.id);
  assert.equal(replayedRet.state, 'paid');
  assert.equal(replayedRet.is_completed, true);
  assert.ok(replayedRet.payment_id);
  assert.deepEqual(replayedRet.payment_ids, [replayedRet.payment_id]);

  const payment = read(replayed, 'account.payment', replayedRet.payment_id);
  assert.equal(payment.company_id, mainCompanyId);
  assert.equal(payment.amount, 42);
  assert.equal(payment.destination_account_id, mainType.tax_payable_account_id);
  assert.equal(payment.state, 'posted');

  assert.equal(accountBalanceInCompany(replayed, mainCompanyId, mainType.tax_payable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(replayed, mainCompanyId, mainType.tax_receivable_account_id, mainType.payment_partner_id), 0);
  assert.equal(accountBalanceInCompany(replayed, memberId, memberType.tax_payable_account_id), 0);
  assert.equal(accountBalanceInCompany(replayed, memberId, memberType.tax_receivable_account_id), 0);
  assertAllMovesBalanced(replayed, [mainCompanyId, memberId]);

  // 2. Marking an ordinary posted payment as the unit's tax payment via diff is rejected when amount, type, company, or destination account is wrong
  const postOrdinaryPayment = (baseDb, overrides) => {
    const draft = create(baseDb, 'account.payment', {
      partner_id: mainType.payment_partner_id,
      partner_type: 'supplier',
      payment_type: 'outbound',
      amount: 42,
      date: today(),
      company_id: mainCompanyId,
      state: 'draft',
      destination_account_id: mainType.tax_payable_account_id,
      ...overrides,
    });
    return {
      id: draft.id,
      db: postPayment(draft.db, read(draft.db, 'account.payment', draft.id)),
    };
  };

  const markForgedPaymentDiff = (baseDb, ordinaryId) => {
    const withPaidReturn = {
      ...baseDb,
      records: {
        ...baseDb.records,
        'account.payment': baseDb.records['account.payment'].map((p) => (
          p.id === ordinaryId ? { ...p, is_tax_payment: true, return_id: ret.id } : p
        )),
        'account.return': baseDb.records['account.return'].map((r) => (
          r.id === ret.id ? { ...r, state: 'paid', is_completed: true, payment_id: ordinaryId, payment_ids: [ordinaryId] } : r
        )),
      },
    };
    return diffDb(submittedDb, withPaidReturn);
  };

  // Wrong amount (20 instead of 42)
  {
    const ord = postOrdinaryPayment(submittedDb, { amount: 20 });
    assert.throws(
      () => applyDiff(submittedDb, markForgedPaymentDiff(ord.db, ord.id), { isAdmin: true }),
      /settle its closing entry|Tax return payment requires a posted payment/i,
    );
  }

  // Wrong payment_type (inbound instead of outbound)
  {
    const ord = postOrdinaryPayment(submittedDb, { payment_type: 'inbound' });
    assert.throws(
      () => applyDiff(submittedDb, markForgedPaymentDiff(ord.db, ord.id), { isAdmin: true }),
      /settle its closing entry|Tax return payment requires a posted payment/i,
    );
  }

  // Wrong company (memberId instead of mainCompanyId)
  {
    const ord = postOrdinaryPayment(submittedDb, { company_id: memberId, destination_account_id: memberType.tax_payable_account_id });
    assert.throws(
      () => applyDiff(submittedDb, markForgedPaymentDiff(ord.db, ord.id), { isAdmin: true }),
      /settle its closing entry|Tax return payment requires a posted payment/i,
    );
  }

  // Wrong destination_account_id (partner/IC account instead of main tax payable)
  {
    const ord = postOrdinaryPayment(submittedDb, { destination_account_id: mainIcRec.id });
    assert.throws(
      () => applyDiff(submittedDb, markForgedPaymentDiff(ord.db, ord.id), { isAdmin: true }),
      /settle its closing entry|Tax return payment requires a posted payment/i,
    );
  }

  // 3. Omitting member settlement entry from a valid paid diff is rejected by applyDiff
  const missingMemberSettlementDb = {
    ...paidDb,
    records: {
      ...paidDb.records,
      'account.move': paidDb.records['account.move'].filter(
        (m) => !((m.company_id ?? 1) === memberId && m.is_tax_payment && m.tax_return_id === ret.id),
      ),
    },
  };
  assert.throws(
    () => applyDiff(submittedDb, diffDb(submittedDb, missingMemberSettlementDb), { isAdmin: true }),
    /Tax return payment requires a posted payment/i,
  );

  // 4. Pointing a unit tax payment at an unrelated balanced entry with the right destination line is rejected
  {
    const unrelated = postEntry(paidDb, {
      journal: 'MISC',
      date: today(),
      ref: 'Unrelated balanced entry with destination line',
      company: mainCompanyId,
      lines: [
        { account_id: mainType.tax_payable_account_id, partner_id: mainType.payment_partner_id, debit: 42 },
        { account_id: mainIcRec.id, credit: 42 },
      ],
    });
    const forgedEntryDb = {
      ...unrelated.db,
      records: {
        ...unrelated.db.records,
        'account.payment': unrelated.db.records['account.payment'].map((p) => (
          p.id === replayedRet.payment_id ? { ...p, move_id: unrelated.id } : p
        )),
      },
    };
    assert.throws(
      () => applyDiff(submittedDb, diffDb(submittedDb, forgedEntryDb), { isAdmin: true }),
      /The journal entry must book this payment amount and direction|Tax return payment requires a posted payment/i,
    );
  }
});

test('Finding 2: a member with no currency next to a base-currency company is rejected', () => {
  const { db, memberId } = setupTaxUnitEnv({ mainCountry: 'Egypt', memberCountry: 'Egypt' });
  const dbWithoutMemberCurr = write(db, 'res.company', memberId, { currency_id: null });
  const nextId = (dbWithoutMemberCurr.seq['account.tax.unit'] ?? 0) + 1;
  const draft = {
    ...dbWithoutMemberCurr,
    seq: { ...dbWithoutMemberCurr.seq, 'account.tax.unit': nextId },
    records: {
      ...dbWithoutMemberCurr.records,
      'account.tax.unit': [
        ...(dbWithoutMemberCurr.records['account.tax.unit'] ?? []),
        {
          id: nextId,
          name: 'Missing Currency Unit',
          country: 'Egypt',
          company_ids: [1, memberId],
          main_company_id: 1,
          member_return_type_ids: [],
        },
      ],
    },
  };
  assert.throws(
    () => applyDiff(dbWithoutMemberCurr, diffDb(dbWithoutMemberCurr, draft), { isAdmin: true }),
    /Set a currency on every company in the tax unit/i,
  );
});

test('Finding 3: an Egypt unit with a member without a country is rejected', () => {
  const { db, memberId } = setupTaxUnitEnv({ mainCountry: 'Egypt', memberCountry: '' });
  const nextId = (db.seq['account.tax.unit'] ?? 0) + 1;
  const draft = {
    ...db,
    seq: { ...db.seq, 'account.tax.unit': nextId },
    records: {
      ...db.records,
      'account.tax.unit': [
        ...(db.records['account.tax.unit'] ?? []),
        {
          id: nextId,
          name: 'Blank Member Country Unit',
          country: 'Egypt',
          company_ids: [1, memberId],
          main_company_id: 1,
          member_return_type_ids: [],
        },
      ],
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, draft), { isAdmin: true }),
    /Set a country on every company in the tax unit/i,
  );
});
