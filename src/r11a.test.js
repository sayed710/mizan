import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journalAudit } from './models/journal_audit.js';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const props = (node) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
const text = (node) => node.nodeType === 3 ? node.nodeValue : (node.childNodes ?? []).map(text).join('');

test('journal audit uses the accounting date for filtering and display', () => {
  const db = { records: { 'account.journal': [{ id: 1 }], 'account.move': [{ id: 1, name: 'Bill', state: 'posted', journal_id: 1, invoice_date: '2026-01-31', date: '2026-02-01', line_ids: [{ debit: 100 }] }] } };
  assert.deepEqual(journalAudit(db, { from: '2026-01-01', to: '2026-01-31' }), []);
  assert.equal(journalAudit(db, { from: '2026-02-01', to: '2026-02-28' })[0].items[0].date, '2026-02-01');
});

test('report custom periods reach depreciation and archived analytic activity', async () => {
  const { makeEl } = setupDom();
  globalThis.location = { hash: '#/accounting' };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, getDb, commit } = await import('./store.js');
  await initStore();
  const base = getDb();
  const db = { ...base, records: { ...base.records,
    'account.asset': [
      { id: 1, name: 'Future asset', state: 'open', acquisition_date: '2026-03-01', original_value: 300 },
      { id: 2, name: 'Disposed asset', state: 'close', acquisition_date: '2025-01-01', disposal_date: '2026-02-01', original_value: 200, depreciation_ids: [{ date: '2025-12-31', amount: 50, posted: true }] },
    ],
    'account.analytic.account': [{ id: 1, name: 'Archived project', active: false }],
    'account.analytic.line': [{ id: 1, name: 'Historical activity', account_id: 1, date: '2026-01-15', amount: 123 }],
  } };
  await React.act(async () => commit(db));
  const { Reports } = await import('./views/Reports.jsx');
  const host = makeEl('div'); host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    for (const report of ['tax', 'cashflow', 'executive', 'depreciation', 'analytic', 'budget']) {
      await React.act(async () => root.render(React.createElement(Reports, { leaf: { report } })));
      assert.ok(find(host, (node) => node.tagName === 'OPTION' && props(node)?.value === 'custom'), report);
      const select = find(host, (node) => node.tagName === 'SELECT' && props(node)?.value === 'year');
      await React.act(async () => props(select).onChange({ target: { value: 'custom' } }));
      const from = find(host, (node) => node.tagName === 'INPUT' && props(node)?.type === 'date');
      await React.act(async () => props(from).onChange({ target: { value: '2026-01-01' } }));
      const to = find(host, (node) => node.tagName === 'INPUT' && props(node)?.type === 'date' && node !== from);
      await React.act(async () => props(to).onChange({ target: { value: '2026-01-31' } }));
      if (report === 'depreciation') {
        assert.match(text(host), /Disposed asset/);
        assert.match(text(host), /150\.00/);
        assert.doesNotMatch(text(host), /Future asset/);
        await React.act(async () => props(to).onChange({ target: { value: '2026-02-01' } }));
        assert.doesNotMatch(text(host), /Disposed asset/);
      }
      if (report === 'analytic') {
        assert.match(text(host), /Archived project/);
        assert.match(text(host), /Historical activity/);
        assert.match(text(host), /123\.00/);
      }
    }
  } finally { await React.act(async () => root.unmount()); }
});

test('journal audit for cash-basis payment with tagged base keeps base items and excludes tax_grid_base from tax rows', async () => {
  const { seed } = await import('./seed.js');
  const { create, read, search } = await import('./orm.js');
  const { postMove, payMove } = await import('./models/accounting.js');
  const { accountId } = await import('./models/ledger.js');
  const { taxSnapshot } = await import('./models/taxes.js');
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: '+Box Audit Base', applicability: 'taxes', tax_negate: false });
  const taxTag = create(baseTag.db, 'account.account.tag', { name: '+Box Audit Tax', applicability: 'taxes', tax_negate: false });
  const tax = create(taxTag.db, 'account.tax', {
    name: 'Audit CB 20%',
    amount: 20,
    amount_type: 'percent',
    type_tax_use: 'purchase',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: accountId(taxTag.db, '131100'),
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: accountId(taxTag.db, '131000'), tag_ids: [taxTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: accountId(taxTag.db, '131000'), tag_ids: [taxTag.id] },
    ],
  });
  db = tax.db;
  const partner = search(db, 'res.partner')[0];
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    invoice_date: '2026-03-01',
    company_id: 1,
    invoice_line_ids: [{ name: 'Tagged expense', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', tax.id)) }],
  });
  db = postMove(bill.db, bill.id);
  db = payMove(db, bill.id, 1200, '2026-03-05');

  const groups = journalAudit(db, { from: '2026-03-05', to: '2026-03-05', companyId: 1 });
  const misc = groups.find((g) => g.journal.code === 'MISC');
  assert.ok(misc);
  assert.ok(misc.items.some((item) => item.line.tax_grid_base));
  assert.equal(misc.taxes.length, 1);
  assert.deepEqual(misc.taxes[0], { name: 'Audit CB 20%', base: 1000, tax: 200 });
});

