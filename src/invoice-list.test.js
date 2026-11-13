import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, emptyDb, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor } from './models/index.js';
import { postMove, payMove } from './models/accounting.js';

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
  const direct = top.children.find((c) => c.key === key);
  if (direct) return direct;
  for (const child of top.children) {
    const nested = child.children?.find((c) => c.key === key);
    if (nested) return nested;
  }
  return null;
};

async function mountMoveList(leaf, initialDb = seed()) {
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
  const { ActionView } = await import('./views/ActionView.jsx');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const params = new URLSearchParams('view=list');
  const render = async (renderLeaf = leaf) => {
    await React.act(async () => root.render(React.createElement(ActionView, {
      leaf: renderLeaf,
      base: `#/accounting/${renderLeaf.key}`,
      params,
    })));
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

const headerLabels = (host) => allFind(host, (n) => n.tagName === 'THEAD')
  .flatMap((thead) => allFind(thead, (n) => n.tagName === 'TH' && !hasClass(n, 'check')))
  .map((th) => th.textContent.trim());

test('customer invoice and vendor bill lists match Odoo 20 column order and labels', async () => {
  const invoicesLeaf = leafFor('Customers', 'invoices');
  const creditNotesLeaf = leafFor('Customers', 'credit-notes');
  const billsLeaf = leafFor('Vendors', 'bills');
  const refundsLeaf = leafFor('Vendors', 'refunds');
  const miscLeaf = leafFor('Accounting', 'misc');

  const ctx = await mountMoveList(invoicesLeaf);
  try {
    assert.deepEqual(headerLabels(ctx.host), [
      'Number', 'Customer', 'Invoice Date', 'Due Date', 'Tax Excluded', 'Total', 'Amount Due', 'Status',
    ]);

    await ctx.render(creditNotesLeaf);
    assert.deepEqual(headerLabels(ctx.host), [
      'Number', 'Customer', 'Invoice Date', 'Due Date', 'Tax Excluded', 'Total', 'Amount Due', 'Status',
    ]);

    await ctx.render(billsLeaf);
    assert.deepEqual(headerLabels(ctx.host), [
      'Number', 'Vendor', 'Bill Date', 'Due Date', 'Tax Excluded', 'Total', 'Amount Due', 'Status',
    ]);

    await ctx.render(refundsLeaf);
    assert.deepEqual(headerLabels(ctx.host), [
      'Number', 'Vendor', 'Bill Date', 'Due Date', 'Tax Excluded', 'Total', 'Amount Due', 'Status',
    ]);

    await ctx.render(miscLeaf);
    assert.deepEqual(headerLabels(ctx.host), [
      'Number', 'Partner', 'Date', 'Due Date', 'Tax Excluded', 'Total', 'Amount Due', 'Status',
    ]);
  } finally {
    await ctx.done();
  }
});

test('invoice and bill list Status column renders a single badge for draft, cancel, not paid, partial, and paid', async () => {
  let db = { ...seed(), records: { ...seed().records, 'account.move': [] } };
  const draftInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-05',
    invoice_date_due: '2026-02-05',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = draftInv.db;

  const cancelledInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-06',
    invoice_date_due: '2026-02-06',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = write(cancelledInv.db, 'account.move', cancelledInv.id, { state: 'cancel' });

  const unpaidInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-07',
    invoice_date_due: '2026-02-07',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(unpaidInv.db, unpaidInv.id);

  const partialInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-08',
    invoice_date_due: '2026-02-08',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(partialInv.db, partialInv.id);
  db = payMove(db, partialInv.id, 120, '2026-01-09');

  const paidInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-10',
    invoice_date_due: '2026-02-10',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 400, tax: 0 }],
  });
  db = postMove(paidInv.db, paidInv.id);
  db = payMove(db, paidInv.id, 400, '2026-01-11');

  const ctx = await mountMoveList(leafFor('Customers', 'invoices'), db);
  try {
    const tbody = find(ctx.host, (n) => n.tagName === 'TBODY');
    const rows = allFind(tbody, (n) => n.tagName === 'TR');
    assert.equal(rows.length, 5);

    const statusBadges = rows.map((tr) => {
      const tds = allFind(tr, (n) => n.tagName === 'TD');
      const statusCell = tds.at(-1);
      const badges = allFind(statusCell, (n) => n.tagName === 'SPAN' && hasClass(n, 'badge'));
      assert.equal(badges.length, 1, 'status cell renders exactly one badge');
      return badges[0].textContent.trim();
    });
    assert.deepEqual(statusBadges, ['Draft', 'Cancelled', 'Not Paid', 'Partially Paid', 'Paid']);
  } finally {
    await ctx.done();
  }
});

