import './models/index.js';
import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './registry.js';
import { postMove } from './models/accounting.js';
import { accountId, isBalanced } from './models/ledger.js';
import { addDays } from './models/common.js';
import { generateGroupedEntries } from './models/deferred.js';
import { deferredReport } from './models/reports.js';
import { applyDiff, diffDb } from './sync.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const reactProps = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));
function findAll(node, predicate) {
  const result = [];
  const walk = (n) => {
    if (!n) return;
    if (predicate(n)) result.push(n);
    for (const child of n.childNodes ?? []) walk(child);
  };
  walk(node);
  return result;
}

test('dfr4-1: computation basis day / month / full_months splits mid-month start and end periods per Odoo', () => {
  const base = seed();
  // Guard rejects invalid computation method even through diffDb + applyDiff
  const badCompDb = {
    ...base,
    records: {
      ...base.records,
      'res.company': base.records['res.company'].map((c) => (
        c.id === 1 ? { ...c, deferred_revenue_amount_computation_method: 'invalid_basis' } : c
      )),
    },
  };
  assert.throws(
    () => applyDiff(base, diffDb(base, badCompDb), { isAdmin: true }),
    /deferred_revenue_amount_computation_method|computation method/i,
  );

  // Mid-month start and end: 2026-01-15 to 2026-03-15
  // Jan 15..31 = 17 days (of 31), Feb 1..28 = 28 days (of 28), Mar 1..15 = 15 days (of 31); total = 60 days.
  // Months weights: 17/31, 1, 15/31 (sum = 63/31).
  const cases = [
    { method: 'day', revExpected: [283.33, 466.67, 250], expExpected: [170, 280, 150] },
    { method: 'month', revExpected: [269.84, 492.06, 238.1], expExpected: [161.9, 295.24, 142.86] },
    { method: 'full_months', revExpected: [333.34, 333.33, 333.33], expExpected: [200, 200, 200] },
  ];

  for (const { method, revExpected, expExpected } of cases) {
    let db = write(seed(), 'res.company', 1, {
      generate_deferred_revenue_entries_method: 'manual',
      generate_deferred_expense_entries_method: 'manual',
      deferred_revenue_amount_computation_method: method,
      deferred_expense_amount_computation_method: method,
      deferred_revenue_account_id: accountId(base, '212000'),
      deferred_expense_account_id: accountId(base, '132000'),
    });

    const inv = create(db, 'account.move', {
      move_type: 'out_invoice',
      partner_id: 2,
      invoice_date: '2026-01-15',
      invoice_line_ids: [{
        name: 'Mid-month Revenue',
        qty: 1,
        price_unit: 1000,
        tax: 0,
        account_id: accountId(db, '410000'),
        deferred_start_date: '2026-01-15',
        deferred_end_date: '2026-03-15',
      }],
    });
    db = postMove(inv.db, inv.id);
    const revSched = search(db, 'account.deferral').find((d) => d.source_move_id === inv.id);
    assert.deepEqual(revSched.board.map((l) => l.amount), revExpected, `${method} revenue split`);

    const bill = create(db, 'account.move', {
      move_type: 'in_invoice',
      partner_id: 1,
      invoice_date: '2026-01-15',
      invoice_line_ids: [{
        name: 'Mid-month Expense',
        qty: 1,
        price_unit: 600,
        tax: 0,
        account_id: accountId(db, '600000'),
        deferred_start_date: '2026-01-15',
        deferred_end_date: '2026-03-15',
      }],
    });
    db = postMove(bill.db, bill.id);
    const expSched = search(db, 'account.deferral').find((d) => d.source_move_id === bill.id);
    assert.deepEqual(expSched.board.map((l) => l.amount), expExpected, `${method} expense split`);
  }
});

