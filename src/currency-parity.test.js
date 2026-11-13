import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { formatCurrency } from './money.js';
import { addDays, today } from './models/common.js';
import { checkAmountDisplay } from './models/payments.js';

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

const currenciesLeaf = () => findLeafByKey(menusFor('accounting'), 'currencies');

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
    getDb,
    render,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

test('res.currency list columns, optional visibility, 6 decimals, toggle switch, and muted inactive rows', async () => {
  const def = models['res.currency'];
  assert.deepEqual(def.list, ['name', 'symbol', 'full_name', 'rate_date', 'rate', 'inverse_rate', 'active']);
  assert.equal(def.fields.full_name.optional, 'show');
  assert.equal(def.fields.inverse_rate.optional, 'hide');

  const { visibleListColumns } = await import('./views/List.jsx');
  const { ActionView } = await import('./views/ActionView.jsx');
  let db = seed();
  const defaultCols = visibleListColumns(def, db, {}).cols;
  assert.deepEqual(defaultCols, ['name', 'symbol', 'full_name', 'rate_date', 'rate', 'active']);
  const withInverse = visibleListColumns(def, db, { inverse_rate: true }).cols;
  assert.deepEqual(withInverse, ['name', 'symbol', 'full_name', 'rate_date', 'rate', 'inverse_rate', 'active']);

  const leaf = currenciesLeaf();
  const ctx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/currencies', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    const headers = allFind(ctx.host, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((th) => th.textContent.replace(/[▲▼]/g, '').trim()).filter(Boolean);
    assert.deepEqual(headers, ['Currency', 'Symbol', 'Name', 'Date', 'Current Rate', 'Active']);

    const eurRow = allFind(ctx.host, (n) => n.tagName === 'TR').find((tr) => tr.textContent.includes('EUR'));
    assert.ok(eurRow, 'EUR row rendered');
    assert.ok(eurRow.textContent.includes('0.900000'), 'Current Rate displays 6 decimals');

    // Editable active toggle switch in list archives EUR; toggling Archived filter reveals muted EUR row
    const eurSwitch = find(eurRow, (n) => n.tagName === 'INPUT' && props(n)?.role === 'switch');
    assert.ok(eurSwitch, 'Active column renders toggle switch');
    assert.equal(props(eurSwitch).checked, true);
    await ctx.React.act(async () => {
      props(eurSwitch).onChange({ target: { checked: false } });
    });
    const eur = search(ctx.getDb(), 'res.currency', { includeArchived: true }).find((c) => c.name === 'EUR');
    assert.equal(eur.active, false);

    // Reveal Archived rows and confirm muted decoration class
    const togglePanelBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    await ctx.React.act(async () => {
      props(togglePanelBtn).onClick();
    });
    const archivedBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Archived');
    await ctx.React.act(async () => {
      props(archivedBtn).onClick();
    });
    const mutedRow = allFind(ctx.host, (n) => n.tagName === 'TR').find((tr) => tr.textContent.includes('EUR'));
    assert.ok(mutedRow && hasClass(mutedRow, 'muted'), 'inactive currency row has muted class');
  } finally {
    await ctx.done();
  }
});

