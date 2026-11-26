import { test } from 'node:test';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import assert from 'node:assert/strict';
import { seed } from './seed.js';
import { applyFilters, create, read, search } from './orm.js';
import { setStatementLineReview } from './models/bank.js';
import { applyDiff, diffDb } from './sync.js';
import { models } from './models/index.js';
import { salesInvoiceView, creditNoteView, purchaseInvoiceView, vendorRefundView, postMove, markAsReviewed } from './models/accounting.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const fields = models['account.move'].fields;
test('sales lists expose send and download', () => {
  for (const view of [salesInvoiceView, creditNoteView]) assert.deepEqual(view.listActions.filter((a) => ['Send', 'Download'].includes(a.label)).map((a) => a.label), ['Send', 'Download']);
});
test('document filters use review state and document type', () => {
  const filter = salesInvoiceView.filters.flat().find((f) => f.id === 'to_check');
  assert.equal(filter.fn({ state: 'posted', review_state: 'todo' }), true);
  assert.equal(filter.fn({ state: 'posted', to_check: true, review_state: 'reviewed' }), false);
  for (const [view, type] of [[salesInvoiceView, 'out_invoice'], [creditNoteView, 'out_refund'], [purchaseInvoiceView, 'in_invoice'], [vendorRefundView, 'in_refund']]) assert.equal(view.filters.flat().find((f) => f.id === type).fn({ move_type: type }), true);
});
test('document lists expose currency, company tax and sales sent columns', () => {
  for (const [view, label] of [[salesInvoiceView, 'Invoice Currency'], [creditNoteView, 'Credit Note Currency'], [purchaseInvoiceView, 'Bill Currency'], [vendorRefundView, 'Refund Currency']]) {
    assert.equal(view.listLabels.currency_id, label);
    assert.ok(view.list.includes('amount_tax_signed'));
  }
  assert.ok(salesInvoiceView.list.includes('move_sent_values'));
  assert.equal(fields.move_sent_values.compute({ is_move_sent: false }), 'not_sent');
  assert.equal(fields.amount_tax_signed.compute({ line_ids: [{ display_type: 'tax', debit: 0, credit: 12 }] }, seed()), 12);
});
test('journal items smart button is available on invoices and refunds', () => {
  const button = models['account.move'].form.smart.find((b) => b.label === 'Journal Items');
  for (const move_type of ['out_invoice', 'out_refund', 'in_invoice', 'in_refund']) assert.equal(button.when({ move_type }), true);
  assert.equal(button.when({ move_type: 'entry' }), false);
  assert.equal(button.target({ id: 42 }), 'accounting/journal-items?move=42');
});
test('base form does not expose localisation cancellation request', () => {
  assert.equal(models['account.move'].form.buttons.some((b) => b.label === 'Request Cancel'), false);
});


test('Journal Items action renders only the chosen document lines, including drafts', async () => {
  const db = seed();
  const account = db.records['account.account'][0];
  const journal = db.records['account.journal'][0];
  const types = ['out_invoice', 'out_refund', 'in_invoice', 'in_refund'];
  const moves = types.map((move_type, index) => ({
    id: 98000 + index, move_type, state: index === 1 ? 'draft' : index === 2 ? 'cancel' : 'posted', company_id: 1,
    date: '2026-01-01', journal_id: journal.id, name: `INV15/${index}`,
    line_ids: [{ account_id: account.id, name: `INV15-LINE-${index}`, debit: 1, credit: 0 }, { account_id: account.id, name: 'INV15-SECTION', display_type: 'line_section', debit: 0, credit: 0 }],
  }));
  db.records['account.move'].push(...moves);
  setupDom();
  const previousLocation = globalThis.location;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();
  await commit(db);
  const button = models['account.move'].form.smart.find((item) => item.label === 'Journal Items');
  try {
    for (const [index, move] of moves.entries()) {
      globalThis.location = { hash: `#/${button.target(move)}` };
      const host = globalThis.document.createElement('div');
      host.ownerDocument = globalThis.document;
      const root = createRoot(host);
      try {
        await React.act(async () => root.render(React.createElement(JournalItems, { leaf: {} })));
        const body = find(host, (node) => node.tagName === 'TBODY');
        assert.ok(body.textContent.includes(`INV15-LINE-${index}`));
        assert.ok(!body.textContent.includes('INV15-SECTION')); 
        for (const other of moves.keys()) {
          if (other !== index) assert.ok(!body.textContent.includes(`INV15-LINE-${other}`));
        }
      } finally {
        await React.act(async () => root.unmount());
      }
    }
  } finally {
    globalThis.location = previousLocation;
  }
});


test('bank review flag makes a posted bill appear in To Review until marked reviewed', () => {
  const base = seed();
  const partner = search(base, 'res.partner')[0];
  const bill = create(base, 'account.move', { move_type: 'in_invoice', partner_id: partner.id, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  let db = postMove(bill.db, bill.id);
  const journal = search(db, 'account.journal').find((item) => item.type === 'bank' && (item.company_id ?? 1) === 1);
  const line = create(db, 'account.bank.statement.line', { journal_id: journal.id, company_id: 1, date: '2026-01-01', payment_ref: 'Review bill', amount: -100, state: 'to_check' });
  // Exercise the bank review operation with a fixture linking its bank move to the bill.
  db = { ...line.db, records: { ...line.db.records, 'account.bank.statement.line': line.db.records['account.bank.statement.line'].map((item) => item.id === line.id ? { ...item, state: 'reconciled', move_id: bill.id, bank_move_id: bill.id } : item) } };
  const flagged = setStatementLineReview(db, line.id, true);
  db = applyDiff(db, diffDb(db, flagged), { isAdmin: true });
  const filtered = () => applyFilters('account.move', [read(db, 'account.move', bill.id)], ['to_check'], db, purchaseInvoiceView.filters);
  assert.equal(read(db, 'account.move', bill.id).review_state, 'todo');
  assert.deepEqual(filtered().map((move) => move.id), [bill.id]);
  assert.equal(db.records['account.move'].find((move) => move.id === bill.id).review_state, undefined);
  const reviewed = markAsReviewed(db, bill.id);
  db = applyDiff(db, diffDb(db, reviewed), { isAdmin: true });
  assert.equal(read(db, 'account.move', bill.id).review_state, 'reviewed');
  assert.deepEqual(filtered(), []);
  assert.equal(fields.review_state.compute({ state: 'draft', to_check: true }), null);
});
