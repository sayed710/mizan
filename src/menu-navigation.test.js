import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

// The same minimal React DOM approach as formview-wizard.test.js, with real
// EventTargets so effect subscriptions and StrictMode cleanup are exercised.
function setupDom() {
  const makeEl = (tag = 'div') => {
    const node = Object.assign(new EventTarget(), {
      nodeType: 1, tagName: tag.toUpperCase(), nodeName: tag.toUpperCase(),
      childNodes: [], style: {}, options: [], ownerDocument: globalThis.document,
      appendChild(child) { this.childNodes.push(child); child.parentNode = this; return child; },
      removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child; },
      insertBefore(child, before) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; },
      setAttribute(name, value) { this[name] = String(value); },
      removeAttribute(name) { delete this[name]; },
      contains(child) { return child === this || this.childNodes.some((c) => c.contains?.(child)); },
      closest(selector) {
        let cur = this;
        const targetTag = selector.toUpperCase();
        while (cur && cur.nodeType === 1) {
          if (cur.tagName === targetTag) return cur;
          cur = cur.parentNode;
        }
        return null;
      },
      dispatchEvent(event) {
        let cur = this;
        let canceled = false;
        Object.defineProperty(event, 'target', { value: this, configurable: true });
        while (cur) {
          Object.defineProperty(event, 'currentTarget', { value: cur, configurable: true });
          const ok = EventTarget.prototype.dispatchEvent.call(cur, event);
          if (!ok) canceled = true;
          if (!event.bubbles || event.cancelBubble) break;
          cur = cur.parentNode;
        }
        return !canceled;
      },
      focus() { document.activeElement = this; },
      querySelector(selector) { return find(this, (n) => selector === '[role=menuitem]' ? n.role === 'menuitem' : n['aria-expanded'] != null); },
      querySelectorAll() { return []; },
    });
    Object.defineProperty(node, 'textContent', {
      get() { return this.childNodes.map((c) => c.nodeType === 3 ? c.nodeValue : c.textContent).join(''); },
      set(value) { this.childNodes = value ? [{ nodeType: 3, nodeValue: String(value) }] : []; },
    });
    return node;
  };
  globalThis.window = Object.assign(new EventTarget(), { HTMLIFrameElement: class {}, scrollTo() {} });
  globalThis.document = Object.assign(new EventTarget(), {
    nodeType: 9, nodeName: '#document', visibilityState: 'hidden',
    documentElement: makeEl('html'), createElement: makeEl,
    createElementNS: (namespace, tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, nodeValue: text }),
    createComment: () => ({ nodeType: 8 }),
  });
  globalThis.location = { hash: '#/inventory/transfers' };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return makeEl('div');
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
}

const props = (node) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

test('Operations → Receipts updates the page and closes both menus in StrictMode', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(App))));
    assert.ok(find(container, (n) => n.tagName === 'MAIN' && n.textContent.includes('Transfers')));
    const toggle = find(container, (n) => n.tagName === 'BUTTON' && n['aria-controls'] === 'nav-menus');
    await React.act(async () => props(toggle).onClick());
    const operations = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Operations');
    await React.act(async () => props(operations).onClick());
    const receipts = find(container, (n) => n.tagName === 'A' && n.role === 'menuitem' && n.textContent === 'Receipts');
    assert.ok(receipts);
    await React.act(async () => {
      // Invoke the React handler, then the anchor's native hash navigation.
      const event = { preventDefault() { this.defaultPrevented = true; } };
      props(receipts).onClick(event);
      assert.ok(!event.defaultPrevented);
      location.hash = props(receipts).href;
      window.dispatchEvent(new Event('hashchange'));
    });
    assert.equal(location.hash, '#/inventory/receipts');
    assert.ok(find(container, (n) => n.tagName === 'MAIN' && n.textContent.includes('Receipts')));
    assert.equal(operations['aria-expanded'], 'false');
    assert.equal(toggle['aria-expanded'], 'false');
    assert.equal(find(container, (n) => n.role === 'menu'), null);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('clicking a submenu button keeps the mobile panel open, while anchor clicks and same-hash navigation close it', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore } = await import('./store.js');
  await initStore();
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(App))));
    const toggle = find(container, (n) => n.tagName === 'BUTTON' && n['aria-controls'] === 'nav-menus');
    await React.act(async () => {
      toggle.dispatchEvent(new Event('click', { bubbles: true }));
    });
    assert.equal(toggle['aria-expanded'], 'true', 'mobile menu panel opened');

    const operations = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Operations');
    await React.act(async () => {
      operations.dispatchEvent(new Event('click', { bubbles: true }));
    });
    assert.equal(toggle['aria-expanded'], 'true', 'mobile menu panel must remain open when opening submenu');
    assert.equal(operations['aria-expanded'], 'true', 'submenu Operations opened');

    const appTitle = find(container, (n) => n.tagName === 'A' && n.textContent === 'Inventory');
    assert.ok(appTitle);
    await React.act(async () => {
      appTitle.dispatchEvent(new Event('click', { bubbles: true }));
    });
    assert.equal(toggle['aria-expanded'], 'false', 'app-title link closes panel on same-hash navigation');

    await React.act(async () => {
      toggle.dispatchEvent(new Event('click', { bubbles: true }));
    });
    assert.equal(toggle['aria-expanded'], 'true');
    const transfersLink = find(container, (n) => n.tagName === 'A' && n.textContent === 'Transfers');
    assert.ok(transfersLink);
    await React.act(async () => {
      transfersLink.dispatchEvent(new Event('click', { bubbles: true }));
    });
    assert.equal(toggle['aria-expanded'], 'false', 'menu link click closes panel');
  } finally {
    await React.act(async () => root.unmount());
  }
});

