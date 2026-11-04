import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { creditNote, postMove } from './models/accounting.js';
import { today } from './models/common.js';
import { accountId, postEntry } from './models/ledger.js';
import { startSession } from './models/pos.js';

test('sales journal entries respect the sales lock', () => {
  let db = seed();
  db = { ...db, settings: { ...db.settings, sale_lock_date: '2026-12-31' } };
  const journal = db.records['account.journal'].find((j) => j.type === 'sale');
  const accounts = db.records['account.account'];
  const move = create(db, 'account.move', { move_type: 'entry', journal_id: journal.id, date: '2026-01-01', line_ids: [{ account_id: accounts[0].id, debit: 1, credit: 0 }, { account_id: accounts[1].id, debit: 0, credit: 1 }] });
  assert.throws(() => postMove(move.db, move.id), /lock/i);
});

test('current currency rate excludes future rates', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'TEST', rate_ids: [{ date: today(), rate: 1 }, { date: '9999-01-01', rate: 2 }] });
  db = currency.db;
  assert.equal(read(db, 'res.currency', currency.id).current_rate, 1);
});

test('posted account types cannot be reclassified', () => {
  let db = seed();
  const invoice = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 3, invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }],
  });
  db = postMove(invoice.db, invoice.id);
  const receivable = read(db, 'account.move', invoice.id).line_ids.find((line) => line.debit > 0);
  assert.equal(read(db, 'account.account', receivable.account_id).account_type, 'asset_receivable');
  assert.throws(() => write(db, 'account.account', receivable.account_id, { account_type: 'expense' }), /cannot change after journal items/i);
});

test('account code lookup rejects ambiguity and permits company chart copies', () => {
  let db = seed();
  const company = create(db, 'res.company', { name: 'Account copy company' });
  db = company.db;
  const copy = create(db, 'account.account', {
    code: '400000', name: 'Company Sales', account_type: 'income', company_id: company.id,
  });
  db = copy.db;
  assert.equal(accountId(db, '400000', company.id), copy.id);
  assert.throws(() => create(db, 'account.account', {
    code: '400000', name: 'Duplicate company sales', account_type: 'income', company_id: company.id,
  }), /already used for this company/i);

  const duplicate = { ...read(db, 'account.account', accountId(db, '400000')), id: (db.seq['account.account'] ?? 0) + 1 };
  const legacyDb = {
    ...db,
    seq: { ...db.seq, 'account.account': duplicate.id },
    records: { ...db.records, 'account.account': [...db.records['account.account'], duplicate] },
  };
  assert.throws(() => postEntry(legacyDb, {
    journal: 'MISC', lines: [{ account: '400000', debit: 1 }, { account: '101401', credit: 1 }],
  }), /select a record explicitly/i);
});

