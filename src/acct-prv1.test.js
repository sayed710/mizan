import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { create, messagesOf, read } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { postMove, previewInvoice } from './models/accounting.js';
import { applyDiff, diffDb } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const textOf = (node) => (node?.nodeType === 3 ? node.nodeValue : (node?.childNodes ?? []).map(textOf).join(''));
const propsOf = (n) => n?.[Object.keys(n).find((k) => k.startsWith('__reactProps$'))];

function findAllInTree(root, predicate, out = []) {
  if (!root) return out;
  if (predicate(root)) out.push(root);
  for (const child of root.childNodes ?? []) {
    findAllInTree(child, predicate, out);
  }
  return out;
}

test('PRV-1: customer invoices and credit notes get Preview form button with Odoo 20 visibility and rendered preview without print dialog', async () => {
  const btn = models['account.move'].form.buttons.find((b) => b.label === 'Preview');
  assert.ok(btn, 'Preview button exists on account.move form buttons');
  assert.equal(btn.name, 'preview_invoice', 'Preview button matches Odoo 20 name preview_invoice');
  assert.equal(typeof models['account.move'].preview_invoice, 'function', 'preview_invoice method is available on account.move model');

  // Odoo 20 visibility in account_move_views.xml: invisible="move_type not in ('out_invoice', 'out_refund')"
  for (const state of ['draft', 'posted', 'cancel']) {
    assert.equal(btn.when({ move_type: 'out_invoice', state }), true, `visible on ${state} customer invoice`);
    assert.equal(btn.when({ move_type: 'out_refund', state }), true, `visible on ${state} customer credit note`);
    assert.equal(btn.when({ move_type: 'in_invoice', state }), false, `hidden on ${state} vendor bill`);
    assert.equal(btn.when({ move_type: 'in_refund', state }), false, `hidden on ${state} vendor refund`);
    assert.equal(btn.when({ move_type: 'entry', state }), false, `hidden on ${state} journal entry`);
  }

  // Preconditions & guards
  const db0 = seed();
  assert.throws(
    () => previewInvoice(db0, { move_type: 'out_invoice' }),
    /Save the document before previewing/,
    'refuses previewing unsaved record without an id',
  );
  assert.throws(
    () => previewInvoice(db0, { id: 99, move_type: 'in_invoice' }),
    /Only customer invoices and credit notes can be previewed/,
    'refuses previewing vendor bills',
  );
  assert.throws(
    () => previewInvoice(db0, { id: 99, move_type: 'entry' }),
    /Only customer invoices and credit notes can be previewed/,
    'refuses previewing journal entries',
  );

  // Running preview returns the #/preview/... route (never #/print/...)
  const createdInv = create(db0, 'account.move', { move_type: 'out_invoice', partner_id: 1, name: '/' });
  const inv = read(createdInv.db, 'account.move', createdInv.id);
  const invRes = btn.run(createdInv.db, inv);
  assert.equal(invRes.go, `#/preview/account.move/${inv.id}`);
  assert.ok(!invRes.go.includes('#/print/'), 'must never use #/print/ route for preview');

  const createdRefund = create(createdInv.db, 'account.move', { move_type: 'out_refund', partner_id: 1, name: '/' });
  const refund = read(createdRefund.db, 'account.move', createdRefund.id);
  const refRes = btn.run(createdRefund.db, refund);
  assert.equal(refRes.go, `#/preview/account.move/${refund.id}`);
  assert.ok(!refRes.go.includes('#/print/'), 'must never use #/print/ route for preview');

  // Verify rendered document without opening browser print dialog
  setupDom();
  let printCallCount = 0;
  globalThis.print = () => { printCallCount++; };

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  const { App } = await import('./App.jsx');
  const { FormView } = await import('./views/FormView.jsx');

  await initStore();
  await commit(createdRefund.db);

  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);

  try {
    // 1. Render PrintDoc directly with preview=true
    await React.act(async () => {
      root.render(React.createElement(PrintDoc, { model: 'account.move', id: inv.id, preview: true }));
    });
    // Wait for any timeout that might have triggered window.print()
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(printCallCount, 0, 'PrintDoc in preview mode must NOT trigger window.print()');
    const previewText = textOf(host);
    assert.ok(previewText.includes('Draft Invoice'), 'renders invoice title');

    // 2. Render App with #/preview/account.move/:id
    globalThis.location = {
      hash: `#/preview/account.move/${inv.id}`,
      replace(h) { this.hash = h; },
    };
    await React.act(async () => {
      root.render(React.createElement(App));
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(printCallCount, 0, 'App under #/preview/ route must NOT trigger window.print()');
    assert.equal(globalThis.location.hash, `#/preview/account.move/${inv.id}`);

    // 3. FormView header renders Preview button for customer invoice and clicking navigates to preview
    const invoiceLeaf = menusFor('accounting').find((m) => m.label === 'Customers').children.find((c) => c.key === 'invoices');
    globalThis.location = {
      hash: `#/accounting/invoices/${inv.id}`,
      replace(h) { this.hash = h; },
    };
    await React.act(async () => {
      root.render(React.createElement(FormView, {
        leaf: invoiceLeaf,
        id: inv.id,
        base: '#/accounting/invoices',
        params: new URLSearchParams('view=form'),
      }));
    });

    const buttons = findAllInTree(host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Preview');
    assert.equal(buttons.length, 1, 'Preview button rendered in FormView header for customer invoice');

    await React.act(async () => {
      propsOf(buttons[0]).onClick();
      await new Promise((r) => setTimeout(r, 100));
    });
    assert.equal(globalThis.location.hash, `#/preview/account.move/${inv.id}`, 'navigates to preview route');
    assert.ok(!globalThis.location.hash.startsWith('#/print/'), 'never leaves browser tab on #/print/ route');
    assert.equal(printCallCount, 0, 'opening preview does not trigger print dialog');

    // 4. FormView header hides Preview button for vendor bill
    const bill = create(createdRefund.db, 'account.move', { move_type: 'in_invoice', partner_id: 2 });
    await React.act(async () => commit(bill.db));
    const billLeaf = menusFor('accounting').find((m) => m.label === 'Vendors').children.find((c) => c.key === 'bills');
    globalThis.location = {
      hash: `#/accounting/bills/${bill.id}`,
      replace(h) { this.hash = h; },
    };
    await React.act(async () => {
      root.render(React.createElement(FormView, {
        leaf: billLeaf,
        id: bill.id,
        base: '#/accounting/bills',
        params: new URLSearchParams('view=form'),
      }));
    });

    const billButtons = findAllInTree(host, (n) => n.tagName === 'BUTTON' && textOf(n).trim() === 'Preview');
    assert.equal(billButtons.length, 0, 'Preview button is hidden where Odoo hides it (vendor bills)');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('PRV-2: opening the preview must not change the move (no is_move_sent, no sequence, no chatter) and is diff-verifiable', () => {
  const db0 = seed();

  // Case 1: Draft customer invoice
  const draftCreate = create(db0, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    name: '/',
    state: 'draft',
    is_move_sent: false,
    invoice_line_ids: [{ name: 'Test item', qty: 2, price_unit: 100 }],
  });
  const draftBefore = read(draftCreate.db, 'account.move', draftCreate.id);
  const draftMessagesBefore = messagesOf(draftCreate.db, 'account.move', draftCreate.id);

  const draftRes = previewInvoice(draftCreate.db, draftBefore);
  const draftAfter = read(draftRes.db, 'account.move', draftCreate.id);
  const draftMessagesAfter = messagesOf(draftRes.db, 'account.move', draftCreate.id);

  assert.equal(draftAfter.is_move_sent, false, 'is_move_sent must not flip on draft preview');
  assert.equal(draftAfter.name, '/', 'name/sequence must not change on draft preview');
  assert.equal(draftAfter.state, 'draft', 'state must remain draft on draft preview');
  assert.equal(draftMessagesAfter.length, draftMessagesBefore.length, 'no chatter message written on draft preview');
  assert.deepEqual(draftAfter, draftBefore, 'draft invoice record must be completely unchanged');

  // Case 2: Posted customer invoice
  const draftForPost = create(db0, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-02-01',
    invoice_line_ids: [{ name: 'Test item', qty: 1, price_unit: 250, account_id: 1 }],
  });
  const postedDb = postMove(draftForPost.db, draftForPost.id);
  const postedBefore = read(postedDb, 'account.move', draftForPost.id);
  const postedMessagesBefore = messagesOf(postedDb, 'account.move', draftForPost.id);

  const postedRes = previewInvoice(postedDb, postedBefore);
  const postedAfter = read(postedRes.db, 'account.move', draftForPost.id);
  const postedMessagesAfter = messagesOf(postedRes.db, 'account.move', draftForPost.id);

  assert.equal(postedAfter.is_move_sent, false, 'is_move_sent must not flip on posted preview');
  assert.equal(postedAfter.name, postedBefore.name, 'name must not change on posted preview');
  assert.equal(postedAfter.state, 'posted', 'state must remain posted on posted preview');
  assert.equal(postedMessagesAfter.length, postedMessagesBefore.length, 'no chatter message written on posted preview');
  assert.deepEqual(postedAfter, postedBefore, 'posted invoice record must be completely unchanged');

  // Case 3: Customer credit note (out_refund)
  const refundCreate = create(postedDb, 'account.move', {
    move_type: 'out_refund',
    partner_id: 1,
    name: '/',
    state: 'draft',
    is_move_sent: false,
    invoice_line_ids: [{ name: 'Return item', qty: 1, price_unit: 50 }],
  });
  const refundBefore = read(refundCreate.db, 'account.move', refundCreate.id);
  const refundRes = previewInvoice(refundCreate.db, refundBefore);
  const refundAfter = read(refundRes.db, 'account.move', refundCreate.id);
  assert.deepEqual(refundAfter, refundBefore, 'credit note record must be completely unchanged');

  // Diff-verifiable check: diffDb + applyDiff
  const diff = diffDb(draftCreate.db, draftRes.db);
  assert.deepEqual(diff.upserts?.['account.move'] ?? [], [], 'diffDb must show zero account.move upserts');
  assert.deepEqual(diff.inserts?.['mail.message'] ?? [], [], 'diffDb must show zero chatter message inserts');
  assert.deepEqual(diff.deletes?.['account.move'] ?? [], [], 'diffDb must show zero deletes');

  const syncedDb = applyDiff(draftCreate.db, diff, { isAdmin: true });
  assert.deepEqual(read(syncedDb, 'account.move', draftCreate.id), draftBefore, 'database after applyDiff remains identical');
});