// Report views load lazily; wait until the route's content renders (slow CI runners need more than one act tick).
const rendered = async (React, container, text) => {
  for (let i = 0; i < 200 && !container.textContent.includes(text); i++) await React.act(() => new Promise((resolve) => setTimeout(resolve, 50)));
};

test('Unrealized Currencies report date and revaluation button operate through the menu route', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { create, search } = await import('./orm.js');
  const { postMove } = await import('./models/accounting.js');
  await initStore();
  const currency = create(getDb(), 'res.currency', { name: 'MENUFX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const invoice = create(currency.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ name: 'Menu test', qty: 1, price_unit: 100, tax: 0 }] });
  await commit(postMove(invoice.db, invoice.id));
  location.hash = '#/accounting/unrealized-currencies';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'Unrealized Currencies');
    const input = find(container, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    assert.ok(input);
    await React.act(async () => props(input).onChange({ target: { value: '2026-02-28' } }));
    assert.ok(container.textContent.includes('MENUFX'));
    const button = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Revalue Foreign Currency');
    assert.ok(button);
    await React.act(async () => props(button).onClick());
    assert.ok(search(getDb(), 'account.move').some((m) => m.revaluation_date === '2026-02-28'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('Customer Statement menu displays the selected customer and period and prints', async () => {
  const container = setupDom();
  let printed = false;
  window.print = () => { printed = true; };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { create, updateSettings } = await import('./orm.js');
  const { postEntry } = await import('./models/ledger.js');
  const { createCompany } = await import('./models/company.js');
  await initStore();
  const partner = create(getDb(), 'res.partner', { name: 'Statement Test Customer' });
  const other = createCompany(partner.db, { name: 'Hidden Statement Company' });
  let db = updateSettings(other.db, { current_company_id: 1, allowed_company_ids: [1] });
  const entry = (date, amount, ref) => {
    db = postEntry(db, { journal: 'MISC', date, ref, company: 1, lines: [{ account: '121000', partner_id: partner.id, debit: Math.max(amount, 0), credit: Math.max(-amount, 0) }, { account: '400000', debit: Math.max(-amount, 0), credit: Math.max(amount, 0) }] }).db;
  };
  entry('2026-01-01', 100, 'OPENING');
  entry('2026-02-01', 50, 'INVOICE TEST');
  entry('2026-02-02', -20, 'PAYMENT TEST');
  entry('2026-02-04', -10, 'CREDIT NOTE TEST');
  db = create(db, 'account.account', { code: '400000', name: '400000', account_type: 'income', company_id: other.id }).db;
  db = create(db, 'account.journal', { code: 'MISC', name: 'Other journal', type: 'general', company_id: other.id }).db;
  db = postEntry(db, { journal: 'MISC', date: '2026-02-03', ref: 'HIDDEN COMPANY ENTRY', company: other.id, lines: [{ account: '121000', partner_id: partner.id, debit: 700 }, { account: '400000', credit: 700 }] }).db;
  await commit(db);
  location.hash = '#/accounting/customer-statement';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'Customer Statement');
    assert.ok(container.textContent.includes('Customer Statement'));
    const period = find(container, (n) => n.tagName === 'SELECT' && (props(n)?.children ?? []).some?.((child) => child?.props?.value === 'custom'));
    assert.ok(period);
    await React.act(async () => props(period).onChange({ target: { value: 'custom' } }));
    const dates = [];
    const collect = (n) => { if (n.tagName === 'INPUT' && props(n)?.type === 'date') dates.push(n); (n.childNodes ?? []).forEach(collect); };
    collect(container);
    await React.act(async () => props(dates[0]).onChange({ target: { value: '2026-02-01' } }));
    await React.act(async () => props(dates[1]).onChange({ target: { value: '2026-02-28' } }));
    const customer = find(container, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Customer');
    assert.ok(customer);
    await React.act(async () => props(customer).onChange({ target: { value: String(partner.id) } }));
    assert.ok(container.textContent.includes('INVOICE TEST'));
    assert.ok(container.textContent.includes('PAYMENT TEST'));
    assert.ok(container.textContent.includes('CREDIT NOTE TEST'));
    assert.ok(container.textContent.includes('100.00'));
    assert.ok(container.textContent.includes('120.00'));
    assert.ok(!container.textContent.includes('OPENING'));
    assert.ok(!container.textContent.includes('HIDDEN COMPANY ENTRY'));
    assert.ok(!container.textContent.includes('820.00'));
    const print = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Print');
    await React.act(async () => props(print).onClick());
    assert.ok(printed);
  } finally { await React.act(async () => root.unmount()); }
});

test('Review sales menus show individual quantity discrepancies only for selected companies', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { seed } = await import('./seed.js');
  const { create, updateSettings } = await import('./orm.js');
  const { createCompany } = await import('./models/company.js');
  await initStore();
  const company = createCompany(seed(), { name: 'Hidden company' });
  let db = updateSettings(company.db, { current_company_id: 1, allowed_company_ids: [1] });
  const first = create(db, 'sale.order', { name: 'VISIBLE-ORDER', partner_id: 1, company_id: 1, order_line: [
    { name: 'Delivered line', qty: 8, qty_delivered: 5, qty_invoiced: 2, price_unit: 1 },
    { name: 'Invoiced line', qty: 8, qty_delivered: 1, qty_invoiced: 4, price_unit: 1 },
    { name: 'Equal line', qty: 2, qty_delivered: 2, qty_invoiced: 2, price_unit: 1 },
  ] });
  const hidden = create(first.db, 'sale.order', { name: 'HIDDEN-ORDER', partner_id: 1, company_id: company.id, order_line: [{ name: 'Hidden line', qty: 3, qty_delivered: 3, qty_invoiced: 0, price_unit: 1 }] });
  await commit(hidden.db);
  location.hash = '#/accounting/invoices-to-be-issued';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'Invoices To Be Issued');
    assert.ok(container.textContent.includes('Invoices To Be Issued'));
    assert.ok(container.textContent.includes('Delivered line'));
    assert.ok(!container.textContent.includes('Invoiced line'));
    assert.ok(!container.textContent.includes('Equal line'));
    assert.ok(!container.textContent.includes('HIDDEN-ORDER'));
    const link = find(container, (n) => n.tagName === 'A' && props(n)?.href?.includes(`/sales/orders/${first.id}`));
    assert.ok(link);
    await React.act(async () => { location.hash = '#/accounting/invoiced-not-delivered'; window.dispatchEvent(new Event('hashchange')); });
    assert.ok(container.textContent.includes('Invoiced Not Delivered'));
    assert.ok(container.textContent.includes('Invoiced line'));
    assert.ok(!container.textContent.includes('Delivered line'));
    assert.ok(!container.textContent.includes('Equal line'));
  } finally { await React.act(async () => root.unmount()); }
});

test('Loans Analysis menu reports posted loan activity as of the selected date and company', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { seed } = await import('./seed.js');
  const { create, read, updateSettings } = await import('./orm.js');
  const { confirmLoan, postDueLines, earlyRepayment } = await import('./models/loans.js');
  const { createCompany } = await import('./models/company.js');
  await initStore();
  const other = createCompany(seed(), { name: 'Other loan company' });
  let db = updateSettings(other.db, { current_company_id: 1, allowed_company_ids: [1] });
  const loan = create(db, 'account.loan', { name: 'ANALYSIS LOAN', company_id: 1, lender_id: 2, amount: 1200, start_date: '2026-01-10', duration: 6, interest_rate: 6, method: 'linear' });
  db = confirmLoan(loan.db, read(loan.db, 'account.loan', loan.id));
  db = postDueLines(db, read(db, 'account.loan', loan.id), '2026-02-28');
  db = earlyRepayment(db, read(db, 'account.loan', loan.id), { date: '2026-03-05', amount: 300 });
  const hidden = create(db, 'account.loan', { name: 'HIDDEN LOAN', company_id: other.id, amount: 400, start_date: '2026-01-01', duration: 2, interest_rate: 0 });
  await commit(hidden.db);
  location.hash = '#/accounting/loans-analysis';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'Loans Analysis');
    assert.ok(container.textContent.includes('Loans Analysis'));
    const date = find(container, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    assert.ok(date);
    await React.act(async () => props(date).onChange({ target: { value: '2026-02-28' } }));
    assert.ok(container.textContent.includes('ANALYSIS LOAN'));
    assert.ok(container.textContent.includes('1,200.00'));
    assert.ok(container.textContent.includes('1,000.00'));
    assert.ok(container.textContent.includes('6.00'));
    assert.ok(!container.textContent.includes('HIDDEN LOAN'));
    await React.act(async () => props(date).onChange({ target: { value: '2026-03-06' } }));
    assert.ok(container.textContent.includes('700.00'));
    await React.act(async () => props(date).onChange({ target: { value: '2026-01-01' } }));
    assert.ok(!container.textContent.includes('ANALYSIS LOAN'));
  } finally { await React.act(async () => root.unmount()); }
});

