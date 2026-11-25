import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { applyFilters, create, read, search } from './orm.js';
import { seed } from './seed.js';
import { menusFor } from './models/index.js';
import {
  creditNoteView,
  markAsReviewed,
  postMove,
  purchaseInvoiceView,
  salesInvoiceView,
  vendorRefundView,
} from './models/accounting.js';
import { today } from './models/common.js';
import { applyDiff, diffDb } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, name) => String(classOf(node)).split(/\s+/).includes(name);
const allFind = (node, pred, acc = []) => {
  if (!node) return acc;
  if (pred(node)) acc.push(node);
  for (const child of node.childNodes ?? []) allFind(child, pred, acc);
  return acc;
};

function leafFor(sectionLabel, key) {
  return menusFor('accounting').find((m) => m.label === sectionLabel).children.find((c) => c.key === key);
}

function cleanMovesDb() {
  const base = seed();
  return {
    ...base,
    records: {
      ...base.records,
      'account.move': [],
      'account.payment': [],
      'account.bank.statement.line': [],
      'purchase.order': [],
    },
  };
}

async function mountActionView(leaf, initialDb = seed()) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
  const { makeEl } = setupDom();
  globalThis.document.createElementNS ??= (_, tag) => makeEl(tag);
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  await initStore();
  await commit(initialDb);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  let currentLeaf = leaf;
  const render = async (nextLeaf = currentLeaf) => {
    currentLeaf = nextLeaf;
    await act(async () => {
      root.render(React.createElement(ActionView, { leaf: currentLeaf, base: `#/accounting/${currentLeaf.key}`, params: new URLSearchParams('view=list') }));
    });
  };
  await render(leaf);
  return {
    React,
    act,
    host,
    render,
    getDb,
    commit,
    done: async () => {
      await act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

async function actClick(act, el) {
  await act(async () => props(el).onClick({ stopPropagation: () => {}, preventDefault: () => {} }));
}

const origFetch = globalThis.fetch;
const origConfirm = globalThis.confirm;
const origAlert = globalThis.alert;
const origLoc = globalThis.location;

afterEach(() => {
  globalThis.fetch = origFetch;
  globalThis.confirm = origConfirm;
  globalThis.alert = origAlert;
  globalThis.location = origLoc;
});

test('INV-14: per-type currency column labels match Odoo 20 across all four document lists', async () => {
  const invoicesLeaf = leafFor('Customers', 'invoices');
  const creditNotesLeaf = leafFor('Customers', 'credit-notes');
  const billsLeaf = leafFor('Vendors', 'bills');
  const refundsLeaf = leafFor('Vendors', 'refunds');

  assert.equal(salesInvoiceView.listLabels.currency_id, 'Invoice Currency');
  assert.equal(creditNoteView.listLabels.currency_id, 'Credit Note Currency');
  assert.equal(purchaseInvoiceView.listLabels.currency_id, 'Bill Currency');
  assert.equal(vendorRefundView.listLabels.currency_id, 'Refund Currency');

  assert.equal(invoicesLeaf.listLabels.currency_id, 'Invoice Currency');
  assert.equal(creditNotesLeaf.listLabels.currency_id, 'Credit Note Currency');
  assert.equal(billsLeaf.listLabels.currency_id, 'Bill Currency');
  assert.equal(refundsLeaf.listLabels.currency_id, 'Refund Currency');

  const ctx = await mountActionView(creditNotesLeaf, seed());
  try {
    const toggleOptionalCol = async (labelText) => {
      const colsTh = find(ctx.host, (n) => n.tagName === 'TH' && hasClass(n, 'o2m-cols-th'));
      await actClick(ctx.act, find(colsTh, (n) => n.tagName === 'BUTTON'));
      const btn = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox')
        .find((b) => b.textContent.replace('✓', '').trim() === labelText);
      assert.ok(btn, `optional column menu must include ${labelText}`);
      await actClick(ctx.act, btn);
    };
    const headers = () => allFind(ctx.host, (n) => n.tagName === 'THEAD')
      .flatMap((thead) => allFind(thead, (n) => n.tagName === 'TH' && !hasClass(n, 'check') && !hasClass(n, 'o2m-cols-th')))
      .map((th) => th.textContent.trim().replace(/\s*[▲▼]$/, ''));

    await toggleOptionalCol('Credit Note Currency');
    assert.ok(headers().includes('Credit Note Currency'));

    await ctx.render(refundsLeaf);
    await toggleOptionalCol('Refund Currency');
    assert.ok(headers().includes('Refund Currency'));
  } finally {
    await ctx.done();
  }
});

test('INV-14: list header actions expose Send, Register Payment, Download per Odoo 20 and enforce constraints', () => {
  assert.deepEqual(salesInvoiceView.listActions.map((a) => a.label), ['Send', 'Register Payment', 'Download']);
  assert.deepEqual(creditNoteView.listActions.map((a) => a.label), ['Send', 'Register Payment', 'Download']);
  assert.deepEqual(purchaseInvoiceView.listActions.map((a) => a.label), ['Register Payment', 'Download']);
  assert.deepEqual(vendorRefundView.listActions.map((a) => a.label), ['Register Payment', 'Download']);
  for (const action of [...salesInvoiceView.listActions, ...purchaseInvoiceView.listActions]) {
    assert.equal(action.requiresSelection, true, `${action.label} requires selection`);
  }

  let db = cleanMovesDb();
  const partnerWithEmail = create(db, 'res.partner', { name: 'Email Cust', email: 'ar@example.com' });
  db = partnerWithEmail.db;
  const partnerNoEmail = create(db, 'res.partner', { name: 'No Email Cust', email: '' });
  db = partnerNoEmail.db;
  const vendor = search(db, 'res.partner').find((p) => p.supplier_rank > 0) ?? partnerWithEmail;

  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partnerWithEmail.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);

  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partnerWithEmail.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 150, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);

  const invNoEmail = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partnerNoEmail.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(invNoEmail.db, invNoEmail.id);

  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partnerWithEmail.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 40, tax: 0 }],
  });
  db = draftInv.db;

  const postedBill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: vendor.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 80, tax: 0 }],
  });
  db = postMove(postedBill.db, postedBill.id);

  const miscJournal = search(db, 'account.journal').find((j) => j.type === 'general');
  const accounts = search(db, 'account.account').filter((a) => !a.company_id || a.company_id === 1);
  const entry = create(db, 'account.move', {
    move_type: 'entry', journal_id: miscJournal.id, date: today(),
    line_ids: [{ account_id: accounts[0].id, debit: 20 }, { account_id: accounts[1].id, credit: 20 }],
  });
  db = postMove(entry.db, entry.id);

  const sendAction = salesInvoiceView.listActions.find((a) => a.label === 'Send');
  const downloadAction = salesInvoiceView.listActions.find((a) => a.label === 'Download');

  // Constraints on Send
  assert.throws(() => sendAction.wizard(db, []), /Select at least one record/);
  assert.throws(() => sendAction.wizard(db, [inv1.id, draftInv.id]), /not posted/i);
  assert.throws(() => sendAction.wizard(db, [postedBill.id]), /sales documents/i);
  assert.throws(() => sendAction.run(db, [inv1.id, draftInv.id], { email: true, download: false }), /not posted/i);
  assert.throws(() => sendAction.run(db, [inv1.id], { email: false, download: false }), /Select at least one channel/);

  // Wizard Email default reflects whether all selected partners have email
  const allEmailSpec = sendAction.wizard(db, [inv1.id, inv2.id]);
  assert.equal(allEmailSpec.fields.find((f) => f.name === 'email').default, true);
  assert.equal(allEmailSpec.fields.find((f) => f.name === 'download').default, false);
  const mixedEmailSpec = sendAction.wizard(db, [inv1.id, invNoEmail.id]);
  assert.equal(mixedEmailSpec.fields.find((f) => f.name === 'email').default, false);

  // Batch Send with download marks all selected posted invoices sent and navigates to batch print route
  const sentRes = sendAction.run(db, [inv1.id, inv2.id], { email: false, download: true });
  assert.equal(sentRes.go, `#/print/account.move/${inv1.id},${inv2.id}`);
  assert.equal(read(sentRes.db, 'account.move', inv1.id).is_move_sent, true);
  assert.equal(read(sentRes.db, 'account.move', inv2.id).is_move_sent, true);

  // Diff round-trip keeps is_move_sent persisted cleanly
  const synced = applyDiff(db, diffDb(db, sentRes.db), { isAdmin: false });
  assert.equal(read(synced, 'account.move', inv1.id).is_move_sent, true);
  assert.equal(read(synced, 'account.move', inv2.id).is_move_sent, true);

  // Download works for invoices/bills without modifying is_move_sent, and rejects journal entries
  assert.throws(() => downloadAction.run(db, []), /Select at least one record/);
  assert.throws(() => downloadAction.run(db, [entry.id]), /Only invoices, credit notes, bills, and refunds/);
  const dlRes = downloadAction.run(db, [inv1.id, draftInv.id]);
  assert.equal(dlRes.go, `#/print/account.move/${inv1.id},${draftInv.id}`);
  assert.equal(read(dlRes.db, 'account.move', inv1.id).is_move_sent, false);
  const billDlRes = purchaseInvoiceView.listActions.find((a) => a.label === 'Download').run(db, [postedBill.id]);
  assert.equal(billDlRes.go, `#/print/account.move/${postedBill.id}`);
});

