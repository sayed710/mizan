import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom } from './test-support/dom.js';
import { applyFilters, create, groupRecords, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { postPayment, reversePayment } from './models/pay.js';
import { postMove, payMove } from './models/accounting.js';
import { unreconcile } from './models/bank.js';
import { companySum } from './models/money.js';
import { actionRecords } from './companyView.js';

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
const leafFor = (sectionLabel, key) => {
  const top = menusFor('accounting').find((m) => m.label === sectionLabel);
  const direct = top?.children?.find((c) => c.key === key);
  if (direct) return direct;
  for (const child of top?.children ?? []) {
    const nested = child.children?.find((c) => c.key === key);
    if (nested) return nested;
  }
  return null;
};

const fieldLabelsOf = (group) => allFind(group, (n) => hasClass(n, 'field'))
  .map((f) => allFind(f, (c) => c.tagName === 'LABEL' || hasClass(c, 'field-label'))[0]?.textContent?.replaceAll('*', '').trim());

async function withUi(initialDb, fn) {
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_namespace, tag) => makeEl(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { ActionView, parseRel } = await import('./views/ActionView.jsx');
  const ActionViewModule = { parseRel };
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const renderAction = async (leaf, query = 'view=list') => {
    await React.act(async () => root.render(React.createElement(ActionView, {
      leaf,
      base: `#/accounting/${leaf.key}`,
      params: new URLSearchParams(query),
    })));
  };
  const renderForm = async (leaf, id) => {
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf,
      id,
      base: `#/accounting/${leaf.key}`,
      params: new URLSearchParams('view=form'),
    })));
  };
  try {
    return await fn({ React, host, commit, getDb, renderAction, renderForm, parseRel: ActionViewModule.parseRel });
  } finally {
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
}

test('Customer Payments and Vendor Payments list columns, partner headers, and signed company amounts match Odoo 20', async () => {
  let db = seed();
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = {
    ...db,
    records: {
      ...db.records,
      'res.currency': db.records['res.currency'].map((c) => (
        c.id === eur.id ? { ...c, rate_ids: [{ date: '2026-01-01', rate: 0.5 }] } : c
      )),
    },
  };
  const rateOnDate = 0.5;
  const partner = search(db, 'res.partner')[0];
  const custIn = create(db, 'account.payment', {
    partner_id: partner.id, partner_type: 'customer', payment_type: 'inbound',
    amount: 100, currency_id: eur.id, date: '2026-02-10', company_id: 1,
  });
  db = postPayment(custIn.db, read(custIn.db, 'account.payment', custIn.id));
  const vendOut = create(db, 'account.payment', {
    partner_id: partner.id, partner_type: 'supplier', payment_type: 'outbound',
    amount: 75, currency_id: usd.id, date: '2026-02-11', company_id: 1,
  });
  db = postPayment(vendOut.db, read(vendOut.db, 'account.payment', vendOut.id));

  const postedIn = read(db, 'account.payment', custIn.id);
  const postedOut = read(db, 'account.payment', vendOut.id);
  const expectedInCompany = Math.round((100 / rateOnDate) * 100) / 100;
  assert.equal(postedIn.amount_company_currency_signed, expectedInCompany);
  assert.equal(postedOut.amount_company_currency_signed, -75);

  // Verify companySum does not double-convert foreign-currency posted payments when companyBooked is set.
  assert.equal(
    companySum(db, [postedIn, postedOut], 'amount_company_currency_signed', undefined, { companyBooked: true }),
    Math.round((expectedInCompany - 75) * 100) / 100,
  );

  assert.deepEqual(models['account.payment'].list, [
    'date', 'name', 'journal_id', 'company_id', 'partner_id',
    'amount_signed', 'currency_id', 'activities', 'amount_company_currency_signed', 'display_state',
  ]);
  assert.ok(models['account.payment'].fields.memo);
  assert.ok(models['account.payment'].fields.payment_type);
  assert.ok(!models['account.payment'].list.includes('memo'));
  assert.ok(!models['account.payment'].list.includes('payment_type'));

  const custLeaf = leafFor('Customers', 'payments');
  const vendLeaf = leafFor('Vendors', 'vendor-payments');

  await withUi(db, async ({ host, renderAction }) => {
    await renderAction(custLeaf);
    const custHeaders = allFind(host, (n) => n.tagName === 'TH' && !hasClass(n, 'check') && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim());
    assert.deepEqual(custHeaders, ['Date', 'Number', 'Journal', 'Customer', 'Amount in Currency', 'Amount', 'Status']);
    const custRows = allFind(host, (n) => n.tagName === 'TBODY')[0].childNodes.filter((n) => n.tagName === 'TR');
    assert.ok(custRows.some((tr) => tr.textContent.includes(postedIn.name) && tr.textContent.includes('Paid')));
    assert.ok(!custRows.some((tr) => tr.textContent.includes(postedOut.name)));

    await renderAction(vendLeaf);
    const vendHeaders = allFind(host, (n) => n.tagName === 'TH' && !hasClass(n, 'check') && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.replace(/[▲▼]/g, '').trim());
    assert.deepEqual(vendHeaders, ['Date', 'Number', 'Journal', 'Vendor', 'Amount in Currency', 'Amount', 'Status']);
    const vendRows = allFind(host, (n) => n.tagName === 'TBODY')[0].childNodes.filter((n) => n.tagName === 'TR');
    assert.ok(vendRows.some((tr) => tr.textContent.includes(postedOut.name) && tr.textContent.includes('-') && tr.textContent.includes('Paid')));
    assert.ok(!vendRows.some((tr) => tr.textContent.includes(postedIn.name)));
  });
});

