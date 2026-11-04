import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { create, read, search, updateSettings, write } from './orm.js';
import { configureCompanyChart, createCompany } from './models/company.js';
import { postMove } from './models/accounting.js';
import { confirmAsset } from './models/assets.js';
import { accountId, journalItems } from './models/ledger.js';

const reset = (db, id) => models['account.move'].form.buttons.find((b) => b.label === 'Reset to Draft').run(db, read(db, 'account.move', id)).db;
const billWithAsset = () => {
  let db = seed();
  const fixed = accountId(db, '151000');
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 2, invoice_date: '2025-01-01', invoice_line_ids: [{ name: 'Machine', qty: 1, price_unit: 100, tax: 0, account_id: fixed }] });
  db = postMove(bill.db, bill.id);
  return { db, id: bill.id, fixed, asset: search(db, 'account.asset').find((a) => a.bill_id === bill.id) };
};

test('foreign credit settlement uses the document company and booked counterpart', () => {
  for (const [type, refund, partner, counterpartType] of [['out_invoice', 'out_refund', 2, 'asset_receivable'], ['in_invoice', 'in_refund', 3, 'liability_payable']]) {
    let db = seed();
    const company = createCompany(db, { name: 'Other company' });
    db = updateSettings(company.db, { current_company_id: 1, allowed_company_ids: [1, company.id] });
    let counterpart;
    const accountDefaults = {};
    for (const [code, accountType] of [['121000', 'asset_receivable'], ['211000', 'liability_payable'], ['FXGAIN', 'income_other'], ['FXLOSS', 'expense_other']]) {
      const account = create(db, 'account.account', { company_id: company.id, code, name: code, account_type: accountType });
      db = account.db;
      if (accountType === counterpartType) counterpart = account.id;
      if (accountType === 'asset_receivable') accountDefaults.receivable = account.id;
      if (accountType === 'liability_payable') accountDefaults.payable = account.id;
      if (code === 'FXGAIN') db = write(db, 'res.company', company.id, { income_currency_exchange_account_id: account.id });
      if (code === 'FXLOSS') db = write(db, 'res.company', company.id, { expense_currency_exchange_account_id: account.id });
    }
    const companyConfig = read(db, 'res.company', company.id);
    db = configureCompanyChart(db, company.id, {
      account_receivable_id: accountDefaults.receivable,
      account_payable_id: accountDefaults.payable,
      default_payment_journal_id: companyConfig.default_payment_journal_id,
    });
    const currency = create(db, 'res.currency', { name: 'Foreign', rate_ids: [{ date: '2037-01-01', rate: 2 }, { date: '2037-02-01', rate: 1 }] });
    const document = create(currency.db, 'account.move', { move_type: type, company_id: company.id, partner_id: partner, currency_id: currency.id, invoice_date: '2037-01-02', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
    db = postMove(document.db, document.id);
    const note = create(db, 'account.move', { move_type: refund, company_id: company.id, partner_id: partner, currency_id: currency.id, reversed_entry_id: document.id, invoice_date: '2037-02-02', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
    db = postMove(note.db, note.id);
    const entry = search(db, 'account.move').find((m) => m.ref === `Exchange difference ${read(db, 'account.move', note.id).name}`);
    assert.equal(entry.company_id, company.id);
    assert.equal(entry.line_ids.find((l) => l.account_id === counterpart)?.partner_id, partner);
    const configured = read(db, 'res.company', company.id);
    assert.ok(entry.line_ids.some((l) => [configured.income_currency_exchange_account_id, configured.expense_currency_exchange_account_id].includes(l.account_id)));
    assert.equal(journalItems(db, { company_id: company.id }).filter((l) => l.account_id === counterpart && l.partner_id === partner).reduce((sum, l) => sum + l.debit - l.credit, 0), 0);
    assert.equal(read(db, 'account.move', document.id).amount_residual, 0);
    assert.equal(read(db, 'account.move', note.id).amount_residual, 0);
  }
});

test('bill reset rejects active or depreciated assets through button and direct write', () => {
  const fixture = billWithAsset();
  const active = confirmAsset(fixture.db, fixture.asset);
  for (const state of ['open', 'paused', 'close', 'draft']) {
    const db = state === 'draft' ? write(active, 'account.asset', fixture.asset.id, { state, depreciation_ids: [{ posted: true }] }) : write(active, 'account.asset', fixture.asset.id, { state });
    assert.throws(() => reset(db, fixture.id), /assets/);
    assert.throws(() => write(db, 'account.move', fixture.id, { state: 'draft' }), /assets/);
    assert.equal(read(db, 'account.move', fixture.id).state, 'posted');
  }
});

test('reposting a bill refreshes its draft asset without duplicates', () => {
  const { id, fixed, asset, db: initial } = billWithAsset();
  let db = reset(initial, id);
  db = write(db, 'account.move', id, { invoice_line_ids: [{ name: 'Updated machine', qty: 1, price_unit: 200, tax: 0, account_id: fixed }] });
  db = postMove(db, id);
  const assets = search(db, 'account.asset').filter((a) => a.bill_id === id);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].id, asset.id);
  assert.equal(assets[0].original_value, 200);
  assert.equal(assets[0].name, 'Updated machine');
});
