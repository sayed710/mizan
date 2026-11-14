import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import './models/index.js';
import { postMove } from './models/accounting.js';
import { accountId } from './models/ledger.js';
import { createCompany, setCompanies } from './models/company.js';
import { secureEntries } from './models/hash_chain.js';
import { postPayment } from './models/pay.js';
import { addDays, today } from './models/common.js';
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

async function mountJournalItems(initialDb, hash = '#/accounting/journal-items', leaf = {}) {
  const prevStorage = globalThis.localStorage;
  const prevLocation = globalThis.location;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  globalThis.location = { hash };
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
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => root.render(React.createElement(JournalItems, { leaf })));
  return {
    React,
    host,
    mem,
    getDb,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
      globalThis.location = prevLocation;
    },
  };
}

async function click(React, el) {
  await React.act(async () => {
    props(el)?.onClick?.({ preventDefault: () => {}, stopPropagation: () => {}, currentTarget: el, target: el });
  });
}

function journalColumnsAndMenus(host) {
  const thead = find(host, (n) => n.tagName === 'THEAD');
  const visibleHeaders = allFind(thead, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((n) => n.textContent.trim());
  const toggleBtn = find(thead, (n) => hasClass(n, 'o2m-cols-toggle'));
  return { thead, visibleHeaders, toggleBtn };
}

function optionalMenuButtons(thead) {
  return allFind(thead, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox');
}

function buildRichJournalItemsDb() {
  let db = seed();
  const dateNow = today();
  const yesterday = addDays(dateNow, -1);
  const tomorrow = addDays(dateNow, 10);
  const priorMonth = addDays(`${dateNow.slice(0, 7)}-01`, -5);
  const ap = accountId(db, '211000');
  const inc = accountId(db, '400000');
  const exp = search(db, 'account.account').find((a) => a.account_type === 'expense' && (a.company_id ?? 1) === 1).id;
  const bankAcct = accountId(db, '101401');
  const saleJ = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id ?? 1) === 1);
  const purchJ = search(db, 'account.journal').find((j) => j.type === 'purchase' && (j.company_id ?? 1) === 1);
  const bankJ = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const cashJ = search(db, 'account.journal').find((j) => j.type === 'cash' && (j.company_id ?? 1) === 1);
  const miscJ = search(db, 'account.journal').find((j) => j.type === 'general' && (j.company_id ?? 1) === 1);
  const cardJRes = create(db, 'account.journal', { name: 'Corporate Card', code: 'CRD1', type: 'credit', default_account_id: bankAcct, suspense_account_id: accountId(db, '101404') });
  db = cardJRes.db;
  const cardJ = read(db, 'account.journal', cardJRes.id);

  const partner = search(db, 'res.partner').find((p) => p.customer_rank > 0) ?? search(db, 'res.partner')[0];
  const fxPartnerRes = create(db, 'res.partner', { name: 'Euro Customer', customer_rank: 1 });
  db = fxPartnerRes.db;
  const vendor = search(db, 'res.partner').find((p) => p.supplier_rank > 0) ?? search(db, 'res.partner')[0];
  const prod = search(db, 'product')[0];
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const vatSale = search(db, 'account.tax').find((tx) => tx.type_tax_use === 'sale' && tx.amount > 0);
  const tagRes = create(db, 'account.account.tag', { name: 'VAT Output Grid', applicability: 'taxes' });
  db = tagRes.db;
  const analyticRes = create(db, 'account.analytic.account', { name: 'R&D Dept', code: 'RD' });
  db = analyticRes.db;
  const splitTermRes = create(db, 'account.payment.term', {
    name: '50/50 Split with Early Discount',
    early_discount: true,
    discount_percent: 2,
    discount_days: 10,
    line_ids: [
      { value_type: 'percent', value: 50, nb_days: -1 },
      { value_type: 'balance', nb_days: 30 },
    ],
  });
  db = splitTermRes.db;

  // 1. Overdue & split-term customer invoice with early discount, tax, product, analytic distribution, and tax grid.
  const splitInvRes = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJ.id,
    date: dateNow,
    invoice_date: dateNow,
    invoice_payment_term_id: splitTermRes.id,
    ref: 'INV-SPLIT-REF',
    invoice_line_ids: [{
      name: 'Consulting Fee',
      product_id: prod?.id ?? null,
      account_id: inc,
      qty: 1,
      price_unit: 200,
      tax: vatSale?.amount ?? 0,
      tax_ids: vatSale ? [vatSale.id] : [],
      analytic_distribution: { [analyticRes.id]: 100 },
    }],
  });
  db = postMove(splitInvRes.db, splitInvRes.id);

  // Pay exact halfAmt (114) so installment 1 + payment form a closed matching group (full_reconcile_id set in Odoo 20), leaving only installment 2 unreconciled.
  const invTotal = read(db, 'account.move', splitInvRes.id).amount_total;
  const halfAmt = Number((invTotal / 2).toFixed(2));
  const halfPayRes = create(db, 'account.payment', {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    journal_id: bankJ.id,
    invoice_id: splitInvRes.id,
    amount: halfAmt,
    date: dateNow,
  });
  db = postPayment(halfPayRes.db, read(halfPayRes.db, 'account.payment', halfPayRes.id));

  // 1b. Split-term invoice (150 + 150) with a single bridging payment of 200: installment 1 has amount_residual = 0,
  // yet both AR lines share the same partial matching group with installment 2 still open (full_reconcile_id = False).
  const bridgedInvRes = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: partner.id,
    journal_id: saleJ.id,
    date: dateNow,
    invoice_date: dateNow,
    invoice_payment_term_id: splitTermRes.id,
    ref: 'INV-BRIDGE-REF',
    invoice_line_ids: [{
      name: 'Bridged Advisory',
      account_id: inc,
      qty: 1,
      price_unit: 300,
      tax: 0,
      tax_ids: [],
    }],
  });
  db = postMove(bridgedInvRes.db, bridgedInvRes.id);
  const bridgedPayRes = create(db, 'account.payment', {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    journal_id: bankJ.id,
    invoice_id: bridgedInvRes.id,
    amount: 200,
    date: dateNow,
  });
  db = postPayment(bridgedPayRes.db, read(bridgedPayRes.db, 'account.payment', bridgedPayRes.id));

  // 2. Foreign-currency posted invoice in EUR (not paid yet, overdue due date).
  const fxInvRes = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: fxPartnerRes.id,
    journal_id: saleJ.id,
    currency_id: eur.id,
    date: dateNow,
    invoice_date: dateNow,
    invoice_date_due: yesterday,
    ref: 'FX-EUR-01',
    invoice_line_ids: [{
      name: 'Foreign SaaS',
      account_id: inc,
      qty: 1,
      price_unit: 100,
      tax: 0,
      tax_ids: [],
    }],
  });
  db = postMove(fxInvRes.db, fxInvRes.id);

  // 3. Posted vendor bill in prior month invoice date + future due date + tax grid on custom line.
  const billRes = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    journal_id: purchJ.id,
    date: priorMonth,
    invoice_date: priorMonth,
    invoice_date_due: tomorrow,
    ref: 'BILL-PRIOR-01',
    invoice_line_ids: [{
      name: 'Cloud Hosting',
      account_id: exp,
      qty: 1,
      price_unit: 75,
      tax: 0,
      tax_ids: [],
    }],
  });
  db = postMove(billRes.db, billRes.id);

  // 4. Posted cash, credit card, and miscellaneous entries (with tax grid tag).
  const cashPayRes = create(db, 'account.payment', {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: partner.id,
    journal_id: cashJ.id,
    amount: 33.25,
    date: dateNow,
  });
  db = postPayment(cashPayRes.db, read(cashPayRes.db, 'account.payment', cashPayRes.id));

  const cardMoveRes = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: cardJ.id,
    date: dateNow,
    ref: 'CARD-REF-77',
    line_ids: [
      { account_id: exp, partner_id: vendor.id, name: 'Airline Ticket', debit: 145, credit: 0, tax_tag_ids: [tagRes.id] },
      { account_id: bankAcct, partner_id: vendor.id, name: 'Card Settlement', debit: 0, credit: 145 },
    ],
  });
  db = postMove(cardMoveRes.db, cardMoveRes.id);

  const miscMoveRes = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: miscJ.id,
    date: dateNow,
    ref: 'MISC-HASH-1',
    line_ids: [
      { account_id: exp, partner_id: vendor.id, name: 'Secured Office Supply', debit: 42.5, credit: 0 },
      { account_id: ap, partner_id: vendor.id, name: 'Secured AP Credit', debit: 0, credit: 42.5 },
    ],
  });
  db = postMove(miscMoveRes.db, miscMoveRes.id);
  // Enable hash chain on Miscellaneous journal and secure MISC-HASH-1 so Not Secured distinguishes secured vs unsecured items.
  db = write(db, 'account.journal', miscJ.id, { restrict_mode_hash_table: true });
  db = secureEntries(db, { throughMoveId: miscMoveRes.id });

  // 5. Draft (unposted) entry with overdue due date and info decoration.
  const draftRes = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: miscJ.id,
    date: dateNow,
    ref: 'DRAFT-INFO-1',
    line_ids: [
      { account_id: exp, name: 'Draft Item Debit', debit: 19, credit: 0 },
      { account_id: ap, partner_id: vendor.id, name: 'Draft Item Credit', debit: 0, credit: 19, date_maturity: yesterday },
    ],
  });
  db = draftRes.db;

    return { db, splitInvId: splitInvRes.id, bridgedInvId: bridgedInvRes.id, fxInvId: fxInvRes.id, billId: billRes.id, miscMoveId: miscMoveRes.id, draftMoveId: draftRes.id, halfPayId: halfPayRes.id, halfAmt, eur, partner, vendor, tagId: tagRes.id, incName: read(db, 'account.account', inc).name };
}