test('Payment status labels, bank-matched Reconciled display_state, filters, and group-bys behave per Odoo 20', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');

  // Draft, Canceled, Paid (unreconciled), Reconciled (matched with statement line), and Reversed payments
  const d = create(db, 'account.payment', { partner_id: partner.id, partner_type: 'customer', payment_type: 'inbound', amount: 10, date: '2026-03-01', company_id: 1 });
  db = d.db;
  const c = create(db, 'account.payment', { partner_id: partner.id, partner_type: 'customer', payment_type: 'inbound', amount: 20, date: '2026-03-02', company_id: 1 });
  db = write(c.db, 'account.payment', c.id, { state: 'cancel' });
  const p = create(db, 'account.payment', { partner_id: partner.id, partner_type: 'customer', payment_type: 'inbound', amount: 30, date: '2026-03-03', journal_id: bankJournal.id, company_id: 1 });
  db = postPayment(p.db, read(p.db, 'account.payment', p.id));
  const m = create(db, 'account.payment', { partner_id: partner.id, partner_type: 'customer', payment_type: 'inbound', amount: 40, date: '2026-03-04', journal_id: bankJournal.id, company_id: 1 });
  db = postPayment(m.db, read(m.db, 'account.payment', m.id));
  const rev = create(db, 'account.payment', { partner_id: partner.id, partner_type: 'supplier', payment_type: 'outbound', amount: 50, date: '2026-03-05', journal_id: bankJournal.id, company_id: 1 });
  db = postPayment(rev.db, read(rev.db, 'account.payment', rev.id));
  db = reversePayment(db, read(db, 'account.payment', rev.id));

  const stmtLine = create(db, 'account.bank.statement.line', {
    journal_id: bankJournal.id, date: '2026-03-04', payment_ref: 'Match M', partner_id: partner.id, amount: 40, payment_id: m.id, company_id: 1,
  });
  const matchBtn = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment');
  db = matchBtn.run(stmtLine.db, read(stmtLine.db, 'account.bank.statement.line', stmtLine.id)).db;

  // Stored states remain unchanged; presentation labels match Odoo 20.
  assert.equal(read(db, 'account.payment', d.id).state, 'draft');
  assert.equal(read(db, 'account.payment', c.id).state, 'cancel');
  assert.equal(read(db, 'account.payment', p.id).state, 'posted');
  assert.equal(read(db, 'account.payment', m.id).state, 'posted');
  assert.equal(read(db, 'account.payment', rev.id).state, 'reversed');

  assert.equal(read(db, 'account.payment', d.id).display_state, 'draft');
  assert.equal(read(db, 'account.payment', c.id).display_state, 'cancel');
  assert.equal(read(db, 'account.payment', p.id).display_state, 'posted');
  assert.equal(read(db, 'account.payment', m.id).display_state, 'reconciled');
  assert.equal(read(db, 'account.payment', rev.id).display_state, 'reversed');

  const opts = Object.fromEntries(models['account.payment'].fields.display_state.options);
  assert.deepEqual(opts, {
    draft: 'Draft',
    posted: 'Paid',
    reconciled: 'Reconciled',
    cancel: 'Canceled',
    reversed: 'Reversed',
  });

  // Search filters: Outstanding = posted and not reconciled
  const all = search(db, 'account.payment').filter((r) => [d.id, c.id, p.id, m.id, rev.id].includes(r.id));
  assert.deepEqual(applyFilters('account.payment', all, ['outstanding'], db).map((r) => r.id), [p.id]);
  assert.deepEqual(applyFilters('account.payment', all, ['draft'], db).map((r) => r.id), [d.id]);
  assert.deepEqual(applyFilters('account.payment', all, ['paid'], db).map((r) => r.id), [p.id, m.id]);
  assert.deepEqual(applyFilters('account.payment', all, ['customer'], db).map((r) => r.id), [d.id, c.id, p.id, m.id]);
  assert.deepEqual(applyFilters('account.payment', all, ['supplier'], db).map((r) => r.id), [rev.id]);

  // Unreconciling returns display_state back to 'posted' (Paid)
  const afterUnrec = unreconcile(db, read(db, 'account.bank.statement.line', stmtLine.id)).db;
  assert.equal(read(afterUnrec, 'account.payment', m.id).display_state, 'posted');

  // Group bys: Partner, Journal, Status, Payment Date, Currency, Company
  assert.deepEqual(models['account.payment'].groupBys, ['partner_id', 'journal_id', 'display_state', 'date', 'currency_id', 'company_id']);
  const byStatus = groupRecords(db, 'account.payment', all, 'display_state');
  assert.equal(byStatus.find((g) => g.key === 'reconciled').records.length, 1);
  assert.equal(byStatus.find((g) => g.key === 'posted').records.length, 1);
  assert.equal(byStatus.find((g) => g.key === 'cancel').label, 'Canceled');
});