test('Accounting exposes tax groups and issued checks through their menus', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { seed } = await import('./seed.js');
  const { create, read } = await import('./orm.js');
  const { models } = await import('./models/index.js');
  await initStore();
  const group = create(seed(), 'account.tax.group', { name: 'TEST VAT GROUP' });
  const bank = create(group.db, 'res.partner.bank', { partner_id: 7, account_number: 'TEST-CHECK-BANK' });
  const bill = create(bank.db, 'account.move', { move_type: 'in_invoice', partner_id: 7, invoice_line_ids: [{ qty: 1, price_unit: 125, tax: 0 }] });
  const action = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
  const posted = action(bill.db, 'account.move', bill.id, 'Confirm');
  const batch = create(posted, 'account.batch.payment', { name: 'CHECK BATCH', batch_type: 'outbound', date: '2026-01-01', check_number_start: 431, lines: [{ amount: 125, move_id: bill.id }] });
  await commit(action(batch.db, 'account.batch.payment', batch.id, 'Validate'));
  location.hash = '#/accounting/tax-groups';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'TEST VAT GROUP');
    assert.ok(container.textContent.includes('TEST VAT GROUP'));
    await React.act(async () => { location.hash = '#/accounting/checks'; window.dispatchEvent(new Event('hashchange')); });
    assert.ok(container.textContent.includes('CHECK BATCH'));
    assert.ok(container.textContent.includes('431'));
  } finally { await React.act(async () => root.unmount()); }
});