test('journal audit includes zero-rated tax with base tags (base and 0 tax) while excluding cash-basis base-grid lines', async () => {
  const { seed } = await import('./seed.js');
  const { create, read, search } = await import('./orm.js');
  const { postMove, payMove } = await import('./models/accounting.js');
  const { accountId } = await import('./models/ledger.js');
  const { taxSnapshot } = await import('./models/taxes.js');
  let db = seed();
  const baseTag = create(db, 'account.account.tag', { name: '+Zero Base', applicability: 'taxes', tax_negate: false });
  const cbBaseTag = create(baseTag.db, 'account.account.tag', { name: '+CB Base', applicability: 'taxes', tax_negate: false });
  const cbTaxTag = create(cbBaseTag.db, 'account.account.tag', { name: '+CB Tax', applicability: 'taxes', tax_negate: false });
  const zeroTax = create(cbTaxTag.db, 'account.tax', {
    name: 'Zero Export 0%',
    amount: 0,
    amount_type: 'percent',
    type_tax_use: 'sale',
    company_id: 1,
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: accountId(cbTaxTag.db, '251000'), tag_ids: [] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [baseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: accountId(cbTaxTag.db, '251000'), tag_ids: [] },
    ],
  });
  const cbTax = create(zeroTax.db, 'account.tax', {
    name: 'CB Sale 10%',
    amount: 10,
    amount_type: 'percent',
    type_tax_use: 'sale',
    company_id: 1,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: accountId(zeroTax.db, '251100'),
    invoice_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [cbBaseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: accountId(zeroTax.db, '251000'), tag_ids: [cbTaxTag.id] },
    ],
    refund_repartition_line_ids: [
      { factor_percent: 100, repartition_type: 'base', tag_ids: [cbBaseTag.id] },
      { factor_percent: 100, repartition_type: 'tax', account_id: accountId(zeroTax.db, '251000'), tag_ids: [cbTaxTag.id] },
    ],
  });
  db = cbTax.db;
  const partner = search(db, 'res.partner')[0];
  const zeroInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-04-10',
    company_id: 1,
    invoice_line_ids: [{ name: 'Export service', qty: 1, price_unit: 500, ...taxSnapshot(read(db, 'account.tax', zeroTax.id)) }],
  });
  db = postMove(zeroInv.db, zeroInv.id);
  const postedZero = read(db, 'account.move', zeroInv.id);
  assert.ok(postedZero.line_ids.some((l) => l.tax_grid_base && l.tax_zero), 'posted zero-rated line carries both tax_grid_base and tax_zero');

  const cbInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    invoice_date: '2026-04-10',
    company_id: 1,
    invoice_line_ids: [{ name: 'CB service', qty: 1, price_unit: 1000, ...taxSnapshot(read(db, 'account.tax', cbTax.id)) }],
  });
  db = postMove(cbInv.db, cbInv.id);
  db = payMove(db, cbInv.id, 1100, '2026-04-11');

  const groups = journalAudit(db, { from: '2026-04-10', to: '2026-04-11', companyId: 1 });
  const sale = groups.find((g) => g.journal.type === 'sale');
  assert.ok(sale);
  assert.deepEqual(sale.taxes, [
    { name: 'CB Sale 10%', base: 1000, tax: 100 },
    { name: 'Zero Export 0%', base: 500, tax: 0 },
  ]);
  const misc = groups.find((g) => g.journal.code === 'MISC');
  assert.ok(misc);
  assert.ok(misc.items.some((item) => item.line.tax_grid_base && !item.line.tax_zero));
  assert.deepEqual(misc.taxes, [{ name: 'CB Sale 10%', base: 1000, tax: 100 }]);
});
