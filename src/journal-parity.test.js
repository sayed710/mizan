import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { seed } from './seed.js';
import { create, write, read, search, applyFilters } from './orm.js';
import { models } from './models/index.js';
import { accountId, journalId, ensureBankSuspense, outstandingAccount, isLiquidityJournal } from './models/ledger.js';
import { postMove, creditNote, payMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { payQuote } from './models/quoteplus.js';
import { statementImportJournalChoices, importStatement } from './models/statements.js';
import { bookBankMovement, reconcileWith } from './models/bank.js';
import { postBatch } from './models/payments.js';
import { journalCards } from './models/finance.js';
import { cashflowAnalysis } from './models/reports.js';
import { createCompany } from './models/company.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { fieldRequired } from './field-metadata.js';
import { saveFormRecord } from './views/formSave.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const { reorderSequenceUpdates, visibleListColumns } = await import('./views/List.jsx');
const { actionRecords } = await import('./views/ActionView.jsx');

function accountsFor(db, companyId = 1) {
  return {
    income: accountId(db, '400000', companyId),
    expense: accountId(db, '500000', companyId),
    bank: accountId(db, '101401', companyId) ?? search(db, 'account.account').find((a) => (a.company_id ?? 1) === companyId && a.account_type === 'asset_cash')?.id,
    suspense: ensureBankSuspense(db, companyId).id,
    receivable: accountId(db, '121000', companyId),
    payable: accountId(db, '211000', companyId),
  };
}

function makeCreditJournal(db, companyId = 1, overrides = {}) {
  const accs = accountsFor(db, companyId);
  const card = create(db, 'account.account', { code: `2190${companyId}`, name: 'Corporate Card', account_type: 'liability_credit_card', company_id: companyId });
  return create(card.db, 'account.journal', {
    name: 'Corporate Card',
    code: 'CARD',
    type: 'credit',
    company_id: companyId,
    default_account_id: card.id,
    suspense_account_id: accs.suspense,
    payment_sequence: true,
    ...overrides,
  });
}

function iso11649Valid(ref) {
  assert.match(ref, /^RF\d{2}[A-Z0-9]+$/);
  const rearranged = `${ref.slice(4)}${ref.slice(0, 4)}`;
  const digits = [...rearranged].map((c) => (c >= '0' && c <= '9' ? c : String(c.charCodeAt(0) - 55))).join('');
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

test('migration 40 backfills journal parity fields without changing existing numbering semantics', () => {
  const base = seed();
  const v39Db = {
    ...base,
    schema_version: 39,
    records: {
      ...base.records,
      'account.journal': [
        {
          id: 901, name: 'Sales Distinct', code: 'SD', type: 'sale', company_id: 1,
          default_account_id: accountId(base, '400000', 1),
          invoice_sequence_prefix: 'SD/2026/', invoice_sequence_next_number: 1,
          refund_sequence_prefix: 'RSD/2026/', refund_sequence_next_number: 1,
        },
        {
          id: 902, name: 'Sales Shared', code: 'SS', type: 'sale', company_id: 1,
          default_account_id: accountId(base, '400000', 1),
          invoice_sequence_prefix: 'SS/2026/', invoice_sequence_next_number: 1,
        },
        {
          id: 903, name: 'Bank Old', code: 'BO', type: 'bank', company_id: 1,
          default_account_id: accountId(base, '101401', 1),
          suspense_account_id: ensureBankSuspense(base, 1).id,
        },
        {
          id: 904, name: 'Card Old', code: 'CO', type: 'credit', company_id: 1,
          default_account_id: accountId(base, '101401', 1),
          suspense_account_id: ensureBankSuspense(base, 1).id,
        },
      ],
    },
  };

  assert.equal(SCHEMA_VERSION, 49);
  const upgraded = migrate(v39Db);
  assert.equal(upgraded.schema_version, 49);

  const sd = read(upgraded, 'account.journal', 901);
  const ss = read(upgraded, 'account.journal', 902);
  const bo = read(upgraded, 'account.journal', 903);
  const co = read(upgraded, 'account.journal', 904);

  assert.equal(sd.refund_sequence, true);
  assert.equal(sd.sequence, 10);
  assert.equal(sd.active, true);
  assert.equal(sd.invoice_reference_type, 'invoice');
  assert.equal(sd.invoice_reference_model, 'odoo');

  assert.equal(ss.refund_sequence, false);
  assert.equal(ss.sequence, 20);

  assert.equal(bo.payment_sequence, true);
  assert.equal(bo.bank_statements_source, 'undefined');
  assert.equal(co.payment_sequence, true);

  // Idempotent on second pass
  const again = migrate(upgraded);
  assert.equal(again.schema_version, 49);
  assert.equal(read(again, 'account.journal', 901).refund_sequence, true);
  assert.equal(read(again, 'account.journal', 902).refund_sequence, false);
});

test('refund_sequence shares invoice sequence when false and uses dedicated refund sequence when true', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Customer Refund Test', customer_rank: 1 });
  db = partner.db;
  const customer = read(db, 'res.partner', partner.id);
  const accs = accountsFor(db, 1);

  const sharedJ = create(db, 'account.journal', {
    name: 'Shared Seq Sale',
    code: 'SHS',
    type: 'sale',
    default_account_id: accs.income,
    refund_sequence: false,
    invoice_sequence_prefix: 'SHS/',
    invoice_sequence_next_number: 1,
  });
  db = sharedJ.db;

  const year = new Date().toISOString().slice(0, 4);
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: customer.id, journal_id: sharedJ.id, date: `${year}-03-01`, invoice_date: `${year}-03-01`,
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100 }],
  });
  db = postMove(inv1.db, inv1.id);
  assert.equal(read(db, 'account.move', inv1.id).name, `SHS/${year}/00001`);

  const cnShared = creditNote(db, read(db, 'account.move', inv1.id), { method: 'cancel', date: `${year}-03-02`, journal_id: sharedJ.id });
  db = cnShared.db;
  assert.equal(read(db, 'account.move', cnShared.id).name, `SHS/${year}/00002`);

  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: customer.id, journal_id: sharedJ.id, date: `${year}-03-03`, invoice_date: `${year}-03-03`,
    invoice_line_ids: [{ name: 'Service 2', qty: 1, price_unit: 50 }],
  });
  db = postMove(inv2.db, inv2.id);
  assert.equal(read(db, 'account.move', inv2.id).name, `SHS/${year}/00003`);

  // Dedicated refund sequence enabled
  const dedJ = create(db, 'account.journal', {
    name: 'Dedicated Seq Sale',
    code: 'DED',
    type: 'sale',
    default_account_id: accs.income,
    refund_sequence: true,
    invoice_sequence_prefix: 'DED/',
    invoice_sequence_next_number: 1,
    refund_sequence_prefix: 'RDED/',
    refund_sequence_next_number: 1,
  });
  db = dedJ.db;

  const invDed = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: customer.id, journal_id: dedJ.id, date: `${year}-03-04`, invoice_date: `${year}-03-04`,
    invoice_line_ids: [{ name: 'Consulting', qty: 1, price_unit: 200 }],
  });
  db = postMove(invDed.db, invDed.id);
  assert.equal(read(db, 'account.move', invDed.id).name, `DED/${year}/00001`);

  const cnDed = creditNote(db, read(db, 'account.move', invDed.id), { method: 'cancel', date: `${year}-03-05`, journal_id: dedJ.id });
  db = cnDed.db;
  assert.equal(read(db, 'account.move', cnDed.id).name, `RDED/${year}/00001`);
});

