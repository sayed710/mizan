import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { journalAudit } from './models/journal_audit.js';
import { journalAuditExportRows } from './models/journal_audit_export.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyCreditNote, postMove } from './models/accounting.js';
import { taxesByGrid } from './models/finance.js';
import { accountId, postEntry } from './models/ledger.js';
import { applyPaymentCredit, postPayment, reversePayment } from './models/pay.js';
import { taxSnapshot } from './models/taxes.js';
import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(textOf).join(''));

const db = { records: {
  'account.journal': [{ id: 1, name: 'Sales' }, { id: 2, name: 'Bank' }],
  'account.payment': [{ move_id: 4 }],
  'account.move': [
    { id: 1, journal_id: 1, state: 'posted', date: '2026-01-01', to_check: true, line_ids: [{ debit: 12, credit: 2, currency_id: 2, amount_currency: 7 }] },
    { id: 2, journal_id: 1, state: 'draft', date: '2026-01-02', line_ids: [{ debit: 5, credit: 0 }] },
    { id: 3, journal_id: 1, state: 'cancel', date: '2026-01-03', line_ids: [{ debit: 99 }] },
    { id: 4, journal_id: 2, state: 'posted', date: '2026-01-04', line_ids: [{ debit: 0, credit: 3 }] },
  ],
} };

test('journal audit counts moves and entries to review, and balances totals', () => {
  const [sales, bank] = journalAudit(db);
  assert.equal(sales.count, 1); assert.equal(sales.to_review, 1);
  assert.equal(bank.count, 1); assert.equal(bank.to_review, 0);
  assert.equal(sales.balance, sales.debit - sales.credit);
  assert.equal(sales.items[0].line.amount_currency, 7);
});
test('draft and payment options filter whole moves', () => {
  const groups = journalAudit(db, { includeDraft: true, includePayments: false });
  assert.equal(groups.length, 1); assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].items.map((item) => item.move.id), [1, 2]);
});
test('new labels have Arabic translations', () => {
  const source = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  for (const label of ['Include Payments', 'Draft Entries', 'To Review']) assert.match(source, new RegExp(`'${label}': '[\\u0600-\\u06ff ]+'`));
});

test('tax grids total tagged line balances per journal and export all filtered details', () => {
  const fixture = { records: { ...db.records,
    'account.account.tag': [{ id: 8, name: 'Grid A' }, { id: 9, name: 'Grid zero' }],
    'account.move': db.records['account.move'].map((move) => move.id === 1 ? { ...move, name: 'S/1', line_ids: [
      { name: 'Sale', debit: 2, credit: 12, tax_tag_ids: [8, 9, 8], tax_name: 'VAT', tax_base: 10, tax_side: 'sale' },
      { name: 'Adjustment', debit: 10, credit: 0, tax_tag_ids: [9], tax_grid_base: true, tax_side: 'sale' },
    ] } : move),
  } };
  const [group] = journalAudit(fixture, { includePayments: false });
  assert.deepEqual(group.grids.map(({ name, amount }) => [name, amount]), [['Grid A', 10], ['Grid zero', 0]]);
  const { rows } = journalAuditExportRows(fixture, { includeDraft: true, includePayments: false });
  assert.ok(rows.some((row) => row[0].startsWith('Sales (') && row[1] === 2));
  assert.ok(rows.some((row) => row[4] === 'S/1' && row[7] === 'Sale'));
  assert.ok(rows.some((row) => row[7] === 'Adjustment'));
  assert.ok(rows.some((row) => row[0] === 'Tax Summary'));
  assert.ok(rows.some((row) => row[7] === 'VAT'));
  assert.ok(rows.some((row) => row[0] === 'Tax Grids'));
  assert.ok(rows.some((row) => row[7] === 'Grid A' && row[11] === 10));
  assert.ok(!rows.some((row) => String(row[0]).startsWith('Bank (')));
  assert.equal(rows.at(-1)[0], 'Total');
  const allRows = journalAuditExportRows(fixture).rows;
  assert.ok(allRows.some((row) => String(row[0]).startsWith('Bank (')));
  assert.equal(allRows.filter((row) => row[0] === 'Tax Grids').length, 1);
});

test('Finding 1: posted sale and purchase tax grids match taxesByGrid sign and eligibility rules', () => {
  let state = seed();
  const saleBaseTag = create(state, 'account.account.tag', { name: 'Sale Base Grid', applicability: 'taxes' });
  const saleTaxTag = create(saleBaseTag.db, 'account.account.tag', { name: 'Sale Tax Grid', applicability: 'taxes' });
  const purchBaseTag = create(saleTaxTag.db, 'account.account.tag', { name: 'Purchase Base Grid', applicability: 'taxes' });
  const purchTaxTag = create(purchBaseTag.db, 'account.account.tag', { name: 'Purchase Tax Grid', applicability: 'taxes' });
  const ignoredTag = create(purchTaxTag.db, 'account.account.tag', { name: 'Closing Ignored Grid', applicability: 'taxes' });
  state = ignoredTag.db;

  const saleTaxAcc = accountId(state, '251000');
  const purchTaxAcc = accountId(state, '131000');
  const saleTax = create(state, 'account.tax', {
    name: 'Sale VAT 10%',
    amount: 10,
    type_tax_use: 'sale',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [saleBaseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: saleTaxAcc, tag_ids: [saleTaxTag.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [saleBaseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: saleTaxAcc, tag_ids: [saleTaxTag.id] },
    ],
  });
  const purchTax = create(saleTax.db, 'account.tax', {
    name: 'Purchase VAT 20%',
    amount: 20,
    type_tax_use: 'purchase',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [purchBaseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: purchTaxAcc, tag_ids: [purchTaxTag.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [purchBaseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: purchTaxAcc, tag_ids: [purchTaxTag.id] },
    ],
  });
  state = purchTax.db;

  const partner = search(state, 'res.partner')[0];
  const inv = create(state, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-05-05',
    invoice_line_ids: [{ qty: 1, price_unit: 200, ...taxSnapshot(read(state, 'account.tax', saleTax.id)) }],
  });
  state = postMove(inv.db, inv.id);

  const bill = create(state, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2026-05-06',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(state, 'account.tax', purchTax.id)) }],
  });
  state = postMove(bill.db, bill.id);

  // Non-eligible tagged lines and closing entries must be excluded from tax grids just like taxesByGrid.
  const ineligible = postEntry(state, {
    journal: 'MISC',
    date: '2026-05-07',
    lines: [
      { account: '400000', debit: 50, tax_tag_ids: [ignoredTag.id] },
      { account: '301000', credit: 50 },
    ],
  });
  state = ineligible.db;
  const closing = postEntry(state, {
    journal: 'MISC',
    date: '2026-05-07',
    lines: [
      { account: '400000', debit: 25, tax_grid_base: true, tax_side: 'sale', tax_tag_ids: [ignoredTag.id] },
      { account: '301000', credit: 25 },
    ],
  });
  state = {
    ...closing.db,
    records: {
      ...closing.db.records,
      'account.move': closing.db.records['account.move'].map((m) => (m.id === closing.id ? { ...m, is_closing: true } : m)),
    },
  };

  const period = { from: '2026-05-01', to: '2026-05-31', company_id: 1 };
  const expectedGrids = taxesByGrid(state, period);
  const auditGroups = journalAudit(state, { from: period.from, to: period.to, companyId: 1 });

  const auditGrids = new Map();
  for (const g of auditGroups) {
    for (const grid of g.grids) auditGrids.set(grid.id, (auditGrids.get(grid.id) ?? 0) + grid.amount);
  }
  assert.equal(auditGrids.get(saleBaseTag.id), 200);
  assert.equal(auditGrids.get(saleTaxTag.id), 20);
  assert.equal(auditGrids.get(purchBaseTag.id), 100);
  assert.equal(auditGrids.get(purchTaxTag.id), 20);
  assert.equal(auditGrids.has(ignoredTag.id), false);

  for (const row of expectedGrids) {
    assert.equal(auditGrids.get(row.id), row.base + row.tax, `grid ${row.name} matches taxesByGrid`);
  }

  const { rows } = journalAuditExportRows(state, { period: { from: '2026-05-01', to: '2026-05-31' }, companyId: 1 });
  assert.ok(rows.some((r) => r[7] === 'Sale Base Grid' && r[11] === 200));
  assert.ok(rows.some((r) => r[7] === 'Sale Tax Grid' && r[11] === 20));
});

