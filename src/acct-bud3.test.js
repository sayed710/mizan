import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import './models/index.js';
import { menusFor, models } from './models/index.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { budgetReport } from './models/analyticplus.js';
import { createCompany, setCompanies } from './models/company.js';
import { applyDiff, diffDb } from './sync.js';
import { invoiceJournalDefaults } from './test-support/accounting-company.js';
import { setupDom, find } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const replaceRecord = (db, model, id, values) => ({
  ...db,
  records: {
    ...db.records,
    [model]: db.records[model].map((record) => (record.id === id ? { ...record, ...values } : record)),
  },
});

test('BUD-1: budget report omits inline company selector and relies on company set on the budget record', async () => {
  let db = seed();
  const branch = createCompany(db, { name: 'Bud3 Branch', ...invoiceJournalDefaults(db) });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const created = create(db, 'account.budget', {
    name: 'Legacy Companyless Budget',
    company_id: 1,
    state: 'confirmed',
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    lines: [{ planned: 100 }],
  });
  db = replaceRecord(created.db, 'account.budget', created.id, { company_id: null });

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');

  const bodyHtml = renderToStaticMarkup(
    React.createElement('table', null, React.createElement(Budget, { db, period: {}, companyId: 'all' })),
  );
  assert.doesNotMatch(bodyHtml, /<select\b/);
  assert.match(bodyHtml, new RegExp(`#/open/account\\.budget/${created.id}`));
  assert.match(bodyHtml, /Select a company on the budget record to show this budget report\./);

  // Company is set on the budget record itself (draft form) and enforced through diffDb + applyDiff guards.
  const draft = replaceRecord(db, 'account.budget', created.id, { state: 'draft' });
  const assigned = write(draft, 'account.budget', created.id, { company_id: branch.id });
  const confirmed = write(assigned, 'account.budget', created.id, { state: 'confirmed' });
  const synced = applyDiff(draft, diffDb(draft, confirmed));
  assert.equal(read(synced, 'account.budget', created.id).company_id, branch.id);

  const draftSynced = replaceRecord(synced, 'account.budget', created.id, { state: 'draft' });
  const cleared = replaceRecord(draftSynced, 'account.budget', created.id, { company_id: null });
  assert.throws(
    () => applyDiff(draftSynced, diffDb(draftSynced, cleared)),
    /Company is required/,
  );
  const invalidCompany = replaceRecord(draftSynced, 'account.budget', created.id, { company_id: 99999 });
  assert.throws(
    () => applyDiff(draftSynced, diffDb(draftSynced, invalidCompany)),
    /Select an existing company for the budget/,
  );

  const updatedHtml = renderToStaticMarkup(
    React.createElement('table', null, React.createElement(Budget, { db: synced, period: {}, companyId: 'all' })),
  );
  assert.match(updatedHtml, /Bud3 Branch/);
  assert.doesNotMatch(updatedHtml, /Select a company on the budget record/);
});