test('payment_sequence toggles dedicated P-prefixed vs shared sequence across payMove, postPayment, payQuote, and statement entries', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Customer PaySeq Test', customer_rank: 1 });
  db = partner.db;
  const customer = read(db, 'res.partner', partner.id);
  const accs = accountsFor(db, 1);

  const sharedBank = create(db, 'account.journal', {
    name: 'Shared Seq Bank',
    code: 'SBK',
    type: 'bank',
    default_account_id: accs.bank,
    suspense_account_id: accs.suspense,
    payment_sequence: false,
  });
  db = sharedBank.db;

  // 1) Invoice + payMove with payment_sequence: false -> uses SBK/<year>/00001
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: customer.id, date: '2026-04-05',
    invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 300 }],
  });
  db = postMove(inv.db, inv.id);
  db = payMove(db, inv.id, 100, '2026-04-06', { journalId: sharedBank.id });
  const sharedMove1 = search(db, 'account.move').find((m) => m.journal_id === sharedBank.id);
  assert.equal(sharedMove1.name, 'SBK/2026/00001');

  // 2) Standalone postPayment interleaved on same journal -> SBK/2026/00002
  const p = create(db, 'account.payment', {
    partner_id: customer.id, partner_type: 'customer', payment_type: 'inbound',
    journal_id: sharedBank.id, amount: 50, date: '2026-04-07',
  });
  db = postPayment(p.db, read(p.db, 'account.payment', p.id));
  const payRec = read(db, 'account.payment', p.id);
  assert.equal(payRec.name, 'SBK/2026/00002');
  assert.equal(read(db, 'account.move', payRec.move_id).name, 'SBK/2026/00002');

  // 3) Statement movement interleaved on same journal -> SBK/2026/00003
  const sl = create(db, 'account.bank.statement.line', {
    journal_id: sharedBank.id, date: '2026-04-08', payment_ref: 'Bank Fee Deposit', amount: 75,
  });
  db = sl.db;
  const booked = bookBankMovement(db, read(db, 'account.bank.statement.line', sl.id), 1, { date: '2026-04-08', openAmount: 75 });
  db = booked.db;
  assert.equal(read(db, 'account.move', booked.bankMoveId).name, 'SBK/2026/00003');

  // 4) Quote payment on dedicated payment_sequence: true journal -> PDBK/2026/00001
  const dedBank = create(db, 'account.journal', {
    name: 'Dedicated Seq Bank',
    code: 'DBK',
    type: 'bank',
    default_account_id: accs.bank,
    suspense_account_id: accs.suspense,
    payment_sequence: true,
  });
  db = dedBank.db;
  const order = create(db, 'sale.order', {
    partner_id: customer.id,
    order_line: [{ product_id: 1, qty: 1, price_unit: 200 }],
  });
  const pqDb = payQuote(order.db, order.id, 100, { date: '2026-04-09', journal: 'DBK' });
  const quotePay = search(pqDb, 'account.payment').find((x) => x.sale_id === order.id);
  assert.equal(quotePay.name, 'PDBK/2026/00001');
  assert.equal(read(pqDb, 'account.move', quotePay.move_id).name, 'DBK/2026/00001');
});

