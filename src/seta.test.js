import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { newDefaults } from './views/formDefaults.js';
import { createCompany } from './models/company.js';
import { taxReport } from './models/finance.js';
import { postPayment } from './models/pay.js';
import { payMove, postMove } from './models/accounting.js';
import { reconcileWith } from './models/bank.js';
import { generateReturns } from './models/taxreturn.js';
import { invoiceQrPayload, invoiceQrSettingsForCompany } from './models/qr.js';
import { taxSnapshot } from './models/taxes.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';

test('Finding 1: new document creation inherits current company from db', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Second Company' });
  db = { ...c2.db, settings: { ...c2.db.settings, current_company_id: c2.id } };
  const values = newDefaults(db, 'account.move', {}, new URLSearchParams(), null);
  assert.equal(values.company_id, c2.id);
});

test('Finding 2: unreleased cash-basis taxes resolve company transition accounts and stay out of tax report', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Company Two' });
  db = c2.db;
  const compId = c2.id;
  for (const code of ['101401', '251000', '251100', '400000']) {
    const orig = db.records['account.account'].find((a) => a.code === code);
    db = create(db, 'account.account', { ...orig, company_id: compId }).db;
  }
  const origJournal = db.records['account.journal'].find((j) => j.code === 'INV');
  const journalRes = create(db, 'account.journal', { ...origJournal, company_id: compId, invoice_sequence_prefix: 'C2-INV/', invoice_sequence_next_number: 1, refund_sequence_prefix: 'C2-RINV/', refund_sequence_next_number: 1 });
  db = journalRes.db;

  const taxAccount = search(db, 'account.account').find((a) => a.code === '251000' && a.company_id === compId);
  const transitionAccount = search(db, 'account.account').find((a) => a.code === '251100' && a.company_id === compId);
  assert.ok(transitionAccount, 'company 2 has transition account');
  assert.equal(transitionAccount.company_id, compId);

  const { db: d1, id: taxId } = create(db, 'account.tax', {
    name: 'VAT 15% Cash Basis C2',
    amount: 15,
    amount_type: 'percent',
    type_tax_use: 'sale',
    company_id: compId,
    tax_exigibility: 'on_payment',
    account_id: taxAccount.id,
    cash_basis_transition_account_id: transitionAccount.id,
  });
  db = d1;
  const incomeAccount = search(db, 'account.account').find((a) => a.code === '400000' && a.company_id === compId);
  const partner = search(db, 'res.partner')[0];
  const taxRec = read(db, 'account.tax', taxId);
  const { db: d2, id: moveId } = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: compId,
    journal_id: journalRes.id,
    partner_id: partner.id,
    invoice_date: '2026-05-10',
    invoice_line_ids: [{
      name: 'Service',
      qty: 1,
      price_unit: 100,
      account_id: incomeAccount.id,
      ...taxSnapshot(taxRec, db),
    }],
  });
  db = postMove(d2, moveId);
  const report = taxReport(db, { from: '2026-05-01', to: '2026-05-31', company_id: compId });
  assert.equal(report.output, 0, 'unreleased cash-basis tax must not be included in tax output');
  assert.equal(report.payable, 0, 'unreleased cash-basis tax must not be included in tax payable');
});

test('Finding 3: accounting lock dates are scoped to res.company and sister companies remain unlocked', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Company Two' });
  db = c2.db;
  const comp2Id = c2.id;
  for (const code of ['101401', '400000']) {
    const orig = db.records['account.account'].find((a) => a.code === code);
    db = create(db, 'account.account', { ...orig, company_id: comp2Id }).db;
  }
  const origJournal = db.records['account.journal'].find((j) => j.code === 'INV');
  const journal2Res = create(db, 'account.journal', { ...origJournal, company_id: comp2Id, invoice_sequence_prefix: 'C2-INV/', invoice_sequence_next_number: 1, refund_sequence_prefix: 'C2-RINV/', refund_sequence_next_number: 1 });
  db = journal2Res.db;

  // Lock Company 1 via res.company
  db = write(db, 'res.company', 1, { lock_date: '2026-03-31', sale_lock_date: '2026-03-31' });

  const partner = search(db, 'res.partner')[0];
  const incomeAccount2 = search(db, 'account.account').find((a) => a.code === '400000' && a.company_id === comp2Id);

  // Company 2 invoice dated 2026-03-15 can be posted
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: comp2Id,
    journal_id: journal2Res.id,
    partner_id: partner.id,
    invoice_date: '2026-03-15',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, account_id: incomeAccount2.id }],
  });
  db = inv2.db;
  assert.doesNotThrow(() => {
    postMove(db, inv2.id);
  });

  // Company 1 invoice dated 2026-03-15 fails
  const journal1 = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id === 1 || !j.company_id));
  const incomeAccount1 = search(db, 'account.account').find((a) => a.code === '400000' && (a.company_id === 1 || !a.company_id));
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: journal1.id,
    partner_id: partner.id,
    invoice_date: '2026-03-15',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, account_id: incomeAccount1.id }],
  });
  db = inv1.db;
  assert.throws(() => {
    postMove(db, inv1.id);
  }, /locked/i);
});