test('Fiscal Categories menu and category form respect selected companies and show linked accounts', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { seed } = await import('./seed.js');
  const { create, read, updateSettings, write } = await import('./orm.js');
  const { createCompany } = await import('./models/company.js');
  await initStore();
  const company = createCompany(seed(), { name: 'Second fiscal company' });
  const first = create(company.db, 'account.fiscal.category', { name: 'VISIBLE CATEGORY', code: 'VIS', company_id: 1 });
  const second = create(first.db, 'account.fiscal.category', { name: 'HIDDEN CATEGORY', code: 'HID', company_id: company.id });
  const account = create(second.db, 'account.account', { name: 'FISCAL LINKED ACCOUNT', code: 'FISCAL1', company_id: 1, fiscal_category_id: first.id });
  assert.throws(() => write(account.db, 'account.account', account.id, { fiscal_category_id: second.id }), /company/i);
  assert.equal(read(account.db, 'account.fiscal.category', first.id).account_ids[0].name, 'FISCAL LINKED ACCOUNT');
  await commit(updateSettings(account.db, { current_company_id: 1, allowed_company_ids: [1] }));
  location.hash = '#/accounting/fiscal-categories';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'VISIBLE CATEGORY');
    assert.ok(container.textContent.includes('VISIBLE CATEGORY'));
    assert.ok(!container.textContent.includes('HIDDEN CATEGORY'));
    await React.act(async () => { location.hash = `#/accounting/fiscal-categories/${first.id}`; window.dispatchEvent(new Event('hashchange')); });
    assert.ok(container.textContent.includes('FISCAL LINKED ACCOUNT'));
  } finally { await React.act(async () => root.unmount()); }
});

