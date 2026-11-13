import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { migrate } from './migrations.js';
import { accountBalance, journalItems, postEntry } from './models/ledger.js';
import { postMove } from './models/accounting.js';

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
const fieldLabelsOf = (container) => allFind(container, (n) => hasClass(n, 'field'))
  .map((f) => f.childNodes[0]?.textContent?.replaceAll('*', '').trim());

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

const accountsLeaf = () => findLeafByKey(menusFor('accounting'), 'accounts');

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

test('Chart of Accounts list shows Odoo 20 columns in order, renders reconcile checkbox, and sorts by code', async () => {
  const leaf = accountsLeaf();
  let db = create(seed(), 'account.account', { code: '000999', name: 'Early Code Account', account_type: 'asset_current', reconcile: false }).db;
  db = create(db, 'account.account', { code: '999999', name: 'Late Code Account', account_type: 'expense', reconcile: false }).db;
  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/accounts', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    const table = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    assert.ok(table, 'renders Chart of Accounts table');
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.trim()).filter(Boolean);
    assert.deepEqual(headers, ['Code', 'Account Name', 'Type', 'Allow Reconciliation']);

    const tbody = allFind(table, (n) => n.tagName === 'TBODY')[0];
    const firstRow = tbody.childNodes[0];
    const codes = tbody.childNodes.map((tr) => tr.childNodes[1]?.textContent?.trim()).filter(Boolean);
    assert.equal(codes[0], '000999', 'sorted ascending by code');
    assert.deepEqual(codes, [...codes].sort((a, b) => a.localeCompare(b)), 'rows stay sorted by code');

    const reconcileCheckbox = find(firstRow, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox' && props(n)?.['aria-label'] === 'Allow Reconciliation');
    assert.ok(reconcileCheckbox, 'Allow Reconciliation renders as a checkbox in the list');
    assert.equal(props(reconcileCheckbox).checked, false);
    await ctx.React.act(async () => {
      props(reconcileCheckbox).onChange({ target: { checked: true } });
    });
    const earlyAcc = search(ctx.getDb(), 'account.account').find((a) => a.code === '000999');
    assert.equal(earlyAcc.reconcile, true, 'toggling reconcile checkbox in list saves the change');
  } finally {
    await ctx.done();
  }
});

test('account.account form renders Balance header, code+name title, and Accounting tab fields in exact Odoo 20 order', async () => {
  const leaf = accountsLeaf();
  let db = seed();
  const revAcc = search(db, 'account.account').find((a) => a.code === '400000');
  const cashAcc = search(db, 'account.account').find((a) => a.code === '101401');
  const vatSale = search(db, 'account.tax').find((x) => x.name === 'VAT 14%' && x.type_tax_use === 'sale');
  db = write(db, 'account.account', revAcc.id, { tax_ids: [vatSale.id], description: 'Primary product sales account' });
  // Post one entry and create one draft entry so Balance sums posted items only.
  db = postEntry(db, {
    journal: 'MISC',
    date: '2026-02-01',
    ref: 'Posted balance entry',
    lines: [
      { account_id: cashAcc.id, debit: 250, credit: 0 },
      { account_id: revAcc.id, debit: 0, credit: 250 },
    ],
  }).db;
  db = create(db, 'account.move', {
    move_type: 'entry',
    state: 'draft',
    date: '2026-02-02',
    ref: 'Draft excluded',
    line_ids: [
      { account_id: cashAcc.id, debit: 999, credit: 0 },
      { account_id: revAcc.id, debit: 0, credit: 999 },
    ],
  }).db;

  const expectedPostedSum = journalItems(db, { company_id: 1 })
    .filter((l) => l.account_id === revAcc.id)
    .reduce((s, l) => s + (l.debit || 0) - (l.credit || 0), 0);
  assert.equal(accountBalance(db, read(db, 'account.account', revAcc.id)), expectedPostedSum);

  const { FormView } = await import('./views/FormView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(FormView, { leaf, id: revAcc.id, base: '#/accounting/accounts', params: new URLSearchParams('view=form') }),
    db,
  );
  try {
    const titleBox = find(ctx.host, (n) => hasClass(n, 'title-field'));
    const titleInputs = allFind(titleBox, (n) => n.tagName === 'INPUT').map((n) => props(n)?.value);
    assert.deepEqual(titleInputs, [revAcc.code, revAcc.name], 'code and name stay editable in the title');

    const balanceBtn = allFind(ctx.host, (n) => hasClass(n, 'smart')).find((n) => n.textContent.includes('Balance'));
    assert.ok(balanceBtn, 'Balance smart button renders in form header');
    const balValue = find(balanceBtn, (n) => n.tagName === 'B')?.textContent ?? '';
    assert.ok(balValue.includes(Math.abs(expectedPostedSum).toLocaleString('en-US', { minimumFractionDigits: 2 })), `Balance shows posted sum (${balValue})`);
    assert.ok(!balValue.includes('999'), 'draft entries excluded from Balance');
    assert.equal(models['account.account'].fields.current_balance.readonly, true);

    const tabs = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab').map((b) => b.textContent.trim());
    assert.deepEqual(tabs, ['Accounting']);

    const panel = find(ctx.host, (n) => hasClass(n, 'tab-panel'));
    assert.deepEqual(fieldLabelsOf(panel), [
      'Type',
      'Default Taxes',
      'Fiscal Category',
      'Tags',
      'Allow Reconciliation',
      'Active',
      'Depreciation Model',
      'Description',
    ]);
  } finally {
    await ctx.done();
  }
});