test('dfr4-2: deferred dates are per invoice/bill line, visible on lines, and validated through guards and sync', async () => {
  const base = seed();
  assert.equal(models['account.move'].fields.deferred_start_date, undefined);
  assert.equal(models['account.move'].fields.deferred_end_date, undefined);
  assert.equal(models['account.move'].fields.invoice_line_ids.fields.deferred_start_date.type, 'date');
  assert.equal(models['account.move'].fields.invoice_line_ids.fields.deferred_end_date.type, 'date');

  // Verify two lines on the same invoice create separate per-line schedules while non-deferred line does not
  let db = write(base, 'res.company', 1, {
    generate_deferred_revenue_entries_method: 'manual',
    deferred_revenue_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(base, '212000'),
  });
  const multiLineInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [
      {
        name: 'Plan A',
        qty: 1,
        price_unit: 200,
        tax: 0,
        account_id: accountId(db, '410000'),
        deferred_start_date: '2026-01-01',
        deferred_end_date: '2026-02-28',
      },
      {
        name: 'Plan B',
        qty: 1,
        price_unit: 300,
        tax: 0,
        account_id: accountId(db, '410000'),
        deferred_start_date: '2026-03-01',
        deferred_end_date: '2026-05-31',
      },
      {
        name: 'Immediate Setup Fee',
        qty: 1,
        price_unit: 50,
        tax: 0,
        account_id: accountId(db, '410000'),
      },
    ],
  });
  db = postMove(multiLineInv.db, multiLineInv.id);
  const schedules = search(db, 'account.deferral').filter((d) => d.source_move_id === multiLineInv.id);
  assert.equal(schedules.length, 2, 'Two deferred lines create two independent schedules');
  assert.deepEqual(
    schedules.map((s) => [s.start_date, s.end_date, s.amount]),
    [['2026-01-01', '2026-02-28', 200], ['2026-03-01', '2026-05-31', 300]],
  );

  // Validation: missing end date, missing start date, start > end, invalid calendar date, section line with dates,
  // and mandatory is_deferred account without dates must all fail through both model writes and diffDb + applyDiff.
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Valid line', qty: 1, price_unit: 100, tax: 0, account_id: accountId(db, '410000') }],
  });
  const baseDraftDb = draftInv.db;

  const invalidLineSpecs = [
    { name: 'Only start', qty: 1, price_unit: 100, tax: 0, account_id: accountId(db, '410000'), deferred_start_date: '2026-01-01' },
    { name: 'Start after end', qty: 1, price_unit: 100, tax: 0, account_id: accountId(db, '410000'), deferred_start_date: '2026-03-01', deferred_end_date: '2026-02-01' },
    { name: 'Invalid calendar date', qty: 1, price_unit: 100, tax: 0, account_id: accountId(db, '410000'), deferred_start_date: '2026-02-30', deferred_end_date: '2026-03-31' },
    { display_type: 'line_section', name: 'Section', qty: 0, price_unit: 0, deferred_start_date: '2026-01-01', deferred_end_date: '2026-01-31' },
  ];

  // Odoo lets a draft keep an end date alone while the user is still entering dates.
  const endOnly = write(baseDraftDb, 'account.move', draftInv.id, { invoice_line_ids: [{ name: 'Only end', qty: 1, price_unit: 100, tax: 0, account_id: accountId(db, '410000'), deferred_end_date: '2026-01-31' }] });
  assert.equal(read(endOnly, 'account.move', draftInv.id).invoice_line_ids[0].deferred_end_date, '2026-01-31');

  for (const badLine of invalidLineSpecs) {
    assert.throws(
      () => write(baseDraftDb, 'account.move', draftInv.id, { invoice_line_ids: [badLine] }),
      /deferred start and end dates/i,
    );
    const forged = {
      ...baseDraftDb,
      records: {
        ...baseDraftDb.records,
        'account.move': baseDraftDb.records['account.move'].map((m) => (
          m.id === draftInv.id ? { ...m, invoice_line_ids: [badLine] } : m
        )),
      },
    };
    assert.throws(
      () => applyDiff(baseDraftDb, diffDb(baseDraftDb, forged), { isAdmin: false, author: 'Clerk' }),
      /deferred start and end dates/i,
    );
  }

  // Mandatory is_deferred account without dates cannot be posted even if forged via diffDb + applyDiff
  const reqDefAcc = create(baseDraftDb, 'account.account', {
    code: '410955',
    name: 'Mandatory Deferred Revenue',
    account_type: 'income',
    company_id: 1,
    is_deferred: true,
  });
  const billDraft = create(reqDefAcc.db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Sub', qty: 1, price_unit: 100, tax: 0, account_id: reqDefAcc.id }],
  });
  assert.throws(() => postMove(billDraft.db, billDraft.id), /deferred start and end dates/i);
  const forgedPosted = {
    ...billDraft.db,
    records: {
      ...billDraft.db.records,
      'account.move': billDraft.db.records['account.move'].map((m) => (
        m.id === billDraft.id
          ? {
              ...m,
              state: 'posted',
              name: 'INV/2026/99999',
              line_ids: [
                { account_id: accountId(billDraft.db, '121000'), debit: 100, credit: 0, partner_id: 2 },
                { account_id: reqDefAcc.id, debit: 0, credit: 100, partner_id: 2 },
              ],
            }
          : m
      )),
    },
  };
  assert.throws(
    () => applyDiff(billDraft.db, diffDb(billDraft.db, forgedPosted), { isAdmin: false, author: 'Clerk' }),
    /deferred start and end dates/i,
  );

  // UI: invoice form shows Deferred Start Date and Deferred End Date columns on invoice_line_ids when toggled on
  const editableDraftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [
      {
        name: 'Draft Plan A',
        qty: 1,
        price_unit: 200,
        tax: 0,
        account_id: accountId(db, '410000'),
        deferred_start_date: '2026-01-01',
        deferred_end_date: '2026-05-31',
      },
    ],
  });
  const { makeEl } = setupDom();
  globalThis.localStorage?.clear?.();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(editableDraftInv.db));
  const { FormView } = await import('./views/FormView.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(React.createElement(FormView, {
        leaf: { model: 'account.move', form: models['account.move'].form },
        id: String(editableDraftInv.id),
        base: '#/accounting/invoices',
        params: new URLSearchParams(),
      }));
    });
    const optBtn = find(host, (n) => n.tagName === 'BUTTON' && reactProps(n)?.className === 'o2m-cols-toggle');
    assert.ok(optBtn, 'Optional columns toggle exists on invoice lines table');
    await React.act(async () => {
      reactProps(optBtn).onClick();
    });
    const startItem = find(host, (n) => reactProps(n)?.role === 'menuitemcheckbox' && textOf(n).includes('Deferred Start Date'));
    const endItem = find(host, (n) => reactProps(n)?.role === 'menuitemcheckbox' && textOf(n).includes('Deferred End Date'));
    assert.ok(startItem && endItem, 'Deferred Start Date and Deferred End Date appear in invoice line columns menu');
    await React.act(async () => {
      reactProps(startItem).onClick();
      reactProps(endItem).onClick();
    });
    const dateInputs = findAll(host, (n) => n.tagName === 'INPUT' && reactProps(n)?.type === 'date');
    assert.ok(dateInputs.some((n) => reactProps(n).value === '2026-01-01'), 'Line-level deferred_start_date input renders on invoice line');
    assert.ok(dateInputs.some((n) => reactProps(n).value === '2026-05-31'), 'Line-level deferred_end_date input renders on invoice line');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('dfr4-3: generation setting switches between on_validation and manual grouped with idempotent Generate Entries + reversal', async () => {
  // 1. On invoice validation mode posts recognition automatically; Generate Entries is disabled on report
  let db = write(seed(), 'res.company', 1, {
    generate_deferred_revenue_entries_method: 'on_validation',
    deferred_revenue_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(seed(), '212000'),
  });
  const autoInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Auto Sub',
      qty: 1,
      price_unit: 200,
      tax: 0,
      account_id: accountId(db, '410000'),
      deferred_start_date: '2026-01-01',
      deferred_end_date: '2026-02-28',
    }],
  });
  db = postMove(autoInv.db, autoInv.id);
  const autoSched = search(db, 'account.deferral').find((d) => d.source_move_id === autoInv.id);
  assert.equal(autoSched.board.every((l) => l.posted && l.move_id), true, 'On validation posts recognition entries immediately');

  // 2. Manual & Grouped mode: posting creates schedule only; Generate Entries creates 1 entry + 1 next-day reversal once
  db = write(seed(), 'res.company', 1, {
    generate_deferred_revenue_entries_method: 'manual',
    generate_deferred_expense_entries_method: 'manual',
    deferred_revenue_amount_computation_method: 'full_months',
    deferred_expense_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(seed(), '212000'),
    deferred_expense_account_id: accountId(seed(), '132000'),
  });
  const invJan = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Manual Sub',
      qty: 1,
      price_unit: 300,
      tax: 0,
      account_id: accountId(db, '410000'),
      deferred_start_date: '2026-01-01',
      deferred_end_date: '2026-03-31',
    }],
  });
  db = postMove(invJan.db, invJan.id);
  // Invoice dated in March with start date in Jan must NOT be recognized in Jan Generate Entries
  const invMar = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{
      name: 'Future Billed Contract',
      qty: 1,
      price_unit: 300,
      tax: 0,
      account_id: accountId(db, '410000'),
      deferred_start_date: '2026-01-01',
      deferred_end_date: '2026-03-31',
    }],
  });
  db = postMove(invMar.db, invMar.id);

  assert.equal(search(db, 'account.move').filter((m) => m.is_deferred_grouped).length, 0);

  const afterFirst = generateGroupedEntries(db, { date: '2026-01-31', company_id: 1, kind: 'revenue' });
  const groupedJan = search(afterFirst, 'account.move').filter((m) => m.is_deferred_grouped);
  assert.equal(groupedJan.length, 2, 'Generates 1 grouped entry and 1 reversal');
  const mainJan = groupedJan.find((m) => !m.reversed_entry_id);
  const revJan = read(afterFirst, 'account.move', mainJan.reversal_move_id);
  assert.equal(mainJan.deferral_date, '2026-01-31');
  assert.equal(revJan.deferral_date, addDays('2026-01-31', 1));
  assert.ok(isBalanced(mainJan.line_ids) && isBalanced(revJan.line_ids));
  assert.equal(mainJan.line_ids.find((l) => l.account_id === accountId(afterFirst, '410000'))?.credit, 100, 'Only the Jan-dated invoice is recognized in Jan');

  // Running twice creates nothing new
  const afterSecond = generateGroupedEntries(afterFirst, { date: '2026-01-31', company_id: 1, kind: 'revenue' });
  assert.equal(afterSecond, afterFirst, 'Running Generate Entries twice for same period creates nothing new');
});