test('BUD-2: Planned, Actual and Achievement use one period time basis matching Odoo budget.line achieved_percentage', async (t) => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Marketing Bud3', plan_id: search(db, 'account.analytic.plan')[0].id });
  db = analytic.db;

  // Post a $155 vendor bill and a $31 confirmed unbilled PO in January 2026, plus a $500 bill in June 2026.
  const janBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 155, tax: 0, analytic_distribution: { [analytic.id]: 100 } }],
  });
  db = postMove(janBill.db, janBill.id);

  const junBill = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_date: '2026-06-15',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 500, tax: 0, analytic_distribution: { [analytic.id]: 100 } }],
  });
  db = postMove(junBill.db, junBill.id);

  const po = create(db, 'purchase.order', {
    partner_id: 2,
    company_id: 1,
    date_order: '2026-01-12',
    order_line: [{ product_id: 5, qty: 1, price_unit: 31, tax: 0, analytic_distribution: { [analytic.id]: 100 } }],
  });
  const confirmOrder = models['purchase.order'].form.buttons.find((b) => b.label === 'Confirm Order');
  db = confirmOrder.run(po.db, read(po.db, 'purchase.order', po.id)).db;

  // Annual expense budget over 365 days ($10/day -> $3650/yr, $310 for 31-day January).
  const budget = create(db, 'account.budget', {
    name: 'Annual Marketing Budget',
    budget_type: 'expense',
    company_id: 1,
    state: 'confirmed',
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    lines: [{ analytic_account_id: analytic.id, planned: 3650 }],
  });
  db = budget.db;

  // Full budget period at mid-year atDate: Achievement uses full-period achieved_amount / budget_amount * 100 (17.95%), not theoretical.
  const [fullYear] = budgetReport(db, budget.id, '2026-03-01');
  assert.equal(fullYear.planned_amount, 3650);
  assert.equal(fullYear.achieved_amount, 655);
  assert.equal(fullYear.committed_amount, 686);
  assert.equal(fullYear.budget_variance, -2995);
  assert.equal(fullYear.budget_achievement, 17.95);

  // January period filter: Planned, Actual, Committed, Variance, Achievement all share the 2026-01-01..2026-01-31 time basis.
  const janPeriod = { from: '2026-01-01', to: '2026-01-31' };
  const [jan] = budgetReport(db, budget.id, '2026-01-15', { period: janPeriod });
  assert.equal(jan.planned_amount, 310);
  assert.equal(jan.achieved_amount, 155);
  assert.equal(jan.committed_amount, 186);
  assert.equal(jan.budget_variance, -155);
  assert.equal(jan.budget_achievement, 50);
  assert.equal(jan.achievement, 50);

  // Verify the rendered Budget report cells match the single-time-basis values, including mid-January (2026-01-15) and when atDate < budget start (theoretical = 0).
  const futureBudget = create(db, 'account.budget', {
    name: 'Future Budget',
    budget_type: 'expense',
    company_id: 1,
    state: 'confirmed',
    date_from: '2099-01-01',
    date_to: '2099-12-31',
    lines: [{ analytic_account_id: analytic.id, planned: 1200 }],
  });
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');

  const janHtml = renderToStaticMarkup(
    React.createElement('table', null, React.createElement(Budget, { db, period: janPeriod, companyId: '1' })),
  );
  assert.match(janHtml, /\$310\.00/);
  assert.match(janHtml, /\$155\.00/);
  assert.match(janHtml, /\$186\.00/);
  assert.match(janHtml, /-\$155\.00/);
  assert.match(janHtml, />50%</);

  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-15T12:00:00Z') });
  try {
    const midJanHtml = renderToStaticMarkup(
      React.createElement('table', null, React.createElement(Budget, { db, period: janPeriod, companyId: '1' })),
    );
    assert.match(midJanHtml, />50%</);
    assert.doesNotMatch(midJanHtml, /103/);
  } finally {
    t.mock.timers.reset();
  }

  const futureHtml = renderToStaticMarkup(
    React.createElement('table', null, React.createElement(Budget, { db: futureBudget.db, period: { from: '2099-01-01', to: '2099-12-31' }, companyId: '1' })),
  );
  assert.match(futureHtml, /Future Budget/);
  assert.match(futureHtml, />0%</);
});

test('BUD-3: multi-year budget prorates each yearly period across full line duration without exhausting plan early', async () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Multi-Year Project', plan_id: search(db, 'account.analytic.plan')[0].id });
  db = analytic.db;

  const budget = create(db, 'account.budget', {
    name: 'Two-Year Budget',
    budget_type: 'expense',
    company_id: 1,
    state: 'confirmed',
    date_from: '2026-01-01',
    date_to: '2027-12-31',
    lines: [{ analytic_account_id: analytic.id, planned: 7300 }],
  });
  db = budget.db;

  const [y1] = budgetReport(db, budget.id, '2026-12-31', { period: { from: '2026-01-01', to: '2026-12-31' } });
  const [y2] = budgetReport(db, budget.id, '2027-12-31', { period: { from: '2027-01-01', to: '2027-12-31' } });
  const [before] = budgetReport(db, budget.id, '2025-12-31', { period: { from: '2025-01-01', to: '2025-12-31' } });

  assert.equal(y1.planned_amount, 3650);
  assert.equal(y2.planned_amount, 3650);
  assert.equal(y1.planned_amount + y2.planned_amount, 7300);
  assert.equal(before.planned_amount, 0);

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');
  const periods = [
    { label: '2026', from: '2026-01-01', to: '2026-12-31' },
    { label: '2027', from: '2027-01-01', to: '2027-12-31' },
  ];
  const html = renderToStaticMarkup(
    React.createElement('table', null, React.createElement(Budget, { db, period: periods[0], periods, companyId: '1' })),
  );
  assert.equal((html.match(/>\$3,650\.00</g) ?? []).length, 2);
  assert.doesNotMatch(html, />\$7,300\.00</);
});

test('BUD-4: refund-only expense budget reports negative achieved amount and negative achievement percentage', async () => {
  let db = seed();
  const analytic = create(db, 'account.analytic.account', { name: 'Refund Budget Account', plan_id: search(db, 'account.analytic.plan')[0].id });
  db = analytic.db;

  const refund = create(db, 'account.move', {
    move_type: 'in_refund',
    partner_id: 2,
    company_id: 1,
    invoice_date: '2026-02-10',
    invoice_line_ids: [{ product_id: 5, qty: 1, price_unit: 25, tax: 0, analytic_distribution: { [analytic.id]: 100 } }],
  });
  db = postMove(refund.db, refund.id);

  const budget = create(db, 'account.budget', {
    name: 'Refund Expense Budget',
    budget_type: 'expense',
    company_id: 1,
    state: 'confirmed',
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    lines: [{ analytic_account_id: analytic.id, planned: 100 }],
  });
  db = budget.db;

  const [row] = budgetReport(db, budget.id, '2026-06-30', { period: { from: '2026-01-01', to: '2026-12-31' } });
  assert.equal(row.practical, 25);
  assert.equal(row.achieved_amount, -25);
  assert.equal(row.budget_achievement, -25);
  assert.equal(row.achievement, -25);

  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Budget } = await import('./views/Reports.jsx');
  const html = renderToStaticMarkup(
    React.createElement('table', null, React.createElement(Budget, { db, period: { from: '2026-01-01', to: '2026-12-31' }, companyId: '1' })),
  );
  assert.match(html, />-\$25\.00</);
  assert.match(html, />-25%</);
  assert.doesNotMatch(html, />25%</);
});

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

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