test('archived accounts are hidden by default, shown with archived filter, and rejected on new journal items and invoice lines', async () => {
  const leaf = accountsLeaf();
  let db = seed();
  const expense = search(db, 'account.account').find((a) => a.code === '600000');
  const cash = search(db, 'account.account').find((a) => a.code === '101401');
  const archived = create(db, 'account.account', { code: '699900', name: 'Archived Expense', account_type: 'expense', active: false, company_id: 1 });
  db = archived.db;

  // Stored accounts from before the Active field read as active after migration 38.
  const legacy = { ...db, schema_version: 37, records: { ...db.records, 'account.account': db.records['account.account'].map(({ active: _drop, ...a }) => (a.id === archived.id ? { ...a, active: false } : a)) } };
  const migrated = migrate(legacy);
  assert.equal(read(migrated, 'account.account', expense.id).active, true);
  assert.equal(migrated.records['account.account'].find((a) => a.id === archived.id).active, false);

  // List hides archived by default, reveals with Archived filter toggle.
  const { ActionView } = await import('./views/ActionView.jsx');
  const ctx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/accounts', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    assert.ok(!ctx.host.textContent.includes('699900'), 'archived account hidden from list by default');
    const togglePanelBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    assert.ok(togglePanelBtn);
    await ctx.React.act(async () => {
      props(togglePanelBtn).onClick();
    });
    const archivedBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Archived');
    assert.ok(archivedBtn);
    await ctx.React.act(async () => {
      props(archivedBtn).onClick();
    });
    assert.ok(ctx.host.textContent.includes('699900'), 'archived account visible when Archived filter is toggled on');
  } finally {
    await ctx.done();
  }

  // Creating/adding journal items or invoice lines with an archived account is rejected.
  assert.throws(() => create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    date: '2026-03-01',
    line_ids: [
      { account_id: archived.id, debit: 50, credit: 0 },
      { account_id: cash.id, debit: 0, credit: 50 },
    ],
  }), /Archived accounts cannot be selected/);

  assert.throws(() => postEntry(db, {
    journal: 'MISC',
    company: 1,
    date: '2026-03-01',
    lines: [
      { account_id: archived.id, debit: 50, credit: 0 },
      { account_id: cash.id, debit: 0, credit: 50 },
    ],
  }), /Archived accounts cannot be selected/);

  assert.throws(() => create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    invoice_line_ids: [{ name: 'Line', account_id: archived.id, qty: 1, price_unit: 100 }],
  }), /Archived accounts cannot be selected/);

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    invoice_line_ids: [{ name: 'Active line', account_id: expense.id, qty: 1, price_unit: 100 }],
  });
  assert.throws(() => write(inv.db, 'account.move', inv.id, {
    invoice_line_ids: [...read(inv.db, 'account.move', inv.id).invoice_line_ids, { name: 'Bad', account_id: archived.id, qty: 1, price_unit: 10 }],
  }), /Archived accounts cannot be selected/);

  // Existing line referencing an account that was later archived does not block unrelated edits.
  const laterArchivedDb = write(inv.db, 'account.account', expense.id, { active: false });
  assert.doesNotThrow(() => write(laterArchivedDb, 'account.move', inv.id, { ref: 'Unrelated ref update' }));

  // Verify account.account field candidates exclude archived accounts on invoice lines.
  const inv2 = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, company_id: 1, invoice_line_ids: [{ name: 'Row', qty: 1, price_unit: 10 }] });
  const { FormView } = await import('./views/FormView.jsx');
  const invLeaf = findLeafByKey(menusFor('accounting'), 'invoices');
  const formCtx = await mountView(
    (React) => React.createElement(FormView, { leaf: invLeaf, id: inv2.id, base: '#/accounting/invoices', params: new URLSearchParams('view=form') }),
    inv2.db,
  );
  try {
    const colBtn = find(formCtx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Optional columns');
    await formCtx.React.act(async () => { props(colBtn).onClick(); });
    const accColToggle = find(formCtx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox' && n.textContent.includes('Account'));
    await formCtx.React.act(async () => { props(accColToggle).onClick(); });
    const accSelect = find(formCtx.host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Account 1');
    assert.ok(accSelect, 'Account select visible in invoice lines');
    const optionValues = accSelect.options.map((o) => Number(props(o)?.value)).filter(Boolean);
    assert.ok(!optionValues.includes(archived.id), 'archived account not offered in invoice line account selector');
    assert.ok(optionValues.includes(expense.id), 'active account is offered');
  } finally {
    await formCtx.done();
  }
});

test('account Default Taxes apply by document side and fiscal position without a product, preserve product taxes and manual taxes, and validate company ownership', () => {
  let db = seed();
  const saleTax = search(db, 'account.tax').find((x) => x.name === 'VAT 14%' && x.type_tax_use === 'sale');
  const purchTax = search(db, 'account.tax').find((x) => x.name === 'VAT 14%' && x.type_tax_use === 'purchase');
  const exportSaleTax = search(db, 'account.tax').find((x) => x.name === '0% Exports');
  const exportPurchTax = search(db, 'account.tax').find((x) => x.name === '0% Imports');
  const manualSaleTax = create(db, 'account.tax', { name: 'Manual Sale 5%', type_tax_use: 'sale', amount: 5, company_id: 1 });
  db = manualSaleTax.db;
  const prodSaleTax = create(db, 'account.tax', { name: 'Product Sale 8%', type_tax_use: 'sale', amount: 8, company_id: 1 });
  db = prodSaleTax.db;
  const exportFp = search(db, 'account.fiscal.position').find((fp) => fp.name === 'Export');

  const mixedAcc = create(db, 'account.account', {
    code: '490100',
    name: 'Mixed Default Tax Account',
    account_type: 'income',
    company_id: 1,
    tax_ids: [saleTax.id, purchTax.id],
  });
  db = mixedAcc.db;

  const product = create(db, 'product', {
    name: 'Taxed Product',
    type: 'service',
    list_price: 200,
    tax_id: prodSaleTax.id,
  });
  db = product.db;

  const lineOnchange = models['account.move'].fields.invoice_line_ids.onchange;

  // Customer invoice without product -> picks sale tax only.
  const custLine = lineOnchange({ name: 'No product', qty: 1, price_unit: 100, account_id: mixedAcc.id }, 'account_id', db, {
    move_type: 'out_invoice',
    company_id: 1,
  });
  assert.equal(custLine.tax_id, saleTax.id);
  assert.equal(custLine.tax, 14);

  // Mapped through Export fiscal position -> maps sale tax to 0% Exports.
  const custFpLine = lineOnchange({ name: 'Export service', qty: 1, price_unit: 100, account_id: mixedAcc.id }, 'account_id', db, {
    move_type: 'out_invoice',
    company_id: 1,
    fiscal_position_id: exportFp.id,
  });
  assert.equal(custFpLine.tax_id, exportSaleTax.id);
  assert.equal(custFpLine.tax, 0);

  // Vendor bill without product -> picks purchase tax only, and maps with FP to 0% Imports.
  const billLine = lineOnchange({ name: 'Vendor expense', qty: 1, price_unit: 100, account_id: mixedAcc.id }, 'account_id', db, {
    move_type: 'in_invoice',
    company_id: 1,
  });
  assert.equal(billLine.tax_id, purchTax.id);
  const billFpLine = lineOnchange({ name: 'Import bill', qty: 1, price_unit: 100, account_id: mixedAcc.id }, 'account_id', db, {
    move_type: 'in_invoice',
    company_id: 1,
    fiscal_position_id: exportFp.id,
  });
  assert.equal(billFpLine.tax_id, exportPurchTax.id);

  // Line WITH product keeps product tax even after changing account.
  const withProd = lineOnchange({ product_id: product.id, qty: 1 }, 'product_id', db, { move_type: 'out_invoice', company_id: 1 });
  assert.equal(withProd.tax_id, prodSaleTax.id);
  const afterAccOnProd = lineOnchange({ ...withProd, account_id: mixedAcc.id }, 'account_id', db, { move_type: 'out_invoice', company_id: 1 });
  assert.equal(afterAccOnProd.tax_id, prodSaleTax.id);

  // Hand-picked tax afterwards is kept.
  const handPicked = lineOnchange({ ...custLine, tax_id: manualSaleTax.id }, 'tax_id', db, { move_type: 'out_invoice', company_id: 1 });
  assert.equal(handPicked.tax_id, manualSaleTax.id);
  assert.equal(handPicked.tax, 5);
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    company_id: 1,
    invoice_date: '2026-03-10',
    invoice_line_ids: [handPicked],
  });
  const postedInv = postMove(draftInv.db, draftInv.id);
  assert.equal(read(postedInv, 'account.move', draftInv.id).invoice_line_ids[0].tax_id, manualSaleTax.id);

  // Cross-company default tax rejected; same-company and shared accepted.
  const company2 = create(db, 'res.company', { name: 'Co2' });
  const co2Tax = create(company2.db, 'account.tax', { name: 'Co2 VAT', type_tax_use: 'sale', amount: 15, company_id: company2.id });
  assert.throws(() => write(co2Tax.db, 'account.account', mixedAcc.id, { tax_ids: [co2Tax.id] }), /Tax belongs to another company/);
  assert.throws(() => create(co2Tax.db, 'account.account', { code: '490101', name: 'Bad Cross Tax', account_type: 'income', company_id: 1, tax_ids: [co2Tax.id] }), /Tax belongs to another company/);
  assert.doesNotThrow(() => write(co2Tax.db, 'account.account', mixedAcc.id, { tax_ids: [saleTax.id, manualSaleTax.id] }));
});