test('credit journal behaves as liquidity journal across payments, statements, batches, dashboard, and cashflow', () => {
  let db = seed();
  const cp = create(db, 'res.partner', { name: 'Card Buyer', customer_rank: 1 });
  const vp = create(cp.db, 'res.partner', { name: 'Card Vendor', supplier_rank: 1 });
  db = vp.db;
  const customer = read(db, 'res.partner', cp.id);
  const vendor = read(db, 'res.partner', vp.id);
  const cj = makeCreditJournal(db, 1);
  db = cj.db;
  const creditJ = read(db, 'account.journal', cj.id);

  assert.equal(isLiquidityJournal(creditJ), true);
  assert.ok(ensureBankSuspense(db, 1, creditJ.id).id);
  const accs = accountsFor(db, 1);
  db = write(db, 'account.journal', creditJ.id, {
    outstanding_receipts_account_id: accs.bank,
    outstanding_payments_account_id: accs.bank,
  });
  const creditWithOut = read(db, 'account.journal', creditJ.id);
  assert.ok(outstandingAccount(db, creditWithOut, 1, true));
  assert.ok(outstandingAccount(db, creditWithOut, 1, false));

  // Import statement choices & manual file import support credit journal
  const choices = statementImportJournalChoices(db, 1);
  assert.ok(choices.some((j) => j.id === creditJ.id));
  const ofx = '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN><TRNAMT>120.00</TRNAMT><DTPOSTED>20260501</DTPOSTED><NAME>CARD RECEIPT</NAME><FITID>CRD1</FITID></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
  const imported = importStatement(db, 'card.ofx', ofx, { journal_id: creditJ.id, company_id: 1 });
  assert.equal(imported.count, 1);
  db = imported.db;
  const importedLine = search(db, 'account.bank.statement.line').find((l) => l.journal_id === creditJ.id && l.payment_ref === 'CARD RECEIPT');
  assert.equal(importedLine.journal_id, creditJ.id);

  // Post invoice and reconcile with credit statement line
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: customer.id, date: '2026-05-01',
    invoice_line_ids: [{ name: 'Card Sale', qty: 1, price_unit: 120 }],
  });
  db = postMove(inv.db, inv.id);

  // Register Payment wizard domain includes credit
  const regAction = models['account.move'].form.buttons.find((a) => a.label === 'Register Payment');
  const wizardDomain = regAction.wizard(db, read(db, 'account.move', inv.id)).fields.find((f) => f.name === 'journal_id').domain;
  assert.equal(wizardDomain(creditJ), true);

  db = reconcileWith(db, importedLine, inv.id);
  assert.equal(read(db, 'account.move', inv.id).payment_state, 'paid');

  // Inbound batch payment works on credit journal
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: customer.id, date: '2026-05-02',
    invoice_line_ids: [{ name: 'Batch Card Sale', qty: 1, price_unit: 80 }],
  });
  db = postMove(inv2.db, inv2.id);
  const inBatch = create(db, 'account.batch.payment', {
    batch_type: 'inbound', journal_id: creditJ.id, date: '2026-05-03',
    lines: [{ move_id: inv2.id, amount: 80 }],
  });
  db = postBatch(inBatch.db, read(inBatch.db, 'account.batch.payment', inBatch.id));
  assert.equal(read(db, 'account.move', inv2.id).amount_residual, 0);
  assert.equal(read(db, 'account.move', inv2.id).payment_state, 'paid');

  // Outbound check batch stays rejected on credit journal (checks require bank)
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: vendor.id, date: '2026-05-02',
    invoice_line_ids: [{ name: 'Bill', qty: 1, price_unit: 50 }],
  });
  db = postMove(bill.db, bill.id);
  const outBatch = create(db, 'account.batch.payment', {
    batch_type: 'outbound', journal_id: creditJ.id, date: '2026-05-03', check_number_start: 1001,
    lines: [{ move_id: bill.id, amount: 50 }],
  });
  assert.throws(() => postBatch(outBatch.db, read(outBatch.db, 'account.batch.payment', outBatch.id)), /Checks require a bank journal/);

  // Dashboard journal card & cashflowAnalysis include credit journal
  const cards = journalCards(db);
  const creditCard = cards.find((c) => c.journal.id === creditJ.id);
  assert.ok(creditCard);
  assert.equal(creditCard.kind, 'credit');
  assert.equal(creditCard.hasOutstandingAccounts, true);

  const cf = cashflowAnalysis(db, { from: '2026-05-01', to: '2026-05-31' });
  assert.ok(cf.journals.some((b) => b.name === 'Corporate Card'));

  // online_sync stores on bank journal without blocking manual import path
  const bankId = journalId(db, 'BNK1', 1);
  db = write(db, 'account.journal', bankId, { bank_statements_source: 'online_sync' });
  assert.equal(read(db, 'account.journal', bankId).bank_statements_source, 'online_sync');
  const syncOfx = '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN><TRNAMT>40.00</TRNAMT><DTPOSTED>20260504</DTPOSTED><NAME>MANUAL</NAME><FITID>MAN1</FITID></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
  const syncImport = importStatement(db, 'manual.ofx', syncOfx, { journal_id: bankId, company_id: 1 });
  assert.equal(syncImport.count, 1);
});