test('Fiscal Report menu groups period movements by category, drills down and follows selected companies', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { seed } = await import('./seed.js');
  const { create, updateSettings, write } = await import('./orm.js');
  const { createCompany } = await import('./models/company.js');
  const { accountId, postEntry } = await import('./models/ledger.js');
  const { trialBalance } = await import('./models/reports.js');
  const { companyViewDb } = await import('./companyView.js');
  await initStore();
  const initial = seed();
  const other = createCompany(initial, { name: 'Fiscal Other Company', currency_id: initial.records['res.company'][0].currency_id });
  const category = create(other.db, 'account.fiscal.category', { name: 'Fiscal Test Category', company_id: 1 });
  const foreign = create(category.db, 'account.fiscal.category', { name: 'Fiscal Foreign Category', company_id: other.id });
  let db = write(foreign.db, 'account.account', accountId(foreign.db, '121000', 1), { fiscal_category_id: category.id });
  db = write(db, 'account.account', accountId(db, '121000', other.id), { name: 'Foreign Receivable', fiscal_category_id: foreign.id });
  db = create(db, 'account.account', { code: '400000', name: 'Foreign Income', account_type: 'income', company_id: other.id }).db;
  db = create(db, 'account.journal', { code: 'MISC', name: 'Foreign Misc', type: 'general', company_id: other.id }).db;
  const post = (company, date, amount) => { db = postEntry(db, { journal: 'MISC', company, date, lines: [{ account: '121000', debit: amount }, { account: '400000', credit: amount }] }).db; };
  post(1, '2026-01-01', 900);
  post(1, '2026-02-01', 75);
  post(other.id, '2026-02-02', 250);
  db = create(db, 'account.move', { move_type: 'entry', state: 'draft', company_id: 1, date: '2026-02-03', line_ids: [{ account_id: accountId(db, '121000', 1), debit: 800 }] }).db;
  db = updateSettings(db, { current_company_id: 1, allowed_company_ids: [1] });
  await commit(db);
  location.hash = '#/accounting/fiscal-report';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'Fiscal Report');
    assert.ok(container.textContent.includes('Fiscal Report'));
    const period = find(container, (n) => n.tagName === 'SELECT' && (props(n)?.children ?? []).some?.((child) => child?.props?.value === 'custom'));
    assert.ok(period);
    await React.act(async () => props(period).onChange({ target: { value: 'custom' } }));
    const dates = [];
    const collect = (n) => { if (n.tagName === 'INPUT' && props(n)?.type === 'date') dates.push(n); (n.childNodes ?? []).forEach(collect); };
    collect(container);
    await React.act(async () => props(dates[0]).onChange({ target: { value: '2026-02-01' } }));
    await React.act(async () => props(dates[1]).onChange({ target: { value: '2026-02-28' } }));
    const categoryRow = find(container, (n) => n.tagName === 'TR' && n.textContent.includes('Fiscal Test Category'));
    const uncategorized = find(container, (n) => n.tagName === 'TR' && n.textContent.includes('Uncategorized'));
    const total = find(container, (n) => n.tagName === 'TR' && n.textContent.startsWith('Total'));
    assert.ok(categoryRow && uncategorized && total);
    assert.deepEqual(categoryRow.childNodes.slice(1).map((n) => Number(n.textContent.replace(/[^0-9.-]/g, ''))), [75, 0, 75]);
    assert.deepEqual(uncategorized.childNodes.slice(1).map((n) => Number(n.textContent.replace(/[^0-9.-]/g, ''))), [0, 75, -75]);
    assert.ok(!container.textContent.includes('Fiscal Foreign Category'));
    assert.ok(!container.textContent.includes('900.00'));
    assert.ok(!container.textContent.includes('800.00'));
    const trial = trialBalance(companyViewDb(db), { from: '2026-02-01', to: '2026-02-28' });
    const cells = total.childNodes.map((n) => n.textContent);
    assert.deepEqual(cells.slice(1).map((value) => Number(value.replace(/[^0-9.-]/g, ''))), [trial.totals.debit, trial.totals.credit, trial.totals.debit - trial.totals.credit]);
    const expand = find(categoryRow, (n) => n.tagName === 'BUTTON');
    assert.ok(expand);
    await React.act(async () => props(expand).onClick());
    assert.ok(container.textContent.includes('121000 Account Receivable'));
    await React.act(async () => commit(updateSettings(db, { current_company_id: 1, allowed_company_ids: [1, other.id] })));
    assert.ok(container.textContent.includes('Fiscal Foreign Category'));
    assert.ok(container.textContent.includes('250.00'));
    const bothTotal = find(container, (n) => n.tagName === 'TR' && n.textContent.startsWith('Total'));
    assert.deepEqual(bothTotal.childNodes.slice(1).map((n) => Number(n.textContent.replace(/[^0-9.-]/g, ''))), [325, 325, 0]);
  } finally { await React.act(async () => root.unmount()); }
});

