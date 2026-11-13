import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { applyFilters, create, groupRecords, matches, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { addDays, today } from './models/common.js';
import { createCompany } from './models/company.js';
import { creditNote, payMove, postMove, purchaseInvoiceView, salesInvoiceView, statusInPayment } from './models/accounting.js';
import { setActor } from './models/authority.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

afterEach(() => setActor(null));

const allFind = (node, pred, acc = []) => {
  if (!node) return acc;
  if (pred(node)) acc.push(node);
  for (const child of node.childNodes ?? []) allFind(child, pred, acc);
  return acc;
};
const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, name) => String(classOf(node)).split(/\s+/).includes(name);

function leafFor(sectionLabel, key) {
  const sec = menusFor('accounting').find((m) => m.label === sectionLabel);
  return sec.children.find((c) => c.key === key);
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

function addOutstandingReceipts(db) {
  const acc = create(db, 'account.account', { code: 'TEST-OUT-REC', name: 'Outstanding Receipts', company_id: 1, account_type: 'asset_current', reconcile: true });
  return write(acc.db, 'res.company', 1, { outstanding_receipts_account_id: acc.id });
}

async function mountMoveList(leaf, initialDb = seed()) {
  const prevStorage = globalThis.localStorage;
  const storeMem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (storeMem.has(k) ? storeMem.get(k) : null),
    setItem: (k, v) => storeMem.set(k, String(v)),
    removeItem: (k) => storeMem.delete(k),
  };
  const { makeEl } = setupDom();
  globalThis.document.createElementNS ??= (_, tag) => makeEl(tag);
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { commit } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  commit(initialDb);

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  let currentLeaf = leaf;
  const render = async (nextLeaf = currentLeaf) => {
    currentLeaf = nextLeaf;
    await act(async () => {
      root.render(React.createElement(ActionView, { leaf: currentLeaf, base: `#/accounting/${currentLeaf.key}`, params: new URLSearchParams() }));
    });
  };
  await render(leaf);
  return {
    host,
    render,
    setDb: async (nextDb) => { commit(nextDb); await render(currentLeaf); },
    done: async () => {
      await act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

const headerLabels = (host) => allFind(host, (n) => n.tagName === 'THEAD')
  .flatMap((thead) => allFind(thead, (n) => n.tagName === 'TH' && !hasClass(n, 'check') && !hasClass(n, 'o2m-cols-th')))
  .map((th) => th.textContent.trim().replace(/\s*[▲▼]$/, ''));

const bodyRows = (host) => allFind(find(host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR');

test('sales and purchases menus configure exact Odoo 20 column order, optional states, and multi-company Company visibility', async () => {
  const invoicesLeaf = leafFor('Customers', 'invoices');
  const creditNotesLeaf = leafFor('Customers', 'credit-notes');
  const billsLeaf = leafFor('Vendors', 'bills');
  const refundsLeaf = leafFor('Vendors', 'refunds');

  assert.deepEqual(invoicesLeaf.list, salesInvoiceView.list);
  assert.deepEqual(creditNotesLeaf.list, salesInvoiceView.list);
  assert.deepEqual(billsLeaf.list, purchaseInvoiceView.list);
  assert.deepEqual(refundsLeaf.list, purchaseInvoiceView.list);
  assert.ok(salesInvoiceView.list.includes('invoice_user_id') && !salesInvoiceView.list.includes('payment_reference'));
  assert.ok(purchaseInvoiceView.list.includes('payment_reference') && !purchaseInvoiceView.list.includes('invoice_user_id'));

  const { visibleListColumns } = await import('./views/List.jsx');
  const singleDb = seed();
  const multiDb = createCompany(singleDb, { name: 'Branch Co', currency_id: read(singleDb, 'res.company', 1).currency_id }).db;

  const salesSingle = visibleListColumns(models['account.move'], singleDb, {}, invoicesLeaf);
  assert.deepEqual(salesSingle.cols, [
    'name', 'partner_id', 'invoice_date', 'invoice_date_due',
    'amount_untaxed_in_currency_signed', 'amount_total_in_currency_signed', 'amount_residual_in_currency_signed', 'status_in_payment',
  ]);
  assert.ok(!salesSingle.optionalCols.some(([k]) => k === 'company_id'), 'single-company hides Company optional column');

  const salesMulti = visibleListColumns(models['account.move'], multiDb, {
    journal_id: true, date: true, invoice_origin: true, ref: true, invoice_user_id: true,
    activities: true, company_id: true, amount_tax_in_currency_signed: true, currency_id: true,
  }, invoicesLeaf);
  assert.deepEqual(salesMulti.cols, salesInvoiceView.list, 'showing all sales optional columns preserves exact Odoo 20 order');
  assert.ok(salesMulti.optionalCols.some(([k]) => k === 'company_id'), 'multi-company exposes Company optional column');

  const purchMulti = visibleListColumns(models['account.move'], multiDb, {
    journal_id: true, date: true, invoice_origin: true, payment_reference: true, ref: true,
    activities: true, company_id: true, amount_tax_in_currency_signed: true, currency_id: true,
  }, billsLeaf);
  assert.deepEqual(purchMulti.cols, purchaseInvoiceView.list, 'showing all purchase optional columns preserves exact Odoo 20 order');

  // Mount Bills UI and toggle optional columns menu to reveal Journal, Payment Reference, Tax, Bill Currency.
  const ctx = await mountMoveList(billsLeaf, multiDb);
  try {
    assert.deepEqual(headerLabels(ctx.host), [
      'Number', 'Vendor', 'Bill Date', 'Due Date', 'Tax Excluded', 'Total', 'Amount Due', 'Status',
    ]);
    const colsTh = find(ctx.host, (n) => n.tagName === 'TH' && hasClass(n, 'o2m-cols-th'));
    const colToggle = find(colsTh, (n) => n.tagName === 'BUTTON');
    assert.ok(colToggle, 'optional columns button renders');
    await actClick(colToggle);
    const optButtons = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox');
    assert.ok(optButtons.length >= 8, 'optional column buttons rendered');
    for (const labelText of ['Journal', 'Payment Reference', 'Company', 'Tax', 'Bill Currency']) {
      const btn = optButtons.find((b) => b.textContent.replace('✓', '').trim() === labelText);
      assert.ok(btn, `optional menu includes ${labelText}`);
      await actClick(btn);
    }
    const afterToggle = headerLabels(ctx.host);
    for (const labelText of ['Journal', 'Payment Reference', 'Company', 'Tax Excluded', 'Tax', 'Bill Currency']) {
      assert.ok(afterToggle.includes(labelText), `${labelText} rendered after toggle`);
    }
    // Refunds keeps its own optional column storage, and remounting Bills reads Bills' persisted optional state in exact Odoo 20 column order.
    await ctx.render(refundsLeaf);
    assert.equal(headerLabels(ctx.host).length, 8);
    await ctx.render(billsLeaf);
    assert.deepEqual(headerLabels(ctx.host), [
      'Number', 'Vendor', 'Journal', 'Bill Date', 'Due Date', 'Payment Reference', 'Company',
      'Tax Excluded', 'Tax', 'Total', 'Amount Due', 'Bill Currency', 'Status',
    ]);
  } finally {
    await ctx.done();
  }
});

async function actClick(el) {
  const { act } = await import('react');
  await act(async () => props(el).onClick({ stopPropagation: () => {}, preventDefault: () => {} }));
}

test('credit notes and refunds show signed negative document-currency amounts, bold Number/Total, and net sum footers', async () => {
  let db = cleanMovesDb();
  let eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  if (!eur) {
    const createdEur = create(db, 'res.currency', { name: 'EUR', symbol: '€', rate_ids: [{ date: '2026-01-01', rate: 0.5 }], active: true });
    db = createdEur.db;
    eur = read(db, 'res.currency', createdEur.id);
  } else {
    db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 0.5 }], active: true });
  }
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, currency_id: eur.id, invoice_date: today(), invoice_date_due: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 10 }],
  });
  db = postMove(inv.db, inv.id);
  const cn = create(db, 'account.move', {
    move_type: 'out_refund', partner_id: 2, currency_id: eur.id, invoice_date: today(), invoice_date_due: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 40, tax: 10 }],
  });
  db = postMove(cn.db, cn.id);
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 7, invoice_date: today(), invoice_date_due: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 200, tax: 10 }],
  });
  db = postMove(bill.db, bill.id);
  const refund = create(db, 'account.move', {
    move_type: 'in_refund', partner_id: 7, invoice_date: today(), invoice_date_due: today(),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 10 }],
  });
  db = postMove(refund.db, refund.id);

  const cnRec = read(db, 'account.move', cn.id);
  assert.equal(cnRec.amount_untaxed_in_currency_signed, -40);
  assert.equal(cnRec.amount_tax_in_currency_signed, -4);
  assert.equal(cnRec.amount_total_in_currency_signed, -44);
  assert.equal(cnRec.amount_residual_in_currency_signed, -44);

  const refundRec = read(db, 'account.move', refund.id);
  assert.equal(refundRec.amount_untaxed_in_currency_signed, -50);
  assert.equal(refundRec.amount_tax_in_currency_signed, -5);
  assert.equal(refundRec.amount_total_in_currency_signed, -55);
  assert.equal(refundRec.amount_residual_in_currency_signed, -55);

  const ctx = await mountMoveList(leafFor('Customers', 'credit-notes'), db);
  try {
    const row = bodyRows(ctx.host)[0];
    const tds = allFind(row, (n) => n.tagName === 'TD');
    assert.ok(hasClass(tds[1], 'bold'), 'Number cell is bold');
    assert.ok(hasClass(tds[6], 'bold'), 'Total cell is bold');
    assert.equal(tds[5].textContent.trim(), '-€40.00');
    assert.equal(tds[6].textContent.trim(), '-€44.00');
    assert.equal(tds[7].textContent.trim(), '-€44.00');
    const tfoot = find(ctx.host, (n) => n.tagName === 'TFOOT');
    const footCells = allFind(tfoot, (n) => n.tagName === 'TD').map((td) => td.textContent.trim());
    // 40 EUR at rate 0.5 -> 80 USD; negative for credit note in company currency.
    assert.equal(footCells[5], '-$80.00');
    assert.equal(footCells[6], '-$88.00');
    assert.equal(footCells[7], '-$88.00');
  } finally {
    await ctx.done();
  }
});