test('payment_reference follows invoice_reference_type and invoice_reference_model on sale invoice posting', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Ref Buyer', ref: 'CUST-42', customer_rank: 1 });
  db = partner.db;
  const invJId = journalId(db, 'INV', 1);

  const postWithRefSettings = (type, model, extra = {}) => {
    db = write(db, 'account.journal', invJId, {
      invoice_reference_type: type,
      invoice_reference_model: model,
    });
    const m = create(db, 'account.move', {
      move_type: 'out_invoice', partner_id: partner.id, journal_id: invJId,
      invoice_line_ids: [{ name: 'Item', qty: 1, price_unit: 100 }],
      ...extra,
    });
    db = postMove(m.db, m.id);
    return read(db, 'account.move', m.id);
  };

  const mOdoo = postWithRefSettings('invoice', 'odoo');
  assert.equal(mOdoo.payment_reference, mOdoo.name);

  const mNumber = postWithRefSettings('invoice', 'number');
  assert.equal(mNumber.payment_reference, mNumber.name.replace(/\D+/g, ''));

  const mEuro = postWithRefSettings('invoice', 'euro');
  assert.equal(iso11649Valid(mEuro.payment_reference), true);
  assert.ok(mEuro.payment_reference.endsWith(mEuro.name.replace(/[^A-Za-z0-9]/g, '').toUpperCase()));

  const mPartnerOdoo = postWithRefSettings('partner', 'odoo');
  assert.equal(mPartnerOdoo.payment_reference, 'CUST-42');

  const mPartnerEuro = postWithRefSettings('partner', 'euro');
  assert.equal(iso11649Valid(mPartnerEuro.payment_reference), true);
  assert.ok(mPartnerEuro.payment_reference.endsWith('CUST42'));

  const mNone = postWithRefSettings('none', 'odoo');
  assert.equal(mNone.payment_reference ?? '', '');

  const mManual = postWithRefSettings('invoice', 'odoo', { payment_reference: 'CUSTOM-PAY-REF' });
  assert.equal(mManual.payment_reference, 'CUSTOM-PAY-REF');
});