test('Finding 4: postPayment resolves company default payment journal and rejects cross-company journal', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Company Two' });
  db = c2.db;
  const comp2Id = c2.id;
  const origAcc = db.records['account.account'].find((a) => a.code === '101401');
  const bnkAccount = create(db, 'account.account', { ...origAcc, company_id: comp2Id });
  db = bnkAccount.db;

  const origJournal = db.records['account.journal'].find((j) => j.code === 'BNK1');
  const bankJournal2 = create(db, 'account.journal', {
    ...origJournal,
    company_id: comp2Id,
    default_account_id: bnkAccount.id,
    default_for_payments: true,
  });
  db = bankJournal2.db;

  const partner = search(db, 'res.partner')[0];
  const pay = create(db, 'account.payment', {
    partner_id: partner.id,
    amount: 100,
    payment_type: 'outbound',
    partner_type: 'supplier',
    company_id: comp2Id,
    state: 'draft',
  });
  db = pay.db;
  const posted = postPayment(db, read(db, 'account.payment', pay.id));
  assert.equal(read(posted, 'account.payment', pay.id).state, 'posted');

  const bankJournal1 = search(db, 'account.journal').find((j) => j.type === 'bank' && j.company_id === 1);
  assert.throws(() => create(db, 'account.payment', {
    partner_id: partner.id,
    amount: 50,
    payment_type: 'outbound',
    partner_type: 'supplier',
    company_id: comp2Id,
    journal_id: bankJournal1.id,
    state: 'draft',
  }), /Journal: select a record shared with or belonging to this company/);

  // Even for a pre-existing stored draft payment pointing at another company's journal, postPayment rejects it.
  const seededBadPay = create(db, 'account.payment', {
    partner_id: partner.id,
    amount: 50,
    payment_type: 'outbound',
    partner_type: 'supplier',
    company_id: comp2Id,
    journal_id: bankJournal2.id,
    state: 'draft',
  });
  const forcedDb = {
    ...seededBadPay.db,
    records: {
      ...seededBadPay.db.records,
      'account.payment': seededBadPay.db.records['account.payment'].map((p) => (p.id === seededBadPay.id ? { ...p, journal_id: bankJournal1.id } : p)),
    },
  };
  assert.throws(() => {
    postPayment(forcedDb, read(forcedDb, 'account.payment', seededBadPay.id));
  }, /Payment journal belongs to another company/i);
});