test('Finding 2: draft invoices compute debit, credit, tax, grid, and detail rows without posting or mutating', async () => {
  let state = seed();
  const baseTag = create(state, 'account.account.tag', { name: 'Draft Base Tag', applicability: 'taxes' });
  const taxTag = create(baseTag.db, 'account.account.tag', { name: 'Draft Tax Tag', applicability: 'taxes' });
  const tax = create(taxTag.db, 'account.tax', {
    name: 'Draft VAT 10%',
    amount: 10,
    type_tax_use: 'sale',
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [baseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: accountId(taxTag.db, '251000'), tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [baseTag.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: accountId(taxTag.db, '251000'), tag_ids: [taxTag.id] },
    ],
  });
  state = tax.db;
  const partner = search(state, 'res.partner')[0];
  const draftInv = create(state, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-06-10',
    invoice_line_ids: [{ name: 'Draft Consulting', qty: 1, price_unit: 300, ...taxSnapshot(read(state, 'account.tax', tax.id)) }],
  });
  state = draftInv.db;
  const rawDraft = read(state, 'account.move', draftInv.id);
  assert.equal(rawDraft.state, 'draft');
  assert.equal((rawDraft.line_ids ?? []).length, 0);

  const withoutDraft = journalAudit(state, { from: '2026-06-01', to: '2026-06-30', companyId: 1, includeDraft: false });
  assert.equal(withoutDraft.length, 0);

  const withDraft = journalAudit(state, { from: '2026-06-01', to: '2026-06-30', companyId: 1, includeDraft: true });
  assert.equal(withDraft.length, 1);
  const saleGroup = withDraft[0];
  assert.equal(saleGroup.count, 1);
  assert.equal(saleGroup.debit, 330);
  assert.equal(saleGroup.credit, 330);
  assert.equal(saleGroup.balance, 0);
  assert.equal(saleGroup.items.length, 3);
  assert.deepEqual(saleGroup.taxes, [{ name: 'Draft VAT 10%', base: 300, tax: 30 }]);
  assert.deepEqual(saleGroup.grids.map((g) => [g.name, g.amount]), [['Draft Base Tag', 300], ['Draft Tax Tag', 30]]);

  // Original draft invoice must remain unposted and unmutated.
  const afterDraft = read(state, 'account.move', draftInv.id);
  assert.equal(afterDraft.state, 'draft');
  assert.equal((afterDraft.line_ids ?? []).length, 0);

  const { rows } = journalAuditExportRows(state, { period: { from: '2026-06-01', to: '2026-06-30' }, companyId: 1, includeDraft: true });
  assert.ok(rows.some((r) => r[0].startsWith('Customer Invoices') && r[1] === 1 && r[9] === 330 && r[10] === 330));
  assert.ok(rows.some((r) => r[9] === 330 && r[10] === 0));
  assert.ok(rows.some((r) => r[7] === 'Draft VAT 10%' && r[12] === 300 && r[13] === 30));
  assert.ok(rows.some((r) => r[7] === 'Draft Base Tag' && r[11] === 300));

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/journal-audit' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(state));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'journalAudit' } })));
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && n !== fromInput);
    await React.act(async () => props(fromInput).onChange({ target: { value: '2026-06-01' } }));
    await React.act(async () => props(toInput).onChange({ target: { value: '2026-06-30' } }));
    const draftCheckbox = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && textOf(n.parentNode).includes('Draft Entries'));
    await React.act(async () => props(draftCheckbox).onChange({ target: { checked: true } }));
    const rendered = textOf(host);
    assert.match(rendered, /330\.00/);
    assert.match(rendered, /Draft VAT 10%/);
    assert.match(rendered, /Draft Base Tag/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Finding 3: disabling Include Payments hides payment reversals and linked FX moves', () => {
  let state = seed();
  const fxAcc = create(state, 'account.account', { name: 'FX Gain', code: '790100', account_type: 'income_other', company_id: 1 });
  state = write(fxAcc.db, 'res.company', 1, { income_currency_exchange_account_id: fxAcc.id });
  const fxCurr = create(state, 'res.currency', { name: 'JAUDFX', rate_ids: [{ date: '2026-07-01', rate: 2 }, { date: '2026-07-05', rate: 1 }] });
  state = fxCurr.db;

  const inv = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    currency_id: fxCurr.id,
    invoice_date: '2026-07-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  state = postMove(inv.db, inv.id);

  const fxPay = create(state, 'account.payment', {
    company_id: 1,
    partner_id: 1,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 100,
    date: '2026-07-05',
  });
  state = postPayment(fxPay.db, read(fxPay.db, 'account.payment', fxPay.id));
  state = applyPaymentCredit(state, fxPay.id, inv.id, '2026-07-05');
  const fxMoveId = read(state, 'account.move', inv.id).payments[0].payment_fx_move_id;
  assert.ok(fxMoveId, 'FX move created by foreign-currency settlement');
  const fxPayMoveId = read(state, 'account.payment', fxPay.id).move_id;

  const revPay = create(state, 'account.payment', {
    company_id: 1,
    partner_id: 1,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 50,
    date: '2026-07-06',
  });
  state = postPayment(revPay.db, read(revPay.db, 'account.payment', revPay.id));
  const revPayMoveId = read(state, 'account.payment', revPay.id).move_id;
  state = reversePayment(state, read(state, 'account.payment', revPay.id), '2026-07-07');
  const reversalMove = state.records['account.move'].find((m) => m.reversed_entry_id === revPayMoveId);
  assert.ok(reversalMove, 'payment reversal move created');

  const includedIds = new Set(journalAudit(state, { from: '2026-07-01', to: '2026-07-31', companyId: 1, includePayments: true })
    .flatMap((g) => g.items.map((it) => it.move.id)));
  assert.ok(includedIds.has(inv.id));
  assert.ok(includedIds.has(fxPayMoveId));
  assert.ok(includedIds.has(fxMoveId));
  assert.ok(includedIds.has(revPayMoveId));
  assert.ok(includedIds.has(reversalMove.id));

  const excludedIds = new Set(journalAudit(state, { from: '2026-07-01', to: '2026-07-31', companyId: 1, includePayments: false })
    .flatMap((g) => g.items.map((it) => it.move.id)));
  assert.ok(excludedIds.has(inv.id), 'invoice stays visible');
  assert.ok(!excludedIds.has(fxPayMoveId), 'FX payment move hidden');
  assert.ok(!excludedIds.has(fxMoveId), 'linked FX move hidden');
  assert.ok(!excludedIds.has(revPayMoveId), 'reversed payment move hidden');
  assert.ok(!excludedIds.has(reversalMove.id), 'payment reversal move hidden');
});