test('account.journal guards reject missing required accounts per type, archived/cross-company accounts, and invalid bank_account_id', () => {
  let db = seed();
  const accs1 = accountsFor(db, 1);
  const comp2 = createCompany(db, { name: 'Second Co' });
  db = comp2.db;

  // sale / purchase require default_account_id on create
  assert.throws(() => create(db, 'account.journal', { name: 'NoDef Sale', code: 'NDS', type: 'sale', company_id: 1 }), /is required/);
  assert.throws(() => create(db, 'account.journal', { name: 'NoDef Buy', code: 'NDB', type: 'purchase', company_id: 1 }), /is required/);

  // liquidity journals require suspense_account_id on create; default_account_id is allowed unset on create, required once saved
  assert.throws(() => create(db, 'account.journal', { name: 'NoSusp Card', code: 'NSC', type: 'credit', company_id: 1 }), /Suspense Account is required/);
  const createdCard = create(db, 'account.journal', {
    name: 'Draft Card', code: 'DCRD', type: 'credit', company_id: 1,
    suspense_account_id: accs1.suspense,
  });
  db = createdCard.db;
  assert.equal(read(db, 'account.journal', createdCard.id).default_account_id ?? null, null);
  assert.throws(() => saveFormRecord(db, 'account.journal', createdCard.id, { name: 'Draft Card Renamed' }), /Default Account is required/);

  // Cross-company and archived accounts rejected
  const co2Income = create(db, 'account.account', { code: '400222', name: 'Co2 Income', account_type: 'income', company_id: comp2.id });
  assert.throws(() => create(co2Income.db, 'account.journal', {
    name: 'Cross Co Sale', code: 'CCS', type: 'sale', company_id: 1, default_account_id: co2Income.id,
  }), /Select an active default account belonging to this journal company/);

  const archivedAcc = create(db, 'account.account', { code: '499999', name: 'Old Income', account_type: 'income', company_id: 1, active: false });
  assert.throws(() => create(archivedAcc.db, 'account.journal', {
    name: 'Archived Acc Sale', code: 'AAS', type: 'sale', company_id: 1, default_account_id: archivedAcc.id,
  }), /Select an active default account belonging to this journal company/);

  // Type-specific account guards (profit/loss on cash/bank only, non_deductible on purchase only)
  assert.throws(() => create(db, 'account.journal', {
    name: 'Credit Profit', code: 'CRP', type: 'credit', company_id: 1,
    default_account_id: accs1.bank, suspense_account_id: accs1.suspense, profit_account_id: accs1.income,
  }), /Profit account is only valid for cash\/bank journals/);

  assert.throws(() => create(db, 'account.journal', {
    name: 'Sale Private', code: 'SLP', type: 'sale', company_id: 1,
    default_account_id: accs1.income, non_deductible_account_id: accs1.expense,
  }), /Private share account is only valid for purchase journals/);

  const buyWithPrivate = create(db, 'account.journal', {
    name: 'Purchase Private', code: 'PRP', type: 'purchase', company_id: 1,
    default_account_id: accs1.expense, non_deductible_account_id: accs1.expense,
  });
  assert.equal(read(buyWithPrivate.db, 'account.journal', buyWithPrivate.id).non_deductible_account_id, accs1.expense);

  // Bank account domain limited to company's partner banks + guard rejects cross-company bank account
  const comp1PartnerId = read(db, 'res.company', 1).partner_id;
  const comp2PartnerId = read(db, 'res.company', comp2.id).partner_id;
  const bank1 = create(db, 'res.partner.bank', { account_number: 'ACC-C1-001', partner_id: comp1PartnerId, company_id: 1 });
  const bank2 = create(bank1.db, 'res.partner.bank', { account_number: 'ACC-C2-002', partner_id: comp2PartnerId, company_id: comp2.id });
  db = bank2.db;

  const bankDomain = models['account.journal'].fields.bank_account_id.domain;
  const sampleBankJournal = { type: 'bank', company_id: 1 };
  assert.equal(bankDomain(read(db, 'res.partner.bank', bank1.id), sampleBankJournal, db), true);
  assert.equal(bankDomain(read(db, 'res.partner.bank', bank2.id), sampleBankJournal, db), false);

  assert.throws(() => create(db, 'account.journal', {
    name: 'Cross Bank', code: 'CBK', type: 'bank', company_id: 1,
    default_account_id: accs1.bank, suspense_account_id: accs1.suspense, bank_account_id: bank2.id,
  }), /Select an active bank account belonging to this journal company/);
});