test('INV-14: ActionView Send wizard and multi-document PrintDoc rendering work end-to-end', async () => {
  let db = cleanMovesDb();
  const partner = create(db, 'res.partner', { name: 'Batch Send Cust', email: 'batch@example.com' });
  db = partner.db;
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 2, price_unit: 75, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);

  globalThis.confirm = () => true;
  globalThis.alert = () => {};
  globalThis.location = { hash: '#/accounting/invoices' };

  const ctx = await mountActionView(leafFor('Customers', 'invoices'), db);
  try {
    const checkboxes = () => allFind(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    // Select both invoice rows (index 0 is Select all).
    await ctx.act(async () => props(checkboxes()[1]).onChange());
    await ctx.act(async () => props(checkboxes()[2]).onChange());

    const sendBtn = allFind(ctx.host, (n) => n.tagName === 'BUTTON').find((b) => b.textContent.trim() === 'Send');
    assert.ok(sendBtn, 'ActionView must render Send button on Customer Invoices');
    await actClick(ctx.act, sendBtn);

    const dialog = find(ctx.host, (n) => n.tagName === 'FORM' && hasClass(n, 'wizard'));
    assert.ok(dialog, 'Send wizard opens from ActionView');
    const dlCheckbox = find(dialog, (n) => n.tagName === 'INPUT' && props(n)?.id === 'w-download');
    await ctx.act(async () => props(dlCheckbox).onChange({ target: { checked: true } }));

    await ctx.act(async () => {
      const form = find(ctx.host, (n) => n.tagName === 'FORM' && hasClass(n, 'wizard'));
      await props(form).onSubmit({ preventDefault() {} });
    });

    assert.equal(globalThis.location.hash, `#/print/account.move/${inv1.id},${inv2.id}`);
    assert.equal(read(ctx.getDb(), 'account.move', inv1.id).is_move_sent, true);
    assert.equal(read(ctx.getDb(), 'account.move', inv2.id).is_move_sent, true);
    for (const id of [inv1.id, inv2.id]) {
      const notes = (ctx.getDb().messages ?? []).filter((m) => m.model === 'account.move' && m.res_id === id);
      assert.ok(notes.some((m) => m.body.includes('Not sent: Email is not configured.')), `chatter note recorded for move ${id}`);
    }

    // Verify PrintDoc renders both documents when given comma-separated IDs.
    const { PrintDoc } = await import('./views/PrintDoc.jsx');
    const { createRoot } = await import('react-dom/client');
    const printHost = globalThis.document.createElement('div');
    printHost.ownerDocument = globalThis.document;
    const printRoot = createRoot(printHost);
    try {
      await ctx.act(async () => {
        printRoot.render(ctx.React.createElement(PrintDoc, { model: 'account.move', id: `${inv1.id},${inv2.id}` }));
      });
      const papers = allFind(printHost, (n) => n.tagName === 'ARTICLE' && hasClass(n, 'paper'));
      assert.equal(papers.length, 2, 'multi-move PrintDoc must render one paper article per selected move');
      assert.ok(papers[0].textContent.includes(read(ctx.getDb(), 'account.move', inv1.id).name));
      assert.ok(papers[1].textContent.includes(read(ctx.getDb(), 'account.move', inv2.id).name));
    } finally {
      await ctx.act(async () => printRoot.unmount());
    }
  } finally {
    await ctx.done();
  }
});

