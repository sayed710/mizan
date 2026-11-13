import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { applyFilters, create, groupRecords, matches, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { today } from './models/common.js';
import { createCompany } from './models/company.js';
import { customerPaymentView, postPayment, reversePayment, vendorPaymentView } from './models/pay.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

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

function cleanPaymentsDb() {
  const base = seed();
  return {
    ...base,
    records: {
      ...base.records,
      'account.payment': [],
      'account.bank.statement.line': [],
      'mail.activity': [],
    },
  };
}

function singleCurrencyDb(db) {
  const companyCurrencyId = read(db, 'res.company', 1).currency_id;
  return {
    ...db,
    records: {
      ...db.records,
      'res.currency': (db.records['res.currency'] ?? []).map((c) => (
        c.id === companyCurrencyId ? c : { ...c, active: false }
      )),
    },
  };
}

async function mountPaymentList(leaf, initialDb) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const { makeEl } = setupDom();
  globalThis.document.createElementNS ??= (_, tag) => makeEl(tag);
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { commit } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  commit(initialDb);

  let host = makeEl('div');
  host.ownerDocument = globalThis.document;
  let root = createRoot(host);
  let currentLeaf = leaf;
  const render = async (nextLeaf = currentLeaf) => {
    currentLeaf = nextLeaf;
    await act(async () => {
      root.render(React.createElement(ActionView, { leaf: currentLeaf, base: `#/accounting/${currentLeaf.key}`, params: new URLSearchParams('view=list') }));
    });
  };
  await render(leaf);
  return {
    get host() { return host; },
    render,
    // Re-mount cleanly because test-support/dom.js's insertBefore appends rather than inserts before existing siblings.
    remount: async (nextLeaf = currentLeaf) => {
      await act(async () => root.unmount());
      host = makeEl('div');
      host.ownerDocument = globalThis.document;
      root = createRoot(host);
      await render(nextLeaf);
    },
    setDb: async (nextDb) => { commit(nextDb); await render(currentLeaf); },
    done: async () => {
      await act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

async function actClick(el) {
  const { act } = await import('react');
  await act(async () => props(el).onClick({ stopPropagation: () => {}, preventDefault: () => {} }));
}

const headerLabels = (host) => allFind(host, (n) => n.tagName === 'THEAD')
  .flatMap((thead) => allFind(thead, (n) => n.tagName === 'TH' && !hasClass(n, 'check') && !hasClass(n, 'o2m-cols-th')))
  .map((th) => th.textContent.trim().replace(/\s*[▲▼]$/, ''));

const bodyRows = (host) => allFind(find(host, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR');

test('payment leaves configure Odoo 20 column order, customer/vendor labels, optional visibility, and multi-currency defaults', async () => {
  const custLeaf = leafFor('Customers', 'payments');
  const vendLeaf = leafFor('Vendors', 'vendor-payments');

  assert.deepEqual(custLeaf.list, customerPaymentView.list);
  assert.deepEqual(vendLeaf.list, vendorPaymentView.list);
  assert.equal(custLeaf.listLabels.partner_id, 'Customer');
  assert.equal(vendLeaf.listLabels.partner_id, 'Vendor');
  assert.equal(custLeaf.listLabels.currency_id, 'Payment Currency');
  assert.equal(vendLeaf.listLabels.currency_id, 'Payment Currency');

  const { visibleListColumns } = await import('./views/List.jsx');
  const multiCurrSingleCo = cleanPaymentsDb();
  const singleCurrSingleCo = singleCurrencyDb(multiCurrSingleCo);
  const multiCurrMultiCo = createCompany(multiCurrSingleCo, { name: 'Branch Co', currency_id: read(multiCurrSingleCo, 'res.company', 1).currency_id }).db;

  // Single-company + multi-currency: Amount in Currency is optional show, Company excluded.
  const visMultiCurr = visibleListColumns(models['account.payment'], multiCurrSingleCo, {}, custLeaf);
  assert.deepEqual(visMultiCurr.cols, [
    'date', 'name', 'journal_id', 'partner_id', 'amount_signed', 'amount_company_currency_signed', 'display_state',
  ]);
  assert.ok(!visMultiCurr.optionalCols.some(([k]) => k === 'company_id'));
  assert.equal(visMultiCurr.optionalCols.find(([k]) => k === 'amount_signed')?.[1].optional, 'show');
  assert.equal(visMultiCurr.optionalCols.find(([k]) => k === 'currency_id')?.[1].optional, 'hide');
  assert.equal(visMultiCurr.optionalCols.find(([k]) => k === 'activities')?.[1].optional, 'hide');

  // Single-currency: Amount in Currency defaults to optional hide.
  const visSingleCurr = visibleListColumns(models['account.payment'], singleCurrSingleCo, {}, custLeaf);
  assert.deepEqual(visSingleCurr.cols, [
    'date', 'name', 'journal_id', 'partner_id', 'amount_company_currency_signed', 'display_state',
  ]);
  assert.equal(visSingleCurr.optionalCols.find(([k]) => k === 'amount_signed')?.[1].optional, 'hide');

  // Multi-company + all optional columns shown: exact Odoo 20 order.
  const visAll = visibleListColumns(models['account.payment'], multiCurrMultiCo, {
    company_id: true, amount_signed: true, currency_id: true, activities: true,
  }, vendLeaf);
  assert.deepEqual(visAll.cols, [
    'date', 'name', 'journal_id', 'company_id', 'partner_id',
    'amount_signed', 'currency_id', 'activities', 'amount_company_currency_signed', 'display_state',
  ]);

  // Mount UI and verify headers, optional column toggles, and per-leaf labels.
  const ctx = await mountPaymentList(custLeaf, multiCurrMultiCo);
  try {
    assert.deepEqual(headerLabels(ctx.host), [
      'Date', 'Number', 'Journal', 'Customer', 'Amount in Currency', 'Amount', 'Status',
    ]);
    const colsTh = find(ctx.host, (n) => n.tagName === 'TH' && hasClass(n, 'o2m-cols-th'));
    await actClick(find(colsTh, (n) => n.tagName === 'BUTTON'));
    const optButtons = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox');
    for (const labelText of ['Company', 'Payment Currency', 'Activities']) {
      const btn = optButtons.find((b) => b.textContent.replace('✓', '').trim() === labelText);
      assert.ok(btn, `optional menu includes ${labelText}`);
      await actClick(btn);
    }
    await ctx.remount(custLeaf);
    assert.deepEqual(headerLabels(ctx.host), [
      'Date', 'Number', 'Journal', 'Company', 'Customer', 'Amount in Currency', 'Payment Currency', 'Activities', 'Amount', 'Status',
    ]);

    await ctx.remount(vendLeaf);
    assert.deepEqual(headerLabels(ctx.host), [
      'Date', 'Number', 'Journal', 'Vendor', 'Amount in Currency', 'Amount', 'Status',
    ]);
  } finally {
    await ctx.done();
  }
});

test('signed Amount in Currency (inbound/outbound), Activities cell, and Amount-only sum footer render accurately', async () => {
  let db = cleanPaymentsDb();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 0.5 }] });
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');

  // Inbound customer EUR payment (+100 EUR, +200 USD)
  const pIn = create(db, 'account.payment', {
    partner_id: 2, partner_type: 'customer', payment_type: 'inbound',
    amount: 100, currency_id: eur.id, journal_id: bankJournal.id, date: '2026-02-01', company_id: 1,
  });
  db = postPayment(pIn.db, read(pIn.db, 'account.payment', pIn.id));

  // Outbound customer refund EUR payment (-40 EUR, -80 USD)
  const pOut = create(db, 'account.payment', {
    partner_id: 2, partner_type: 'customer', payment_type: 'outbound',
    amount: 40, currency_id: eur.id, journal_id: bankJournal.id, date: '2026-02-02', company_id: 1,
  });
  db = postPayment(pOut.db, read(pOut.db, 'account.payment', pOut.id));
  db = create(db, 'mail.activity', { res_model: 'account.payment', res_id: pIn.id, summary: 'Verify wire', activity_type: 'todo' }).db;

  assert.equal(read(db, 'account.payment', pIn.id).amount_signed, 100);
  assert.equal(read(db, 'account.payment', pOut.id).amount_signed, -40);
  assert.equal(read(db, 'account.payment', pIn.id).amount_company_currency_signed, 200);
  assert.equal(read(db, 'account.payment', pOut.id).amount_company_currency_signed, -80);

  const ctx = await mountPaymentList(leafFor('Customers', 'payments'), db);
  try {
    const colsTh = find(ctx.host, (n) => n.tagName === 'TH' && hasClass(n, 'o2m-cols-th'));
    await actClick(find(colsTh, (n) => n.tagName === 'BUTTON'));
    const optButtons = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox');
    await actClick(optButtons.find((b) => b.textContent.replace('✓', '').trim() === 'Payment Currency'));
    await actClick(optButtons.find((b) => b.textContent.replace('✓', '').trim() === 'Activities'));
    await ctx.remount();

    const rows = bodyRows(ctx.host);
    const inCells = allFind(rows[0], (n) => n.tagName === 'TD').map((td) => td.textContent.trim());
    const outCells = allFind(rows[1], (n) => n.tagName === 'TD').map((td) => td.textContent.trim());
    assert.equal(inCells[5], '100.00 €');
    assert.equal(inCells[6], 'EUR');
    assert.equal(inCells[7], 'Verify wire');
    assert.equal(inCells[8], '$200.00');
    assert.equal(outCells[5], '-40.00 €');
    assert.equal(outCells[8], '-$80.00');

    // Sum footer appears ONLY on Amount (amount_company_currency_signed), not Amount in Currency.
    const tfoot = find(ctx.host, (n) => n.tagName === 'TFOOT');
    const footCells = allFind(tfoot, (n) => n.tagName === 'TD').map((td) => td.textContent.trim());
    assert.equal(footCells[5], '', 'Amount in Currency has no sum footer');
    assert.equal(footCells[8], '$120.00', 'Amount shows net company sum footer');
  } finally {
    await ctx.done();
  }
});

test('payment status badges and row decorations render across draft, paid, reconciled, canceled, and reversed', async () => {
  let db = cleanPaymentsDb();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const d0 = today();

  const d = create(db, 'account.payment', { partner_id: 2, partner_type: 'customer', payment_type: 'inbound', amount: 10, date: d0, journal_id: bankJournal.id, company_id: 1 });
  const c = create(d.db, 'account.payment', { partner_id: 2, partner_type: 'customer', payment_type: 'inbound', amount: 20, date: d0, journal_id: bankJournal.id, company_id: 1 });
  db = write(c.db, 'account.payment', c.id, { state: 'cancel' });

  const paid = create(db, 'account.payment', { partner_id: 2, partner_type: 'customer', payment_type: 'inbound', amount: 30, date: d0, journal_id: bankJournal.id, company_id: 1 });
  db = postPayment(paid.db, read(paid.db, 'account.payment', paid.id));

  const rec = create(db, 'account.payment', { partner_id: 2, partner_type: 'customer', payment_type: 'inbound', amount: 40, date: d0, journal_id: bankJournal.id, company_id: 1 });
  db = postPayment(rec.db, read(rec.db, 'account.payment', rec.id));
  const stmt = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id, date: d0, payment_ref: 'MATCH-REC', partner_id: 2, amount: 40, payment_id: rec.id, company_id: 1,
  });
  db = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment')
    .run(stmt.db, read(stmt.db, 'account.bank.statement.line', stmt.id)).db;

  const rev = create(db, 'account.payment', { partner_id: 2, partner_type: 'customer', payment_type: 'inbound', amount: 50, date: d0, journal_id: bankJournal.id, company_id: 1 });
  db = postPayment(rev.db, read(rev.db, 'account.payment', rev.id));
  db = reversePayment(db, read(db, 'account.payment', rev.id), d0);

  const ctx = await mountPaymentList(leafFor('Customers', 'payments'), db);
  try {
    const rendered = bodyRows(ctx.host).map((tr) => {
      const tds = allFind(tr, (n) => n.tagName === 'TD');
      const badge = find(tds[7], (n) => hasClass(n, 'badge'));
      return { rowCls: classOf(tr), badgeText: badge.textContent.trim(), badgeCls: classOf(badge) };
    });
    const byText = (txt) => rendered.find((r) => r.badgeText === txt);
    assert.ok(byText('Draft').rowCls.includes('info') && byText('Draft').badgeCls.includes('badge-info'));
    assert.ok(byText('Paid').badgeCls.includes('badge-warning'));
    assert.ok(byText('Reconciled').badgeCls.includes('badge-success'));
    assert.ok(byText('Canceled').rowCls.includes('muted') && byText('Canceled').badgeCls.includes('badge-muted'));
    assert.ok(byText('Reversed').badgeCls.includes('badge-muted'));
  } finally {
    await ctx.done();
  }
});