test('Finding 6: three-way matching exception blocks payMove, postPayment, and reconcileWith', async () => {
  let db = seed();
  db = write({ ...db, settings: { ...db.settings, three_way_matching: true } }, 'res.company', 1, { three_way_matching: true });
  const vendor = search(db, 'res.partner')[0];
  const prod = search(db, 'product').find((p) => (p.purchase_method ?? 'receive') === 'receive' && p.type === 'goods') ?? search(db, 'product')[0];
  db = write(db, 'product', prod.id, { purchase_method: 'receive', type: 'goods' });

  const po = create(db, 'purchase.order', {
    partner_id: vendor.id,
    state: 'purchase',
    order_line: [{ product_id: prod.id, qty: 10, qty_delivered: 2, price_unit: 50 }],
  });
  db = po.db;

  const expenseAccount = search(db, 'account.account').find((a) => a.code === '600000');
  const billJournal = search(db, 'account.journal').find((j) => j.code === 'BILL');
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    purchase_id: po.id,
    journal_id: billJournal.id,
    invoice_date: '2026-06-01',
    invoice_line_ids: [{ product_id: prod.id, qty: 10, price_unit: 50, account_id: expenseAccount.id }],
  });
  db = postMove(bill.db, bill.id);
  const { shouldBePaid } = await import('./models/billcontrol.js');
  assert.equal(shouldBePaid(db, read(db, 'account.move', bill.id)), 'exception');

  // 1. payMove must throw
  assert.throws(() => {
    payMove(db, bill.id, 100);
  }, /three-way matching/i);

  // 2. postPayment must not settle the exception bill
  const pay = create(db, 'account.payment', {
    partner_id: vendor.id,
    amount: 500,
    payment_type: 'outbound',
    partner_type: 'supplier',
    state: 'draft',
  });
  const afterPay = postPayment(pay.db, read(pay.db, 'account.payment', pay.id));
  const billAfterPay = read(afterPay, 'account.move', bill.id);
  assert.equal(billAfterPay.amount_residual, billAfterPay.amount_total, 'bill with exception must remain unpaid');

  // 3. reconcileWith must throw
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const stmtLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id,
    partner_id: vendor.id,
    amount: -500,
    date: '2026-06-01',
    payment_ref: 'Payment for bill',
    state: 'to_check',
  });
  assert.throws(() => {
    reconcileWith(stmtLine.db, read(stmtLine.db, 'account.bank.statement.line', stmtLine.id), bill.id);
  }, /three-way matching/i);
});

test('Finding 9: updating tax periodicity and start date on res.company synchronizes return type and generates correct schedule', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { tax_periodicity: 'trimester', tax_start_date: '2026-01-01' });

  const vatType = search(db, 'account.return.type').find((t) => (t.company_id ?? 1) === 1 && t.name === 'VAT Return');
  assert.equal(vatType.deadline_periodicity, 'trimester');
  assert.equal(vatType.deadline_start_date, '2026-01-01');

  const { created } = generateReturns(db, vatType.id);
  assert.ok(created.length > 0);
  assert.equal(created[0].date_from, '2026-01-01');
  assert.equal(created[0].date_to, '2026-03-31');
});

test('Finding 10: invoice QR settings persisted on res.company generate QR for multi-company invoices', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Second Co' });
  db = c2.db;
  const comp2Id = c2.id;

  // Simulate settings being saved for Company 2
  db = write(db, 'res.company', comp2Id, {
    invoice_qr: 'epc',
    vat: 'FR12345678901',
    company_iban: 'FR7630006000011234567890189',
  });

  // When active company is 1, printing Company 2's invoice
  db = { ...db, settings: { ...db.settings, current_company_id: 1 } };
  const comp2 = read(db, 'res.company', comp2Id);
  const settings = invoiceQrSettingsForCompany(db, comp2);
  assert.equal(settings.invoice_qr, 'epc');
  assert.equal(settings.company_vat, 'FR12345678901');
  assert.equal(settings.company_iban, 'FR7630006000011234567890189');

  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const move = {
    move_type: 'out_invoice',
    state: 'posted',
    currency_id: eur.id,
    amount_residual: 100,
    name: 'INV/2026/0001',
  };
  const payload = invoiceQrPayload(settings, comp2, move, 'EUR');
  assert.ok(payload, 'QR payload should be generated for company 2 invoice');
  assert.match(payload, /FR7630006000011234567890189/);
});

test('Finding 3: migration 25 copies global locks to all companies and clears settings', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Company Two' });
  db = c2.db;
  const oldDb = {
    ...db,
    schema_version: 25,
    settings: {
      ...db.settings,
      lock_date: '2026-03-31',
      sale_lock_date: '2026-03-31',
      purchase_lock_date: '2026-02-28',
      hard_lock_date: '2026-01-31',
    },
  };
  const migrated = migrate(oldDb);
  assert.equal(SCHEMA_VERSION, 52);
  assert.equal(migrated.schema_version, 52);
  assert.equal('lock_date' in migrated.settings, false);
  assert.equal('sale_lock_date' in migrated.settings, false);
  assert.equal('purchase_lock_date' in migrated.settings, false);
  assert.equal('hard_lock_date' in migrated.settings, false);

  const comp1 = read(migrated, 'res.company', 1);
  const comp2 = read(migrated, 'res.company', c2.id);
  assert.equal(comp1.lock_date, '2026-03-31');
  assert.equal(comp1.sale_lock_date, '2026-03-31');
  assert.equal(comp1.purchase_lock_date, '2026-02-28');
  assert.equal(comp1.hard_lock_date, '2026-01-31');

  assert.equal(comp2.lock_date, '2026-03-31');
  assert.equal(comp2.sale_lock_date, '2026-03-31');
  assert.equal(comp2.purchase_lock_date, '2026-02-28');
  assert.equal(comp2.hard_lock_date, '2026-01-31');
});

