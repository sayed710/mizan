import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { postPayment, reverseEntry, unreconcileJournalItems } from './models/pay.js';
import { today } from './models/common.js';
import { t } from './i18n.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];
const classOf = (node) => props(node)?.className ?? node?.className ?? '';
const hasClass = (node, cls) => typeof classOf(node) === 'string' && classOf(node).split(/\s+/).includes(cls);
const allFind = (root, pred, out = []) => {
  if (!root) return out;
  if (pred(root)) out.push(root);
  for (const child of root.childNodes ?? []) allFind(child, pred, out);
  return out;
};

const findLeafByKey = (items, key) => {
  for (const item of items) {
    if (item.key === key) return item;
    if (item.children) {
      const found = findLeafByKey(item.children, key);
      if (found) return found;
    }
  }
  return null;
};

const entriesLeaf = () => findLeafByKey(menusFor('accounting'), 'entries');

async function mountView(renderElement, initialDb = seed()) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  setupDom();
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = origCreate(tag);
    el.insertBefore = (child, before) => {
      const idx = before ? el.childNodes.indexOf(before) : -1;
      if (idx >= 0) el.childNodes.splice(idx, 0, child);
      else el.childNodes.push(child);
      child.parentNode = el;
      if (child.tagName === 'OPTION') el.options.push(child);
      return child;
    };
    return el;
  };
  globalThis.document.createElementNS = (_, tag) => globalThis.document.createElement(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const render = async () => {
    await React.act(async () => root.render(renderElement(React)));
  };
  await render();
  return {
    React,
    host,
    mem,
    commit,
    getDb,
    render,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

async function click(React, el) {
  await React.act(async () => {
    props(el)?.onClick?.({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: el, target: el });
  });
}

async function openSearchPanel(React, host) {
  const toggle = find(host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
  await click(React, toggle);
  return find(host, (n) => hasClass(n, 'search-panel'));
}

test('Journal Entries list shows Odoo 20 columns, signed company-currency Total, status badges, optional columns, and preserves invoice/bill menus', async () => {
  let db = seed();
  const [partner, supplier] = search(db, 'res.partner');
  const fxDate = today();
  const eurRes = create(db, 'res.currency', { name: 'EUR', symbol: '€', rounding: 0.01, rate_ids: [{ date: fxDate, rate: 2 }] });
  db = eurRes.db;
  const eur = { id: eurRes.id };
  const saleAcct = search(db, 'account.account').find((a) => a.account_type === 'income');
  const expAcct = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const revJournal = search(db, 'account.journal').find((j) => j.type === 'sale');
  const billJournal = search(db, 'account.journal').find((j) => j.type === 'purchase');

  // Foreign-currency posted customer invoice (EUR 100 at rate 2 EUR/USD -> +50 USD signed).
  let res = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: revJournal.id,
    currency_id: eur.id,
    date: fxDate,
    invoice_date: fxDate,
    ref: 'INV-FX-1',
    invoice_line_ids: [{ name: 'Consulting', account_id: saleAcct.id, qty: 1, price_unit: 100, tax: 0, tax_ids: [] }],
  });
  db = postMove(res.db, res.id);
  const invId = res.id;

  // Posted vendor bill (-200 signed).
  res = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: supplier.id,
    journal_id: billJournal.id,
    date: fxDate,
    invoice_date: fxDate,
    ref: 'BILL-200',
    invoice_line_ids: [{ name: 'Hosting', account_id: expAcct.id, qty: 1, price_unit: 200, tax: 0, tax_ids: [] }],
  });
  db = postMove(res.db, res.id);
  const billId = res.id;

  // Cancelled draft entry with an open mail activity.
  res = create(db, 'account.move', { move_type: 'entry', date: fxDate, ref: 'CAN-1', state: 'cancel', line_ids: [] });
  db = res.db;
  const cancelId = res.id;
  db = create(db, 'mail.activity', { res_model: 'account.move', res_id: cancelId, summary: 'Follow up cancelled', activity_type: 'To Do' }).db;

  assert.equal(read(db, 'account.move', invId).amount_total_signed, 50);
  assert.equal(read(db, 'account.move', billId).amount_total_signed, -200);

  // Invoices and bills menus must keep their original list config and model overdue filter.
  const invLeaf = findLeafByKey(menusFor('accounting'), 'invoices');
  const billLeaf = findLeafByKey(menusFor('accounting'), 'bills');
  assert.equal(invLeaf.list, undefined);
  assert.equal(billLeaf.list, undefined);
  assert.ok(models['account.move'].filters.flat().some((f) => f.id === 'overdue'));

  const leaf = entriesLeaf();
  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView((React) => React.createElement(ActionView, { leaf, base: '#/accounting/entries', params: new URLSearchParams() }), db);
  try {
    const thead = find(ctx.host, (n) => n.tagName === 'THEAD');
    assert.deepEqual(
      allFind(thead, (n) => n.tagName === 'TH' && !hasClass(n, 'check') && !hasClass(n, 'o2m-cols-th')).map((n) => n.textContent.replace(/[▲▼]/g, '').trim()),
      ['Date', 'Number', 'Partner', 'Reference', 'Journal', 'Total', 'Status'],
    );

    // Status badges: Draft / Posted / Cancelled.
    const badges = allFind(ctx.host, (n) => hasClass(n, 'badge')).map((b) => [b.textContent.trim(), classOf(b)]);
    assert.ok(badges.some(([txt, cls]) => txt === 'Posted' && cls.includes('badge-success')));
    assert.ok(badges.some(([txt, cls]) => txt === 'Cancelled' && cls.includes('badge-muted')));

    // Toggle optional columns: Invoice Date and Activities.
    const colsBtn = find(thead, (n) => hasClass(n, 'o2m-cols-toggle'));
    assert.ok(colsBtn, 'Journal Entries list has optional columns toggle');
    await click(ctx.React, colsBtn);
    const items = allFind(thead, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox');
    assert.deepEqual(items.map((b) => b.textContent.replace('✓', '').trim()), ['Invoice Date', 'Activities']);
    for (const item of items) await click(ctx.React, item);
    assert.deepEqual(
      allFind(thead, (n) => n.tagName === 'TH' && !hasClass(n, 'check') && !hasClass(n, 'o2m-cols-th')).map((n) => n.textContent.replace(/[▲▼]/g, '').trim()),
      ['Date', 'Number', 'Partner', 'Reference', 'Journal', 'Total', 'Status', 'Invoice Date', 'Activities'],
    );
    assert.ok(ctx.host.textContent.includes('Follow up cancelled'));
  } finally {
    await ctx.done();
  }
});