test('payment search, filters (OR groups, isPaymentMatched Outstanding, monthFilters), and group-bys match Odoo 20', async () => {
  let db = cleanPaymentsDb();
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const cashJournal = search(db, 'account.journal').find((j) => j.type === 'cash');
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const d0 = today();
  const p2 = read(db, 'res.partner', 2);

  const pDraft = create(db, 'account.payment', {
    partner_id: 2, partner_type: 'customer', payment_type: 'inbound',
    amount: 111.5, currency_id: usd.id, journal_id: cashJournal.id, date: '2024-01-15', memo: 'ALPHA-MEMO', company_id: 1,
  });
  const pOut = create(pDraft.db, 'account.payment', {
    partner_id: 3, partner_type: 'customer', payment_type: 'inbound',
    amount: 225, currency_id: eur.id, journal_id: bankJournal.id, date: d0, memo: 'BETA-WIRE', company_id: 1,
  });
  db = postPayment(pOut.db, read(pOut.db, 'account.payment', pOut.id));

  const pRec = create(db, 'account.payment', {
    partner_id: 2, partner_type: 'customer', payment_type: 'inbound',
    amount: 330, currency_id: usd.id, journal_id: bankJournal.id, date: d0, memo: 'GAMMA-MATCH', company_id: 1,
  });
  db = postPayment(pRec.db, read(pRec.db, 'account.payment', pRec.id));
  const stmt = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id, date: d0, payment_ref: 'MATCH-G', partner_id: 2, amount: 330, payment_id: pRec.id, company_id: 1,
  });
  db = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment')
    .run(stmt.db, read(stmt.db, 'account.bank.statement.line', stmt.id)).db;

  const pVend = create(db, 'account.payment', {
    partner_id: 7, partner_type: 'supplier', payment_type: 'outbound',
    amount: 440, currency_id: usd.id, journal_id: bankJournal.id, date: d0, memo: 'VENDOR-OUT', company_id: 1,
  });
  db = postPayment(pVend.db, read(pVend.db, 'account.payment', pVend.id));

  // Free-text search matches number, partner, memo, amount, journal; Company does not match in single-company mode.
  const all = search(db, 'account.payment');
  const outName = read(db, 'account.payment', pOut.id).name;
  assert.deepEqual(all.filter((r) => matches(db, 'account.payment', r, [outName], customerPaymentView.searchFields)).map((r) => r.id), [pOut.id]);
  assert.deepEqual(all.filter((r) => matches(db, 'account.payment', r, [p2.name], customerPaymentView.searchFields)).map((r) => r.id), [pDraft.id, pRec.id]);
  assert.deepEqual(all.filter((r) => matches(db, 'account.payment', r, ['ALPHA-MEMO'], customerPaymentView.searchFields)).map((r) => r.id), [pDraft.id]);
  assert.deepEqual(all.filter((r) => matches(db, 'account.payment', r, ['225'], customerPaymentView.searchFields)).map((r) => r.id), [pOut.id]);
  assert.deepEqual(all.filter((r) => matches(db, 'account.payment', r, [cashJournal.name], customerPaymentView.searchFields)).map((r) => r.id), [pDraft.id]);

  // Filters: verify Outstanding computes via isPaymentMatched even on raw stored records (no display_state field).
  const rawRecords = db.records['account.payment'];
  assert.equal(rawRecords[0].display_state, undefined);
  assert.deepEqual(applyFilters('account.payment', rawRecords, ['customer'], db, customerPaymentView.filters).map((r) => r.id), [pDraft.id, pOut.id, pRec.id]);
  assert.deepEqual(applyFilters('account.payment', rawRecords, ['supplier'], db, customerPaymentView.filters).map((r) => r.id), [pVend.id]);
  assert.deepEqual(applyFilters('account.payment', rawRecords, ['customer', 'supplier'], db, customerPaymentView.filters).map((r) => r.id), [pDraft.id, pOut.id, pRec.id, pVend.id]);
  assert.deepEqual(applyFilters('account.payment', rawRecords, ['draft', 'paid'], db, customerPaymentView.filters).map((r) => r.id), [pDraft.id, pOut.id, pRec.id, pVend.id]);
  assert.deepEqual(applyFilters('account.payment', rawRecords, ['outstanding'], db, customerPaymentView.filters).map((r) => r.id), [pOut.id, pVend.id]);
  assert.deepEqual(applyFilters('account.payment', rawRecords, ['date_month'], db, customerPaymentView.filters).map((r) => r.id), [pOut.id, pRec.id, pVend.id]);
  assert.deepEqual(applyFilters('account.payment', rawRecords, ['date_year'], db, customerPaymentView.filters).map((r) => r.id), [pOut.id, pRec.id, pVend.id]);

  // Group Bys: exact order, labels, Currency gated on multi-currency, Company gated on multi-company.
  assert.deepEqual(customerPaymentView.groupBys, ['partner_id', 'journal_id', 'display_state', 'date', 'currency_id', 'company_id']);
  for (const key of customerPaymentView.groupBys) {
    assert.ok(groupRecords(db, 'account.payment', all, key).length >= 1, `groupRecords works for ${key}`);
  }
  assert.ok(groupRecords(db, 'account.payment', all, 'currency_id').some((g) => g.label === 'EUR'));

  const groupByButtonTexts = async (targetDb) => {
    const ctx = await mountPaymentList(leafFor('Customers', 'payments'), targetDb);
    try {
      await actClick(find(ctx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle')));
      const panel = find(ctx.host, (n) => hasClass(n, 'search-panel'));
      const sections = allFind(panel, (n) => n.tagName === 'SECTION');
      const groupSection = sections.find((s) => find(s, (h) => h.tagName === 'H3')?.textContent.includes('Group By'));
      return allFind(groupSection, (n) => n.tagName === 'BUTTON').map((b) => b.textContent.trim());
    } finally {
      await ctx.done();
    }
  };

  assert.deepEqual(await groupByButtonTexts(db), ['Partner', 'Journal', 'Status', 'Payment Date', 'Currency']);
  assert.deepEqual(await groupByButtonTexts(singleCurrencyDb(db)), ['Partner', 'Journal', 'Status', 'Payment Date']);
  const multiDb = createCompany(db, { name: 'Branch Co', currency_id: usd.id }).db;
  assert.deepEqual(await groupByButtonTexts(multiDb), ['Partner', 'Journal', 'Status', 'Payment Date', 'Currency', 'Company']);
});

test('Arabic translations cover every payment list column, status, filter, and group-by label', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {}, removeItem() {} };
  try {
    const { t } = await import(`./i18n.js?lang_ar_pay_list=${Date.now()}`);
    for (const label of [
      'Date', 'Number', 'Journal', 'Company', 'Customer', 'Vendor', 'Partner',
      'Amount in Currency', 'Payment Currency', 'Activities', 'Amount', 'Status',
      'Draft', 'Paid', 'Reconciled', 'Canceled', 'Reversed',
      'Customer Payments', 'Vendor Payments', 'Outstanding',
      'Payment Date', 'Payment Date: This Month', 'Payment Date: This Year',
      'Currency',
    ]) {
      assert.notEqual(t(label), label, `Arabic translation present for ${label}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