test('invoice and bill list footer sums Tax Excluded, Total, and Amount Due in company currency', async () => {
  let db = { ...seed(), records: { ...seed().records, 'account.move': [] } };
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR')
    ?? create(db, 'res.currency', { name: 'EUR', rate_ids: [{ date: '2026-01-01', rate: 2 }] });
  if (eur.db) db = eur.db;
  const eurId = eur.id;
  db = write(db, 'res.currency', eurId, { rate_ids: [{ date: '2026-01-01', rate: 2 }] });

  const vat = create(db, 'account.tax', { name: 'UI List VAT 10%', type_tax_use: 'sale', amount: 10 });
  db = vat.db;

  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-10',
    invoice_date_due: '2026-02-10',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 10, tax_ids: [vat.id] }],
  });
  db = postMove(inv1.db, inv1.id);
  db = payMove(db, inv1.id, 50, '2026-01-12');

  // Foreign currency invoice: 100 EUR untaxed, 110 EUR total, 110 EUR due -> 50 / 55 / 55 USD at rate 2 EUR per USD.
  const inv2 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    currency_id: eurId,
    invoice_date: '2026-01-15',
    invoice_date_due: '2026-02-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 10, tax_ids: [vat.id] }],
  });
  db = postMove(inv2.db, inv2.id);

  const bill1 = create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 7,
    invoice_date: '2026-01-16',
    invoice_date_due: '2026-02-16',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 200, tax: 0 }],
  });
  db = postMove(bill1.db, bill1.id);

  const ctx = await mountMoveList(leafFor('Customers', 'invoices'), db);
  try {
    const tfoot = find(ctx.host, (n) => n.tagName === 'TFOOT');
    assert.ok(tfoot, 'list renders footer totals');
    const cells = allFind(tfoot, (n) => n.tagName === 'TD').map((td) => td.textContent.trim());
    // Leading check column + 8 data columns: Number, Customer, Invoice Date, Due Date, Tax Excluded, Total, Amount Due, Status.
    assert.deepEqual(cells, ['', '', '', '', '', '$150.00', '$165.00', '$115.00', '']);

    await ctx.render(leafFor('Vendors', 'bills'));
    const billFoot = find(ctx.host, (n) => n.tagName === 'TFOOT');
    assert.ok(billFoot, 'vendor bill list renders footer totals');
    const billCells = allFind(billFoot, (n) => n.tagName === 'TD').map((td) => td.textContent.trim());
    assert.deepEqual(billCells, ['', '', '', '', '', '$200.00', '$200.00', '$200.00', '']);
  } finally {
    await ctx.done();
  }
});

test('empty customer invoice and vendor bill lists show Odoo empty-state help without footer sums', async () => {
  const base = seed();
  const emptyMovesDb = {
    ...emptyDb(),
    records: { ...base.records, 'account.move': [] },
    seq: base.seq,
    settings: base.settings,
  };

  const ctx = await mountMoveList(leafFor('Customers', 'invoices'), emptyMovesDb);
  try {
    const emptyCell = find(ctx.host, (n) => n.tagName === 'TD' && hasClass(n, 'empty'));
    assert.ok(emptyCell, 'empty state rendered');
    assert.ok(emptyCell.textContent.includes('Create a customer invoice'));
    assert.ok(emptyCell.textContent.includes('Create invoices, register payments and keep track of the discussions with your customers.'));
    assert.equal(find(ctx.host, (n) => n.tagName === 'TFOOT'), null, 'empty list hides footer sums');

    await ctx.render(leafFor('Vendors', 'bills'));
    const billEmptyCell = find(ctx.host, (n) => n.tagName === 'TD' && hasClass(n, 'empty'));
    assert.ok(billEmptyCell, 'vendor bill empty state rendered');
    assert.ok(billEmptyCell.textContent.includes('Create a vendor bill'));
    assert.ok(billEmptyCell.textContent.includes('Create invoices, register payments and keep track of the discussions with your vendors.'));
    assert.equal(find(ctx.host, (n) => n.tagName === 'TFOOT'), null, 'empty bill list hides footer sums');
  } finally {
    await ctx.done();
  }
});

test('posted misc and bank entries show Posted badge while posted unpaid invoice shows Not Paid', async () => {
  const base = seed();
  let db = { ...base, records: { ...base.records, 'account.move': [] } };
  const journals = search(db, 'account.journal');
  const miscJournal = journals.find((j) => j.type === 'general');
  const bankJournal = journals.find((j) => j.type === 'bank');
  const accounts = search(db, 'account.account').filter((a) => !a.company_id || a.company_id === 1);
  const accA = accounts[0].id;
  const accB = accounts[1].id;

  const miscEntry = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: miscJournal.id,
    date: '2026-01-10',
    line_ids: [
      { account_id: accA, debit: 100, credit: 0 },
      { account_id: accB, debit: 0, credit: 100 },
    ],
  });
  db = postMove(miscEntry.db, miscEntry.id);

  const bankEntry = create(db, 'account.move', {
    move_type: 'entry',
    journal_id: bankJournal.id,
    date: '2026-01-11',
    line_ids: [
      { account_id: accA, debit: 200, credit: 0 },
      { account_id: accB, debit: 0, credit: 200 },
    ],
  });
  db = postMove(bankEntry.db, bankEntry.id);

  const unpaidInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-01-12',
    invoice_date_due: '2026-02-12',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 300, tax: 0 }],
  });
  db = postMove(unpaidInv.db, unpaidInv.id);

  const entriesLeaf = leafFor('Accounting', 'entries');
  const miscLeaf = leafFor('Accounting', 'misc');
  const ctx = await mountMoveList(entriesLeaf, db);
  try {
    const statusByRow = () => {
      const tbody = find(ctx.host, (n) => n.tagName === 'TBODY');
      return allFind(tbody, (n) => n.tagName === 'TR').map((tr) => {
        const tds = allFind(tr, (n) => n.tagName === 'TD');
        const badges = allFind(tds.at(-1), (n) => n.tagName === 'SPAN' && hasClass(n, 'badge'));
        assert.equal(badges.length, 1);
        return badges[0].textContent.trim();
      });
    };

    // Journal Entries list contains misc entry, bank entry, and unpaid invoice.
    assert.deepEqual(statusByRow(), ['Posted', 'Posted', 'Not Paid']);

    await ctx.render(miscLeaf);
    assert.deepEqual(statusByRow(), ['Posted', 'Posted']);
  } finally {
    await ctx.done();
  }
});
