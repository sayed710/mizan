import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, isMultiCompany, matches, read, search, write } from './orm.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { seed } from './seed.js';
import { menusFor, models, viewsOf } from './models/index.js';
import { payMove, postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { postBatch } from './models/payments.js';

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

const bankAccountsLeaf = () => findLeafByKey(menusFor('accounting'), 'bank-accounts');

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
      return el;
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
  const render = async (el) => {
    await React.act(async () => root.render(renderElement(React, el)));
  };
  await render();
  return {
    React,
    host,
    commit,
    getDb,
    render,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

test('res.partner.bank opens in list view with Odoo list columns, optional states, toggles, editable list, and muted inactive rows', async () => {
  const def = models['res.partner.bank'];
  assert.deepEqual(viewsOf('res.partner.bank'), ['list']);
  assert.ok(def.form, 'form view remains available');
  assert.equal(def.groupBys, undefined);
  assert.deepEqual(def.list, [
    'sequence',
    'account_number',
    'partner_id',
    'holder_name',
    'bank_name',
    'bank_bic',
    'clearing_number',
    'company_id',
    'allow_out_payment',
    'active',
  ]);
  assert.deepEqual(def.listLabels, { bank_name: 'Bank' });
  assert.deepEqual(def.listFields, {
    partner_id: { optional: 'hide' },
    holder_name: { optional: 'hide' },
    bank_name: { optional: 'hide' },
    bank_bic: { optional: 'show' },
    clearing_number: { optional: 'hide' },
    company_id: { optional: 'hide', multiCompanyOnly: true },
    allow_out_payment: { optional: 'show', widget: 'toggle' },
    active: { optional: 'hide', widget: 'toggle' },
  });
  assert.deepEqual(def.editableList, ['allow_out_payment', 'active']);

  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const activeBank = create(db, 'res.partner.bank', {
    partner_id: partner.id,
    account_number: 'ACC-100',
    bank_bic: 'DEUTDEFF',
    bank_name: 'Deutsche Bank',
  });
  db = activeBank.db;
  const archivedBank = create(db, 'res.partner.bank', {
    partner_id: partner.id,
    account_number: 'ACC-200',
    bank_bic: 'CHASUS33',
    active: false,
  });
  db = archivedBank.db;

  const { visibleListColumns } = await import('./views/List.jsx');
  assert.equal(def.listDecoration(read(db, 'res.partner.bank', activeBank.id)), '');
  assert.equal(def.listDecoration(read(db, 'res.partner.bank', archivedBank.id)), 'muted');
  assert.equal(isMultiCompany(db), false);
  assert.deepEqual(
    visibleListColumns(def, db, {}, { listFields: def.listFields }).cols,
    ['sequence', 'account_number', 'bank_bic', 'allow_out_payment'],
  );

  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(ActionView, {
      leaf: bankAccountsLeaf(),
      base: '#/accounting/bank-accounts',
      params: new URLSearchParams(),
    }),
    db,
  );
  try {
    const table = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'opens in list view by default');
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.trim()).filter((h) => h && h !== '⋯');
    assert.deepEqual(headers, ['Account Number', 'BIC/SWIFT', 'Trust Bank Account']);

    const tbody = find(table, (n) => n.tagName === 'TBODY');
    assert.equal(tbody.textContent.includes('ACC-100'), true);
    assert.equal(tbody.textContent.includes('ACC-200'), false);

    const row = tbody.childNodes[0];
    assert.ok(find(row, (n) => hasClass(n, 'drag-handle')), 'renders sequence drag handle');
    assert.equal(props(row)?.draggable, true);

    const trustSwitch = find(row, (n) => n.tagName === 'INPUT' && props(n)?.role === 'switch');
    assert.ok(trustSwitch, 'Trust Bank Account renders as toggle switch in list');
    assert.equal(props(trustSwitch).checked, false);
    await ctx.React.act(async () => {
      props(trustSwitch).onChange({ target: { checked: true } });
    });
    assert.equal(read(ctx.getDb(), 'res.partner.bank', activeBank.id).allow_out_payment, true);

    // Optional column toggle & Archived filter in SearchPanel
    const colBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'o2m-cols-toggle'));
    assert.ok(colBtn, 'optional column toggle menu exists');
    await ctx.React.act(async () => props(colBtn).onClick());
    const colMenu = find(ctx.host, (n) => hasClass(n, 'o2m-cols-menu'));
    assert.ok(colMenu.textContent.includes('Bank'), 'optional menu uses listLabel "Bank"');
    assert.equal(colMenu.textContent.includes('Company'), false, 'multiCompanyOnly column hidden in single-company');

    const toggleSearch = find(ctx.host, (n) => n.tagName === 'BUTTON' && hasClass(n, 'search-toggle'));
    await ctx.React.act(async () => props(toggleSearch).onClick());
    const archivedBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Archived');
    await ctx.React.act(async () => props(archivedBtn).onClick());

    const rowsAfterArchive = find(ctx.host, (n) => n.tagName === 'TBODY').childNodes;
    assert.ok(rowsAfterArchive.some((r) => hasClass(r, 'muted') && r.textContent.includes('ACC-200')));
  } finally {
    await ctx.done();
  }
});