test('status_in_payment badges, row decorations, and relative Due Date hiding work across all states', async () => {
  let db = addOutstandingReceipts(cleanMovesDb());
  const d0 = today();
  const dueIn5 = addDays(d0, 5);
  const due3Ago = addDays(d0, -3);

  db = write(db, 'res.company', 1, { three_way_matching: true });

  // 1. Draft invoice (due In 5 days) -> row info, badge Draft (info)
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: d0, invoice_date_due: dueIn5,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = draftInv.db;

  // 2. Cancelled invoice (due hidden) -> row muted, badge Cancelled (danger)
  const cancelInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: d0, invoice_date_due: dueIn5,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 60, tax: 0 }],
  });
  db = write(cancelInv.db, 'account.move', cancelInv.id, { state: 'cancel' });

  // 3. Not Paid overdue (3 days ago) -> badge Not Paid (warning)
  const notPaidInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: d0, invoice_date_due: due3Ago,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(notPaidInv.db, notPaidInv.id);

  // 4. Partially Paid (due Today) -> badge Partially Paid (muted)
  const partialInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: d0, invoice_date_due: d0,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = payMove(postMove(partialInv.db, partialInv.id), partialInv.id, 40, d0);

  // 5. In Payment (outstanding payment not yet reconciled on bank statement; due hidden) -> badge In Payment (success)
  const inPayInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: d0, invoice_date_due: due3Ago,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 80, tax: 0 }],
  });
  db = payMove(postMove(inPayInv.db, inPayInv.id), inPayInv.id, 80, d0);

  // 6. Paid (matched on bank statement; due hidden) -> badge Paid (success)
  const paidInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: d0, invoice_date_due: due3Ago,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 90, tax: 0 }],
  });
  db = payMove(postMove(paidInv.db, paidInv.id), paidInv.id, 90, d0);
  const paidPayment = search(db, 'account.payment').find((p) => p.invoice_id === paidInv.id);
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const stmtLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id, date: d0, payment_ref: 'MATCH-PAID', amount: 90, state: 'to_check', partner_id: 2, payment_id: paidPayment.id,
  });
  const matchBtn = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment');
  db = matchBtn.run(stmtLine.db, read(stmtLine.db, 'account.bank.statement.line', stmtLine.id)).db;

  // 7. Reversed (settled solely by linked credit note; due hidden) -> badge Reversed (success)
  const revInv = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_date: d0, invoice_date_due: due3Ago,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 70, tax: 0 }],
  });
  const revBase = postMove(revInv.db, revInv.id);
  const cnOut = creditNote(revBase, read(revBase, 'account.move', revInv.id));
  const cnId = Number(cnOut.go.split('/').at(-1));
  db = postMove(cnOut.db, cnId);

  // 8. Blocked vendor bill (three-way matching exception with no matching PO) -> badge Blocked (danger), due shown
  const po = create(db, 'purchase.order', {
    partner_id: 7, state: 'purchase', invoice_status: 'to invoice',
    order_line: [{ product_id: 1, qty: 1, price_unit: 100 }],
  });
  db = po.db;
  const blockedBill = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 7, purchase_id: po.id, invoice_date: d0, invoice_date_due: dueIn5,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(blockedBill.db, blockedBill.id);

  assert.equal(read(db, 'account.move', inPayInv.id).status_in_payment, 'in_payment');
  assert.equal(read(db, 'account.move', paidInv.id).status_in_payment, 'paid');
  assert.equal(read(db, 'account.move', revInv.id).status_in_payment, 'reversed');
  assert.equal(read(db, 'account.move', blockedBill.id).status_in_payment, 'blocked');
  // statusInPayment helper returns 'posted' for non-invoice entries with badge 'muted'.
  assert.equal(statusInPayment({ state: 'posted', move_type: 'entry' }, db), 'posted');
  assert.equal(models['account.move'].fields.status_in_payment.badge.posted, 'muted');
  assert.equal(models['account.move'].fields.status_in_payment.badge.sent, 'muted');

  const ctx = await mountMoveList(leafFor('Customers', 'invoices'), db);
  try {
    const byId = new Map();
    for (const tr of bodyRows(ctx.host)) {
      const tds = allFind(tr, (n) => n.tagName === 'TD');
      const num = tds[1].textContent.trim();
      const due = tds[4].textContent.trim();
      const badge = find(tds[8], (n) => hasClass(n, 'badge'));
      byId.set(num, { tr, due, badgeText: badge.textContent.trim(), badgeCls: classOf(badge) });
    }
    const rowOf = (id) => byId.get(read(db, 'account.move', id).name);

    // Cancel row shares name '/' with draft only if multiple drafts; check by iterating rows:
    const rowsList = bodyRows(ctx.host).map((tr) => {
      const tds = allFind(tr, (n) => n.tagName === 'TD');
      const badge = find(tds[8], (n) => hasClass(n, 'badge'));
      return { rowCls: classOf(tr), due: tds[4].textContent.trim(), badgeText: badge.textContent.trim(), badgeCls: classOf(badge) };
    });
    const draftRow = rowsList.find((r) => r.badgeText === 'Draft');
    const cancelRow = rowsList.find((r) => r.badgeText === 'Cancelled');
    assert.ok(draftRow.rowCls.includes('info') && draftRow.badgeCls.includes('badge-info') && draftRow.due === 'In 5 days');
    assert.ok(cancelRow.rowCls.includes('muted') && cancelRow.badgeCls.includes('badge-danger') && cancelRow.due === '');

    assert.equal(rowOf(notPaidInv.id).due, '3 days ago');
    assert.equal(rowOf(notPaidInv.id).badgeText, 'Not Paid');
    assert.ok(rowOf(notPaidInv.id).badgeCls.includes('badge-warning'));

    assert.equal(rowOf(partialInv.id).due, 'Today');
    assert.equal(rowOf(partialInv.id).badgeText, 'Partially Paid');
    assert.ok(rowOf(partialInv.id).badgeCls.includes('badge-muted'));

    assert.equal(rowOf(inPayInv.id).due, '', 'Due Date hidden for In Payment');
    assert.equal(rowOf(inPayInv.id).badgeText, 'In Payment');
    assert.ok(rowOf(inPayInv.id).badgeCls.includes('badge-success'));

    assert.equal(rowOf(paidInv.id).due, '', 'Due Date hidden for Paid');
    assert.equal(rowOf(paidInv.id).badgeText, 'Paid');
    assert.ok(rowOf(paidInv.id).badgeCls.includes('badge-success'));

    assert.equal(rowOf(revInv.id).due, '', 'Due Date hidden for Reversed');
    assert.equal(rowOf(revInv.id).badgeText, 'Reversed');
    assert.ok(rowOf(revInv.id).badgeCls.includes('badge-success'));

    await ctx.render(leafFor('Vendors', 'bills'));
    const billRow = bodyRows(ctx.host)[0];
    const billTds = allFind(billRow, (n) => n.tagName === 'TD');
    const billBadge = find(billTds[8], (n) => hasClass(n, 'badge'));
    assert.equal(billTds[4].textContent.trim(), 'In 5 days');
    assert.equal(billBadge.textContent.trim(), 'Blocked');
    assert.ok(classOf(billBadge).includes('badge-danger'));
  } finally {
    await ctx.done();
  }
});