test('invoice sequences are selected and advanced independently by journal', () => {
  let db = seed();
  const invoiceJournal = read(db, 'account.journal', read(db, 'res.company', 1).default_sale_journal_id);
  const extra = create(db, 'account.journal', {
    name: 'Alternate Sales', code: 'ALT', type: 'sale', company_id: 1,
    invoice_sequence_prefix: 'ALT/', invoice_sequence_next_number: 1, refund_sequence_prefix: 'ALT-R/', refund_sequence_next_number: 1,
    default_account_id: invoiceJournal.default_account_id,
  });
  db = extra.db;
  const unconfigured = create(db, 'account.journal', {
    name: 'Unconfigured Sales', code: 'UNCFG', type: 'sale', company_id: 1,
    default_account_id: invoiceJournal.default_account_id,
  });
  const noSequenceInvoice = create(unconfigured.db, 'account.move', {
    move_type: 'out_invoice', journal_id: unconfigured.id, partner_id: 3, invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }],
  });
  assert.throws(() => postMove(noSequenceInvoice.db, noSequenceInvoice.id), /Configure the invoice sequence prefix/i);

  const noCounter = create(db, 'account.journal', {
    name: 'Journal without a sequence counter', code: 'NOCNT', type: 'sale', company_id: 1,
    invoice_sequence_prefix: 'NOCNT/', default_account_id: invoiceJournal.default_account_id,
  });
  const noCounterInvoice = create(noCounter.db, 'account.move', {
    move_type: 'out_invoice', journal_id: noCounter.id, partner_id: 3, invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }],
  });
  assert.throws(() => postMove(noCounterInvoice.db, noCounterInvoice.id), /positive next invoice sequence number/i);

  const defaulted = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 3, invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }],
  });
  assert.equal(read(defaulted.db, 'account.move', defaulted.id).journal_id, undefined);
  const defaultPosted = postMove(defaulted.db, defaulted.id);
  assert.equal(read(defaultPosted, 'account.move', defaulted.id).journal_id, invoiceJournal.id);

  const noDefaultCompany = create(db, 'res.company', { name: 'Company without an invoice journal' });
  const unassigned = create(noDefaultCompany.db, 'account.move', {
    move_type: 'out_invoice', company_id: noDefaultCompany.id, partner_id: 3, invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }],
  });
  assert.throws(() => postMove(unassigned.db, unassigned.id), /configure a default sales journal/i);

  const first = create(db, 'account.move', {
    move_type: 'out_invoice', journal_id: invoiceJournal.id, partner_id: 3, invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }],
  });
  const currentInvoiceJournal = read(db, 'account.journal', invoiceJournal.id);
  const expectedFirst = `${currentInvoiceJournal.invoice_sequence_prefix}${today().slice(0, 4)}/${String(currentInvoiceJournal.invoice_sequence_next_number).padStart(5, '0')}`;
  db = postMove(first.db, first.id);
  assert.equal(read(db, 'account.move', first.id).name, expectedFirst);
  assert.equal(read(db, 'account.journal', invoiceJournal.id).invoice_sequence_next_number, currentInvoiceJournal.invoice_sequence_next_number + 1);
  const refund = creditNote(db, read(db, 'account.move', first.id));
  const currentRefundJournal = read(db, 'account.journal', invoiceJournal.id);
  const expectedRefund = `${currentRefundJournal.refund_sequence_prefix}${today().slice(0, 4)}/${String(currentRefundJournal.refund_sequence_next_number).padStart(5, '0')}`;
  db = postMove(refund.db, refund.id);
  assert.equal(read(db, 'account.move', refund.id).name, expectedRefund);
  assert.equal(read(db, 'account.journal', invoiceJournal.id).refund_sequence_next_number, currentRefundJournal.refund_sequence_next_number + 1);
  const nextOnFirstJournal = create(db, 'account.move', {
    move_type: 'out_invoice', journal_id: invoiceJournal.id, partner_id: 3, invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 11, tax: 0 }],
  });
  const nextInvoiceJournal = read(db, 'account.journal', invoiceJournal.id);
  const expectedNext = `${nextInvoiceJournal.invoice_sequence_prefix}${today().slice(0, 4)}/${String(nextInvoiceJournal.invoice_sequence_next_number).padStart(5, '0')}`;
  db = postMove(nextOnFirstJournal.db, nextOnFirstJournal.id);
  assert.equal(read(db, 'account.move', nextOnFirstJournal.id).name, expectedNext);
  assert.equal(read(db, 'account.journal', invoiceJournal.id).invoice_sequence_next_number, nextInvoiceJournal.invoice_sequence_next_number + 1);
  const second = create(db, 'account.move', {
    move_type: 'out_invoice', journal_id: extra.id, partner_id: 3, invoice_date: today(),
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 10, tax: 0 }],
  });
  const alternateJournal = read(db, 'account.journal', extra.id);
  db = postMove(second.db, second.id);
  assert.equal(read(db, 'account.move', second.id).name, `${alternateJournal.invoice_sequence_prefix}${today().slice(0, 4)}/${String(alternateJournal.invoice_sequence_next_number).padStart(5, '0')}`);
  assert.equal(read(db, 'account.journal', extra.id).invoice_sequence_next_number, alternateJournal.invoice_sequence_next_number + 1);
});

test('foreign currency rate is empty when missing while the company currency remains one', () => {
  const db = seed();
  const currency = create(db, 'res.currency', { name: 'NO-RATE', rate_ids: [] });
  assert.equal(read(currency.db, 'res.currency', currency.id).current_rate, null);
  const companyCurrency = read(db, 'res.company', 1).currency_id;
  assert.equal(read(db, 'res.currency', companyCurrency).current_rate, 1);
});

test('POS sessions use an explicitly configured default configuration and journal', () => {
  const db = seed();
  const config = read(db, 'pos.config', db.settings.default_pos_config_id);
  const started = startSession(db);
  const session = read(started.db, 'pos.session', started.id);
  assert.equal(session.config_id, config.id);
  assert.equal(session.journal_id, config.journal_id);

  const noDefault = { ...db, settings: { ...db.settings, default_pos_config_id: null } };
  assert.throws(() => startSession(noDefault), /Select a point of sale configuration or configure a default/i);
  const noJournal = write(db, 'pos.config', config.id, { journal_id: null });
  assert.throws(() => startSession(noJournal), /Configure a sales journal for this point of sale configuration and company/i);
});