test('account.journal list columns, search filters, sequence ordering, and per-type form shape match Odoo 20 parity', () => {
  let db = seed();
  const def = models['account.journal'];
  const fields = def.fields;

  // List columns & labels & type selection order
  assert.deepEqual(def.list, ['sequence', 'name', 'type', 'code', 'default_account_id', 'active', 'company_id']);
  assert.equal(fields.sequence.widget, 'handle');
  assert.equal(fields.name.label, 'Journal');
  assert.equal(fields.active.optional, 'hide');
  assert.equal(fields.company_id.multiCompanyOnly, true);
  assert.deepEqual(fields.type.options, [
    ['sale', 'Sales'],
    ['purchase', 'Purchase'],
    ['cash', 'Cash'],
    ['bank', 'Bank'],
    ['credit', 'Credit Card'],
    ['general', 'Miscellaneous'],
  ]);
  assert.ok(fields.type.help.includes('Credit Card'));

  // company_id & optional active column visibility
  const singleCols = visibleListColumns(def, db, {}).cols;
  assert.equal(singleCols.includes('company_id'), false);
  assert.equal(singleCols.includes('active'), false);
  const activeShownCols = visibleListColumns(def, db, { active: true }).cols;
  assert.equal(activeShownCols.includes('active'), true);

  const c2 = createCompany(db, { name: 'Multi Co' });
  db = c2.db;
  const multiCols = visibleListColumns(def, db, {}).cols;
  assert.equal(multiCols.includes('company_id'), true);

  // Drag reorderSequenceUpdates changes journal sequence order
  const activeJournals = search(db, 'account.journal').filter((j) => (j.company_id ?? 1) === 1);
  const updates = reorderSequenceUpdates(activeJournals, activeJournals[0].id, activeJournals[2].id);
  assert.ok(updates.size >= 2);
  for (const [id, vals] of updates) db = write(db, 'account.journal', id, vals);
  const afterSort = [...search(db, 'account.journal').filter((j) => (j.company_id ?? 1) === 1)].sort(def.sort);
  assert.equal(afterSort[2].id, activeJournals[0].id);

  // Search filters: Sales, Purchases, Liquidity (includes credit), Miscellaneous, Archived
  const cj = makeCreditJournal(db, 1, { active: false });
  db = cj.db;
  const allUnarchived = actionRecords(db, { model: 'account.journal' }, null, false);
  assert.equal(allUnarchived.some((j) => j.id === cj.id), false);
  const onlyArchived = actionRecords(db, { model: 'account.journal' }, null, true);
  assert.deepEqual(onlyArchived.map((j) => j.id), [cj.id]);

  db = write(db, 'account.journal', cj.id, { active: true });
  const visible = actionRecords(db, { model: 'account.journal' }, null, false);
  const liquidityFiltered = applyFilters('account.journal', visible, ['liquidity']);
  assert.ok(liquidityFiltered.some((j) => j.type === 'bank'));
  assert.ok(liquidityFiltered.some((j) => j.type === 'cash'));
  assert.ok(liquidityFiltered.some((j) => j.type === 'credit'));
  assert.equal(liquidityFiltered.some((j) => j.type === 'sale' || j.type === 'general'), false);
  assert.ok(applyFilters('account.journal', visible, ['sales']).every((j) => j.type === 'sale'));
  assert.ok(applyFilters('account.journal', visible, ['purchases']).every((j) => j.type === 'purchase'));
  assert.ok(applyFilters('account.journal', visible, ['miscellaneous']).every((j) => j.type === 'general'));

  // Form tabs per journal type
  const saleTabs = def.form.tabs({ type: 'sale', refund_sequence: false, invoice_reference_type: 'invoice' });
  const saleEntries = saleTabs[0].groups[0];
  assert.equal(saleEntries.find((x) => x.field === 'default_account_id')?.label, 'Default Income Account');
  assert.equal(saleEntries.includes('refund_sequence_prefix'), false);
  const saleAdv = saleTabs.find((t) => t.label === 'Advanced Settings');
  assert.equal(saleAdv.groups.map((g) => g.title).includes('Automation'), true);
  assert.equal(saleAdv.groups.map((g) => g.title).includes('Payment Communications'), true);
  const saleNoneRefAdv = def.form.tabs({ type: 'sale', invoice_reference_type: 'none' }).find((t) => t.label === 'Advanced Settings');
  assert.deepEqual(saleNoneRefAdv.groups[1].fields, ['invoice_reference_type']);

  const bankTabs = def.form.tabs({ type: 'bank' });
  assert.equal(bankTabs[0].groups.some((g) => g.title === 'Bank Account' && g.fields.includes('bank_statements_source')), true);
  assert.equal(bankTabs.some((t) => t.label === 'Advanced Settings'), false);
  assert.equal(fieldRequired(fields.default_account_id, { type: 'bank' }, db, true), false);
  assert.equal(fieldRequired(fields.default_account_id, { type: 'bank' }, db, false), true);
  assert.equal(fieldRequired(fields.bank_statements_source, { type: 'bank' }, db, true), true);

  const creditTabs = def.form.tabs({ type: 'credit' });
  const creditEntries = creditTabs[0].groups[0];
  assert.equal(creditEntries.find((x) => x.field === 'default_account_id')?.label, 'Credit Card Account');
  assert.equal(creditEntries.includes('suspense_account_id'), true);
  assert.equal(creditEntries.includes('profit_account_id'), false);
  assert.equal(creditEntries.includes('loss_account_id'), false);
  assert.equal(creditTabs.find((t) => t.label === 'Advanced Settings').groups[0].title, 'Automation');
});