test('search, filters (My Invoices, states, To Pay/In Payment/Overdue, monthFilters), and all 8 group-bys match Odoo 20', async () => {
  let db = addOutstandingReceipts(cleanMovesDb());
  const emp1 = read(db, 'hr.employee', 1);
  const emp2 = read(db, 'hr.employee', 2);
  db = write(db, 'hr.employee', emp1.id, { user_login: 'admin' });
  db = write(db, 'hr.employee', emp2.id, { user_login: 'mona' });

  const d0 = today();
  const pastDue = addDays(d0, -4);
  const futureDue = addDays(d0, 4);

  const i1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_user_id: emp2.id, invoice_origin: 'SO-ALPHA', ref: 'REF-100',
    invoice_date: d0, date: d0, invoice_date_due: pastDue,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(i1.db, i1.id);

  const i2 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 3, invoice_user_id: emp1.id, invoice_origin: 'SO-BETA', ref: 'REF-200',
    invoice_date: d0, date: d0, invoice_date_due: futureDue,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 80, tax: 0 }],
  });
  db = payMove(postMove(i2.db, i2.id), i2.id, 80, d0);

  const iDraft = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 2, invoice_user_id: emp2.id, invoice_date: '2024-01-10', date: '2024-01-10', invoice_date_due: '2024-02-10',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 25, tax: 0 }],
  });
  db = iDraft.db;

  const iCancel = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: 3, invoice_user_id: emp1.id, invoice_date: d0, date: d0, invoice_date_due: futureDue,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 35, tax: 0 }],
  });
  db = write(iCancel.db, 'account.move', iCancel.id, { state: 'cancel' });

  const b1 = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: 7, payment_reference: 'WIRE-99', invoice_date: d0, date: d0, invoice_date_due: futureDue,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 60, tax: 0 }],
  });
  db = postMove(b1.db, b1.id);

  // Free-text search matches number, source document, ref, payment_reference, partner, journal, salesperson.
  const salesRecs = search(db, 'account.move').filter((m) => m.move_type === 'out_invoice');
  const purchRecs = search(db, 'account.move').filter((m) => m.move_type === 'in_invoice');
  assert.deepEqual(salesRecs.filter((r) => matches(db, 'account.move', r, [read(db, 'account.move', i1.id).name], salesInvoiceView.searchFields)).map((r) => r.id), [i1.id]);
  assert.deepEqual(salesRecs.filter((r) => matches(db, 'account.move', r, ['SO-ALPHA'], salesInvoiceView.searchFields)).map((r) => r.id), [i1.id]);
  assert.deepEqual(salesRecs.filter((r) => matches(db, 'account.move', r, ['REF-200'], salesInvoiceView.searchFields)).map((r) => r.id), [i2.id]);
  assert.deepEqual(salesRecs.filter((r) => matches(db, 'account.move', r, [emp2.name], salesInvoiceView.searchFields)).map((r) => r.id), [i1.id, iDraft.id]);
  assert.deepEqual(purchRecs.filter((r) => matches(db, 'account.move', r, ['WIRE-99'], purchaseInvoiceView.searchFields)).map((r) => r.id), [b1.id]);

  // Filter structure: Accounting Date date filter exists ONLY on purchases.
  assert.ok(!salesInvoiceView.filters.flat().some((f) => f.id.startsWith('date_')));
  assert.ok(purchaseInvoiceView.filters.flat().some((f) => f.id === 'date_month'));
  assert.ok(salesInvoiceView.filters.flat().some((f) => f.id === 'invoice_date_month'));
  assert.ok(salesInvoiceView.filters.flat().some((f) => f.id === 'invoice_date_due_month'));
  assert.ok(!salesInvoiceView.filters.flat().some((f) => ['not_sent', 'to_review'].includes(f.id)));

  // My Invoices follows currentActor -> hr.employee.user_login.
  setActor({ login: 'mona', name: emp2.name });
  assert.deepEqual(applyFilters('account.move', salesRecs, ['myinvoices'], db, salesInvoiceView.filters).map((r) => r.id), [i1.id, iDraft.id]);

  // State OR group.
  assert.deepEqual(applyFilters('account.move', salesRecs, ['draft', 'cancel'], db, salesInvoiceView.filters).map((r) => r.id), [iDraft.id, iCancel.id]);

  // To Pay / In Payment / Overdue OR group.
  assert.deepEqual(applyFilters('account.move', salesRecs, ['unpaid'], db, salesInvoiceView.filters).map((r) => r.id), [i1.id, iDraft.id]);
  assert.deepEqual(applyFilters('account.move', salesRecs, ['in_payment'], db, salesInvoiceView.filters).map((r) => r.id), [i2.id]);
  assert.deepEqual(applyFilters('account.move', salesRecs, ['overdue'], db, salesInvoiceView.filters).map((r) => r.id), [i1.id]);

  // Date filters.
  assert.deepEqual(applyFilters('account.move', salesRecs, ['invoice_date_month'], db, salesInvoiceView.filters).map((r) => r.id), [i1.id, i2.id, iCancel.id]);
  assert.deepEqual(applyFilters('account.move', purchRecs, ['date_month'], db, purchaseInvoiceView.filters).map((r) => r.id), [b1.id]);

  // Group Bys: verify all 8 group keys produce expected groups and Company group-by toggles by company count.
  assert.deepEqual(salesInvoiceView.groupBys, [
    'invoice_user_id', 'partner_id', 'status_in_payment', 'journal_id', 'company_id', 'invoice_date', 'invoice_date_due', 'date',
  ]);
  for (const key of salesInvoiceView.groupBys) {
    assert.ok(groupRecords(db, 'account.move', salesRecs, key).length >= 1, `groupRecords works for ${key}`);
  }
  const byStatus = groupRecords(db, 'account.move', salesRecs, 'status_in_payment').map((g) => g.label);
  assert.ok(byStatus.includes('In Payment') && byStatus.includes('Not Paid'));

  const ctx = await mountMoveList(leafFor('Customers', 'invoices'), db);
  try {
    const toggleBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await actClick(toggleBtn);
    assert.ok(!find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Company'), 'single-company hides Company group-by button');
  } finally {
    await ctx.done();
  }

  const multiDb = createCompany(db, { name: 'Co 2', currency_id: read(db, 'res.company', 1).currency_id }).db;
  const ctxMulti = await mountMoveList(leafFor('Customers', 'invoices'), multiDb);
  try {
    const toggleBtn = find(ctxMulti.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await actClick(toggleBtn);
    assert.ok(find(ctxMulti.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Company'), 'multi-company shows Company group-by button');
  } finally {
    await ctxMulti.done();
  }
});

test('Arabic translations cover every new invoice/bill list label, filter, group-by, and relative date token', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {}, removeItem() {} };
  try {
    const i18nUrl = new URL(`./i18n.js?lang_ar_test=${Date.now()}`, import.meta.url).href;
    const { t } = await import(i18nUrl);
    const labels = [
      'My Invoices', 'Invoice Currency', 'Bill Currency', 'Invoice Date', 'Bill Date', 'Accounting Date',
      'Tax Excluded', 'Tax', 'Total', 'Amount Due', 'To Pay', 'In Payment', 'Overdue', 'Blocked', 'Reversed',
      'Salesperson', 'Source Document', 'Payment Reference',
      'Accounting Date: This Month', 'Accounting Date: This Year',
      'Due Date: This Month', 'Due Date: This Year',
      'Invoice Date: This Month', 'Invoice Date: This Year',
      'Today', 'In 1 day', '1 day ago',
    ];
    for (const label of labels) {
      assert.notEqual(t(label), label, `Arabic translation present for ${label}`);
    }
    assert.ok(t('In {n} days', { n: 5 }).includes('5') && !t('In {n} days', { n: 5 }).includes('In '), 'In {n} days translated');
    assert.ok(t('{n} days ago', { n: 3 }).includes('3') && !t('{n} days ago', { n: 3 }).includes('days'), '{n} days ago translated');
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