test('Cashflow Analysis menu groups statement amounts by month and pivots by journal for selected companies', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { seed } = await import('./seed.js');
  const { create, updateSettings } = await import('./orm.js');
  const { createCompany } = await import('./models/company.js');
  await initStore();
  const initial = seed();
  const other = createCompany(initial, { name: 'Cashflow Other Company', currency_id: initial.records['res.company'][0].currency_id });
  const bank = create(other.db, 'account.journal', { name: 'Analysis Bank', code: 'CFA', type: 'bank', company_id: 1 });
  const cash = create(bank.db, 'account.journal', { name: 'Analysis Cash', code: 'CFC', type: 'cash', company_id: 1 });
  const foreign = create(cash.db, 'account.journal', { name: 'Analysis Foreign Bank', code: 'CFB', type: 'bank', company_id: other.id });
  let db = foreign.db;
  const line = (journal_id, company_id, date, amount, payment_ref) => { db = create(db, 'account.bank.statement.line', { journal_id, company_id, date, amount, payment_ref }).db; };
  line(bank.id, 1, '2026-02-01', 100, 'Bank in');
  line(bank.id, 1, '2026-02-02', -30, 'Bank out');
  line(cash.id, 1, '2026-03-01', 20, 'Cash in');
  line(bank.id, 1, '2026-01-31', 900, 'Outside period');
  line(foreign.id, other.id, '2026-02-03', 250, 'Foreign');
  db = create(db, 'account.bank.statement.line', { company_id: 1, date: '2026-02-05', amount: 800, payment_ref: 'No journal' }).db;
  db = updateSettings(db, { current_company_id: 1, allowed_company_ids: [1] });
  await commit(db);
  location.hash = '#/accounting/cashflow-analysis';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'Cashflow Analysis');
    assert.ok(container.textContent.includes('Cashflow Analysis'));
    const dates = [];
    const collect = (n) => { if (n.tagName === 'INPUT' && props(n)?.type === 'date') dates.push(n); (n.childNodes ?? []).forEach(collect); };
    collect(container);
    assert.equal(dates.length, 2);
    const now = new Date();
    const { isoDate } = await import('./models/common.js');
    assert.equal(props(dates[0]).value, isoDate(new Date(now.getFullYear(), now.getMonth() - 11, 1)));
    assert.equal(props(dates[1]).value, isoDate(now));
    await React.act(async () => props(dates[0]).onChange({ target: { value: '2026-02-01' } }));
    await React.act(async () => props(dates[1]).onChange({ target: { value: '2026-03-31' } }));
    const feb = find(container, (n) => n.tagName === 'TR' && n.textContent.startsWith('2026-02'));
    assert.ok(feb);
    assert.deepEqual(feb.childNodes.slice(1).map((n) => Number(n.textContent.replace(/[^0-9.-]/g, ''))), [100, 30, 70]);
    assert.ok(!container.textContent.includes('900.00'));
    assert.ok(!container.textContent.includes('800.00'));
    assert.ok(!container.textContent.includes('250.00'));
    const pivot = find(container, (n) => n.tagName === 'BUTTON' && n.textContent === 'Pivot by Journal');
    assert.ok(pivot);
    await React.act(async () => props(pivot).onClick());
    assert.ok(container.textContent.includes('Analysis Bank'));
    assert.ok(container.textContent.includes('Analysis Cash'));
    assert.ok(!container.textContent.includes('Analysis Foreign Bank'));
    const pivotFeb = find(container, (n) => n.tagName === 'TR' && n.textContent.startsWith('2026-02'));
    assert.ok(pivotFeb.textContent.includes('70.00'));
    await React.act(async () => commit(updateSettings(db, { current_company_id: 1, allowed_company_ids: [1, other.id] })));
    assert.ok(container.textContent.includes('Analysis Foreign Bank'));
    assert.ok(container.textContent.includes('250.00'));
  } finally { await React.act(async () => root.unmount()); }
});

