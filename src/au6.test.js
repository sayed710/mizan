import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, write } from './orm.js';
import { seed } from './seed.js';
import { closeFiscalYear, reopenFiscalYear } from './models/closing.js';
import { creditNote, postMove } from './models/accounting.js';
import { generateGroupedEntries } from './models/deferred.js';
import { confirmAsset, disposeAsset } from './models/assets.js';
import { accountId, isBalanced, journalItems, postEntry } from './models/ledger.js';
import { closedYearLock } from './models/finance.js';

test('Finding 11: Fiscal year closing locks the fiscal period without mutating company lock_date', () => {
  let db = seed();
  const fy = create(db, 'account.fiscal.year', {
    name: '2024',
    company_id: 1,
    date_from: '2024-01-01',
    date_to: '2024-12-31',
  });
  db = fy.db;
  db = closeFiscalYear(db, fy.id);

  const comp = read(db, 'res.company', 1);
  // res.company.lock_date remains unchanged (admin-controlled setting preserved)
  assert.equal(comp.lock_date, undefined);
  // Period lock is actively enforced dynamically through closedYearLock
  assert.equal(closedYearLock(db, 1), '2024-12-31');

  // Attempting to post an entry dated inside the closed fiscal year is rejected
  assert.throws(
    () => postEntry(db, {
      journal: 'MISC',
      company: 1,
      date: '2024-12-31',
      ref: 'Adjustment',
      lines: [
        { account: '101401', debit: 100 },
        { account: '400000', credit: 100 },
      ],
    }),
    /locked/i,
  );

  // Reopening the fiscal year clears the closedYearLock
  db = reopenFiscalYear(db, fy.id);
  assert.equal(closedYearLock(db, 1), '');
});

test('Finding 12: Credit note deferral adjustment books on the credit note date rather than backdating to a closed year', () => {
  let db = write(seed(), 'res.company', 1, {
    deferred_generation_method: 'manual_grouped',
    deferred_amount_computation_method: 'full_months',
  });

  // Invoice in 2024 with 3 months deferral: Oct, Nov, Dec 2024
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2024-10-01',
    invoice_line_ids: [{
      name: 'Annual Subscription Q4',
      qty: 1,
      price_unit: 120,
      tax: 0,
      deferred_start_date: '2024-10-01',
      deferred_end_date: '2024-12-31',
    }],
  });
  db = postMove(inv.db, inv.id);

  // Grouped deferral generated at year end 2024-12-31
  db = generateGroupedEntries(db, { company_id: 1, kind: 'revenue', date: '2024-12-31' });

  // Fiscal year 2024 is closed
  const fy = create(db, 'account.fiscal.year', {
    name: '2024',
    company_id: 1,
    date_from: '2024-01-01',
    date_to: '2024-12-31',
  });
  db = closeFiscalYear(fy.db, fy.id);

  // Credit note issued in 2025 (2025-01-15) for partial refund of 60
  const cnDraft = creditNote(db, read(db, 'account.move', inv.id), { date: '2025-01-15' });
  const cnLine = read(cnDraft.db, 'account.move', cnDraft.id).invoice_line_ids.map((line) => ({ ...line, price_unit: 60 }));
  const cnWithLines = write(cnDraft.db, 'account.move', cnDraft.id, { invoice_line_ids: cnLine });

  // Posting credit note must succeed without backdating into locked FY 2024
  db = postMove(cnWithLines, cnDraft.id);

  const adjustments = (db.records['account.move'] ?? []).filter((m) =>
    m.state === 'posted' && (m.ref ?? '').includes('Deferred recognition adjustment')
  );
  assert.ok(adjustments.length > 0, 'Adjustment moves must be created');
  for (const adj of adjustments) {
    const adjDate = adj.date ?? adj.invoice_date;
    assert.equal(adjDate, '2025-01-15', 'Adjustment move date must match the credit note date');
    assert.ok(isBalanced(adj.line_ids), 'Adjustment entry must be balanced');
  }
});