test('res.partner.bank search matches bank_name, account_number, partner_id, and multi-company company_id', () => {
  const def = models['res.partner.bank'];
  assert.deepEqual(def.searchFields, ['bank_name', 'account_number', 'company_id', 'partner_id']);

  let db = seed();
  const sub = create(db, 'res.company', { name: 'Subsidiary Corp' });
  db = sub.db;
  const partner = create(db, 'res.partner', { name: 'Delta Industrial' });
  db = partner.db;
  const created = create(db, 'res.partner.bank', {
    partner_id: partner.id,
    account_number: 'US-9988-7766',
    bank_name: 'Bank of America',
    company_id: sub.id,
  });
  db = created.db;
  const rec = read(db, 'res.partner.bank', created.id);

  assert.equal(matches(db, 'res.partner.bank', rec, ['Bank of America'], def.searchFields), true);
  assert.equal(matches(db, 'res.partner.bank', rec, ['9988'], def.searchFields), true);
  assert.equal(matches(db, 'res.partner.bank', rec, ['Delta'], def.searchFields), true);
  assert.equal(matches(db, 'res.partner.bank', rec, ['Subsidiary'], def.searchFields), true);
  assert.equal(matches(db, 'res.partner.bank', rec, ['Unrelated'], def.searchFields), false);
});

