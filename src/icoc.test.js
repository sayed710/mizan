import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { createCompany, ensureMainCompany } from './models/company.js';
import { postMove } from './models/accounting.js';
import { consolidate } from './models/consolidation.js';
import { models } from './models/index.js';

test('consolidation uses accounting date rather than invoice date', () => {
  const db = ensureMainCompany(seed());
  const company = read(db, 'res.company', 1);
  const chart = create(db, 'consolidation.chart', { name: 'Group', currency_id: company.currency_id, company_ids: [{ company_id: 1, method: 'full', ownership: 100 }], account_ids: [{ code: 'SALES', name: 'Sales', account_type: 'income', source_codes: '400000' }] });
  const period = create(chart.db, 'consolidation.period', { chart_id: chart.id, date_from: '2026-01-01', date_to: '2026-12-31' });
  const baseline = consolidate(period.db, period.id).lines.find((line) => line.group_code === 'SALES').total;
  const invoice = create(period.db, 'account.move', { company_id: 1, move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-12-01', date: '2027-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const posted = postMove(invoice.db, invoice.id);
  assert.equal(read(posted, 'account.move', invoice.id).date, '2027-01-01');
  assert.equal(consolidate(posted, period.id).lines.find((line) => line.group_code === 'SALES').total, baseline);
});

test('invoice posting uses configured company and partner receivable accounts', () => {
  let db = seed();
  const companyAccount = create(db, 'account.account', { name: 'Custom receivable', code: 'CUSTOM-AR', account_type: 'asset_receivable', company_id: 1 });
  const partnerAccount = create(companyAccount.db, 'account.account', { name: 'Partner receivable', code: 'PARTNER-AR', account_type: 'asset_receivable', company_id: 1 });
  db = write(partnerAccount.db, 'res.company', 1, { account_default_receivable_id: companyAccount.id });
  const make = (current) => create(current, 'account.move', { company_id: 1, move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  let invoice = make(db);
  db = postMove(invoice.db, invoice.id);
  assert.ok(read(db, 'account.move', invoice.id).line_ids.some((line) => line.account_id === companyAccount.id));
  db = write(db, 'res.partner', 1, { property_account_receivable_id: partnerAccount.id });
  invoice = make(db);
  db = postMove(invoice.db, invoice.id);
  assert.ok(read(db, 'account.move', invoice.id).line_ids.some((line) => line.account_id === partnerAccount.id));
  assert.throws(() => write(db, 'res.company', 1, { account_default_receivable_id: read(db, 'res.company', 1).account_default_payable_id }), /receivable/i);
});

test('posting an intercompany invoice creates a linked draft vendor bill', () => {
  const base = seed();
  const buyer = createCompany(base, { name: 'Buyer', currency_id: read(base, 'res.company', 1).currency_id, intercompany_rule: 'invoice_bill' });
  const expense = create(buyer.db, 'account.account', { name: 'Buyer expense', code: 'BUY-EXP', account_type: 'expense', company_id: buyer.id });
  const journal = create(expense.db, 'account.journal', { name: 'Buyer purchases', code: 'BP', type: 'purchase', company_id: buyer.id, default_account_id: expense.id });
  const configured = write(journal.db, 'res.company', buyer.id, { intercompany_journal_id: journal.id });
  const invoice = create(configured, 'account.move', { company_id: 1, move_type: 'out_invoice', partner_id: read(configured, 'res.company', buyer.id).partner_id, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const db = postMove(invoice.db, invoice.id);
  const source = read(db, 'account.move', invoice.id);
  const bill = read(db, 'account.move', source.intercompany_move_id);
  assert.equal(bill?.state, 'draft');
  assert.equal(bill?.move_type, 'in_invoice');
  assert.equal(bill?.company_id, buyer.id);
  assert.equal(bill?.journal_id, journal.id);
  assert.equal(bill?.intercompany_move_id, invoice.id);
  const reset = models['account.move'].form.buttons.find((button) => button.label === 'Reset to Draft');
  const withPostedBill = postMove(db, bill.id);
  assert.throws(() => reset.run(withPostedBill, read(withPostedBill, 'account.move', source.id)), /credit note/i);
  const resetDb = reset.run(db, source).db;
  assert.equal(read(resetDb, 'account.move', bill.id).state, 'cancel');
  const reposted = postMove(resetDb, source.id);
  const replacement = read(reposted, 'account.move', read(reposted, 'account.move', source.id).intercompany_move_id);
  assert.equal(replacement?.state, 'draft');
  assert.notEqual(replacement.id, bill.id);
});

test('consolidation reports an unlinked intercompany invoice without eliminating it', () => {
  const base = seed();
  const buyer = createCompany(base, { name: 'Buyer', currency_id: read(base, 'res.company', 1).currency_id });
  const chart = create(buyer.db, 'consolidation.chart', { name: 'Group', currency_id: read(base, 'res.company', 1).currency_id, company_ids: [{ company_id: 1, method: 'full', ownership: 100 }, { company_id: buyer.id, method: 'full', ownership: 100 }], account_ids: [{ code: 'AR', name: 'Receivables', account_type: 'asset_receivable', source_codes: '121000' }, { code: 'SALES', name: 'Sales', account_type: 'income', source_codes: '400000' }] });
  const period = create(chart.db, 'consolidation.period', { chart_id: chart.id, date_from: '2026-01-01', date_to: '2026-12-31' });
  const invoice = create(period.db, 'account.move', { company_id: 1, move_type: 'out_invoice', partner_id: read(period.db, 'res.company', buyer.id).partner_id, invoice_date: '2026-01-01', invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 100, tax: 0 }] });
  const result = consolidate(postMove(invoice.db, invoice.id), period.id);
  assert.equal(result.lines.find((line) => line.group_code === 'AR').eliminations, 0);
  assert.equal(result.lines.find((line) => line.group_code === 'SALES').eliminations, 0);
  assert.ok(result.unmatched.some((row) => row.move_id === invoice.id));
});