test('res.currency search matches code, full name, symbol, unit and subunit, and Active/Inactive filters work', async () => {
  const { ActionView } = await import('./views/ActionView.jsx');
  const leaf = currenciesLeaf();
  let db = seed();
  const created = create(db, 'res.currency', {
    name: 'JPY',
    full_name: 'Japanese Yen',
    symbol: '¥',
    currency_unit_label: 'Yen',
    currency_subunit_label: 'Sen',
    active: false,
    rate_ids: [{ date: today(), rate: 150, company_id: null }],
  });
  db = created.db;

  const ctx = await mountView(
    (React) => React.createElement(ActionView, { leaf, base: '#/accounting/currencies', params: new URLSearchParams('view=list') }),
    db,
  );
  try {
    // Default hides inactive JPY
    assert.ok(!ctx.host.textContent.includes('JPY'), 'inactive currency hidden by default');
    assert.ok(ctx.host.textContent.includes('USD'), 'active USD shown by default');

    // Free-text search matches subunit label, unit label, symbol, full name, and code
    const searchInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Search Currencies');
    assert.ok(searchInput);
    for (const term of ['Halalas', 'Saudi Riyals', '﷼', 'Saudi Riyal', 'SAR']) {
      await ctx.React.act(async () => {
        props(searchInput).onChange({ target: { value: term } });
      });
      await ctx.React.act(async () => {
        props(searchInput).onKeyDown({ key: 'Enter' });
      });
      assert.ok(ctx.host.textContent.includes('SAR'), `search "${term}" matches SAR`);
      assert.ok(!ctx.host.textContent.includes('USD'), `search "${term}" filters out USD`);
      const removeFacet = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === `Remove filter ${term}`);
      await ctx.React.act(async () => {
        props(removeFacet).onClick();
      });
    }

    // Active / Inactive filter buttons in one group
    const togglePanelBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Toggle search panel');
    await ctx.React.act(async () => {
      props(togglePanelBtn).onClick();
    });
    const inactiveBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Inactive');
    const activeBtn = find(ctx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Active');
    assert.ok(inactiveBtn && activeBtn);

    // Selecting Inactive alone shows JPY only
    await ctx.React.act(async () => {
      props(inactiveBtn).onClick();
    });
    assert.ok(ctx.host.textContent.includes('JPY'), 'Inactive filter shows archived JPY');
    assert.ok(!ctx.host.textContent.includes('USD'), 'Inactive filter excludes active USD');

    // Adding Active in the same group ORs them and shows both USD and JPY
    await ctx.React.act(async () => {
      props(activeBtn).onClick();
    });
    assert.ok(ctx.host.textContent.includes('JPY') && ctx.host.textContent.includes('USD'), 'Active + Inactive shows both');
  } finally {
    await ctx.done();
  }
});