test('Journal Items menu lists posted lines, filters, groups and opens entries within selected companies', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { seed } = await import('./seed.js');
  const { create, updateSettings } = await import('./orm.js');
  const { createCompany } = await import('./models/company.js');
  const { postEntry } = await import('./models/ledger.js');
  await initStore();
  const company = createCompany(seed(), { name: 'Other journal company' });
  let db = updateSettings(company.db, { current_company_id: 1, allowed_company_ids: [1] });
  const entry = postEntry(db, { journal: 'MISC', company: 1, date: '2026-02-01', ref: 'VISIBLE JOURNAL LINE', lines: [{ account: '121000', partner_id: 1, debit: 55 }, { account: '400000', credit: 55 }] });
  db = entry.db;
  db = create(db, 'account.account', { code: '400000', name: '400000', account_type: 'income', company_id: company.id }).db;
  db = create(db, 'account.journal', { code: 'MISC', name: 'Other journal', type: 'general', company_id: company.id }).db;
  db = postEntry(db, { journal: 'MISC', company: company.id, date: '2026-02-01', ref: 'HIDDEN JOURNAL LINE', lines: [{ account: '121000', debit: 99 }, { account: '400000', credit: 99 }] }).db;
  db = create(db, 'account.move', { move_type: 'entry', state: 'draft', company_id: 1, name: 'DRAFT JOURNAL LINE', line_ids: [{ name: 'DRAFT JOURNAL LINE', debit: 12 }] }).db;
  await commit(db);
  location.hash = '#/accounting/journal-items';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'VISIBLE JOURNAL LINE');
    assert.ok(container.textContent.includes('VISIBLE JOURNAL LINE'));
    assert.ok(!container.textContent.includes('HIDDEN JOURNAL LINE'));
    assert.ok(!container.textContent.includes('DRAFT JOURNAL LINE'));
    assert.ok(find(container, (n) => n.tagName === 'A' && props(n)?.href === `#/accounting/entries/${entry.id}`));
    const from = find(container, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'From');
    await React.act(async () => props(from).onChange({ target: { value: '2026-02-02' } }));
    assert.ok(!find(container, (n) => n.tagName === 'TR' && n.textContent.includes('VISIBLE JOURNAL LINE')));
    await React.act(async () => props(from).onChange({ target: { value: '' } }));
    const group = find(container, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Group By');
    for (const value of ['account', 'partner', 'journal']) {
      await React.act(async () => props(group).onChange({ target: { value } }));
      assert.ok(container.textContent.includes('VISIBLE JOURNAL LINE'));
      assert.ok(find(container, (n) => n.tagName === 'TH' && props(n)?.colSpan === 8));
    }
    await React.act(async () => props(group).onChange({ target: { value: '' } }));
    const search = find(container, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Search');
    await React.act(async () => props(search).onChange({ target: { value: 'VISIBLE JOURNAL LINE' } }));
    assert.ok(container.textContent.includes('55.00'));
  } finally { await React.act(async () => root.unmount()); }
});

test('Accounting menu follows the Odoo top-level, Closing and Review group order', async () => {
  const { menusFor } = await import('./models/index.js');
  const menus = menusFor('accounting');
  assert.deepEqual(menus.map((menu) => menu.label), ['Dashboard', 'Customers', 'Vendors', 'Accounting', 'Review', 'Reporting', 'Configuration']);
  const accounting = menus.find((menu) => menu.label === 'Accounting');
  assert.deepEqual(accounting.children.map((menu) => menu.label), ['Transactions', 'Assets & Liabilities', 'Closing']);
  assert.deepEqual(accounting.children.find((menu) => menu.label === 'Closing').children.map((menu) => menu.label), ['Reconcile', 'Tax Returns', 'Lock Dates…', 'Secure Entries']);
  const review = menus.find((menu) => menu.label === 'Review');
  assert.deepEqual(review.children.map((menu) => menu.label), ['Control', 'Audit', 'Inventory', 'Regularization Entries', 'Sales']);
  const allLabels = (items) => items.flatMap((item) => [item.label, ...allLabels(item.children ?? [])]);
  assert.equal(review.children.find((menu) => menu.label === 'Control').children[0].label, 'Journal Items');
  assert.ok(allLabels(menus).includes('Customer Statement'));
  assert.ok(allLabels(menus).includes('Unrealized Currencies'));
  const regularization = review.children.find((menu) => menu.label === 'Regularization Entries').children;
  assert.equal(regularization.find((menu) => menu.key === 'deferred-revenues').domain({ kind: 'revenue' }), true);
  assert.equal(regularization.find((menu) => menu.key === 'deferred-revenues').domain({ kind: 'expense' }), false);
  assert.equal(regularization.find((menu) => menu.key === 'deferred-expenses').domain({ kind: 'expense' }), true);
  assert.equal(regularization.find((menu) => menu.key === 'deferred-expenses').domain({ kind: 'revenue' }), false);
});