test('Finding 4: all-company totals separate companies by base currency and omit combined monetary sum', async () => {
  let state = seed();
  const eur = create(state, 'res.currency', { name: 'EUR', symbol: '€', position: 'before', rounding: 0.01, rate_ids: [{ date: '2026-08-01', rate: 1 }] });
  state = eur.db;
  const comp2 = createCompanyWithDefaultInvoiceJournals(state, { name: 'Euro Branch', currency_id: eur.id });
  const eurIncome = create(comp2.db, 'account.account', { name: 'Euro Sales Income', code: '400000', account_type: 'income', company_id: comp2.id });
  const eurSalesJournal = create(eurIncome.db, 'account.journal', {
    name: 'Euro Sales',
    code: 'EINV',
    type: 'sale',
    company_id: comp2.id,
    default_account_id: eurIncome.id,
    invoice_sequence_prefix: 'EINV/',
    invoice_sequence_next_number: 1,
  });
  state = write(eurSalesJournal.db, 'res.company', comp2.id, { default_sale_journal_id: eurSalesJournal.id });

  const c1Sale = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2026-08-05',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  state = postMove(c1Sale.db, c1Sale.id);

  const c2Sale = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: comp2.id,
    partner_id: 1,
    invoice_date: '2026-08-06',
    invoice_line_ids: [{ qty: 1, price_unit: 250, tax: 0 }],
  });
  state = postMove(c2Sale.db, c2Sale.id);
  state = { ...state, settings: { ...state.settings, current_company_id: 1, allowed_company_ids: [1, comp2.id] } };

  const { rows } = journalAuditExportRows(state, { period: { from: '2026-08-01', to: '2026-08-31' }, companyId: 'all' });
  const c1TotalRow = rows.find((r) => String(r[0]).includes('(USD)') && r[9] === 100);
  const c2TotalRow = rows.find((r) => String(r[0]).includes('Euro Branch (EUR)') && r[9] === 250);
  const grandTotalRow = rows.at(-1);
  assert.ok(c1TotalRow, 'USD company total row exported');
  assert.ok(c2TotalRow, 'EUR company total row exported');
  assert.equal(grandTotalRow[0], 'Total');
  assert.equal(grandTotalRow[1], 2, 'combined document count preserved');
  assert.equal(grandTotalRow[9], '', 'combined debit omitted across mixed currencies');
  assert.equal(grandTotalRow[10], '', 'combined credit omitted across mixed currencies');
  assert.equal(grandTotalRow[11], '', 'combined balance omitted across mixed currencies');

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/journal-audit' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(state));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'journalAudit' } })));
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && n !== fromInput);
    await React.act(async () => props(fromInput).onChange({ target: { value: '2026-08-01' } }));
    await React.act(async () => props(toInput).onChange({ target: { value: '2026-08-31' } }));

    const rendered = textOf(host);
    assert.match(rendered, /\$100\.00/);
    assert.match(rendered, /€250\.00/);
    assert.doesNotMatch(rendered, /350\.00/);
    const grandTotalTr = find(host, (n) => n.tagName === 'TR' && props(n)?.className === 'rep-total strong');
    assert.ok(grandTotalTr);
    assert.equal(textOf(grandTotalTr.childNodes[1]), '2');
    assert.equal(textOf(grandTotalTr.childNodes[3]), '');
    assert.equal(textOf(grandTotalTr.childNodes[4]), '');
    assert.equal(textOf(grandTotalTr.childNodes[5]), '');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('taxGridLineContributions preserves taxesByGrid output for tagged zero-value rows and tags', () => {
  let state = seed();
  const zeroTaxTag = create(state, 'account.account.tag', { name: 'Zero Tax Tag', applicability: 'taxes' });
  const taggedLineTag = create(zeroTaxTag.db, 'account.account.tag', { name: 'Tagged NonTax Line Tag', applicability: 'taxes' });
  const zeroBaseTag = create(taggedLineTag.db, 'account.account.tag', { name: 'Zero Base Tag', applicability: 'taxes' });
  state = zeroBaseTag.db;
  const move = {
    id: 9901,
    name: 'INV/ZERO/1',
    move_type: 'out_invoice',
    state: 'posted',
    company_id: 1,
    date: '2026-09-10',
    invoice_date: '2026-09-10',
    journal_id: 1,
    line_ids: [
      { account_id: accountId(state, '251000'), debit: 0, credit: 0, tax_name: 'Zero VAT', tax_zero: true, tax_side: 'sale', tax_tag_ids: [zeroTaxTag.id] },
      { account_id: accountId(state, '400000'), debit: 0, credit: 50, tax_tag_ids: [taggedLineTag.id] },
      { account_id: accountId(state, '400000'), debit: 0, credit: 0, tax_grid_base: true, tax_side: 'sale', tax_tag_ids: [zeroBaseTag.id] },
    ],
  };
  state = { ...state, records: { ...state.records, 'account.move': [...state.records['account.move'], move] } };
  const rows = taxesByGrid(state, { from: '2026-09-01', to: '2026-09-30', company_id: 1 });
  assert.deepEqual(rows.find((r) => r.id === zeroTaxTag.id), { id: zeroTaxTag.id, name: 'Zero Tax Tag', base: 0, tax: 0 });
  assert.deepEqual(rows.find((r) => r.id === taggedLineTag.id), { id: taggedLineTag.id, name: 'Tagged NonTax Line Tag', base: 0, tax: 0 });
  assert.deepEqual(rows.find((r) => r.id === zeroBaseTag.id), { id: zeroBaseTag.id, name: 'Zero Base Tag', base: 0, tax: 0 });
});