test('res.currency form groups, company banner, hidden Rates tab, and newest-first Unit/Base & Base/Unit editing', async () => {
  const { FormView } = await import('./views/FormView.jsx');
  let db = seed();
  const usd = search(db, 'res.currency').find((c) => c.name === 'USD');
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');

  // 1. Company currency form: info banner + groups + Price Accuracy + no Rates tab
  const usdCtx = await mountView(
    (React) => React.createElement(FormView, {
      model: 'res.currency',
      id: usd.id,
      leaf: currenciesLeaf(),
      base: '#/accounting/currencies',
      params: new URLSearchParams(),
    }),
    db,
  );
  try {
    const infoBanner = find(usdCtx.host, (n) => hasClass(n, 'alert-info'));
    assert.ok(infoBanner, 'company currency displays info banner');
    assert.equal(infoBanner.textContent.trim(), "This is your company's currency.");

    const labels = fieldLabelsOf(usdCtx.host);
    assert.deepEqual(labels, [
      'Currency', 'Name', 'Active',
      'Symbol', 'Currency Unit', 'Currency Subunit', 'Symbol Position',
      'Rounding Factor', 'Decimal Places',
    ]);
    const groupTitles = allFind(usdCtx.host, (n) => hasClass(n, 'group-title')).map((n) => n.textContent.trim());
    assert.deepEqual(groupTitles, ['Price Accuracy']);
    const rateTabs = allFind(usdCtx.host, (n) => props(n)?.role === 'tab');
    assert.equal(rateTabs.length, 0, 'Rates tab hidden for company currency');
  } finally {
    await usdCtx.done();
  }

  // 2. Foreign currency form (multi-company): no banner, Rates tab visible, newest first, Company placeholder, Unit/Base <-> Base/Unit
  const c2 = create(db, 'res.company', { name: 'Euro Co', currency_id: eur.id });
  db = c2.db;
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [
      { date: addDays(today(), -60), rate: 0.92, company_id: null },
      { date: addDays(today(), -1), rate: 0.9, company_id: c2.id },
    ],
  });

  const eurCtx = await mountView(
    (React) => React.createElement(FormView, {
      model: 'res.currency',
      id: eur.id,
      leaf: currenciesLeaf(),
      base: '#/accounting/currencies',
      params: new URLSearchParams(),
    }),
    db,
  );
  try {
    assert.equal(find(eurCtx.host, (n) => hasClass(n, 'alert-info')), null, 'foreign currency has no company banner');
    const rateTab = find(eurCtx.host, (n) => props(n)?.role === 'tab' && n.textContent.trim() === 'Rates');
    assert.ok(rateTab, 'Rates tab shown for foreign currency');

    const rateTable = find(eurCtx.host, (n) => hasClass(n, 'lines'));
    const rateHeaders = allFind(rateTable, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((th) => th.textContent.trim()).filter(Boolean);
    assert.deepEqual(rateHeaders, ['Date', 'Company', 'Base Currency', 'Unit/Base', 'Base/Unit']);

    const bodyRows = allFind(find(rateTable, (n) => n.tagName === 'TBODY'), (n) => n.tagName === 'TR')
      .filter((tr) => !tr.textContent.includes('Add a line'));
    assert.equal(bodyRows.length, 2);
    // Row 0 is newest date (today()-1, rate 0.9, company Euro Co -> Base Currency EUR)
    const row0Date = find(bodyRows[0], (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    const row1Date = find(bodyRows[1], (n) => n.tagName === 'INPUT' && props(n)?.type === 'date');
    assert.equal(props(row0Date).value, addDays(today(), -1));
    assert.equal(props(row1Date).value, addDays(today(), -60));
    assert.ok(bodyRows[0].textContent.includes('EUR'), 'row 0 Base Currency shows Euro Co currency');
    assert.ok(bodyRows[1].textContent.includes('Visible to all'), 'null company_id shows "Visible to all" option');
    assert.ok(bodyRows[1].textContent.includes('USD'), 'row 1 Base Currency defaults to current company currency');

    // Editing Base/Unit updates rate & Unit/Base
    const basePerUnitInput = find(bodyRows[0], (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Base/Unit 1');
    assert.ok(basePerUnitInput);
    await eurCtx.React.act(async () => {
      props(basePerUnitInput).onChange({ target: { value: '2' } });
    });
    const unitPerBaseAfter = find(eurCtx.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Unit/Base 1');
    assert.equal(props(unitPerBaseAfter).value, 0.5);

    // Editing Unit/Base updates rate & Base/Unit
    await eurCtx.React.act(async () => {
      props(unitPerBaseAfter).onChange({ target: { value: '0.25' } });
    });
    const basePerUnitAfter = find(eurCtx.host, (n) => n.tagName === 'INPUT' && props(n)?.['aria-label'] === 'Base/Unit 1');
    assert.equal(props(basePerUnitAfter).value, 4);

    // Save persists stored rate = 0.25 cleanly without extra computed keys on rate_ids
    const saveBtn = find(eurCtx.host, (n) => n.tagName === 'BUTTON' && n.textContent.trim() === 'Save');
    await eurCtx.React.act(async () => {
      props(saveBtn).onClick();
    });
    const saved = read(eurCtx.getDb(), 'res.currency', eur.id);
    const newest = [...saved.rate_ids].sort((a, b) => b.date.localeCompare(a.date))[0];
    assert.equal(newest.rate, 0.25);
    assert.equal('company_rate' in newest, false);
    assert.equal('inverse_company_rate' in newest, false);

    // Toggling Technical Rate optional column shows rate input and keeps it synced
    const menuTrigger = find(rateTable, (n) => n.tagName === 'BUTTON' && props(n)?.['aria-label'] === 'Optional columns');
    await eurCtx.React.act(async () => {
      props(menuTrigger).onClick();
    });
    const techBtn = find(rateTable, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'menuitemcheckbox' && n.textContent.includes('Technical Rate'));
    assert.ok(techBtn, 'Technical Rate optional toggle exists');
    assert.equal(props(techBtn)['aria-checked'], false);
    await eurCtx.React.act(async () => {
      props(techBtn).onClick();
    });
    const rateHeadersAfter = allFind(rateTable, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((th) => th.textContent.trim()).filter(Boolean);
    assert.deepEqual(rateHeadersAfter, ['Date', 'Company', 'Base Currency', 'Unit/Base', 'Base/Unit', 'Technical Rate']);
  } finally {
    await eurCtx.done();
  }

  // 3. Single-company hides Company column on Rates
  const singleCtx = await mountView(
    (React) => React.createElement(FormView, {
      model: 'res.currency',
      id: eur.id,
      leaf: currenciesLeaf(),
      base: '#/accounting/currencies',
      params: new URLSearchParams(),
    }),
    seed(),
  );
  try {
    const rateTable = find(singleCtx.host, (n) => hasClass(n, 'lines'));
    const rateHeaders = allFind(rateTable, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th')).map((th) => th.textContent.trim()).filter(Boolean);
    assert.deepEqual(rateHeaders, ['Date', 'Base Currency', 'Unit/Base', 'Base/Unit']);
  } finally {
    await singleCtx.done();
  }
});

test('migration 43 renames unit_name to currency_unit_label, preserves checkAmountDisplay, and backfills active/position', () => {
  const db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const legacy = {
    ...db,
    schema_version: 41,
    records: {
      ...db.records,
      'res.currency': db.records['res.currency'].map(({ currency_unit_label: label, active: _a, position: _p, ...c }) => (
        c.id === eur.id
          ? { ...c, unit_name: 'Dinars', active: false }
          : { ...c, unit_name: label }
      )),
    },
  };
  const migrated = migrate(legacy);
  assert.equal(migrated.schema_version, 48);
  assert.equal(SCHEMA_VERSION, 48);

  const migratedEur = read(migrated, 'res.currency', eur.id);
  assert.equal(migratedEur.currency_unit_label, 'Dinars');
  assert.equal('unit_name' in migratedEur, false);
  assert.equal(migratedEur.active, false);
  assert.equal(migratedEur.position, 'before');

  const usd = search(migrated, 'res.currency').find((c) => c.name === 'USD');
  assert.equal(usd.currency_unit_label, 'Dollars');
  assert.equal(usd.active, true);
  assert.equal(usd.position, 'before');

  const amountDisplay = checkAmountDisplay(migrated, { currency_id: eur.id }, null, 25);
  assert.ok(amountDisplay.words.includes('Dinars'), 'checkAmountDisplay uses migrated currency_unit_label');
});

test('archived currency is not selectable on new invoice but stays visible on existing invoice', async () => {
  const { FormView } = await import('./views/FormView.jsx');
  let db = seed();
  const customer = search(db, 'res.partner')[0];
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const existingInv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: customer.id,
    currency_id: eur.id,
    invoice_date: today(),
    invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100 }],
  });
  db = write(existingInv.db, 'res.currency', eur.id, { active: false });

  const invoiceLeaf = findLeafByKey(menusFor('accounting'), 'invoices');
  // New invoice: archived EUR must not be offered in currency select
  const newCtx = await mountView(
    (React) => React.createElement(FormView, {
      id: 'new',
      leaf: invoiceLeaf,
      base: '#/accounting/invoices',
      params: new URLSearchParams(),
    }),
    db,
  );
  try {
    const sel = find(newCtx.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-currency_id');
    assert.ok(sel);
    const optValues = allFind(sel, (n) => n.tagName === 'OPTION').map((o) => Number(props(o)?.value)).filter(Boolean);
    assert.ok(!optValues.includes(eur.id), 'archived currency excluded from new invoice options');
  } finally {
    await newCtx.done();
  }

  // Existing invoice referencing archived EUR keeps showing it
  const oldCtx = await mountView(
    (React) => React.createElement(FormView, {
      model: 'account.move',
      id: existingInv.id,
      leaf: invoiceLeaf,
      base: '#/accounting/invoices',
      params: new URLSearchParams(),
    }),
    db,
  );
  try {
    const sel = find(oldCtx.host, (n) => n.tagName === 'SELECT' && props(n)?.id === 'f-currency_id');
    assert.ok(sel);
    const optTexts = allFind(sel, (n) => n.tagName === 'OPTION').map((o) => o.textContent.trim());
    assert.ok(optTexts.includes('EUR'), 'existing invoice still shows archived currency');
  } finally {
    await oldCtx.done();
  }
});

test('formatCurrency honours position before and after amount', () => {
  assert.equal(formatCurrency(12.5, { name: 'EUR', symbol: '€', rounding: 0.01, position: 'before' }), '€12.50');
  assert.equal(formatCurrency(12.5, { name: 'EUR', symbol: '€', rounding: 0.01, position: 'after' }), '12.50 €');
  assert.equal(formatCurrency(-12.5, { name: 'EUR', symbol: '€', rounding: 0.01, position: 'after' }), '-12.50 €');
  assert.equal(formatCurrency(12.5, { name: 'XTS', symbol: '¤', rounding: 0.01, position: 'before' }), '¤12.50');
  assert.equal(formatCurrency(12.5, { name: 'EUR', symbol: '€', rounding: 0.01, position: 'after' }, ''), '12.50');
});