test('Journal Items list columns match Odoo 20 order, optional state, multi-company and multi-currency gating', async () => {
  // Single-company + multi-currency default seed DB.
  const singleCtx = await mountJournalItems(seed());
  try {
    const { thead, visibleHeaders, toggleBtn } = journalColumnsAndMenus(singleCtx.host);
    assert.deepEqual(
      visibleHeaders,
      ['Select', 'Date', 'Journal Entry', 'Account', 'Partner', 'Label', 'Debit', 'Credit', 'Matching'],
    );
    await click(singleCtx.React, toggleBtn);
    const singleOpts = optionalMenuButtons(thead).map((b) => b.textContent.replace('✓', '').trim());
    assert.deepEqual(singleOpts, [
      'Invoice Date', 'Journal', 'Partner', 'Reference', 'Product', 'Label',
      'Analytic Distribution', 'Taxes', 'In Currency', 'Currency', 'Tax Grids',
      'Discount Date', 'Discount Amount', 'Originator Tax', 'Due Date', 'Balance',
      'Matching', 'Residual', 'Residual in Currency',
    ]);
    assert.ok(!singleOpts.includes('Company'), 'Company hidden when only one company is active');
  } finally {
    await singleCtx.done();
  }

  // Single-currency DB hides In Currency, Currency, and Residual in Currency.
  let oneCurrDb = seed();
  for (const c of search(oneCurrDb, 'res.currency')) {
    if (c.id !== 1) oneCurrDb = write(oneCurrDb, 'res.currency', c.id, { active: false });
  }
  const oneCurrCtx = await mountJournalItems(oneCurrDb);
  try {
    const { thead, toggleBtn } = journalColumnsAndMenus(oneCurrCtx.host);
    await click(oneCurrCtx.React, toggleBtn);
    const opts = optionalMenuButtons(thead).map((b) => b.textContent.replace('✓', '').trim());
    for (const hiddenCol of ['In Currency', 'Currency', 'Residual in Currency', 'Company']) {
      assert.ok(!opts.includes(hiddenCol), `${hiddenCol} hidden in single-currency single-company DB`);
    }
  } finally {
    await oneCurrCtx.done();
  }

  // Multi-company + multi-currency DB exposes all 25 columns in exact Odoo 20 order when enabled.
  let multiDb = seed();
  const branchRes = createCompany(multiDb, { name: 'Branch Co', code: 'BRC' });
  multiDb = setCompanies(branchRes.db, { current: 1, allowed: [1, branchRes.id] });
  const multiCtx = await mountJournalItems(multiDb);
  try {
    const { thead, toggleBtn } = journalColumnsAndMenus(multiCtx.host);
    await click(multiCtx.React, toggleBtn);
    const menuBtns = optionalMenuButtons(thead);
    const menuLabels = menuBtns.map((b) => b.textContent.replace('✓', '').trim());
    assert.deepEqual(menuLabels, [
      'Invoice Date', 'Company', 'Journal', 'Partner', 'Reference', 'Product', 'Label',
      'Analytic Distribution', 'Taxes', 'In Currency', 'Currency', 'Tax Grids',
      'Discount Date', 'Discount Amount', 'Originator Tax', 'Due Date', 'Balance',
      'Matching', 'Residual', 'Residual in Currency',
    ]);
    // Partner, Label, Matching are [show] (checked by default); toggle all [hide] columns on.
    for (const btn of menuBtns) {
      if (!btn.textContent.includes('✓')) await click(multiCtx.React, btn);
    }
    const allHeaders = allFind(find(multiCtx.host, (n) => n.tagName === 'THEAD'), (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((n) => n.textContent.trim());
    assert.deepEqual(allHeaders, [
      'Select',
      'Invoice Date', 'Date', 'Company', 'Journal', 'Journal Entry', 'Account',
      'Partner', 'Reference', 'Product', 'Label', 'Analytic Distribution', 'Taxes',
      'In Currency', 'Currency', 'Debit', 'Credit', 'Tax Grids',
      'Discount Date', 'Discount Amount', 'Originator Tax', 'Due Date', 'Balance',
      'Matching', 'Residual', 'Residual in Currency',
    ]);
  } finally {
    await multiCtx.done();
  }
});

test('Journal Items renders decorations, muted zeros, blanked company currency/non-reconcilable residual, discounts, originator tax and footer sums', async () => {
  const fixture = buildRichJournalItemsDb();
  const ctx = await mountJournalItems(fixture.db);
  try {
    const thead = find(ctx.host, (n) => n.tagName === 'THEAD');
    await click(ctx.React, find(thead, (n) => hasClass(n, 'o2m-cols-toggle')));
    for (const btn of optionalMenuButtons(thead)) {
      if (!btn.textContent.includes('✓')) await click(ctx.React, btn);
    }

    const filterGroup = find(ctx.host, (n) => props(n)?.role === 'group' && props(n)?.['aria-label'] === t('Filters'));
    const unpostedBtn = allFind(filterGroup, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Unposted')[0];
    await click(ctx.React, unpostedBtn);

    const headers = allFind(find(ctx.host, (n) => n.tagName === 'THEAD'), (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((n) => n.textContent.trim());
    const colIndex = (label) => headers.indexOf(label);

    const rows = allFind(find(ctx.host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR' && !hasClass(n, 'group-row'));
    const draftRows = rows.filter((tr) => hasClass(tr, 'info'));
    assert.equal(draftRows.length, 2, 'Draft entry rows use info decoration');

    // Draft AP credit line has debit = 0 (muted) and overdue unreconciled Due Date (danger).
    const draftApRow = draftRows.find((tr) => tr.childNodes[colIndex('Label')]?.textContent.trim() === 'Draft Item Credit');
    assert.ok(draftApRow);
    const debitTd = draftApRow.childNodes[colIndex('Debit')];
    const creditTd = draftApRow.childNodes[colIndex('Credit')];
    assert.ok(hasClass(debitTd, 'muted'), 'Zero Debit cell is muted');
    assert.ok(!hasClass(creditTd, 'muted'), 'Non-zero Credit cell is not muted');
    assert.ok(hasClass(draftApRow.childNodes[colIndex('Due Date')], 'danger'), 'Overdue unreconciled Due Date has danger class');

    // Non-foreign company-currency invoice line blanks In Currency, Currency, Residual in Currency; non-reconcilable income line blanks Residual.
    const splitMoveName = read(fixture.db, 'account.move', fixture.splitInvId).name;
    const consultingRow = rows.find((tr) => tr.childNodes[colIndex('Journal Entry')]?.textContent.trim() === splitMoveName && tr.childNodes[colIndex('Account')]?.textContent.trim() === fixture.incName);
    assert.ok(consultingRow);
    assert.equal(consultingRow.childNodes[colIndex('In Currency')].textContent.trim(), '');
    assert.equal(consultingRow.childNodes[colIndex('Currency')].textContent.trim(), '');
    assert.equal(consultingRow.childNodes[colIndex('Residual')].textContent.trim(), '');
    assert.equal(consultingRow.childNodes[colIndex('Residual in Currency')].textContent.trim(), '');
    assert.match(consultingRow.childNodes[colIndex('Analytic Distribution')].textContent, /R&D Dept: 100%/);

    // Split-term invoice carries early-payment Discount Date & non-zero Discount Amount on installment 1.
    const splitArRows = rows.filter((tr) => tr.childNodes[colIndex('Journal Entry')]?.textContent.trim() === splitMoveName && tr.childNodes[colIndex('Discount Date')]?.textContent.trim());
    assert.ok(splitArRows.length >= 1);
    assert.ok(splitArRows.some((tr) => tr.childNodes[colIndex('Discount Amount')].textContent.trim() !== '' && !/^[^\d]*0\.00$/.test(tr.childNodes[colIndex('Discount Amount')].textContent.trim())));

    // Foreign-currency EUR invoice AR line populates In Currency, Currency (EUR), Residual, and Residual in Currency, and has danger Due Date.
    const fxMoveName = read(fixture.db, 'account.move', fixture.fxInvId).name;
    const fxArRow = rows.find((tr) => tr.childNodes[colIndex('Journal Entry')]?.textContent.trim() === fxMoveName && tr.childNodes[colIndex('Residual')].textContent.trim() !== '');
    assert.ok(fxArRow);
    assert.equal(fxArRow.childNodes[colIndex('Currency')].textContent.trim(), 'EUR');
    assert.match(fxArRow.childNodes[colIndex('In Currency')].textContent, /€/);
    assert.equal(
      fxArRow.childNodes[colIndex('Residual in Currency')].textContent.trim(),
      fxArRow.childNodes[colIndex('In Currency')].textContent.trim(),
      'Unpaid FX AR line Residual in Currency equals In Currency',
    );
    assert.match(fxArRow.childNodes[colIndex('Residual')].textContent, /\$/);
    assert.ok(hasClass(fxArRow.childNodes[colIndex('Due Date')], 'danger'));

    // Non-reconcilable FX income line shows In Currency & Currency, blanks Residual & Residual in Currency.
    const fxIncRow = rows.find((tr) => tr.childNodes[colIndex('Journal Entry')]?.textContent.trim() === fxMoveName && tr.childNodes[colIndex('Account')]?.textContent.trim() === fixture.incName);
    assert.ok(fxIncRow);
    assert.equal(fxIncRow.childNodes[colIndex('Currency')].textContent.trim(), 'EUR');
    assert.equal(fxIncRow.childNodes[colIndex('Residual')].textContent.trim(), '');
    assert.equal(fxIncRow.childNodes[colIndex('Residual in Currency')].textContent.trim(), '');

    // Tax line shows Originator Tax and blank Taxes.
    const splitTaxRows = rows.filter((tr) => tr.childNodes[colIndex('Journal Entry')]?.textContent.trim() === splitMoveName && tr.childNodes[colIndex('Originator Tax')]?.textContent.trim());
    if (splitTaxRows.length) {
      assert.equal(splitTaxRows[0].childNodes[colIndex('Taxes')].textContent.trim(), '');
    }

    // Sum footers: Total Debit, Total Credit, Total Balance, Total Residual.
    const tfoot = find(ctx.host, (n) => n.tagName === 'TFOOT');
    const footTds = allFind(tfoot, (n) => n.tagName === 'TD');
    for (const label of ['Total Debit', 'Total Credit', 'Total Balance', 'Total Residual']) {
      const td = footTds.find((cell) => props(cell)?.['aria-label'] === label);
      assert.ok(td && td.textContent.trim() !== '', `Footer total "${label}" renders non-empty sum`);
    }
  } finally {
    await ctx.done();
  }
});

test('Journal Items filters distinguish Unreconciled vs With residual, Not Secured, journals, accounts, dates and Group By', async () => {
  const fixture = buildRichJournalItemsDb();
  const ctx = await mountJournalItems(fixture.db);
  try {
    const filterGroup = find(ctx.host, (n) => props(n)?.role === 'group' && props(n)?.['aria-label'] === t('Filters'));
    const filterButtons = allFind(filterGroup, (n) => n.tagName === 'BUTTON');
    assert.deepEqual(
      filterButtons.map((b) => b.textContent.trim()),
      ['Unposted', 'Posted', 'Not Secured', 'Unreconciled', 'With residual', 'Sales', 'Purchases', 'Bank', 'Cash', 'Credit', 'Miscellaneous', 'Payable', 'Receivable', 'P&L Accounts', 'Date: This Month', 'Date: This Year', 'Invoice Date: This Month', 'Invoice Date: This Year'],
    );
    const clickFilter = async (label) => click(ctx.React, filterButtons.find((b) => b.textContent.trim() === label));
    const itemRows = () => allFind(find(ctx.host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR' && !hasClass(n, 'group-row'));

    // Not Secured excludes secured entry MISC-HASH-1 while keeping unsecured posted entries.
    await clickFilter('Not Secured');
    const notSecuredTexts = itemRows().map((tr) => tr.textContent);
    assert.ok(notSecuredTexts.some((txt) => txt.includes('Airline Ticket')));
    assert.ok(!notSecuredTexts.some((txt) => txt.includes('Secured Office Supply')), 'Secured posted entry excluded by Not Secured');
    await clickFilter('Not Secured');

    // Unreconciled vs With residual:
    // 1) splitInvId has 2 AR lines (114 + 114) and a single payment of exact halfAmt (114). In Odoo 20, the payment matches
    //    only installment 1, closing {AR1, payment} with a full_reconcile_id; only installment 2 stays Unreconciled and With residual.
    const splitMoveName = read(fixture.db, 'account.move', fixture.splitInvId).name;
    // 2) bridgedInvId has 2 AR lines (150 + 150) and one bridging payment of 200. Installment 1 has amount_residual = 0,
    //    but shares the partial matching group {AR1, payment, AR2} while AR2 still owes 100, so both AR lines stay Unreconciled (full_reconcile_id = False)
    //    while only AR2 matches With residual (amount_residual != 0).
    const bridgedMoveName = read(fixture.db, 'account.move', fixture.bridgedInvId).name;
    await clickFilter('Unreconciled');
    const unreconciledSplitRows = itemRows().filter((tr) => tr.textContent.includes(splitMoveName));
    assert.equal(unreconciledSplitRows.length, 1, 'Exact first-installment payment closes its matching group in Odoo 20, leaving only installment 2 Unreconciled');
    const unreconciledBridgedRows = itemRows().filter((tr) => tr.textContent.includes(bridgedMoveName));
    assert.equal(unreconciledBridgedRows.length, 2, 'Both AR lines remain Unreconciled when one payment bridges installment 1 into open installment 2');
    await clickFilter('Unreconciled');

    await clickFilter('With residual');
    const residualSplitRows = itemRows().filter((tr) => tr.textContent.includes(splitMoveName));
    assert.equal(residualSplitRows.length, 1, 'Only the unpaid second installment matches With residual');
    const residualBridgedRows = itemRows().filter((tr) => tr.textContent.includes(bridgedMoveName));
    assert.equal(residualBridgedRows.length, 1, 'Only the partially unpaid second installment matches With residual');
    await clickFilter('With residual');

    // Invoice Date: This Month excludes prior-month vendor bill.
    const priorBillName = read(fixture.db, 'account.move', fixture.billId).name;
    await clickFilter('Invoice Date: This Month');
    assert.ok(!itemRows().some((tr) => tr.textContent.includes(priorBillName)));
    await clickFilter('Invoice Date: This Month');

    // Search by entry number, entry ref, and exact amount (matching debit or credit).
    const searchInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === t('Search'));
    const setSearch = async (val) => ctx.React.act(async () => {
      props(searchInput).onChange({ target: { value: val } });
    });

    await setSearch(priorBillName);
    assert.ok(itemRows().length >= 2 && itemRows().every((tr) => tr.textContent.includes(priorBillName)), 'Search by entry number narrows rows');

    await setSearch('CARD-REF-77');
    assert.equal(itemRows().length, 2, 'Search by entry reference matches all items of entry');

    await setSearch('145');
    assert.equal(itemRows().length, 2, 'Search by Amount matches items whose debit or credit equals 145');

    await setSearch('');

    // Group By: all 9 options in exact order.
    const groupSelect = find(ctx.host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === t('Group By'));
    assert.deepEqual(
      allFind(groupSelect, (n) => n.tagName === 'OPTION').map((o) => o.textContent.trim()),
      ['None', 'Journal Entry', 'Account', 'Partner', 'Journal', 'Date', 'Invoice Date', 'Taxes', 'Tax Grid', 'Matching'],
    );
    for (const val of ['move', 'account', 'partner', 'journal', 'date', 'invoice_date', 'taxes', 'tax_grids', 'matching']) {
      await ctx.React.act(async () => {
        props(groupSelect).onChange({ target: { value: val } });
      });
      const hdrs = allFind(ctx.host, (n) => hasClass(n, 'group-row'));
      assert.ok(hdrs.length >= 1, `Grouping by ${val} renders group headers`);
      if (val === 'tax_grids') {
        assert.ok(hdrs.some((h) => h.textContent.includes('VAT Output Grid')), 'Tax Grid group shows tag name');
      }
    }
  } finally {
    await ctx.done();
  }
});

test('Arabic i18n covers all Journal Items columns, footer sums, filters, and group-bys', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t: tAr } = await import('./i18n.js?lang=ar-jiparity');
    const keys = [
      'Invoice Date', 'Date', 'Company', 'Journal', 'Journal Entry', 'Account', 'Partner',
      'Reference', 'Product', 'Label', 'Analytic Distribution', 'Taxes', 'In Currency', 'Currency',
      'Debit', 'Credit', 'Tax Grids', 'Discount Date', 'Discount Amount', 'Originator Tax',
      'Due Date', 'Balance', 'Matching', 'Residual', 'Residual in Currency',
      'Total Debit', 'Total Credit', 'Total Balance', 'Total Residual',
      'Unposted', 'Posted', 'Not Secured', 'Unreconciled', 'With residual',
      'Sales', 'Purchases', 'Bank', 'Cash', 'Credit', 'Miscellaneous',
      'Payable', 'Receivable', 'P&L Accounts',
      'Date: This Month', 'Date: This Year', 'Invoice Date: This Month', 'Invoice Date: This Year',
      'Tax Grid', 'Journal Item',
    ];
    for (const key of keys) {
      assert.notEqual(tAr(key), key, `Missing Arabic translation for "${key}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