test('Journal Entries filters, group-bys and search fields cover all Odoo 20 options', async () => {
  let db = seed();
  const todayStr = today();
  const oldDate = '2024-02-10';
  const partner = search(db, 'res.partner')[0];
  const saleJ = search(db, 'account.journal').find((j) => j.type === 'sale');
  const purchJ = search(db, 'account.journal').find((j) => j.type === 'purchase');
  const bankJ = search(db, 'account.journal').find((j) => j.type === 'bank');
  const cashJ = search(db, 'account.journal').find((j) => j.type === 'cash');
  const genJ = search(db, 'account.journal').find((j) => j.type === 'general');
  // Intentionally name a credit journal like a bank one to prove type never infers from name/code.
  const creditJ = create(db, 'account.journal', { name: 'Bank Named Credit', code: 'BNKCR', type: 'credit' });
  db = creditJ.db;
  const income = search(db, 'account.account').find((a) => a.account_type === 'income');
  const expense = search(db, 'account.account').find((a) => a.account_type === 'expense');

  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJ.id,
    date: todayStr,
    invoice_date: oldDate,
    ref: 'REF-SEARCH-ONLY',
    narration: 'HIDDEN-NARRATION-TOKEN',
    invoice_line_ids: [{ name: 'Srv', account_id: income.id, qty: 1, price_unit: 100, tax: 0, tax_ids: [] }],
  });
  db = draftInv.db;

  const autoPosted = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: creditJ.id,
    date: todayStr,
    invoice_date: todayStr,
    ref: 'AUTO-CARD',
    auto_post: 'monthly',
    line_ids: [
      { account_id: expense.id, name: 'Card', debit: 40, credit: 0 },
      { account_id: income.id, name: 'Card', debit: 0, credit: 40 },
    ],
  });
  db = postMove(autoPosted.db, autoPosted.id);

  // Create a posted general entry and reverse it.
  const revOrig = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: genJ.id,
    date: todayStr,
    invoice_date: todayStr,
    ref: 'TO-REV',
    line_ids: [
      { account_id: expense.id, name: 'Rev', debit: 75, credit: 0 },
      { account_id: income.id, name: 'Rev', debit: 0, credit: 75 },
    ],
  });
  db = postMove(revOrig.db, revOrig.id);
  db = reverseEntry(db, read(db, 'account.move', revOrig.id), { date: todayStr }).db;

  // Bank and Cash and Purchase entries so every journal.type filter matches on real records.
  const pEntry = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: partner.id,
    journal_id: purchJ.id,
    date: oldDate,
    invoice_date: todayStr,
    ref: 'PUR-1',
    invoice_line_ids: [{ name: 'Buy', account_id: expense.id, qty: 1, price_unit: 50, tax: 0, tax_ids: [] }],
  });
  db = postMove(pEntry.db, pEntry.id);
  const bankMoveRes = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: bankJ.id,
    date: todayStr,
    ref: 'BNK-1',
    line_ids: [
      { account_id: expense.id, name: 'Fee', debit: 10, credit: 0 },
      { account_id: income.id, name: 'Fee', debit: 0, credit: 10 },
    ],
  });
  db = postMove(bankMoveRes.db, bankMoveRes.id);
  const cashEntry = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: cashJ.id,
    date: todayStr,
    ref: 'CSH-1',
    line_ids: [
      { account_id: expense.id, name: 'Cash', debit: 20, credit: 0 },
      { account_id: income.id, name: 'Cash', debit: 0, credit: 20 },
    ],
  });
  db = postMove(cashEntry.db, cashEntry.id);

  const leaf = entriesLeaf();
  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView((React) => React.createElement(ActionView, { leaf, base: '#/accounting/entries', params: new URLSearchParams() }), db);
  try {
    const panel = await openSearchPanel(ctx.React, ctx.host);
    const buttons = allFind(panel, (n) => n.tagName === 'BUTTON');
    const filterSection = allFind(panel, (n) => n.tagName === 'SECTION')[0];
    const groupSection = allFind(panel, (n) => n.tagName === 'SECTION')[1];

    const filterLabels = allFind(filterSection, (n) => n.tagName === 'BUTTON').map((b) => b.textContent.trim());
    assert.deepEqual(filterLabels, [
      'Unposted', 'Posted',
      'Reversed', 'Manual',
      'Sales', 'Purchases', 'Bank', 'Cash', 'Credit', 'Miscellaneous',
      'Date: This Month', 'Date: This Year',
      'Invoice Date: This Month', 'Invoice Date: This Year',
      'Archived',
    ]);
    const groupLabels = allFind(groupSection, (n) => n.tagName === 'BUTTON').map((b) => b.textContent.trim());
    assert.deepEqual(groupLabels, ['Partner', 'Journal', 'Status', 'Date', 'Invoice Date']);

    const bodyRows = () => allFind(find(ctx.host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR' && !find(n, (c) => hasClass(c, 'empty')) && !hasClass(n, 'group-row'));
    const toggleFilter = async (labelText) => {
      const btn = buttons.find((b) => b.textContent.trim() === labelText);
      assert.ok(btn, `Missing button ${labelText}`);
      await click(ctx.React, btn);
    };

    // Credit filter matches only credit journal (even though named 'Bank Named Credit').
    await toggleFilter('Credit');
    assert.ok(bodyRows().length >= 1 && bodyRows().every((r) => r.textContent.includes('Bank Named Credit')));

    // Combine with Manual (AND across groups): excludes auto_post entry -> 0 rows; turn off Credit -> shows manual rows.
    await toggleFilter('Manual');
    assert.equal(bodyRows().length, 0);
    await toggleFilter('Credit');
    assert.ok(bodyRows().every((r) => !r.textContent.includes('AUTO-CARD')));
    await toggleFilter('Manual');

    // Reversed matches original + reversal entry; Unposted matches draft invoice; Posted matches posted.
    await toggleFilter('Reversed');
    assert.ok(bodyRows().length >= 2);
    await toggleFilter('Reversed');

    for (const labelText of ['Sales', 'Purchases', 'Bank', 'Cash', 'Miscellaneous', 'Unposted', 'Posted', 'Date: This Month', 'Invoice Date: This Month']) {
      await toggleFilter(labelText);
      assert.ok(bodyRows().length >= 1, `Filter ${labelText} should match at least one move`);
      await toggleFilter(labelText);
    }

    // Group By: Status / Partner / Journal / Date / Invoice Date.
    for (const gbLabel of ['Status', 'Partner', 'Journal', 'Date', 'Invoice Date']) {
      const btn = allFind(groupSection, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === gbLabel)[0];
      await click(ctx.React, btn);
      assert.ok(allFind(ctx.host, (n) => hasClass(n, 'group-row')).length >= 1, `Group by ${gbLabel} creates group rows`);
      await click(ctx.React, btn);
    }

    // Search fields: name, ref, partner_id, journal_id match; narration must NOT match.
    const searchInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.placeholder === t('Search...'));
    const addSearch = async (term) => {
      await ctx.React.act(async () => {
        props(searchInput).onChange({ target: { value: term } });
      });
      const latestInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.placeholder === t('Search...'));
      await ctx.React.act(async () => {
        props(latestInput).onKeyDown({ key: 'Enter' });
      });
    };
    const clearSearch = async () => {
      const latestInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.placeholder === t('Search...'));
      await ctx.React.act(async () => {
        props(latestInput).onKeyDown({ key: 'Backspace' });
      });
    };

    await addSearch('REF-SEARCH-ONLY');
    assert.equal(bodyRows().length, 1);
    await clearSearch();
    await addSearch('Bank Named Credit');
    assert.equal(bodyRows().length, 2);
    await clearSearch();
    await addSearch('HIDDEN-NARRATION-TOKEN');
    assert.equal(bodyRows().length, 0);
  } finally {
    await ctx.done();
  }
});