test('analytic distribution model menu scopes rules and defaults new forms to the selected company', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { seed } = await import('./seed.js');
  const { create, updateSettings } = await import('./orm.js');
  const { createCompany } = await import('./models/company.js');
  await initStore();
  const company = createCompany(seed(), { name: 'Distribution company two' });
  let db = updateSettings(company.db, { current_company_id: company.id, allowed_company_ids: [company.id] });
  db = create(db, 'account.analytic.distribution.model', { company_id: 1, account_prefix: 'HIDDEN-FIRST' }).db;
  db = create(db, 'account.analytic.distribution.model', { company_id: company.id, account_prefix: 'VISIBLE-SECOND' }).db;
  await commit(db);
  location.hash = '#/accounting/analytic-distribution-models';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'VISIBLE-SECOND');
    assert.ok(container.textContent.includes('VISIBLE-SECOND'));
    assert.ok(!container.textContent.includes('HIDDEN-FIRST'));
    await React.act(async () => { location.hash = '#/accounting/analytic-distribution-models/new'; window.dispatchEvent(new Event('hashchange')); });
    const main = find(container, (n) => n.tagName === 'MAIN');
    const companySelect = find(main, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id');
    assert.ok(companySelect, `new rule offers selected company: ${main.textContent}`);
    assert.equal(Number(props(companySelect).value), company.id);
  } finally { await React.act(async () => root.unmount()); }
});

test('Multi-Ledger menu and financial reports filter journals and selected companies', async () => {
  const container = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { seed } = await import('./seed.js');
  const { create, updateSettings } = await import('./orm.js');
  const { createCompany } = await import('./models/company.js');
  const { postEntry } = await import('./models/ledger.js');
  const { today } = await import('./models/common.js');
  await initStore();
  const company = createCompany(seed(), { name: 'Other ledger company' });
  let db = updateSettings(company.db, { current_company_id: 1, allowed_company_ids: [1] });
  const first = create(db, 'account.journal', { name: 'Ledger Journal A', code: 'LGA', type: 'general', company_id: 1 });
  const second = create(first.db, 'account.journal', { name: 'Ledger Journal B', code: 'LGB', type: 'general', company_id: 1 });
  db = postEntry(second.db, { journal_id: first.id, company: 1, date: today(), lines: [{ account: '101401', debit: 111 }, { account: '400000', credit: 111 }] }).db;
  db = postEntry(db, { journal_id: second.id, company: 1, date: today(), lines: [{ account: '101401', debit: 222 }, { account: '400000', credit: 222 }] }).db;
  const ledger = create(db, 'account.journal.group', { name: 'Included Journal A', company_id: 1, journal_ids: [first.id] });
  db = create(ledger.db, 'account.journal.group', { name: 'Hidden Ledger', company_id: company.id, journal_ids: [] }).db;
  await commit(db);
  location.hash = '#/accounting/multi-ledger';
  const { App } = await import('./App.jsx');
  const root = createRoot(container);
  try {
    await React.act(async () => root.render(React.createElement(App)));
    await rendered(React, container, 'Included Journal A');
    assert.ok(container.textContent.includes('Included Journal A'));
    assert.ok(!container.textContent.includes('Hidden Ledger'));
    for (const route of ['balance-sheet', 'pnl', 'general-ledger', 'trial-balance']) {
      await React.act(async () => { location.hash = `#/accounting/${route}`; window.dispatchEvent(new Event('hashchange')); });
      const select = find(container, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Ledger');
      assert.ok(select, `${route} has a ledger selector`);
      assert.ok(!select.textContent.includes('Hidden Ledger'));
      await React.act(async () => props(select).onChange({ target: { value: String(ledger.id) } }));
      assert.ok(container.textContent.includes('111.00'), route);
      assert.ok(!container.textContent.includes('333.00'), route);
    }
  } finally { await React.act(async () => root.unmount()); }
});