test('Payment form renders Odoo 20 groups, radio Payment Type, direction-aware bank labels, editable Memo when posted, and smart buttons', async () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice', partner_id: partner.id, invoice_date: '2026-04-01', company_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);
  db = payMove(db, inv1.id, 50, '2026-04-02');
  const custPostedId = db.records['account.payment'].at(-1).id;

  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice', partner_id: partner.id, invoice_date: '2026-04-03', company_id: 1,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 40, tax: 0 }],
  });
  db = postMove(bill1.db, bill1.id);
  db = payMove(db, bill1.id, 40, '2026-04-04');
  const vendPostedId = db.records['account.payment'].at(-1).id;

  // Also a draft customer outbound (refund) payment without invoice_id/unapplied
  const draftOut = create(db, 'account.payment', {
    partner_id: partner.id, partner_type: 'customer', payment_type: 'outbound', amount: 15, date: '2026-04-05', company_id: 1,
  });
  db = draftOut.db;

  const custLeaf = leafFor('Customers', 'payments');
  const vendLeaf = leafFor('Vendors', 'vendor-payments');

  await withUi(db, async ({ React, host, commit, renderForm, parseRel }) => {
    const statusSteps = () => allFind(host, (n) => hasClass(n, 'statusbar'))[0]?.childNodes.map((li) => li.textContent.trim());
    const activeStatus = () => allFind(host, (n) => hasClass(n, 'statusbar'))[0]?.childNodes
      .find((li) => props(li.childNodes[0])?.['aria-current'] === 'step')?.textContent.trim();

    // 1. Draft outbound customer payment: radio Send/Receive, Customer, Customer Bank Account, no extra group for invoice_id/unapplied
    await renderForm(custLeaf, draftOut.id);
    assert.deepEqual(statusSteps(), ['Draft', 'Paid']);
    assert.equal(activeStatus(), 'Draft');
    const titleDraft = allFind(host, (n) => n.tagName === 'H2')[0]?.textContent;
    assert.equal(titleDraft, 'Draft');
    const radios = allFind(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'radio');
    assert.equal(radios.length, 2);
    assert.equal(radios.some((r) => props(r).value === 'outbound' && props(r).checked), true);
    const draftGroups = allFind(host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    // Draft payments also offer the invoice to settle (Qodo: new payments must be able to target one invoice).
    assert.equal(draftGroups.length, 3);
    assert.deepEqual(fieldLabelsOf(draftGroups[0]), ['Payment Type', 'Customer', 'Amount', 'Date', 'Memo']);
    assert.deepEqual(fieldLabelsOf(draftGroups[1]), ['Journal', 'Customer Bank Account']);
    assert.deepEqual(fieldLabelsOf(draftGroups[2]), ['Invoice']);
    const radioGroup = allFind(host, (n) => props(n)?.role === 'radiogroup')[0];
    assert.equal(props(radioGroup)['aria-label'], 'Payment Type');
    const headerButtons = () => allFind(host, (n) => hasClass(n, 'form-header'))[0]?.childNodes[0]?.childNodes
      .filter((b) => b.tagName === 'BUTTON')
      .map((b) => b.textContent.trim());
    const draftHeaderBtns = headerButtons();
    assert.deepEqual(draftHeaderBtns, ['Confirm', 'Cancel']);

    // 2. Posted inbound customer payment: Company Bank Account, invoice_id visible, Memo stays editable while other fields are locked, smart buttons (1 Invoices + Journal Entry)
    await renderForm(custLeaf, custPostedId);
    assert.deepEqual(statusSteps(), ['Draft', 'Paid']);
    assert.equal(activeStatus(), 'Paid');
    const custPosted = read(db, 'account.payment', custPostedId);
    assert.equal(allFind(host, (n) => n.tagName === 'H2')[0]?.textContent, custPosted.name);
    const custGroups = allFind(host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    assert.equal(custGroups.length, 3);
    assert.deepEqual(fieldLabelsOf(custGroups[0]), ['Payment Type', 'Customer', 'Amount', 'Date', 'Memo']);
    assert.deepEqual(fieldLabelsOf(custGroups[1]), ['Journal', 'Company Bank Account']);
    assert.deepEqual(fieldLabelsOf(custGroups[2]), ['Invoice']);
    // Only Memo renders an editable <input>; Amount and other group fields render readonly text
    const memoInput = allFind(host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-memo');
    assert.equal(memoInput.length, 1);
    assert.equal(allFind(host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-amount').length, 0);
    // Smart buttons: 1 Invoices and Journal Entry (header buttons do NOT include Journal Entry)
    const custSmart = allFind(host, (n) => n.tagName === 'A' && hasClass(n, 'smart'));
    assert.equal(custSmart.length, 2);
    assert.equal(custSmart[0].textContent, '1Invoices');
    assert.equal(props(custSmart[0]).href, `#/accounting/invoices?view=list&rel=payment_id:${custPostedId}`);
    assert.equal(custSmart[1].textContent, 'Journal Entry');
    assert.equal(props(custSmart[1]).href, `#/accounting/entries/${custPosted.move_id}`);
    assert.deepEqual(headerButtons(), ['Reverse']);
    // Target filtering resolves exactly the settled invoice
    const relInv = parseRel(db, 'account.move', `payment_id:${custPostedId}`);
    const settledInvs = actionRecords(db, leafFor('Customers', 'invoices'), relInv);
    assert.deepEqual(settledInvs.map((m) => m.id), [inv1.id]);

    // 3. Posted outbound vendor payment: Vendor, Vendor Bank Account, 1 Bills smart button
    await renderForm(vendLeaf, vendPostedId);
    const vendGroups = allFind(host, (n) => n.tagName === 'DIV' && hasClass(n, 'group'));
    assert.deepEqual(fieldLabelsOf(vendGroups[0]), ['Payment Type', 'Vendor', 'Amount', 'Date', 'Memo']);
    assert.deepEqual(fieldLabelsOf(vendGroups[1]), ['Journal', 'Vendor Bank Account']);
    const vendSmart = allFind(host, (n) => n.tagName === 'A' && hasClass(n, 'smart'));
    assert.equal(vendSmart.length, 2);
    const billsSmart = vendSmart.find((a) => a.textContent === '1Bills');
    assert.ok(billsSmart);
    assert.equal(props(billsSmart).href, `#/accounting/bills?view=list&rel=payment_id:${vendPostedId}`);
    const relBill = parseRel(db, 'account.move', `payment_id:${vendPostedId}`);
    const settledBills = actionRecords(db, leafFor('Vendors', 'bills'), relBill);
    assert.deepEqual(settledBills.map((m) => m.id), [bill1.id]);

    // 4. Bank-matched payment shows Reconciled in the statusbar
    const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
    const matchedStmt = create(db, 'account.bank.statement.line', {
      journal_id: bankJournal.id, date: '2026-04-02', payment_ref: 'Match Cust', partner_id: partner.id, amount: 50, payment_id: custPostedId, company_id: 1,
    });
    const matchedDb = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match Payment')
      .run(matchedStmt.db, read(matchedStmt.db, 'account.bank.statement.line', matchedStmt.id)).db;
    await React.act(async () => { await commit(matchedDb); });
    await renderForm(custLeaf, custPostedId);
    assert.deepEqual(statusSteps(), ['Draft', 'Paid', 'Reconciled']);
    assert.equal(activeStatus(), 'Reconciled');
  });
});

test('Arabic translations cover every Odoo 20 payment status, direction, and bank account label', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-pay');
    for (const label of [
      'Paid', 'Canceled', 'Reconciled', 'Reversed',
      'Customer Bank Account', 'Vendor Bank Account', 'Company Bank Account',
      'Outstanding', 'Send', 'Receive', 'Bills', 'Invoices', 'Journal Entry',
    ]) {
      assert.notEqual(t(label), label, `Missing Arabic translation for ${label}`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('payment smart buttons count only documents their destination lists', () => {
  let db = seed();
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-03-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  db = payMove(db, inv.id, 100, '2026-03-02');
  const payment = db.records['account.payment'].at(-1);
  const smart = models['account.payment'].form.smart;
  const invoices = smart.find((s) => typeof s.label === 'function' && s.label(payment) === 'Invoices');
  const notes = smart.find((s) => typeof s.label === 'function' && s.label(payment) === 'Credit Notes');
  assert.equal(invoices.value(db, payment), 1);
  assert.equal(notes.when(payment, db), false);
  // Pretend the settled document were a credit note: it moves to the Credit Notes button.
  const asRefund = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => (m.id === inv.id ? { ...m, move_type: 'out_refund' } : m)) } };
  assert.equal(invoices.when(payment, asRefund), false);
  assert.equal(notes.value(asRefund, payment), 1);
  assert.match(notes.target(payment), /^accounting\/credit-notes\?view=list&rel=payment_id:/);
});

test('a draft payment can target one open invoice in that invoice currency', () => {
  let db = seed();
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-03-01', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  const draft = create(db, 'account.payment', { partner_id: 2, amount: 40, date: '2026-03-02' });
  const rec = read(draft.db, 'account.payment', draft.id);
  assert.ok(models['account.payment'].form.groups(rec).flat().some((f) => f === 'invoice_id'));
  const domain = models['account.payment'].fields.invoice_id.domain;
  assert.equal(domain(read(draft.db, 'account.move', inv.id), rec, draft.db), true);
  assert.equal(domain(read(draft.db, 'account.move', inv.id), { ...rec, payment_type: 'outbound', partner_type: 'supplier' }, draft.db), false);
  const linked = write(draft.db, 'account.payment', draft.id, { invoice_id: inv.id });
  const invoiceCurrency = read(linked, 'account.payment', draft.id).currency_id;
  assert.ok(invoiceCurrency, 'picking the invoice sets the payment currency');
  assert.equal(models['account.payment'].fields.currency_id.readonly(read(linked, 'account.payment', draft.id)), true);
  const other = search(linked, 'res.currency').find((c) => c.id !== invoiceCurrency);
  const forged = { ...linked, records: { ...linked.records, 'account.payment': linked.records['account.payment'].map((p) => (p.id === draft.id ? { ...p, currency_id: other.id } : p)) } };
  assert.throws(() => postPayment(forged, read(forged, 'account.payment', draft.id)), /payment currency must match the invoice currency/);
});

test('posted payment memo is editable only outside a locked period', () => {
  let db = seed();
  const draft = create(db, 'account.payment', { partner_id: 2, amount: 25, date: '2026-01-05' });
  db = postPayment(draft.db, read(draft.db, 'account.payment', draft.id));
  const payment = read(db, 'account.payment', draft.id);
  const unlocked = models['account.payment'].form.unlockedFields;
  assert.deepEqual(unlocked(payment, db), ['memo']);
  const lockedDb = { ...db, records: { ...db.records, 'res.company': db.records['res.company'].map((c) => ({ ...c, lock_date: '2026-01-31' })) } };
  assert.deepEqual(unlocked(payment, lockedDb), []);
});

test('a draft payment cannot target or settle an invoice dated after the payment', () => {
  let db = seed();
  const inv = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 2, invoice_date: '2026-03-10', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  const draft = create(db, 'account.payment', { partner_id: 2, amount: 40, date: '2026-03-02' });
  const rec = read(draft.db, 'account.payment', draft.id);
  const domain = models['account.payment'].fields.invoice_id.domain;
  assert.equal(domain(read(draft.db, 'account.move', inv.id), rec, draft.db), false);
  assert.equal(domain(read(draft.db, 'account.move', inv.id), { ...rec, date: '2026-03-10' }, draft.db), true);
  const linked = write(draft.db, 'account.payment', draft.id, { invoice_id: inv.id });
  assert.throws(() => postPayment(linked, read(linked, 'account.payment', draft.id)), /cannot be before the invoice date/);
});