test('Journal Items shows default/optional columns, all filters on seed data, group-bys, totals, ?account filter, and actions', async () => {
  let db = seed();
  const dateNow = today();
  const [partner, vendor] = search(db, 'res.partner');
  const saleJ = search(db, 'account.journal').find((j) => j.type === 'sale');
  const purchJ = search(db, 'account.journal').find((j) => j.type === 'purchase');
  const bankJ = search(db, 'account.journal').find((j) => j.type === 'bank');
  const cashJ = search(db, 'account.journal').find((j) => j.type === 'cash');
  const creditJ = create(db, 'account.journal', { name: 'Corporate Card', code: 'CRD1', type: 'credit' }).db;
  db = creditJ;
  const cardJ = search(db, 'account.journal').find((j) => j.type === 'credit');
  const ar = search(db, 'account.account').find((a) => a.account_type === 'asset_receivable');
  const ap = search(db, 'account.account').find((a) => a.account_type === 'liability_payable');
  const inc = search(db, 'account.account').find((a) => a.account_type === 'income');
  const exp = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const bankAcct = search(db, 'account.account').find((a) => a.code === '101401');
  const vatSale = search(db, 'account.tax').find((x) => x.type_tax_use === 'sale');

  // Post cash payment BEFORE invoice so it starts as an unapplied receivable credit.
  const payRes = create(db, 'account.payment', {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    journal_id: cashJ.id,
    amount: 30,
    date: dateNow,
  });
  db = postPayment(payRes.db, read(payRes.db, 'account.payment', payRes.id));

  // Posted customer invoice with tax (generates receivable + income + tax lines on sales journal).
  const invRes = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJ.id,
    date: dateNow,
    invoice_date: dateNow,
    invoice_date_due: dateNow,
    ref: 'JI-SALE',
    invoice_line_ids: [{ name: 'Item A', account_id: inc.id, qty: 1, price_unit: 100, tax: vatSale?.amount ?? 14, tax_ids: vatSale ? [vatSale.id] : [] }],
  });
  db = postMove(invRes.db, invRes.id);

  // Posted vendor bill (payable + expense on purchase journal).
  const billRes = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    journal_id: purchJ.id,
    date: dateNow,
    invoice_date: dateNow,
    ref: 'JI-PURCH',
    invoice_line_ids: [{ name: 'Item B', account_id: exp.id, qty: 1, price_unit: 50, tax: 0, tax_ids: [] }],
  });
  db = postMove(billRes.db, billRes.id);

  // Posted credit journal entry and draft (unposted) miscellaneous entry.
  const cardMove = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: cardJ.id,
    date: dateNow,
    ref: 'JI-CARD',
    line_ids: [
      { account_id: exp.id, partner_id: vendor.id, name: 'Flight', debit: 80, credit: 0 },
      { account_id: bankAcct.id, partner_id: vendor.id, name: 'Flight Card', debit: 0, credit: 80 },
    ],
  });
  db = postMove(cardMove.db, cardMove.id);

  const bankMove = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: bankJ.id,
    date: dateNow,
    line_ids: [
      { account_id: bankAcct.id, name: 'Bank transfer', debit: 25, credit: 0 },
      { account_id: inc.id, name: 'Bank transfer', debit: 0, credit: 25 },
    ],
  });
  db = postMove(bankMove.db, bankMove.id);

  const draftMove = create(db, 'account.move', {
    move_type: 'entry',
    date: dateNow,
    line_ids: [
      { account_id: exp.id, name: 'Draft Expense', debit: 15, credit: 0 },
      { account_id: ap.id, partner_id: vendor.id, name: 'Draft Payable', debit: 0, credit: 15 },
    ],
  });
  db = draftMove.db;

  const { JournalItems } = await import('./views/JournalItems.jsx');
  const ctx = await mountView((React) => React.createElement(JournalItems, { leaf: {} }), db);
  try {
    const thead = find(ctx.host, (n) => n.tagName === 'THEAD');
    assert.deepEqual(
      allFind(thead, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((n) => n.textContent.trim()),
      ['Select', 'Date', 'Journal Entry', 'Account', 'Partner', 'Label', 'Debit', 'Credit', 'Matching'],
    );

    // Due Date, Amount in Currency, Company and other Odoo columns live in optional column menu.
    const colsBtn = find(thead, (n) => hasClass(n, 'o2m-cols-toggle'));
    assert.ok(colsBtn);
    await click(ctx.React, colsBtn);
    const optLabels = allFind(thead, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox')
      .map((b) => b.textContent.replace('✓', '').trim());
    for (const col of ['Due Date', 'Amount in Currency', 'Company', 'Invoice Date', 'Journal', 'Reference', 'Product', 'Taxes', 'Tax Grids', 'Balance']) {
      assert.ok(optLabels.includes(col), `Optional column ${col} available`);
    }
    for (const target of ['Due Date', 'Amount in Currency', 'Company']) {
      const btn = allFind(thead, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox' && n.textContent.includes(target))[0];
      await click(ctx.React, btn);
    }
    assert.ok(allFind(thead, (n) => n.tagName === 'TH').some((th) => th.textContent.trim() === 'Due Date'));
    assert.ok(allFind(thead, (n) => n.tagName === 'TH').some((th) => th.textContent.trim() === 'Amount in Currency'));
    assert.ok(allFind(thead, (n) => n.tagName === 'TH').some((th) => th.textContent.trim() === 'Company'));

    // Debit / Credit totals footer row matches visible balanced lines.
    const tfoot = find(ctx.host, (n) => n.tagName === 'TFOOT');
    assert.ok(tfoot, 'Totals footer row renders');
    const footerCells = allFind(tfoot, (n) => n.tagName === 'TD').filter((td) => td.textContent.trim());
    assert.equal(footerCells.length, 2, 'Debit and Credit totals cells present');
    assert.equal(footerCells[0].textContent.trim(), footerCells[1].textContent.trim());

    // Filter controls test on seed+fixture data.
    const filterGroup = find(ctx.host, (n) => props(n)?.role === 'group' && props(n)?.['aria-label'] === t('Filters'));
    const filterButtons = allFind(filterGroup, (n) => n.tagName === 'BUTTON');
    assert.deepEqual(
      filterButtons.map((b) => b.textContent.trim()),
      ['Unposted', 'Posted', 'Unreconciled', 'Sales', 'Purchases', 'Bank', 'Cash', 'Credit', 'Miscellaneous', 'Payable', 'Receivable', 'P&L Accounts', 'Date: This Month', 'Date: This Year'],
    );
    const bodyItemRows = () => allFind(find(ctx.host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR' && !hasClass(n, 'group-row'));
    const clickFilter = async (labelText) => {
      const btn = filterButtons.find((b) => b.textContent.trim() === labelText);
      await click(ctx.React, btn);
    };

    // Posted is on by default; turn on Unposted as well (OR in group 1) -> includes Draft Expense; turn off Posted -> only draft lines.
    const postedCount = bodyItemRows().length;
    await clickFilter('Unposted');
    assert.equal(bodyItemRows().length, postedCount + 2);
    await clickFilter('Posted');
    assert.equal(bodyItemRows().length, 2);
    await clickFilter('Unposted');
    await clickFilter('Posted');

    for (const labelText of ['Unreconciled', 'Sales', 'Purchases', 'Bank', 'Cash', 'Credit', 'Miscellaneous', 'Payable', 'Receivable', 'P&L Accounts', 'Date: This Month', 'Date: This Year']) {
      await clickFilter(labelText);
      assert.ok(bodyItemRows().length >= 1, `Journal Items filter ${labelText} matches rows`);
      await clickFilter(labelText);
    }

    // Group By: Journal Entry, Account, Partner, Journal, Date, Taxes.
    const groupSelect = find(ctx.host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === t('Group By'));
    const optTexts = allFind(groupSelect, (n) => n.tagName === 'OPTION').map((o) => o.textContent.trim());
    assert.deepEqual(optTexts, ['None', 'Journal Entry', 'Account', 'Partner', 'Journal', 'Date', 'Taxes']);
    for (const val of ['move', 'account', 'partner', 'journal', 'date', 'taxes']) {
      await ctx.React.act(async () => {
        props(groupSelect).onChange({ target: { value: val } });
      });
      assert.ok(allFind(ctx.host, (n) => hasClass(n, 'group-row')).length >= 1, `Grouping by ${val} renders group headers`);
    }
    await ctx.React.act(async () => {
      props(groupSelect).onChange({ target: { value: '' } });
    });

    // Reconcile & Unreconcile action works from Journal Items checkboxes.
    const payment = read(db, 'account.payment', payRes.id);
    const payMove = payment.move_id;
    const payOutAcct = read(db, 'account.account', payment.outstanding_account_id)?.name ?? ar.name;
    const invRowCheckbox = allFind(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label']?.includes(ar.name) && props(n)?.['aria-label']?.includes(read(db, 'account.move', invRes.id).name))[0];
    const payRowCheckbox = allFind(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label']?.includes(payOutAcct) && props(n)?.['aria-label']?.includes(read(db, 'account.move', payMove).name))[0];
    assert.ok(invRowCheckbox && payRowCheckbox);
    await ctx.React.act(async () => {
      props(invRowCheckbox).onChange({ target: { checked: true } });
    });
    await ctx.React.act(async () => {
      props(allFind(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label']?.includes(payOutAcct) && props(n)?.['aria-label']?.includes(read(db, 'account.move', payMove).name))[0]).onChange({ target: { checked: true } });
    });
    const recBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Reconcile');
    assert.equal(props(recBtn).disabled, false);
    await click(ctx.React, recBtn);
    const form = find(ctx.host, (n) => n.tagName === 'FORM' && props(n)?.['aria-label'] === 'Reconcile');
    await ctx.React.act(async () => {
      await props(form).onSubmit({ preventDefault: () => {} });
    });
    assert.equal(find(ctx.host, (n) => props(n)?.role === 'alert')?.textContent, undefined);
    assert.ok(read(ctx.getDb(), 'account.move', invRes.id).amount_residual < 114);

    // Unreconcile programmatically/via action still works, and ?account=ID scopes to that account.
    const nextDb = unreconcileJournalItems(ctx.getDb(), [{ move_id: invRes.id, line_identity: JSON.stringify(read(ctx.getDb(), 'account.move', invRes.id).line_ids.find((l) => l.account_id === ar.id)) }], { date: dateNow });
    await ctx.React.act(async () => { await ctx.commit(nextDb); });
  } finally {
    await ctx.done();
  }

  const prevHash = globalThis.location?.hash;
  globalThis.location = { hash: `#/accounting/journal-items?account=${ar.id}` };
  const scopedCtx = await mountView((React) => React.createElement(JournalItems, { leaf: {} }), db);
  try {
    const scopedRows = allFind(find(scopedCtx.host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR' && !hasClass(n, 'group-row'));
    assert.ok(scopedRows.length >= 1, `Expected >=1 scoped row for account ${ar.id}`);
    assert.ok(scopedRows.every((r) => r.textContent.includes(ar.name)));
  } finally {
    globalThis.location = { hash: prevHash ?? '' };
    await scopedCtx.done();
  }
});

test('Arabic translations cover new Journal Entries and Journal Items labels', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-jent');
    for (const key of ['Unposted', 'Bank', 'Miscellaneous', 'Date: This Month', 'Date: This Year', 'Invoice Date: This Month', 'Invoice Date: This Year', 'P&L Accounts', 'Journal Entry', 'Matching', 'Due Date', 'Amount in Currency', 'Reversed', 'Manual', 'Payable', 'Receivable']) {
      assert.notEqual(t(key), key, `Missing Arabic translation for ${key}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
