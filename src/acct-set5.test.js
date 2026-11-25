import test from 'node:test';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { create, read, search, write } from './orm.js';
import { diffDb, applyDiff } from './sync.js';
import { apps, models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { postEntry } from './models/ledger.js';
import { createCompany, setCompanies } from './models/company.js';
import { analyticAccountingEnabled, visibleAccountingMenus } from './models/analytic-setting.js';

const toggle = (db, enabled, isAdmin = true) => applyDiff(db, diffDb(db, write(db, 'res.company', 1, { group_analytic_accounting: enabled })), { isAdmin });
const leaves = (items) => items.flatMap((item) => item.children ? leaves(item.children) : [item.key]);

test('SET5-1: analytic accounting defaults off and is an administrator-controlled setting', () => {
  const db = seed();
  assert.equal(analyticAccountingEnabled(db), false);
  assert.throws(() => toggle(db, true, false), /Only administrators/);
  const enabled = toggle(db, true);
  assert.equal(read(enabled, 'res.company', 1).group_analytic_accounting, true);
  assert.equal(analyticAccountingEnabled(toggle(enabled, false)), false);
});

test('SET5-2: menus and move line fields follow setting without changing distributions', () => {
  let db = seed();
  db = create(db, 'account.analytic.plan', { name: 'Projects' }).db;
  const analytic = create(db, 'account.analytic.account', { name: 'Project' }); db = analytic.db;
  const move = create(db, 'account.move', { move_type: 'out_invoice', invoice_line_ids: [{ name: 'Work', qty: 1, price_unit: 10, analytic_distribution: { [analytic.id]: 100 } }] }); db = move.db;
  const menus = apps.find((app) => app.id === 'accounting').menus;
  const keys = ['analytic-items', 'analytic-report', 'analytic-distribution-models', 'analytic', 'analytic-plans'];
  const fields = models['account.move'].fields;
  const visible = (data, type, field) => Object.fromEntries(fields[field].columnsFor({ move_type: type, company_id: 1 }, data)).analytic_distribution;
  for (const enabled of [false, true, false, true]) {
    if (analyticAccountingEnabled(db) !== enabled) db = toggle(db, enabled);
    const shown = leaves(visibleAccountingMenus(menus, db));
    keys.forEach((key) => assert.equal(shown.includes(key), enabled, key));
    for (const type of ['out_invoice', 'in_invoice']) assert.equal(Boolean(visible(db, type, 'invoice_line_ids')), enabled);
    assert.equal(Boolean(visible(db, 'entry', 'line_ids')), enabled);
    assert.deepEqual(read(db, 'account.move', move.id).invoice_line_ids[0].analytic_distribution, { [analytic.id]: 100 });
  }
});


test('SET5: migration preserves analytics for existing companies while fresh databases default off', () => {
  const fresh = seed();
  assert.equal(fresh.schema_version, SCHEMA_VERSION);
  assert.equal(analyticAccountingEnabled(fresh), false);
  const { group_analytic_accounting: _setting, ...legacyCompany } = read(fresh, 'res.company', 1);
  const legacy = { ...fresh, schema_version: 67, records: { ...fresh.records, 'res.company': [legacyCompany, { id: 2 }, { id: 3, group_analytic_accounting: null }, { id: 4, group_analytic_accounting: false }, { id: 5, group_analytic_accounting: true }] } };
  const upgraded = migrate(legacy);
  assert.equal(upgraded.schema_version, 74);
  assert.deepEqual(upgraded.records['res.company'].map((company) => company.group_analytic_accounting), [true, true, true, false, true]);
  assert.equal(analyticAccountingEnabled(upgraded), true);
  assert.ok(leaves(visibleAccountingMenus(apps.find((app) => app.id === 'accounting').menus, upgraded)).includes('analytic-items'));
  assert.ok(Object.fromEntries(models['account.move'].fields.invoice_line_ids.columnsFor({ move_type: 'out_invoice', company_id: 1 }, upgraded)).analytic_distribution);
  assert.equal(migrate(upgraded), upgraded);
  assert.equal(Object.hasOwn(legacy.records['res.company'][0], 'group_analytic_accounting'), false);
});

test('SET5-3: mandatory analytic plans respect the move company setting while retaining stored distributions', () => {
  let db = toggle(seed(), true);
  const plan = create(db, 'account.analytic.plan', { name: 'Projects', default_applicability: 'mandatory' }); db = plan.db;
  const analytic = create(db, 'account.analytic.account', { name: 'Project A', plan_id: plan.id }); db = analytic.db;

  const saleJ = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const miscJ = search(db, 'account.journal').find((j) => j.type === 'general' && (j.company_id ?? 1) === 1);
  const inc = search(db, 'account.account').find((a) => a.account_type === 'income' && (a.company_id ?? 1) === 1);
  const exp = search(db, 'account.account').find((a) => a.account_type === 'expense' && (a.company_id ?? 1) === 1);
  const cash = search(db, 'account.account').find((a) => a.account_type === 'asset_cash' && (a.company_id ?? 1) === 1);
  const partner = search(db, 'res.partner').find((p) => p.customer_rank > 0) ?? search(db, 'res.partner')[0];

  const keptInvoice = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: saleJ.id,
    partner_id: partner.id,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ name: 'Allocated', account_id: inc.id, qty: 1, price_unit: 100, tax: 0, analytic_distribution: { [analytic.id]: 100 } }],
  }); db = keptInvoice.db;
  const keptEntry = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    journal_id: miscJ.id,
    date: '2026-03-01',
    line_ids: [
      { account_id: exp.id, debit: 40, credit: 0, analytic_distribution: { [analytic.id]: 100 } },
      { account_id: cash.id, debit: 0, credit: 40 },
    ],
  }); db = keptEntry.db;

  const unallocInvoice = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: saleJ.id,
    partner_id: partner.id,
    invoice_date: '2026-03-02',
    invoice_line_ids: [{ name: 'Unallocated', account_id: inc.id, qty: 1, price_unit: 120, tax: 0 }],
  }); db = unallocInvoice.db;
  const unallocEntry = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    journal_id: miscJ.id,
    date: '2026-03-02',
    line_ids: [
      { account_id: exp.id, debit: 50, credit: 0 },
      { account_id: cash.id, debit: 0, credit: 50 },
    ],
  }); db = unallocEntry.db;

  assert.throws(() => postMove(db, unallocInvoice.id), /mandatory.*Projects/);
  assert.throws(() => postMove(db, unallocEntry.id), /mandatory.*Projects/);
  assert.throws(() => postEntry(db, {
    journal: miscJ.id,
    company: 1,
    date: '2026-03-02',
    lines: [{ account_id: exp.id, debit: 30 }, { account_id: cash.id, credit: 30 }],
  }), /mandatory.*Projects/);
  assert.throws(() => applyDiff(db, diffDb(db, write(db, 'account.move', unallocEntry.id, { state: 'posted', name: 'MISC/2026/0099' })), { isAdmin: true }), /mandatory.*Projects/);

  // Disable Analytic Accounting on company 1: stored distributions stay intact, unallocated moves post cleanly.
  db = toggle(db, false);
  assert.deepEqual(read(db, 'account.move', keptInvoice.id).invoice_line_ids[0].analytic_distribution, { [analytic.id]: 100 });
  assert.deepEqual(read(db, 'account.move', keptEntry.id).line_ids[0].analytic_distribution, { [analytic.id]: 100 });

  const postedInvDb = postMove(db, unallocInvoice.id);
  assert.equal(read(postedInvDb, 'account.move', unallocInvoice.id).state, 'posted');
  const postedEntryDb = postMove(postedInvDb, unallocEntry.id);
  assert.equal(read(postedEntryDb, 'account.move', unallocEntry.id).state, 'posted');
  const directEntry = postEntry(postedEntryDb, {
    journal: miscJ.id,
    company: 1,
    date: '2026-03-03',
    lines: [{ account_id: exp.id, debit: 30 }, { account_id: cash.id, credit: 30 }],
  });
  assert.equal(read(directEntry.db, 'account.move', directEntry.id).state, 'posted');
  const syncedEntry = applyDiff(db, diffDb(db, write(db, 'account.move', unallocEntry.id, { state: 'posted', name: 'MISC/2026/0099' })), { isAdmin: true });
  assert.equal(read(syncedEntry, 'account.move', unallocEntry.id).state, 'posted');

  // Multi-company: validation follows the move's own company setting, not current_company_id.
  const branch = createCompany(db, { name: 'Enabled Branch', code: 'ENB' });
  db = write(branch.db, 'res.company', branch.id, { group_analytic_accounting: true });
  const branchInc = create(db, 'account.account', { code: '400100', name: 'Branch Sales', account_type: 'income', company_id: branch.id }); db = branchInc.db;
  const branchExp = create(db, 'account.account', { code: '600100', name: 'Branch Expense', account_type: 'expense', company_id: branch.id }); db = branchExp.db;
  const branchCash = create(db, 'account.account', { code: '101500', name: 'Branch Cash', account_type: 'asset_cash', company_id: branch.id }); db = branchCash.db;
  const branchSaleJ = create(db, 'account.journal', { name: 'Branch Sales', code: 'BSL', type: 'sale', company_id: branch.id, default_account_id: branchInc.id }); db = branchSaleJ.db;
  const branchMiscJ = search(db, 'account.journal').find((j) => j.type === 'general' && j.company_id === branch.id);

  const branchInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: branch.id,
    journal_id: branchSaleJ.id,
    partner_id: partner.id,
    invoice_date: '2026-03-04',
    invoice_line_ids: [{ name: 'Branch Unallocated', account_id: branchInc.id, qty: 1, price_unit: 90, tax: 0 }],
  }); db = branchInv.db;
  const branchEntry = create(db, 'account.move', {
    move_type: 'entry',
    company_id: branch.id,
    journal_id: branchMiscJ.id,
    date: '2026-03-04',
    line_ids: [{ account_id: branchExp.id, debit: 20, credit: 0 }, { account_id: branchCash.id, debit: 0, credit: 20 }],
  }); db = branchEntry.db;

  // Active company = 1 (disabled), yet branch (enabled) still enforces mandatory plan.
  db = setCompanies(db, { current: 1, allowed: [1, branch.id] });
  assert.throws(() => postMove(db, branchInv.id), /mandatory.*Projects/);
  assert.throws(() => postMove(db, branchEntry.id), /mandatory.*Projects/);

  // Active company = branch (enabled), yet company 1 (disabled) posts without allocations.
  db = setCompanies(db, { current: branch.id, allowed: [1, branch.id] });
  assert.equal(read(postMove(db, unallocInvoice.id), 'account.move', unallocInvoice.id).state, 'posted');
  assert.equal(read(postMove(db, unallocEntry.id), 'account.move', unallocEntry.id).state, 'posted');
});