test('confirmed companyless budgets allow assigning a valid company on the form and via non-admin sync while keeping other locked fields protected', async () => {
  let db = seed();
  const branch = createCompany(db, { name: 'Recovery Branch', ...invoiceJournalDefaults(db) });
  db = setCompanies(branch.db, { current: 1, allowed: [1, branch.id] });
  const created = create(db, 'account.budget', {
    name: 'Locked Companyless Budget',
    company_id: 1,
    state: 'confirmed',
    date_from: '2026-01-01',
    date_to: '2026-12-31',
    lines: [{ planned: 250 }],
  });
  db = replaceRecord(created.db, 'account.budget', created.id, { company_id: null });
  const nonAdmin = { author: 'Accountant', isAdmin: false };

  // Non-admin sync rejects tampering with other locked fields while repairing company_id.
  const tamperedName = write(db, 'account.budget', created.id, { company_id: branch.id, name: 'Renamed' });
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedName), nonAdmin),
    /This record is locked: Budget Name cannot change/,
  );
  const tamperedLines = write(db, 'account.budget', created.id, { company_id: branch.id, lines: [{ planned: 999 }] });
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedLines), nonAdmin),
    /This record is locked: Budget Lines cannot change/,
  );

  // Still rejects empty or non-existent company on the confirmed record.
  assert.throws(
    () => applyDiff(db, diffDb(db, replaceRecord(db, 'account.budget', created.id, { company_id: 99999 })), nonAdmin),
    /Select an existing company for the budget/,
  );

  // Repairing a stale/invalid company id (99999) to a valid company succeeds for non-admin users.
  const staleDb = replaceRecord(db, 'account.budget', created.id, { company_id: 99999 });
  const repairedFromStale = write(staleDb, 'account.budget', created.id, { company_id: branch.id });
  const syncedStale = applyDiff(staleDb, diffDb(staleDb, repairedFromStale), nonAdmin);
  assert.equal(read(syncedStale, 'account.budget', created.id).company_id, branch.id);

  // Repairing from company_id: null succeeds for non-admin users, preserves confirmed state, and locks company_id afterward.
  const repaired = write(db, 'account.budget', created.id, { company_id: branch.id });
  const synced = applyDiff(db, diffDb(db, repaired), nonAdmin);
  const repairedRec = read(synced, 'account.budget', created.id);
  assert.equal(repairedRec.company_id, branch.id);
  assert.equal(repairedRec.state, 'confirmed');
  assert.throws(
    () => applyDiff(synced, diffDb(synced, write(synced, 'account.budget', created.id, { company_id: 1 })), nonAdmin),
    /This record is locked: Company cannot change/,
  );

  // UI FormView: company_id is editable on the confirmed companyless budget while other fields stay locked, and locks once saved.
  const prevStorage = globalThis.localStorage;
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
    clear: () => { mem.clear(); },
  };
  const { makeEl } = setupDom();
  globalThis.document.createElementNS = (_ns, tag) => makeEl(tag);
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  const budgetsLeaf = findLeafByKey(menusFor('accounting'), 'budgets');

  await initStore();
  await commit(db);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(FormView, {
      leaf: budgetsLeaf,
      id: String(created.id),
      base: '#/accounting/budgets',
      params: new URLSearchParams(),
    })));

    const nameInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-name');
    assert.equal(props(nameInput)?.readOnly, true);
    assert.equal(find(host, (n) => n.tagName === 'INPUT' && props(n)?.id === 'f-date_from'), null);
    assert.equal(find(host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-budget_type'), null);

    const companySelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id');
    assert.ok(companySelect, 'company_id select must be editable on a confirmed companyless budget');

    await React.act(async () => {
      props(companySelect).onChange({ target: { value: String(branch.id) } });
    });

    // Remains editable while unsaved so the user can adjust before saving.
    assert.ok(find(host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id'));
    const saveBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Save');
    assert.ok(saveBtn, 'Save button must appear after selecting a company');

    await React.act(async () => {
      props(saveBtn).onClick();
    });

    const saved = read(getDb(), 'account.budget', created.id);
    assert.equal(saved.company_id, branch.id);
    assert.equal(saved.state, 'confirmed');
    assert.equal(find(host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-company_id'), null, 'company_id locks after a valid company is saved');
  } finally {
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
});