test('All Companies filtered down to only foreign-base-currency company B renders and exports company B currency while A is active', async () => {
  let state = seed();
  const eur = create(state, 'res.currency', { name: 'EUR', symbol: '€', position: 'before', rounding: 0.01, rate_ids: [{ date: '2031-08-01', rate: 1 }] });
  state = eur.db;
  const comp2 = createCompanyWithDefaultInvoiceJournals(state, { name: 'Euro Branch', currency_id: eur.id });
  const eurIncome = create(comp2.db, 'account.account', { name: 'Euro Sales Income', code: '400000', account_type: 'income', company_id: comp2.id });
  const eurSalesJournal = create(eurIncome.db, 'account.journal', {
    name: 'Euro Sales',
    code: 'EINV',
    type: 'sale',
    company_id: comp2.id,
    default_account_id: eurIncome.id,
    invoice_sequence_prefix: 'EINV/',
    invoice_sequence_next_number: 1,
  });
  state = write(eurSalesJournal.db, 'res.company', comp2.id, { default_sale_journal_id: eurSalesJournal.id });

  // Company A (USD, active) has an invoice in August; Company B (EUR) has invoices in August and September.
  const c1Aug = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2031-08-10',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  state = postMove(c1Aug.db, c1Aug.id);

  const c2Aug = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: comp2.id,
    partner_id: 1,
    invoice_date: '2031-08-11',
    invoice_line_ids: [{ qty: 1, price_unit: 250, tax: 0 }],
  });
  state = postMove(c2Aug.db, c2Aug.id);

  const c2Sep = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: comp2.id,
    partner_id: 1,
    invoice_date: '2031-09-12',
    invoice_line_ids: [{ qty: 1, price_unit: 400, tax: 0 }],
  });
  state = postMove(c2Sep.db, c2Sep.id);
  state = { ...state, settings: { ...state.settings, current_company_id: 1, allowed_company_ids: [1, comp2.id] } };

  // Filtering by period to September leaves only Company B (EUR) contributing under companyId='all'.
  const { rows: sepRows } = journalAuditExportRows(state, { period: { from: '2031-09-01', to: '2031-09-30' }, companyId: 'all' });
  const sepJournalRow = sepRows.find((r) => String(r[0]).startsWith('Euro Sales ('));
  const sepTotalRow = sepRows.at(-1);
  assert.ok(sepJournalRow);
  assert.equal(sepJournalRow[8], 'EUR', 'export journal row reports EUR when only company B contributes');
  assert.equal(sepTotalRow[0], 'Total');
  assert.equal(sepTotalRow[8], 'EUR', 'export total row reports EUR when only company B contributes');
  assert.equal(sepTotalRow[9], 400);

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/journal-audit' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(state));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'journalAudit' } })));
    const companySelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Company');
    assert.equal(props(companySelect).value, 'all');
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && n !== fromInput);

    // 1) Filter period to September -> only Company B contributes
    await React.act(async () => props(fromInput).onChange({ target: { value: '2031-09-01' } }));
    await React.act(async () => props(toInput).onChange({ target: { value: '2031-09-30' } }));
    const sepRendered = textOf(host);
    assert.match(sepRendered, /€400\.00/);
    assert.doesNotMatch(sepRendered, /\$400\.00/);
    const sepTotalTr = find(host, (n) => n.tagName === 'TR' && props(n)?.className === 'rep-total strong');
    assert.equal(textOf(sepTotalTr.childNodes[3]), '€400.00');

    // 2) Filter back to August (both companies have entries), then filter Journals to only Company B's Euro Sales journal
    await React.act(async () => props(fromInput).onChange({ target: { value: '2031-08-01' } }));
    await React.act(async () => props(toInput).onChange({ target: { value: '2031-08-31' } }));
    const journalSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Journals');
    await React.act(async () => props(journalSelect).onChange({ target: { selectedOptions: [{ value: String(eurSalesJournal.id) }] } }));
    const augFilteredRendered = textOf(host);
    assert.match(augFilteredRendered, /€250\.00/);
    assert.doesNotMatch(augFilteredRendered, /\$250\.00|\$100\.00/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Shared journal transacting in multiple company currencies splits per company and preserves tax summary and grids', async () => {
  let state = seed();
  const eur = create(state, 'res.currency', { name: 'EUR', symbol: '€', position: 'before', rounding: 0.01, rate_ids: [{ date: '2031-10-01', rate: 1 }] });
  state = eur.db;
  const comp2 = createCompanyWithDefaultInvoiceJournals(state, { name: 'Euro Branch', currency_id: eur.id });
  state = comp2.db;

  const usdBaseTag = create(state, 'account.account.tag', { name: 'USD Shared Base', applicability: 'taxes' });
  const usdTaxTag = create(usdBaseTag.db, 'account.account.tag', { name: 'USD Shared Tax', applicability: 'taxes' });
  const eurBaseTag = create(usdTaxTag.db, 'account.account.tag', { name: 'EUR Shared Base', applicability: 'taxes' });
  const eurTaxTag = create(eurBaseTag.db, 'account.account.tag', { name: 'EUR Shared Tax', applicability: 'taxes' });
  state = eurTaxTag.db;

  const miscJournal = search(state, 'account.journal').find((j) => j.code === 'MISC');
  assert.equal(miscJournal.company_id ?? null, null, 'MISC is a shared journal');

  const usdMove = postEntry(state, {
    journal: miscJournal.id,
    company: 1,
    date: '2031-10-05',
    lines: [
      { account: '121000', debit: 110 },
      { account: '400000', credit: 100, tax_grid_base: true, tax_side: 'sale', tax_tag_ids: [usdBaseTag.id] },
      { account: '251000', credit: 10, tax_id: 901, tax_name: 'USD VAT 10%', tax_base: 100, tax_side: 'sale', tax_tag_ids: [usdTaxTag.id] },
    ],
  });
  state = usdMove.db;

  const eurRecv = create(state, 'account.account', { name: 'EUR Receivable', code: '121099', account_type: 'asset_receivable', company_id: comp2.id });
  const eurInc = create(eurRecv.db, 'account.account', { name: 'EUR Income', code: '400099', account_type: 'income', company_id: comp2.id });
  const eurTaxAcc = create(eurInc.db, 'account.account', { name: 'EUR Tax Output', code: '251099', account_type: 'liability_current', company_id: comp2.id });
  state = eurTaxAcc.db;

  const eurMove = postEntry(state, {
    journal: miscJournal.id,
    company: comp2.id,
    date: '2031-10-06',
    lines: [
      { account_id: eurRecv.id, debit: 240 },
      { account_id: eurInc.id, credit: 200, tax_grid_base: true, tax_side: 'sale', tax_tag_ids: [eurBaseTag.id] },
      { account_id: eurTaxAcc.id, credit: 40, tax_id: 902, tax_name: 'EUR VAT 20%', tax_base: 200, tax_side: 'sale', tax_tag_ids: [eurTaxTag.id] },
    ],
  });
  state = { ...eurMove.db, settings: { ...eurMove.db.settings, current_company_id: 1, allowed_company_ids: [1, comp2.id] } };

  const groups = journalAudit(state, { from: '2031-10-01', to: '2031-10-31', companyId: null });
  const miscGroups = groups.filter((g) => g.journal.id === miscJournal.id);
  assert.equal(miscGroups.length, 2, 'shared MISC journal splits by company currency');
  const [usdGroup, eurGroup] = miscGroups;
  assert.equal(usdGroup.debit, 110);
  assert.deepEqual(usdGroup.taxes, [{ name: 'USD VAT 10%', base: 100, tax: 10 }]);
  assert.deepEqual(usdGroup.grids.map((g) => [g.name, g.amount]), [['USD Shared Base', 100], ['USD Shared Tax', 10]]);
  assert.equal(eurGroup.debit, 240);
  assert.deepEqual(eurGroup.taxes, [{ name: 'EUR VAT 20%', base: 200, tax: 40 }]);
  assert.deepEqual(eurGroup.grids.map((g) => [g.name, g.amount]), [['EUR Shared Base', 200], ['EUR Shared Tax', 40]]);

  const { rows } = journalAuditExportRows(state, { period: { from: '2031-10-01', to: '2031-10-31' }, companyId: 'all' });
  const usdGroupRow = rows.find((r) => String(r[0]).includes('MISC') && r[8] === 'USD');
  const eurGroupRow = rows.find((r) => String(r[0]).includes('MISC') && r[8] === 'EUR');
  assert.ok(usdGroupRow && usdGroupRow[9] === 110, 'USD split group exported with own debit');
  assert.ok(eurGroupRow && eurGroupRow[9] === 240, 'EUR split group exported with own debit');
  assert.ok(rows.some((r) => r[7] === 'USD VAT 10%' && r[12] === 100 && r[13] === 10));
  assert.ok(rows.some((r) => r[7] === 'EUR VAT 20%' && r[12] === 200 && r[13] === 40));
  assert.ok(rows.some((r) => r[7] === 'USD Shared Base' && r[11] === 100));
  assert.ok(rows.some((r) => r[7] === 'EUR Shared Base' && r[11] === 200));
  assert.equal(rows.filter((r) => r[0] === 'Tax Summary').length, 2);
  assert.equal(rows.filter((r) => r[0] === 'Tax Grids').length, 2);

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/journal-audit' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(state));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'journalAudit' } })));
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && n !== fromInput);
    await React.act(async () => props(fromInput).onChange({ target: { value: '2031-10-01' } }));
    await React.act(async () => props(toInput).onChange({ target: { value: '2031-10-31' } }));

    const rendered = textOf(host);
    assert.match(rendered, /\$110\.00/);
    assert.match(rendered, /USD VAT 10%/);
    assert.match(rendered, /USD Shared Base/);
    assert.match(rendered, /€240\.00/);
    assert.match(rendered, /EUR VAT 20%/);
    assert.match(rendered, /EUR Shared Base/);
    assert.doesNotMatch(rendered, /350\.00/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Incomplete draft invoice preserves valid posted documents, surfaces incomplete error explicitly, and never renders false posted totals', async () => {
  let state = seed();
  // Create a branch company with a valid posted entry in BMISC and a valid posted invoice in BINV, then remove its default receivable so a draft invoice in BINV is incomplete.
  const comp2 = createCompanyWithDefaultInvoiceJournals(state, { name: 'No Receivable Branch', currency_id: 1 });
  state = comp2.db;
  const incomeAcc2 = create(state, 'account.account', { name: 'Branch Income', code: '400088', account_type: 'income', company_id: comp2.id });
  const recvAcc2 = create(incomeAcc2.db, 'account.account', { name: 'Branch Recv', code: '121088', account_type: 'asset_receivable', company_id: comp2.id });
  const invJournal2 = create(recvAcc2.db, 'account.journal', {
    name: 'Branch Sales',
    code: 'BINV',
    type: 'sale',
    company_id: comp2.id,
    default_account_id: incomeAcc2.id,
    invoice_sequence_prefix: 'BINV/',
    invoice_sequence_next_number: 1,
  });
  const miscJournal2 = create(invJournal2.db, 'account.journal', { name: 'Branch Misc', code: 'BMISC', type: 'general', company_id: comp2.id });
  const partner2 = create(miscJournal2.db, 'res.partner', { name: 'Branch Customer' });
  state = write(partner2.db, 'res.company', comp2.id, { default_sale_journal_id: invJournal2.id, account_default_receivable_id: recvAcc2.id });

  const postedMisc = postEntry(state, {
    journal: miscJournal2.id,
    company: comp2.id,
    date: '2031-11-05',
    lines: [
      { account_id: recvAcc2.id, debit: 150 },
      { account_id: incomeAcc2.id, credit: 150 },
    ],
  });
  state = postedMisc.db;

  const postedInv = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: comp2.id,
    journal_id: invJournal2.id,
    partner_id: partner2.id,
    invoice_date: '2031-11-06',
    invoice_line_ids: [{ name: 'Posted Service', qty: 1, price_unit: 200, tax: 0 }],
  });
  // Add a taxed posted invoice with grid tags in the same journal to verify tax details stay intact alongside an incomplete draft.
  const baseTag2 = create(postedInv.db, 'account.account.tag', { name: 'Branch Base Grid', applicability: 'taxes' });
  const taxTag2 = create(baseTag2.db, 'account.account.tag', { name: 'Branch Tax Grid', applicability: 'taxes' });
  const taxAcc2 = create(taxTag2.db, 'account.account', { name: 'Branch Output VAT', code: '251088', account_type: 'liability_current', company_id: comp2.id });
  const saleTax2 = create(taxAcc2.db, 'account.tax', {
    name: 'Branch VAT 10%',
    amount: 10,
    type_tax_use: 'sale',
    company_id: comp2.id,
    invoice_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [baseTag2.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc2.id, tag_ids: [taxTag2.id] },
    ],
    refund_repartition_line_ids: [
      { repartition_type: 'base', factor_percent: 100, tag_ids: [baseTag2.id] },
      { repartition_type: 'tax', factor_percent: 100, account_id: taxAcc2.id, tag_ids: [taxTag2.id] },
    ],
  });
  state = postMove(saleTax2.db, postedInv.id);
  const taxedPostedInv = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: comp2.id,
    journal_id: invJournal2.id,
    partner_id: partner2.id,
    invoice_date: '2031-11-07',
    invoice_line_ids: [{ name: 'Taxed Service', qty: 1, price_unit: 100, ...taxSnapshot(read(state, 'account.tax', saleTax2.id)) }],
  });
  state = postMove(taxedPostedInv.db, taxedPostedInv.id);
  state = write(state, 'res.company', comp2.id, { account_default_receivable_id: null });

  // Incomplete draft WITHOUT explicit journal_id (falls back via resolveAuditJournal to default_sale_journal_id).
  const incompleteDraft = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: comp2.id,
    partner_id: partner2.id,
    name: 'DRAFT/INCOMPLETE/1',
    invoice_date: '2031-11-10',
    invoice_line_ids: [{ name: 'Incomplete Consulting', qty: 1, price_unit: 75, tax: 0 }],
  });
  state = {
    ...incompleteDraft.db,
    settings: { ...incompleteDraft.db.settings, current_company_id: comp2.id, allowed_company_ids: [comp2.id] },
  };

  const groups = journalAudit(state, { from: '2031-11-01', to: '2031-11-30', companyId: comp2.id, includeDraft: true });
  assert.equal(groups.length, 2, 'both journals remain visible');
  const miscGroup = groups.find((g) => g.journal.id === miscJournal2.id);
  const invGroup = groups.find((g) => g.journal.id === invJournal2.id);
  assert.equal(miscGroup.incomplete, false);
  assert.equal(miscGroup.debit, 150);
  assert.equal(invGroup.count, 3, 'two posted invoices + incomplete draft counted');
  assert.equal(invGroup.incomplete, true);
  assert.equal(invGroup.debit, null, 'group containing incomplete draft must not report a false numeric total');
  assert.equal(invGroup.credit, null);
  assert.equal(invGroup.balance, null);
  assert.equal(invGroup.items.length, 5, 'valid posted invoice lines remain intact');
  assert.deepEqual(invGroup.taxes, [
    { name: '0%', base: 200, tax: 0 },
    { name: 'Branch VAT 10%', base: 100, tax: 10 },
  ]);
  assert.deepEqual(invGroup.grids.map((g) => [g.name, g.amount]), [['Branch Base Grid', 100], ['Branch Tax Grid', 10]]);
  assert.equal(invGroup.incomplete_moves.length, 1);
  assert.equal(invGroup.incomplete_moves[0].move.id, incompleteDraft.id);
  assert.match(invGroup.incomplete_moves[0].error, /default receivable account/i);

  const { rows } = journalAuditExportRows(state, { period: { from: '2031-11-01', to: '2031-11-30', journalIds: [invJournal2.id] }, companyId: comp2.id, includeDraft: true });
  const invExportHeader = rows.find((r) => String(r[0]).startsWith('Branch Sales ('));
  const incompleteExportRow = rows.find((r) => r[4] === 'DRAFT/INCOMPLETE/1');
  const exportTotalRow = rows.at(-1);
  assert.equal(invExportHeader[9], 'Unavailable');
  assert.ok(incompleteExportRow, 'incomplete draft without stored journal_id is included and exported with explicit status under journal filter');
  assert.match(String(incompleteExportRow[7]), /Incomplete:.*default receivable account/i);
  assert.equal(incompleteExportRow[9], '');
  assert.ok(rows.some((r) => r[7] === 'Branch VAT 10%' && r[12] === 100 && r[13] === 10));
  assert.ok(rows.some((r) => r[7] === 'Branch Base Grid' && r[11] === 100));
  assert.equal(exportTotalRow[9], 'Unavailable');

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/journal-audit' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(state));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'journalAudit' } })));
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && n !== fromInput);
    await React.act(async () => props(fromInput).onChange({ target: { value: '2031-11-01' } }));
    await React.act(async () => props(toInput).onChange({ target: { value: '2031-11-30' } }));
    const draftCheckbox = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && textOf(n.parentNode).includes('Draft Entries'));
    await React.act(async () => props(draftCheckbox).onChange({ target: { checked: true } }));

    const rendered = textOf(host);
    assert.match(rendered, /\$150\.00/);
    assert.match(rendered, /\$200\.00/);
    assert.match(rendered, /Branch VAT 10%/);
    assert.match(rendered, /Branch Base Grid/);
    assert.match(rendered, /DRAFT\/INCOMPLETE\/1/);
    assert.match(rendered, /Incomplete:/);
    assert.match(rendered, /Unavailable/);
    assert.doesNotMatch(rendered, /\$350\.00/);

    // Filter Journals to Branch Sales: incomplete draft without persisted journal_id still surfaces via guarded journalAudit resolution.
    const journalSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Journals');
    await React.act(async () => props(journalSelect).onChange({ target: { selectedOptions: [{ value: String(invJournal2.id) }] } }));
    const filteredRendered = textOf(host);
    assert.match(filteredRendered, /DRAFT\/INCOMPLETE\/1/);
    assert.match(filteredRendered, /Branch VAT 10%/);
    assert.doesNotMatch(filteredRendered, /\$150\.00/);
  } finally {
    await React.act(async () => root.unmount());
  }

  // journalItems preserves its existing fallback contract on incomplete drafts (returns valid posted items without throwing).
  const { journalItems } = await import('./models/ledger.js');
  const ledgerItems = journalItems(state, { from: '2031-11-01', to: '2031-11-30', company_id: comp2.id, reviewMode: 'all', includeDraftInvoices: true });
  assert.ok(ledgerItems.some((item) => item.move_id === postedInv.id));

  // Unexpected non-configuration errors (e.g. corrupt internal state causing TypeError) must still surface rather than being silently swallowed.
  const { isIncompleteDraftPostingError } = await import('./models/journal_audit.js');
  assert.equal(isIncompleteDraftPostingError(new TypeError('Unexpected null')), false);
  assert.equal(isIncompleteDraftPostingError(new Error('Configure the default receivable account for Demo')), true);
});