test('INV-14: search filters match Odoo 20 view_account_invoice_filter and view_account_bill_filter', () => {
  let db = cleanMovesDb();
  const cust = search(db, 'res.partner').find((p) => p.customer_rank > 0) ?? search(db, 'res.partner')[0];
  const vend = search(db, 'res.partner').find((p) => p.supplier_rank > 0) ?? search(db, 'res.partner')[0];

  const invPosted = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: cust.id, invoice_date: today(), to_check: true,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invPosted.db, invPosted.id);

  const incomeAcc = search(db, 'account.account').find((a) => a.account_type === 'income');
  const securedSaleJournal = create(db, 'account.journal', {
    name: 'Secured Sales',
    code: 'SSAL',
    type: 'sale',
    default_account_id: incomeAcc.id,
    restrict_mode_hash_table: true,
    invoice_sequence_prefix: 'SINV/',
    invoice_sequence_next_number: 1,
    refund_sequence: true,
    refund_sequence_prefix: 'SRINV/',
    refund_sequence_next_number: 1,
  });
  db = securedSaleJournal.db;

  const invSecured = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: cust.id, journal_id: securedSaleJournal.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 120, tax: 0 }],
  });
  db = postMove(invSecured.db, invSecured.id);
  assert.ok(read(db, 'account.move', invSecured.id).inalterable_hash, 'restricted journal hashes posted invoice');

  const invDraftToCheck = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: cust.id, invoice_date: today(), to_check: true,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 30, tax: 0 }],
  });
  db = invDraftToCheck.db;

  const cn = create(db, 'account.move', {
    move_type: 'out_refund', partner_id: cust.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 40, tax: 0 }],
  });
  db = postMove(cn.db, cn.id);

  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const purchaseJournal = search(db, 'account.journal').find((j) => j.type === 'purchase');
  const accounts = search(db, 'account.account').filter((a) => !a.company_id || a.company_id === 1);

  const outReceipt = create(db, 'account.move', {
    move_type: 'out_receipt', partner_id: cust.id, journal_id: saleJournal.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 25, tax: 0 }],
  });
  db = postMove(outReceipt.db, outReceipt.id);

  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: vend.id, invoice_date: today(), to_check: true,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  const inReceipt = create(db, 'account.move', {
    name: 'PRCP/2026/0001',
    move_type: 'in_receipt', partner_id: vend.id, journal_id: purchaseJournal.id, invoice_date: today(), state: 'posted',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 35, tax: 0 }],
    line_ids: [{ account_id: accounts[0].id, debit: 35 }, { account_id: accounts[1].id, credit: 35 }],
  });
  db = inReceipt.db;

  const vRefund = create(db, 'account.move', {
    move_type: 'in_refund', partner_id: vend.id, invoice_date: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(vRefund.db, vRefund.id);

  const salesMoves = [invPosted.id, invSecured.id, invDraftToCheck.id, cn.id, outReceipt.id].map((id) => read(db, 'account.move', id));
  const purchMoves = [bill.id, inReceipt.id, vRefund.id].map((id) => read(db, 'account.move', id));

  // Labels & presence check
  const salesFilters = salesInvoiceView.filters.flat();
  const purchFilters = purchaseInvoiceView.filters.flat();
  for (const [id, label] of [
    ['myinvoices', 'My Invoices'],
    ['not_secured', 'Not Secured'],
    ['out_invoice', 'Invoices'],
    ['out_receipt', 'Receipts'],
    ['out_refund', 'Credit Notes'],
    ['to_check', 'To Review'],
  ]) {
    assert.equal(salesFilters.find((f) => f.id === id)?.label, label, `sales filter ${id} -> ${label}`);
  }
  for (const [id, label] of [
    ['not_secured', 'Not Secured'],
    ['in_invoice', 'Bills'],
    ['in_receipt', 'Receipt'],
    ['in_refund', 'Refunds'],
    ['to_check', 'To Review'],
  ]) {
    assert.equal(purchFilters.find((f) => f.id === id)?.label, label, `purchase filter ${id} -> ${label}`);
  }
  assert.equal(purchFilters.find((f) => f.id === 'myinvoices'), undefined, 'view_account_bill_filter removes My Invoices');
  assert.ok(purchFilters.some((f) => f.label === 'Bill Date: This Month'), 'view_account_bill_filter uses Bill Date');

  // Sales type OR group: Invoices, Receipts, Credit Notes
  assert.deepEqual(applyFilters('account.move', salesMoves, ['out_invoice'], db, salesInvoiceView.filters).map((m) => m.id), [invPosted.id, invSecured.id, invDraftToCheck.id]);
  assert.deepEqual(applyFilters('account.move', salesMoves, ['out_receipt'], db, salesInvoiceView.filters).map((m) => m.id), [outReceipt.id]);
  assert.deepEqual(applyFilters('account.move', salesMoves, ['out_refund'], db, salesInvoiceView.filters).map((m) => m.id), [cn.id]);
  assert.deepEqual(applyFilters('account.move', salesMoves, ['out_invoice', 'out_receipt'], db, salesInvoiceView.filters).map((m) => m.id), [invPosted.id, invSecured.id, invDraftToCheck.id, outReceipt.id]);

  // Purchase type OR group: Bills, Receipt, Refunds
  assert.deepEqual(applyFilters('account.move', purchMoves, ['in_invoice'], db, purchaseInvoiceView.filters).map((m) => m.id), [bill.id]);
  assert.deepEqual(applyFilters('account.move', purchMoves, ['in_receipt'], db, purchaseInvoiceView.filters).map((m) => m.id), [inReceipt.id]);
  assert.deepEqual(applyFilters('account.move', purchMoves, ['in_refund'], db, purchaseInvoiceView.filters).map((m) => m.id), [vRefund.id]);

  // Not Secured: posted and no inalterable_hash
  assert.deepEqual(
    applyFilters('account.move', salesMoves, ['not_secured'], db, salesInvoiceView.filters).map((m) => m.id),
    [invPosted.id, cn.id, outReceipt.id],
  );

  // To Review: posted and flagged (to_check or review_state), cleared by markAsReviewed
  assert.deepEqual(applyFilters('account.move', salesMoves, ['to_check'], db, salesInvoiceView.filters).map((m) => m.id), [invPosted.id]);
  assert.deepEqual(applyFilters('account.move', purchMoves, ['to_check'], db, purchaseInvoiceView.filters).map((m) => m.id), [bill.id]);
  const reviewedDb = markAsReviewed(db, invPosted.id);
  assert.deepEqual(
    applyFilters('account.move', [read(reviewedDb, 'account.move', invPosted.id)], ['to_check'], reviewedDb, salesInvoiceView.filters),
    [],
  );
});

test('INV-14: Arabic translations cover new currency labels, header actions, filters, and errors', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {}, removeItem() {} };
  try {
    const i18nUrl = new URL(`./i18n.js?inv14_ar=${Date.now()}`, import.meta.url).href;
    const { t } = await import(i18nUrl);
    for (const key of [
      'Credit Note Currency',
      'Refund Currency',
      'Send',
      'Download',
      'Invoices',
      'Receipts',
      'Credit Notes',
      'Bills',
      'Receipt',
      'Refunds',
      'To Review',
      'Not Secured',
      'Bill Date: This Month',
      'Bill Date: This Year',
      "You can't generate invoices that are not posted.",
      'You can only generate sales documents or purchase documents for self-billing.',
      'Only invoices, credit notes, bills, and refunds can be downloaded',
      'Journal entry not found',
    ]) {
      assert.notEqual(t(key), key, `Missing Arabic translation for: ${key}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