test('Finding 10: migration 25 migrates global QR/VAT/IBAN settings to current company', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Company Two' });
  db = c2.db;
  const oldDb = {
    ...db,
    schema_version: 25,
    settings: {
      ...db.settings,
      current_company_id: 1,
      invoice_qr: 'epc',
      company_vat: 'DE123456789',
      company_iban: 'DE89370400440532013000',
    },
  };
  const migrated = migrate(oldDb);
  const comp1 = read(migrated, 'res.company', 1);
  const comp2 = read(migrated, 'res.company', c2.id);
  assert.equal(comp1.invoice_qr, 'epc');
  assert.equal(comp1.vat, 'DE123456789');
  assert.equal(comp1.company_iban, 'DE89370400440532013000');
  assert.equal(comp2.invoice_qr ?? null, null);
  assert.notEqual(comp2.vat, 'DE123456789');
  assert.notEqual(comp2.company_iban, 'DE89370400440532013000');
});

test('Finding 3: hard lock cannot move back or be removed through write()', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { hard_lock_date: '2026-03-31' });
  assert.equal(read(db, 'res.company', 1).hard_lock_date, '2026-03-31');

  db = write(db, 'res.company', 1, { hard_lock_date: '2026-04-30' });
  assert.equal(read(db, 'res.company', 1).hard_lock_date, '2026-04-30');

  assert.throws(() => write(db, 'res.company', 1, { hard_lock_date: '2026-04-15' }), /cannot be moved back/i);
  assert.throws(() => write(db, 'res.company', 1, { hard_lock_date: null }), /cannot be moved back/i);
  assert.throws(() => write(db, 'res.company', 1, { hard_lock_date: '' }), /cannot be moved back/i);
});

test('Finding 10: qr.js reads only document company without global fallback', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Company Two' });
  db = c2.db;
  db = {
    ...db,
    settings: {
      ...db.settings,
      current_company_id: 1,
      invoice_qr: 'zatca',
      company_vat: 'GLOBAL-VAT',
      company_iban: 'GLOBAL-IBAN',
    },
  };
  const comp2 = read(db, 'res.company', c2.id);
  const settings = invoiceQrSettingsForCompany(db, comp2);
  assert.equal(settings.invoice_qr, null);
  assert.equal(settings.company_vat, '');
  assert.equal(settings.company_iban, '');

  const comp1 = read(db, 'res.company', 1);
  const settings1 = invoiceQrSettingsForCompany(db, comp1);
  assert.equal(settings1.invoice_qr, null);
  assert.equal(settings1.company_vat, '');
  assert.equal(settings1.company_iban, '');
});

test('Finding 3: companyLockDate reads only the move company record with no global settings fallback', () => {
  let db = seed();
  // Ensure company 1 has no lock_date
  db = write(db, 'res.company', 1, { lock_date: null, sale_lock_date: null });
  // Set dirty global setting
  db = { ...db, settings: { ...db.settings, lock_date: '2026-03-31', sale_lock_date: '2026-03-31' } };

  const partner = search(db, 'res.partner')[0];
  const journal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id === 1 || !j.company_id));
  const incomeAccount = search(db, 'account.account').find((a) => a.code === '400000' && (a.company_id === 1 || !a.company_id));

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: journal.id,
    partner_id: partner.id,
    invoice_date: '2026-03-15',
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, account_id: incomeAccount.id }],
  });
  // Since company 1 has no lock, posting must succeed without being blocked by db.settings
  assert.doesNotThrow(() => {
    postMove(inv.db, inv.id);
  });
});