test('res.partner.bank form renders Odoo groups, no duplicate title field, multi-company Company, Note tab, and Bank Information tab', async () => {
  const def = models['res.partner.bank'];
  assert.equal(def.form.hideTitle, true);
  assert.equal(def.form.chatter, true);
  assert.deepEqual(def.form.groups, [
    ['account_number', 'clearing_number', 'bank_bic', 'partner_id', 'holder_name'],
    ['allow_out_payment', 'company_id'],
  ]);

  let db = seed();
  const partner = search(db, 'res.partner')[0];
  const singleBank = create(db, 'res.partner.bank', {
    partner_id: partner.id,
    account_number: 'FORM-ACC-1',
    active: false,
  });
  db = singleBank.db;

  const { FormView } = await import('./views/FormView.jsx');
  const singleCtx = await mountView(
    (React) => React.createElement(FormView, {
      leaf: bankAccountsLeaf(),
      id: singleBank.id,
      base: '#/accounting/bank-accounts',
      params: new URLSearchParams(),
    }),
    db,
  );
  try {
    const labelText = (f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim();
    const visibleLabels = allFind(singleCtx.host, (n) => hasClass(n, 'field')).map(labelText);
    assert.deepEqual(visibleLabels, [
      'Account Number',
      'Clearing Number',
      'BIC/SWIFT',
      'Partner',
      'Holder Name',
      'Trust Bank Account',
    ]);
    assert.equal(visibleLabels.filter((l) => l === 'Account Number').length, 1, 'Account Number appears only once');
    assert.equal(visibleLabels.includes('Sanitized Account Number'), false);
    assert.equal(visibleLabels.includes('Legacy Account Numbers'), false);

    const ribbon = find(singleCtx.host, (n) => hasClass(n, 'ribbon'));
    assert.ok(ribbon && ribbon.textContent.includes('Archived'), 'archived record shows generic Archived ribbon');
    assert.ok(find(singleCtx.host, (n) => hasClass(n, 'chatter')), 'chatter is preserved');

    // Note tab: textarea without field label and with "Internal notes..." placeholder
    const noteArea = find(singleCtx.host, (n) => n.tagName === 'TEXTAREA' && props(n)?.id === 'f-note');
    assert.ok(noteArea, 'Note tab renders note textarea by default');
    assert.equal(props(noteArea).placeholder, 'Internal notes...');
    assert.equal(visibleLabels.includes('Notes'), false, 'Note tab renders note without field label');

    // Switch to Bank Information tab
    const infoTabBtn = find(singleCtx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Bank Information');
    assert.ok(infoTabBtn, 'Bank Information tab exists');
    await singleCtx.React.act(async () => props(infoTabBtn).onClick());

    const bankNameInput = find(singleCtx.host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-bank_name');
    assert.equal(props(bankNameInput).placeholder, 'e.g. Bank of America');
    const infoText = singleCtx.host.textContent;
    assert.ok(infoText.includes('Bank Address'), 'Bank Information tab shows Bank Address section');
    const infoLabels = allFind(singleCtx.host, (n) => hasClass(n, 'field')).map(labelText);
    for (const expected of ['Bank Name', 'Street', 'Street 2', 'City', 'State', 'ZIP', 'Country']) {
      assert.ok(infoLabels.includes(expected), `Bank Information tab renders ${expected}`);
    }
  } finally {
    await singleCtx.done();
  }

  // Multi-company reveals Company field with "Visible to all" placeholder
  const multiDb = create(db, 'res.company', { name: 'Branch Co' }).db;
  const multiCtx = await mountView(
    (React) => React.createElement(FormView, {
      leaf: bankAccountsLeaf(),
      id: singleBank.id,
      base: '#/accounting/bank-accounts',
      params: new URLSearchParams(),
    }),
    multiDb,
  );
  try {
    const multiLabels = allFind(multiCtx.host, (n) => hasClass(n, 'field'))
      .map((f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim());
    assert.ok(multiLabels.includes('Company'));
    const companySelect = find(multiCtx.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id');
    assert.ok(companySelect);
    assert.equal(companySelect.childNodes[0].textContent, 'Visible to all');
  } finally {
    await multiCtx.done();
  }
});

test('new bank accounts default to untrusted and outbound payments are refused until trusted', () => {
  assert.deepEqual(models['res.partner'].fields.bank_ids.newLine(), {
    account_number: '',
    bank_name: '',
    bank_bic: '',
    allow_out_payment: false,
  });

  let db = seed();
  const vendor = create(db, 'res.partner', { name: 'Vendor Unverified', supplier_rank: 1 });
  db = vendor.db;
  const bank = create(db, 'res.partner.bank', {
    partner_id: vendor.id,
    account_number: 'UNTRUSTED-01',
    bank_bic: 'BNPAFRPPXXX',
  });
  db = bank.db;
  assert.equal(read(db, 'res.partner.bank', bank.id).allow_out_payment, false);

  const account = search(db, 'account.account').find((a) => a.account_type === 'expense');
  const bill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: vendor.id,
    partner_bank_id: bank.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [{ product_id: 1, name: 'Consulting', account_id: account.id, qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(bill.db, bill.id);

  assert.throws(() => payMove(db, bill.id, 200), /outbound payments/i);

  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank');
  const payment = create(db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: vendor.id,
    partner_bank_id: bank.id,
    amount: 200,
    journal_id: bankJournal.id,
  });
  db = payment.db;
  assert.throws(() => postPayment(db, read(db, 'account.payment', payment.id)), /outbound payments/i);

  const batch = create(db, 'account.batch.payment', {
    batch_type: 'outbound',
    check_number_start: 100,
    journal_id: bankJournal.id,
    lines: [{ move_id: bill.id, amount: 200 }],
  });
  assert.throws(() => postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id)), /outbound payments/i);

  // Trusting the bank account unblocks postPayment, payMove, and postBatch
  const trustedDb = write(batch.db, 'res.partner.bank', bank.id, { allow_out_payment: true });
  const postedPaymentDb = postPayment(trustedDb, read(trustedDb, 'account.payment', payment.id));
  assert.equal(read(postedPaymentDb, 'account.payment', payment.id).state, 'posted');

  const paidDb = payMove(trustedDb, bill.id, 200);
  assert.equal(read(paidDb, 'account.move', bill.id).payment_state, 'paid');

  const postedBatchDb = postBatch(trustedDb, read(trustedDb, 'account.batch.payment', batch.id));
  assert.equal(read(postedBatchDb, 'account.batch.payment', batch.id).state, 'posted');
});

test('bank_bic validation allows empty or 8/11 alphanumeric characters and rejects invalid values', () => {
  let db = seed();
  const partner = search(db, 'res.partner')[0];

  // Empty / whitespace allowed
  const bEmpty = create(db, 'res.partner.bank', { partner_id: partner.id, account_number: 'BIC-EMPTY', bank_bic: '' });
  db = bEmpty.db;

  // 8-char and 11-char alphanumeric allowed
  const b8 = create(db, 'res.partner.bank', { partner_id: partner.id, account_number: 'BIC-8', bank_bic: 'DEUTDEFF' });
  db = b8.db;
  const b11 = create(db, 'res.partner.bank', { partner_id: partner.id, account_number: 'BIC-11', bank_bic: 'DEUTDEFF500' });
  db = b11.db;

  // Invalid length or symbols rejected on create and write
  assert.throws(() => create(db, 'res.partner.bank', { partner_id: partner.id, account_number: 'BIC-BAD1', bank_bic: 'SHORT' }), /8 or 11 alphanumeric/i);
  assert.throws(() => create(db, 'res.partner.bank', { partner_id: partner.id, account_number: 'BIC-BAD2', bank_bic: 'DEUT-EFF' }), /8 or 11 alphanumeric/i);
  assert.throws(() => write(db, 'res.partner.bank', b8.id, { bank_bic: '1234567890' }), /8 or 11 alphanumeric/i);
});

test('migration keeps existing stored bank accounts allow_out_payment values unchanged', () => {
  const base = seed();
  const partner = search(base, 'res.partner')[0];
  const bTrue = create(base, 'res.partner.bank', { partner_id: partner.id, account_number: 'OLD-TRUE', allow_out_payment: true });
  const bFalse = create(bTrue.db, 'res.partner.bank', { partner_id: partner.id, account_number: 'OLD-FALSE', allow_out_payment: false });

  const migrated = migrate({ ...bFalse.db, schema_version: SCHEMA_VERSION });
  assert.equal(read(migrated, 'res.partner.bank', bTrue.id).allow_out_payment, true);
  assert.equal(read(migrated, 'res.partner.bank', bFalse.id).allow_out_payment, false);
});

test('Arabic translations exist for all res.partner.bank labels, helps, placeholders, tabs, and validation messages', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import('./i18n.js?bank-ar-test');
    const def = models['res.partner.bank'];
    const strings = [
      def.label,
      def.listLabels.bank_name,
      ...Object.values(def.fields).flatMap((f) => [f.label, f.help, f.placeholder].filter(Boolean)),
      ...def.form.tabs.map((tab) => tab.label),
      'Bank Address',
      'BIC/SWIFT must be 8 or 11 alphanumeric characters',
    ];
    for (const s of strings) {
      if (s === 'BIC/SWIFT') {
        assert.equal(t(s), 'BIC/SWIFT');
      } else {
        assert.notEqual(t(s), s, `missing Arabic translation for: ${s}`);
      }
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});