test('General Ledger under All Companies with a foreign-company journal filter keeps active company currency', async () => {
  let state = seed();
  const eur = create(state, 'res.currency', { name: 'EUR', symbol: '€', position: 'before', rounding: 0.01, rate_ids: [{ date: '2031-01-01', rate: 1 }] });
  state = eur.db;
  const comp2 = createCompanyWithDefaultInvoiceJournals(state, { name: 'Euro Branch', currency_id: eur.id });
  const eurIncome = create(comp2.db, 'account.account', { name: 'Euro Sales Income', code: '400000', account_type: 'income', company_id: comp2.id });
  const eurSalesJournal = create(eurIncome.db, 'account.journal', {
    name: 'Euro Sales',
    code: 'EINV',
    type: 'sale',
    company_id: comp2.id,
    default_account_id: eurIncome.id,
    invoice_sequence_prefix: 'EINV/',
    invoice_sequence_next_number: 1,
  });
  state = write(eurSalesJournal.db, 'res.company', comp2.id, { default_sale_journal_id: eurSalesJournal.id });
  const c2Inv = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: comp2.id,
    partner_id: 1,
    invoice_date: '2031-08-15',
    invoice_line_ids: [{ qty: 1, price_unit: 250, tax: 0 }],
  });
  state = postMove(c2Inv.db, c2Inv.id);
  state = { ...state, settings: { ...state.settings, current_company_id: 1, allowed_company_ids: [1, comp2.id] } };

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/general-ledger' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(state));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'ledger' } })));
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && n !== fromInput);
    await React.act(async () => props(fromInput).onChange({ target: { value: '2031-08-01' } }));
    await React.act(async () => props(toInput).onChange({ target: { value: '2031-08-31' } }));
    const journalSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Journals');
    await React.act(async () => props(journalSelect).onChange({ target: { selectedOptions: [{ value: String(eurSalesJournal.id) }] } }));
    const rendered = textOf(host);
    assert.match(rendered, /\$250\.00/);
    assert.doesNotMatch(rendered, /€250\.00/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Qodo Finding 1: explicit empty journalIds returns no groups in model, export, and empty ledger UI while undefined/nonempty filters still work', async () => {
  let state = seed();
  const invJournal = search(state, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const miscJournal = search(state, 'account.journal').find((j) => j.code === 'MISC');
  const emptyLedger = create(state, 'account.journal.group', { name: 'Empty Ledger', company_id: 1, journal_ids: [] });
  state = emptyLedger.db;

  const sale = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: invJournal.id,
    partner_id: 1,
    invoice_date: '2031-12-03',
    invoice_line_ids: [{ qty: 1, price_unit: 120, tax: 0 }],
  });
  state = postMove(sale.db, sale.id);
  const misc = postEntry(state, {
    journal: miscJournal.id,
    company: 1,
    date: '2031-12-04',
    lines: [
      { account: '121000', debit: 80 },
      { account: '400000', credit: 80 },
    ],
  });
  state = {
    ...misc.db,
    settings: { ...misc.db.settings, current_company_id: 1, allowed_company_ids: [1] },
  };

  // Ordinary results (undefined/null) return both journals; nonempty filter returns only the requested journal.
  const allGroups = journalAudit(state, { from: '2031-12-01', to: '2031-12-31', companyId: 1 });
  assert.deepEqual(allGroups.map((g) => g.journal.id), [invJournal.id, miscJournal.id]);
  const onlyInvGroups = journalAudit(state, { from: '2031-12-01', to: '2031-12-31', companyId: 1, journalIds: [invJournal.id] });
  assert.deepEqual(onlyInvGroups.map((g) => g.journal.id), [invJournal.id]);

  // Explicit empty array (selected ledger with no journals) returns zero groups in model & CSV/XLSX export payload.
  const emptyGroups = journalAudit(state, { from: '2031-12-01', to: '2031-12-31', companyId: 1, journalIds: [] });
  assert.deepEqual(emptyGroups, []);
  const { rows: emptyExportRows } = journalAuditExportRows(state, { period: { from: '2031-12-01', to: '2031-12-31', journalIds: [] }, companyId: 1 });
  assert.equal(emptyExportRows.length, 2, 'only header and zero Total row exported when journalIds is []');
  assert.equal(emptyExportRows[1][0], 'Total');
  assert.equal(emptyExportRows[1][1], 0);
  assert.equal(emptyExportRows[1][9], 0);

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/journal-audit' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(state));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'journalAudit' } })));
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && n !== fromInput);
    await React.act(async () => props(fromInput).onChange({ target: { value: '2031-12-01' } }));
    await React.act(async () => props(toInput).onChange({ target: { value: '2031-12-31' } }));

    // Ordinary UI view renders both $120.00 and $80.00.
    assert.match(textOf(host), /\$120\.00/);
    assert.match(textOf(host), /\$80\.00/);

    // Selecting the empty ledger leaves no journal groups in the report UI.
    const ledgerSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Ledger');
    await React.act(async () => props(ledgerSelect).onChange({ target: { value: String(emptyLedger.id) } }));
    const emptyRendered = textOf(host);
    assert.doesNotMatch(emptyRendered, /\$120\.00|\$80\.00/);
    assert.match(emptyRendered, /No entries for this period\./);

    // Clearing back to All Ledgers restores ordinary results.
    await React.act(async () => props(ledgerSelect).onChange({ target: { value: '' } }));
    assert.match(textOf(host), /\$120\.00/);
    assert.match(textOf(host), /\$80\.00/);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Qodo Finding 2: disabling Include Payments hides payment-linked cash basis release and its reversal while keeping independent cash-basis entries visible', () => {
  let state = seed();
  const cashTax = search(state, 'account.tax').find((t) => t.name === 'VAT 14% (Cash Basis)' && t.type_tax_use === 'sale');
  assert.ok(cashTax, 'seeded cash-basis VAT tax exists');

  // 1) Invoice settled by Payment 1 (later reversed, producing cash-basis release + its reversal), then settled by Payment 2.
  const inv1 = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2031-12-05',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(cashTax) }],
  });
  state = postMove(inv1.db, inv1.id);
  const p1 = create(state, 'account.payment', {
    company_id: 1,
    partner_id: 1,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 114,
    date: '2031-12-06',
  });
  state = postPayment(p1.db, read(p1.db, 'account.payment', p1.id));
  state = applyPaymentCredit(state, p1.id, inv1.id, '2031-12-06');
  const pay1 = read(state, 'account.payment', p1.id);
  const cbRelease1 = read(state, 'account.move', inv1.id).payments.at(-1).cash_basis_move_id;
  assert.ok(cbRelease1, 'payment 1 creates cash-basis release');

  state = reversePayment(state, pay1, '2031-12-07');
  const pay1Reversal = state.records['account.move'].find((m) => m.reversed_entry_id === pay1.move_id);
  const cbReversal1 = state.records['account.move'].find((m) => m.reversed_entry_id === cbRelease1);
  assert.ok(pay1Reversal && cbReversal1, 'payment reversal also reverses linked cash-basis release');

  const p2 = create(state, 'account.payment', {
    company_id: 1,
    partner_id: 1,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 114,
    date: '2031-12-08',
  });
  state = postPayment(p2.db, read(p2.db, 'account.payment', p2.id));
  state = applyPaymentCredit(state, p2.id, inv1.id, '2031-12-08');
  const pay2 = read(state, 'account.payment', p2.id);
  const cbRelease2 = read(state, 'account.move', inv1.id).payments.at(-1).cash_basis_move_id;
  assert.ok(cbRelease2, 'payment 2 creates cash-basis release');

  // 2) Independent cash-basis releases: credit note settlement (non-payment application move) + standalone manual cash-basis entry.
  const inv2 = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2031-12-05',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(cashTax) }],
  });
  state = postMove(inv2.db, inv2.id);
  const note = create(state, 'account.move', {
    move_type: 'out_refund',
    company_id: 1,
    partner_id: 1,
    invoice_date: '2031-12-06',
    invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(cashTax) }],
  });
  state = postMove(note.db, note.id);
  state = applyCreditNote(state, note.id, inv2.id, '2031-12-09');
  const cbFromNote = read(state, 'account.move', inv2.id).payments.at(-1).cash_basis_move_id;
  assert.ok(cbFromNote, 'credit note settlement creates non-payment cash-basis release');

  const manualCb = postEntry(state, {
    journal: 'MISC',
    company: 1,
    date: '2031-12-10',
    ref: 'Manual Cash Basis Adjustment',
    lines: [
      { account: '251000', debit: 14 },
      { account: '251000', credit: 14 },
    ],
  });
  state = manualCb.db;

  const includedIds = new Set(journalAudit(state, { from: '2031-12-01', to: '2031-12-31', companyId: 1, includePayments: true })
    .flatMap((g) => g.items.map((it) => it.move.id)));
  for (const id of [inv1.id, inv2.id, note.id, pay1.move_id, pay1Reversal.id, cbRelease1, cbReversal1.id, pay2.move_id, cbRelease2, cbFromNote, manualCb.id]) {
    assert.ok(includedIds.has(id), `move ${id} visible when includePayments=true`);
  }

  const excludedIds = new Set(journalAudit(state, { from: '2031-12-01', to: '2031-12-31', companyId: 1, includePayments: false })
    .flatMap((g) => g.items.map((it) => it.move.id)));
  assert.ok(excludedIds.has(inv1.id), 'invoice 1 stays visible');
  assert.ok(excludedIds.has(inv2.id), 'invoice 2 stays visible');
  assert.ok(excludedIds.has(note.id), 'credit note stays visible');
  assert.ok(excludedIds.has(cbFromNote), 'credit-note cash-basis release stays visible');
  assert.ok(excludedIds.has(manualCb.id), 'standalone manual cash-basis entry stays visible');
  assert.ok(!excludedIds.has(pay1.move_id), 'reversed payment hidden');
  assert.ok(!excludedIds.has(pay1Reversal.id), 'payment reversal hidden');
  assert.ok(!excludedIds.has(cbRelease1), 'payment-linked cash-basis release 1 hidden');
  assert.ok(!excludedIds.has(cbReversal1.id), 'reversal of payment-linked cash-basis release hidden');
  assert.ok(!excludedIds.has(pay2.move_id), 'payment 2 hidden');
  assert.ok(!excludedIds.has(cbRelease2), 'payment-linked cash-basis release 2 hidden');
});