test('dfr4-4: deferred reports show Not Started and period columns accurately including unlinked credit notes', async () => {
  let db = write(seed(), 'res.company', 1, {
    generate_deferred_revenue_entries_method: 'manual',
    deferred_revenue_amount_computation_method: 'full_months',
    deferred_revenue_account_id: accountId(seed(), '212000'),
  });
  const revAcc = accountId(db, '410000');

  // Schedule 1: Jan-Mar 2026 (300 -> 100/mo)
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{
      name: 'Active Contract', qty: 1, price_unit: 300, tax: 0, account_id: revAcc,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  db = postMove(inv1.db, inv1.id);

  // Schedule 2: Starts in April 2026 (120) + spans into April 2027 (60 after 12 months from Feb 2026)
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{
      name: 'Future Contract', qty: 1, price_unit: 130, tax: 0, account_id: revAcc,
      deferred_start_date: '2026-04-01', deferred_end_date: '2027-04-30',
    }],
  });
  db = postMove(inv2.db, inv2.id);

  // Schedule 3: Unlinked credit note for Jan-Mar 2026 (-30 -> -10/mo)
  const cn = create(db, 'account.move', {
    move_type: 'out_refund',
    partner_id: 2,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{
      name: 'Deferred Rebate', qty: 1, price_unit: 30, tax: 0, account_id: revAcc,
      deferred_start_date: '2026-01-01', deferred_end_date: '2026-03-31',
    }],
  });
  db = postMove(cn.db, cn.id);

  // Report for February 2026:
  // inv1: total 300, not_started 0, before 100, current 100, recognized 200, within_year 100, after_year 0
  // inv2: total 130, not_started 130, before 0, current 0, recognized 0, within_year 110 (Apr26..Feb27 = 11/13*130), after_year 20 (Mar27..Apr27)
  // cn:   total -30, not_started 0, before -10, current -10, recognized -20, within_year -10, after_year 0
  const [row] = deferredReport(db, { from: '2026-02-01', to: '2026-02-28', company_id: 1 }, 'revenue');
  assert.equal(row.total, 400);
  assert.equal(row.not_started, 130);
  assert.equal(row.before, 90);
  assert.equal(row.current, 90);
  assert.equal(row.recognized, 180);
  assert.equal(row.within_year, 200);
  assert.equal(row.after_year, 20);
  assert.equal(row.total, row.recognized + row.within_year + row.after_year);

  // Render Deferred Revenue report view and verify column headers and rendered amounts
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/deferred-revenue-report' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => {
      root.render(React.createElement(Reports, { leaf: { report: 'deferredRevenue' } }));
    });
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && reactProps(n)?.value === 'year');
    assert.ok(periodSelect);
    const thead = find(host, (n) => n.tagName === 'THEAD');
    const yearHeaders = findAll(thead, (n) => n.tagName === 'TH').map(textOf);
    assert.deepEqual(yearHeaders, ['Account', 'Total', 'Not Started', 'Before', String(new Date().getFullYear()), 'Recognized', '<= 12 Months', '> 12 Months']);

    // Render with Feb 2026 custom period to verify period column header and rendered amounts
    await React.act(async () => {
      root.render(React.createElement(Reports, {
        leaf: { report: 'deferredRevenue' },
        params: new URLSearchParams('from=2026-02-01&to=2026-02-28'),
      }));
    });
    const customHeaders = findAll(find(host, (n) => n.tagName === 'THEAD'), (n) => n.tagName === 'TH').map(textOf);
    assert.deepEqual(customHeaders, ['Account', 'Total', 'Not Started', 'Before', '2026-02-01 - 2026-02-28', 'Recognized', '<= 12 Months', '> 12 Months']);
    const bodyRow = find(find(host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR');
    const cellTexts = findAll(bodyRow, (n) => n.tagName === 'TD').slice(1).map(textOf);
    assert.deepEqual(cellTexts, ['$400.00', '$130.00', '$90.00', '$90.00', '$180.00', '$200.00', '$20.00']);
  } finally {
    await React.act(async () => root.unmount());
  }
});
