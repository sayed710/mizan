import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import './models/index.js';
import { seed } from './seed.js';
import { create, read, write } from './orm.js';
import { postMove } from './models/accounting.js';
import { accountId, postEntry, profitAndLoss } from './models/ledger.js';
import { models } from './registry.js';
import { confirmAsset, disposeAsset } from './models/assets.js';
import { renderAnnualReportHtml } from './models/auditreport.js';
import { amortization } from './models/loans.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('asset disposal uses its posted invoice allocation and prevents reuse', () => {
  let db = seed();
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2033-02-15', invoice_line_ids: [
    { qty: 1, price_unit: 50, tax: 0, account_id: accountId(db, '410000') },
    { qty: 1, price_unit: 25, tax: 0, account_id: accountId(db, '410000') },
  ] });
  db = postMove(invoice.db, invoice.id);
  const makeAsset = (database, name) => {
    const asset = create(database, 'account.asset', { name, company_id: 1, original_value: 120, acquisition_date: '2033-01-15', method: 'linear', method_number: 12, method_period: '1', prorata: true });
    return { id: asset.id, db: confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id)) };
  };
  const first = makeAsset(db, 'First');
  db = first.db;
  const options = { date: '2033-02-15', invoiceId: invoice.id, invoiceLine: 0 };
  assert.throws(() => disposeAsset(db, read(db, 'account.asset', first.id), { ...options, saleValue: 10 }), /match/i);
  db = disposeAsset(db, read(db, 'account.asset', first.id), options);
  const disposal = db.records['account.move'].find((move) => move.ref === 'First disposal');
  const debit = (code) => disposal.line_ids.find((line) => read(db, 'account.account', line.account_id).code === code)?.debit;
  assert.equal(debit('410000'), 50);
  assert.equal(debit('690300'), 64.52);
  assert.equal(read(db, 'account.asset', first.id).sale_value, 50);
  const second = makeAsset(db, 'Second');
  assert.throws(() => disposeAsset(second.db, read(second.db, 'account.asset', second.id), { ...options, saleValue: 50 }), /already used/i);
  const result = disposeAsset(second.db, read(second.db, 'account.asset', second.id), { ...options, invoiceLine: 1, saleValue: 25 });
  assert.equal(read(result, 'account.asset', second.id).sale_value, 25);
});

test('asset disposal wizard accepts an invoice with an empty sale price', () => {
  let db = seed();
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2033-02-15', invoice_line_ids: [{ qty: 1, price_unit: 50, tax: 0 }] });
  db = postMove(invoice.db, invoice.id);
  const asset = create(db, 'account.asset', { name: 'Wizard asset', original_value: 120, acquisition_date: '2033-01-15', method: 'linear', method_number: 12, method_period: '1' });
  db = confirmAsset(asset.db, read(asset.db, 'account.asset', asset.id));
  const button = models['account.asset'].form.buttons.find((item) => item.label === 'Sell or Dispose');
  const values = { date: '2033-02-15', invoice_id: invoice.id, invoice_line: '0', sale_value: '' };
  assert.throws(() => button.run(db, read(db, 'account.asset', asset.id), { ...values, sale_value: 10 }), /match/i);
  const result = button.run(db, read(db, 'account.asset', asset.id), values);
  assert.equal(read(result.db, 'account.asset', asset.id).sale_value, 50);
});

test('rendered disposal wizard prefills the selected invoice line amount', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { Wizard } = await import('./views/Wizard.jsx');
  let db = seed();
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2033-02-15', invoice_line_ids: [{ qty: 1, price_unit: 50, tax: 0 }, { qty: 1, price_unit: 25, tax: 0 }] });
  db = postMove(invoice.db, invoice.id);
  const asset = create(db, 'account.asset', { name: 'Wizard asset', original_value: 120, acquisition_date: '2033-01-15', method_number: 12 });
  db = asset.db;
  const button = models['account.asset'].form.buttons.find((item) => item.label === 'Sell or Dispose');
  const spec = button.wizard(db, read(db, 'account.asset', asset.id));
  const rootEl = makeEl('div');
  rootEl.ownerDocument = globalThis.document;
  const root = createRoot(rootEl);
  const props = (node) => node?.[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
  const field = (id) => find(rootEl, (node) => props(node)?.id === `w-${id}`);
  try {
    await React.act(async () => root.render(React.createElement(Wizard, { db, spec, onConfirm: () => {}, onCancel: () => {} })));
    await React.act(async () => props(field('invoice_id')).onChange({ target: { value: String(invoice.id) } }));
    assert.equal(props(field('invoice_line')).value, '0');
    assert.equal(props(field('sale_value')).value, 50);
    await React.act(async () => props(field('invoice_line')).onChange({ target: { value: '1' } }));
    assert.equal(props(field('sale_value')).value, 25);
    await React.act(async () => props(field('invoice_id')).onChange({ target: { value: '' } }));
    assert.equal(props(field('sale_value')).value, '');
  } finally { await React.act(async () => root.unmount()); }
});

test('annual report explains other income and expenses with escaped account names', () => {
  let db = seed();
  db = write(db, 'account.account', accountId(db, '450000'), { name: 'Other <income>' });
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2035-05-01', lines: [{ account: '101401', debit: 150 }, { account: '400000', credit: 100 }, { account: '450000', credit: 50 }] }).db;
  db = postEntry(db, { journal: 'MISC', company: 1, date: '2035-05-02', lines: [{ account: '690400', debit: 20 }, { account: '101401', credit: 20 }] }).db;
  const pnl = profitAndLoss(db, { from: '2035-01-01', to: '2035-12-31', company_id: 1 });
  assert.equal(pnl.detail.otherIncome.find((row) => row.account.code === '450000').balance, 50);
  assert.equal(pnl.detail.otherExpense.find((row) => row.account.code === '690400').balance, 20);
  const html = renderAnnualReportHtml(db, { start_date: '2035-01-01', end_date: '2035-12-31', company_id: 1 });
  assert.match(html, /Other &lt;income&gt;<\/td><td[^>]*>50\.00/);
  assert.match(html, /Interest Expense<\/td><td[^>]*>20\.00/);
  for (const [label, value] of [['Net Operating Income', '100.00'], ['Total Other Income', '50.00'], ['Total Other Expenses', '20.00'], ['Net Income', '130.00']]) {
    assert.ok(html.includes(`${label}</td><td style="text-align: right;">${value}`));
  }
});

test('loan principal remains nonnegative and never exceeds the opening cents', () => {
  for (const method of ['linear', 'annuity']) {
    const lines = amortization({ amount: 0.02, duration: 4, interest_rate: 0, method, start_date: '2026-01-01' });
    let paid = 0;
    for (const line of lines) {
      paid += Math.round(line.principal * 100);
      assert.ok(line.principal >= 0 && line.outstanding >= 0 && paid <= 2);
    }
    assert.equal(paid, 2);
    assert.equal(lines.at(-1).outstanding, 0);
  }
});