test('Finding 14: Asset disposal clears the invoice line account and does not force sales revenue', () => {
  let db = seed();
  const clearingAccountId = accountId(db, '101401');
  const assetAccountId = accountId(db, '151000');
  const depAccountId = accountId(db, '152000');
  const gainAccountId = accountId(db, '450300');

  // Asset with original value $10,000.00 and already depreciated $6,000.00 (book value $4,000.00)
  const assetCreated = create(db, 'account.asset', {
    name: 'Industrial Machine',
    acquisition_date: '2024-01-01',
    original_value: 10000,
    salvage_value: 0,
    already_depreciated: 6000,
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_asset_id: assetAccountId,
    account_depreciation_id: depAccountId,
    account_depreciation_expense_id: accountId(db, '680000'),
  });
  db = confirmAsset(assetCreated.db, read(assetCreated.db, 'account.asset', assetCreated.id));

  // Customer invoice for selling the asset for $5,000.00 booked to clearing account 101401
  const invoiceCreated = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2024-06-30',
    invoice_line_ids: [{
      name: 'Sale of Industrial Machine',
      qty: 1,
      price_unit: 5000,
      tax: 0,
      account_id: clearingAccountId,
    }],
  });
  db = postMove(invoiceCreated.db, invoiceCreated.id);

  // Dispose asset against the sale invoice
  db = disposeAsset(db, read(db, 'account.asset', assetCreated.id), {
    date: '2024-06-30',
    saleValue: 5000,
    invoiceId: invoiceCreated.id,
    invoiceLine: 0,
  });

  const disposedAsset = read(db, 'account.asset', assetCreated.id);
  assert.equal(disposedAsset.state, 'close');
  assert.equal(disposedAsset.book_value, 0);
  assert.equal(disposedAsset.sale_value, 5000);

  const disposalMove = (db.records['account.move'] ?? []).find((m) => m.ref === 'Industrial Machine disposal');
  assert.ok(disposalMove, 'Disposal move must exist');
  assert.ok(isBalanced(disposalMove.line_ids), 'Disposal move must be balanced');

  // Disposal move lines:
  // Credit Asset $10,000
  // Debit Accumulated Depreciation $6,000
  // Debit Clearing Account $5,000
  // Credit Gain on Disposal $1,000
  const lineFor = (accId) => disposalMove.line_ids.find((l) => l.account_id === accId);
  assert.equal(lineFor(assetAccountId).credit, 10000);
  assert.equal(lineFor(depAccountId).debit, 6000);
  assert.equal(lineFor(clearingAccountId).debit, 5000);
  assert.equal(lineFor(gainAccountId).credit, 1000);

  // Clearing account 101401 nets to 0 from the invoice credit ($5,000) and disposal debit ($5,000)
  const clearingItems = journalItems(db, { from: '2024-01-01', to: '2024-12-31' })
    .filter((l) => l.account_id === clearingAccountId && (l.move_id === invoiceCreated.id || l.move_id === disposalMove.id));
  const netClearing = clearingItems.reduce((sum, l) => sum + (l.debit || 0) - (l.credit || 0), 0);
  assert.equal(netClearing, 0, 'Clearing account must net to zero across invoice and disposal move');

  // Verify that an invoice line booked to a sales revenue account (400000) is also offset to net zero
  const revenueAccountId = accountId(db, '400000');
  const asset2 = create(db, 'account.asset', {
    name: 'Office Equipment',
    acquisition_date: '2024-01-01',
    original_value: 2000,
    salvage_value: 0,
    already_depreciated: 1200,
    method: 'linear',
    method_number: 5,
    method_period: '12',
    account_asset_id: assetAccountId,
    account_depreciation_id: depAccountId,
    account_depreciation_expense_id: accountId(db, '680000'),
  });
  db = confirmAsset(asset2.db, read(asset2.db, 'account.asset', asset2.id));

  const invoice2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2024-06-30',
    invoice_line_ids: [{
      name: 'Sale of Office Equipment',
      qty: 1,
      price_unit: 1000,
      tax: 0,
      account_id: revenueAccountId,
    }],
  });
  db = postMove(invoice2.db, invoice2.id);

  db = disposeAsset(db, read(db, 'account.asset', asset2.id), {
    date: '2024-06-30',
    saleValue: 1000,
    invoiceId: invoice2.id,
    invoiceLine: 0,
  });

  const disposal2 = (db.records['account.move'] ?? []).find((m) => m.ref === 'Office Equipment disposal');
  assert.ok(disposal2);
  const revenueItems = journalItems(db, { from: '2024-01-01', to: '2024-12-31' })
    .filter((l) => l.account_id === revenueAccountId && (l.move_id === invoice2.id || l.move_id === disposal2.id));
  const netRevenue = revenueItems.reduce((sum, l) => sum + (l.debit || 0) - (l.credit || 0), 0);
  assert.equal(netRevenue, 0, 'Revenue account is also debited and credited equally, netting to 0');
});