test('Qodo Finding 3: posted invoice with dangling journal_id is skipped without crashing while preserving valid entries in model, export, and UI', async () => {
  let state = seed();
  const invJournal = search(state, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const validInv = create(state, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    journal_id: invJournal.id,
    partner_id: 1,
    invoice_date: '2031-12-15',
    invoice_line_ids: [{ qty: 1, price_unit: 320, tax: 0 }],
  });
  state = postMove(validInv.db, validInv.id);

  // Add an already-posted invoice referencing a non-existent journal ID, plus a separate company lacking defaults so its draft stays safely scoped.
  const danglingPostedInv = {
    id: 998877,
    name: 'DANGLING/2031/001',
    move_type: 'out_invoice',
    state: 'posted',
    company_id: 1,
    journal_id: 999999,
    partner_id: 1,
    date: '2031-12-16',
    invoice_date: '2031-12-16',
    line_ids: [
      { account_id: accountId(state, '121000'), debit: 500, credit: 0 },
      { account_id: accountId(state, '400000'), debit: 0, credit: 500 },
    ],
  };
  state = {
    ...state,
    settings: { ...state.settings, current_company_id: 1, allowed_company_ids: [1] },
    records: {
      ...state.records,
      'account.move': [...state.records['account.move'], danglingPostedInv],
    },
  };

  const groups = journalAudit(state, { from: '2031-12-01', to: '2031-12-31', companyId: 1, includeDraft: true });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].journal.id, invJournal.id);
  assert.equal(groups[0].debit, 320);

  const { rows } = journalAuditExportRows(state, { period: { from: '2031-12-01', to: '2031-12-31' }, companyId: 1, includeDraft: true });
  assert.ok(rows.some((r) => String(r[0]).startsWith('Customer Invoices (') && r[9] === 320));
  assert.ok(!rows.some((r) => r[4] === 'DANGLING/2031/001'));
  assert.equal(rows.at(-1)[9], 320);

  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting/journal-audit' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await React.act(async () => commit(state));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(Reports, { leaf: { report: 'journalAudit' } })));
    const periodSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.value === 'year');
    await React.act(async () => props(periodSelect).onChange({ target: { value: 'custom' } }));
    const fromInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    const toInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && n !== fromInput);
    await React.act(async () => props(fromInput).onChange({ target: { value: '2031-12-01' } }));
    await React.act(async () => props(toInput).onChange({ target: { value: '2031-12-31' } }));
    const rendered = textOf(host);
    assert.match(rendered, /\$320\.00/);
    assert.doesNotMatch(rendered, /DANGLING\/2031\/001/);
  } finally {
    await React.act(async () => root.unmount());
  }
});