test('Arabic translations cover new Chart of Accounts labels and errors', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-coa');
    for (const label of [
      'Code',
      'Account Name',
      'Type',
      'Allow Reconciliation',
      'Balance',
      'Accounting',
      'Default Taxes',
      'Fiscal Category',
      'Tags',
      'Active',
      'Depreciation Model',
      'Description',
      'Select an existing default tax',
      'Tax belongs to another company',
      'Archived accounts cannot be selected on journal items or invoice lines',
    ]) {
      assert.notEqual(t(label), label, `missing Arabic translation for "${label}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('shared chart accounts take company or shared default taxes, and the picker offers them', () => {
  let db = seed();
  const shared = search(db, 'account.account').find((a) => !a.company_id && a.account_type === 'income');
  assert.ok(shared, 'seeded chart has a shared income account');
  const saleTax = search(db, 'account.tax').find((x) => x.name === 'VAT 14%' && x.type_tax_use === 'sale');
  db = write(db, 'account.account', shared.id, { tax_ids: [saleTax.id] });
  assert.deepEqual(read(db, 'account.account', shared.id).tax_ids, [saleTax.id]);
  const domain = models['account.account'].fields.tax_ids.domain;
  assert.equal(domain(saleTax, read(db, 'account.account', shared.id)), true);
  const neutral = create(db, 'account.tax', { name: 'Neutral 3%', type_tax_use: 'sale', amount: 3 });
  const company = create(neutral.db, 'account.account', { code: '490200', name: 'Company Income', account_type: 'income', company_id: 1 });
  assert.equal(domain(read(company.db, 'account.tax', neutral.id), read(company.db, 'account.account', company.id)), true);
  const co2 = create(company.db, 'res.company', { name: 'Co2' });
  const co2Tax = create(co2.db, 'account.tax', { name: 'Co2 VAT', type_tax_use: 'sale', amount: 15, company_id: co2.id });
  assert.equal(domain(read(co2Tax.db, 'account.tax', co2Tax.id), read(co2Tax.db, 'account.account', company.id)), false);
  // On an invoice of company 1, a shared account carrying a company-2 tax applies only company 1's tax.
  db = write(co2Tax.db, 'account.account', shared.id, { tax_ids: [co2Tax.id, saleTax.id] });
  const line = models['account.move'].fields.invoice_line_ids.onchange({ name: 'x', qty: 1, price_unit: 10, account_id: shared.id }, 'account_id', db, { move_type: 'out_invoice', company_id: 1 });
  assert.equal(line.tax_id, saleTax.id);
});

test('picking an account without a default tax keeps the line tax', () => {
  let db = seed();
  const plain = create(db, 'account.account', { code: '490300', name: 'No Default Tax', account_type: 'income', company_id: 1 });
  db = plain.db;
  const onchange = models['account.move'].fields.invoice_line_ids.onchange;
  const move = { move_type: 'in_invoice', company_id: 1 };
  const line = { name: 'Digitized', qty: 1, price_unit: 100, tax: 7, tax_id: null };
  const after = onchange({ ...line, account_id: plain.id }, 'account_id', db, move);
  assert.equal(after.tax, 7);
  const purchTax = search(db, 'account.tax').find((x) => x.name === 'VAT 14%' && x.type_tax_use === 'purchase');
  const kept = onchange({ ...line, tax_id: purchTax.id, tax: 14, account_id: plain.id }, 'account_id', db, move);
  assert.equal(kept.tax_id, purchTax.id);
  assert.equal(kept.tax, 14);
});

test('account Balance button opens journal items of that account only', async () => {
  const smart = models['account.account'].form.smart.find((s) => s.label === 'Balance');
  assert.equal(smart.target({ id: 6 }), 'accounting/journal-items?account=6');
  const db = seed();
  const items = journalItems(db, {});
  const own = items.filter((l) => l.account_id === 6);
  const other = items.find((l) => l.account_id !== 6 && l.move_name && !own.some((o) => o.move_name === l.move_name));
  assert.ok(own.length && other, 'seed has posted items on account 6 and on an unrelated entry');
  const prevLocation = globalThis.location;
  globalThis.location = { hash: '#/accounting/journal-items?account=6' };
  const { JournalItems } = await import('./views/JournalItems.jsx');
  const view = await mountView((React) => React.createElement(JournalItems, { leaf: {} }), db);
  try {
    const text = view.host.textContent;
    assert.ok(text.includes(read(db, 'account.account', 6).name));
    for (const l of own) assert.ok(text.includes(l.move_name), l.move_name);
    assert.ok(!text.includes(other.move_name), other.move_name);
  } finally {
    await view.done();
    globalThis.location = prevLocation;
  }
});

test('Studio custom fields install on the tab-only account form', async () => {
  const { installCustomFields } = await import('./models/studio.js');
  assert.doesNotThrow(() => installCustomFields([{ model: 'account.account', label: 'Audit Ref', type: 'char' }]));
  assert.ok(models['account.account'].form.groups.some((g) => g.custom && g.includes('x_audit_ref')));
  assert.doesNotThrow(() => installCustomFields([{ model: 'account.account', label: 'Audit Ref', type: 'char' }]));
});