test('a credit card journal pays from its credit card liability account', async () => {
  const { paymentJournal } = await import('./models/ledger.js');
  const card = makeCreditJournal(seed());
  const resolved = paymentJournal(card.db, card.id, 1);
  assert.equal(read(card.db, 'account.account', resolved.accountId).account_type, 'liability_credit_card');
});

test('new journals take their payment and credit note sequences from the type, as Odoo does', () => {
  const db = seed();
  const accs = accountsFor(db);
  const bank = create(db, 'account.journal', { name: 'Bank 2', code: 'BNK9', type: 'bank', default_account_id: accs.bank, suspense_account_id: accs.suspense });
  assert.equal(read(bank.db, 'account.journal', bank.id).payment_sequence, true);
  const sale = create(db, 'account.journal', { name: 'Exports', code: 'EXP', type: 'sale', default_account_id: accs.income, invoice_sequence_prefix: 'EXP/', invoice_sequence_next_number: 1 });
  const saleJ = read(sale.db, 'account.journal', sale.id);
  assert.equal(saleJ.refund_sequence, true);
  assert.equal(saleJ.refund_sequence_prefix, 'REXP/');
  assert.equal(saleJ.payment_sequence, false);
  const misc = create(db, 'account.journal', { name: 'Misc 2', code: 'MSC9', type: 'general' });
  assert.equal(read(misc.db, 'account.journal', misc.id).refund_sequence, false);
});

test('a journal stored before Default Account was required accepts system updates, but its form asks for the account', () => {
  const db = seed();
  const sale = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const legacy = { ...db, records: { ...db.records, 'account.journal': db.records['account.journal'].map((j) => (j.id === sale.id ? { ...j, default_account_id: null } : j)) } };
  const renamed = write(legacy, 'account.journal', sale.id, { name: 'Renamed' });
  assert.equal(read(renamed, 'account.journal', sale.id).name, 'Renamed');
  assert.throws(() => saveFormRecord(legacy, 'account.journal', sale.id, { name: 'Renamed' }), /Default Account is required/);
});

test('credit notes get no payment communication', () => {
  let db = seed();
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 5, invoice_date: '2026-04-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  assert.ok(read(db, 'account.move', inv.id).payment_reference);
  const refund = create(db, 'account.move', { move_type: 'out_refund', partner_id: 5, invoice_date: '2026-04-02', invoice_line_ids: [{ qty: 1, price_unit: 40, tax: 0 }] });
  db = postMove(refund.db, refund.id);
  assert.ok(!read(db, 'account.move', refund.id).payment_reference);
});
