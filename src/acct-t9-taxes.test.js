import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import * as ledger from './models/ledger.js';
import { defaultTaxRepartitionLines, fiscalPositionFor, replaceTaxSnapshot, taxGroups, taxSnapshot } from './models/taxes.js';
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

async function mountForm(initialDb, { model, leafKey, id, base }) {
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
  const { initStore, commit } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  await commit(initialDb);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const leaf = findLeafByKey(menusFor('accounting'), leafKey);
  await React.act(async () => root.render(React.createElement(FormView, {
    model,
    leaf,
    id,
    base,
    params: new URLSearchParams('view=form'),
  })));
  return {
    React,
    host,
    done: async () => {
      await React.act(async () => root.unmount());
      globalThis.localStorage = prevStorage;
    },
  };
}

test('TAX-9: res.country.group model and fiscal position country_group_id/state_ids fields + guards', () => {
  assert.ok(models['res.country.group'], 'res.country.group model is registered');
  assert.ok(models['res.country.group'].fields.name, 'res.country.group has name');
  assert.ok(models['res.country.group'].fields.country_ids, 'res.country.group has country_ids');
  assert.equal(models['account.fiscal.position'].fields.country_group_id?.relation, 'res.country.group');
  assert.ok(models['account.fiscal.position'].fields.state_ids, 'account.fiscal.position has state_ids');
  assert.ok(models['res.partner'].fields.state, 'res.partner declares state');

  let db = seed();
  const group = create(db, 'res.country.group', { name: 'GCC', country_ids: ['UAE', 'Saudi Arabia'] });
  db = applyDiff(db, diffDb(db, group.db), { isAdmin: true });
  assert.deepEqual(read(db, 'res.country.group', group.id).country_ids, ['UAE', 'Saudi Arabia']);

  const fp = create(db, 'account.fiscal.position', {
    name: 'GCC Sales',
    auto_apply: true,
    country_group_id: group.id,
    state_ids: ['Dubai'],
  });
  db = applyDiff(db, diffDb(db, fp.db), { isAdmin: true });
  assert.equal(read(db, 'account.fiscal.position', fp.id).country_group_id, group.id);
  assert.deepEqual(read(db, 'account.fiscal.position', fp.id).state_ids, ['Dubai']);

  // Guard rejects dangling country_group_id via diffDb + applyDiff
  const forged = {
    ...db,
    records: {
      ...db.records,
      'account.fiscal.position': db.records['account.fiscal.position'].map((r) => (
        r.id === fp.id ? { ...r, country_group_id: 999999 } : r
      )),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /country group/i);

  // Guard rejects blank country group name via diffDb + applyDiff
  const blankGroup = {
    ...db,
    records: {
      ...db.records,
      'res.country.group': db.records['res.country.group'].map((r) => (
        r.id === group.id ? { ...r, name: '   ' } : r
      )),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, blankGroup), { isAdmin: true }), /name/i);
});

test('TAX-9: fiscalPositionFor matches country group, states, and zip with Odoo specificity order without name inference', () => {
  const base = seed();
  let db = base;
  const eu = create(db, 'res.country.group', { name: 'European Union', country_ids: ['France', 'Germany'] });
  db = eu.db;
  const na = create(db, 'res.country.group', { name: 'North America', country_ids: ['United States', 'Canada'] });
  db = na.db;

  // Lower sequence on broader rules must NOT beat more specific rules
  const fpFallback = create(db, 'account.fiscal.position', { name: 'Fallback', auto_apply: true, sequence: 1 });
  db = fpFallback.db;
  const fpEu = create(db, 'account.fiscal.position', { name: 'EU B2C', auto_apply: true, sequence: 2, country_group_id: eu.id });
  db = fpEu.db;
  const fpNa = create(db, 'account.fiscal.position', { name: 'United States', auto_apply: true, sequence: 3, country_group_id: na.id });
  db = fpNa.db;
  const fpUs = create(db, 'account.fiscal.position', { name: 'US National', auto_apply: true, sequence: 10, country: 'United States' });
  db = fpUs.db;
  const fpUsZip = create(db, 'account.fiscal.position', {
    name: 'US 900xx', auto_apply: true, sequence: 20, country: 'United States', zip_from: '90000', zip_to: '90099',
  });
  db = fpUsZip.db;
  const fpCa = create(db, 'account.fiscal.position', {
    name: 'California', auto_apply: true, sequence: 30, country: 'United States', state_ids: ['California', 'CA'],
  });
  db = fpCa.db;
  const fpCaLaZip = create(db, 'account.fiscal.position', {
    name: 'LA Zip', auto_apply: true, sequence: 40, country: 'United States', state_ids: ['California'], zip_from: '90000', zip_to: '90099',
  });
  db = fpCaLaZip.db;

  const pLa = create(db, 'res.partner', { name: 'LA Co', country: 'United States', state: 'California', zip: '90012' });
  db = pLa.db;
  const pSf = create(db, 'res.partner', { name: 'SF Co', country: 'United States', state: 'CA', zip: '94105' });
  db = pSf.db;
  const pOtherCaZip = create(db, 'res.partner', { name: 'Nevada 90012', country: 'United States', state: 'Nevada', zip: '90012' });
  db = pOtherCaZip.db;
  const pNy = create(db, 'res.partner', { name: 'NY Co', country: 'United States', state: 'New York', zip: '10001' });
  db = pNy.db;
  const pCanada = create(db, 'res.partner', { name: 'Toronto Co', country: 'Canada', state: 'Ontario', zip: 'M5V' });
  db = pCanada.db;
  const pGermany = create(db, 'res.partner', { name: 'Berlin Co', country: 'Germany', zip: '10115' });
  db = pGermany.db;
  const pCityTrick = create(db, 'res.partner', { name: 'European Union', country: 'Brazil', city: 'California' });
  db = pCityTrick.db;

  // Persist through diffDb + applyDiff to prove state survives server sanitizer
  db = applyDiff(base, diffDb(base, db), { isAdmin: true });

  assert.equal(fiscalPositionFor(db, pLa.id, 1), fpCaLaZip.id, 'country + state + zip beats all less specific');
  assert.equal(fiscalPositionFor(db, pSf.id, 1), fpCa.id, 'country + state beats country + zip, country only, and group');
  assert.equal(fiscalPositionFor(db, pOtherCaZip.id, 1), fpUsZip.id, 'country + zip beats country only');
  assert.equal(fiscalPositionFor(db, pNy.id, 1), fpUs.id, 'country only beats country group');
  assert.equal(fiscalPositionFor(db, pCanada.id, 1), fpNa.id, 'country group matches member country');
  assert.equal(fiscalPositionFor(db, pGermany.id, 1), fpEu.id, 'EU country group matches Germany');
  assert.equal(fiscalPositionFor(db, pCityTrick.id, 1), fpFallback.id, 'never matches partner name/city or group name');
});

test('TAX-14: taxSnapshot carries tax_group_id and invoiceTaxTotals groups by tax group with preceding_subtotal', async () => {
  assert.equal(typeof ledger.invoiceTaxTotals, 'function', 'invoiceTaxTotals helper is exported');
  let db = seed();
  const taxAcc = search(db, 'account.account').find((a) => a.code === '251000');

  const gVat = create(db, 'account.tax.group', { name: 'VAT Group', sequence: 10, company_id: 1 });
  db = gVat.db;
  const gEco = create(db, 'account.tax.group', { name: 'Eco Tax', sequence: 20, company_id: 1, preceding_subtotal: 'Subtotal after VAT' });
  db = gEco.db;
  const gCity = create(db, 'account.tax.group', { name: 'City Levy', sequence: 30, company_id: 1 });
  db = gCity.db;

  const tVat14 = create(db, 'account.tax', {
    name: 'VAT 14% G', type_tax_use: 'sale', amount: 14, tax_group_id: gVat.id, ...defaultTaxRepartitionLines(taxAcc.id),
  });
  db = tVat14.db;
  const tVat5 = create(db, 'account.tax', {
    name: 'VAT 5% G', type_tax_use: 'sale', amount: 5, tax_group_id: gVat.id, ...defaultTaxRepartitionLines(taxAcc.id),
  });
  db = tVat5.db;
  const tEco = create(db, 'account.tax', {
    name: 'Eco Fixed 10', type_tax_use: 'sale', amount_type: 'fixed', amount: 10, tax_group_id: gEco.id, ...defaultTaxRepartitionLines(taxAcc.id),
  });
  db = tEco.db;
  const tCity = create(db, 'account.tax', {
    name: 'City 2%', type_tax_use: 'sale', amount: 2, tax_group_id: gCity.id, ...defaultTaxRepartitionLines(taxAcc.id),
  });
  db = tCity.db;

  const s14 = taxSnapshot(read(db, 'account.tax', tVat14.id));
  const s5 = taxSnapshot(read(db, 'account.tax', tVat5.id));
  const sEco = taxSnapshot(read(db, 'account.tax', tEco.id));
  const sCity = taxSnapshot(read(db, 'account.tax', tCity.id));
  assert.equal(s14.tax_group_id, gVat.id);
  assert.equal(s5.tax_group_id, gVat.id);
  assert.equal(replaceTaxSnapshot(taxSnapshot(null)).tax_group_id, null);

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_line_ids: [
      { product_id: 1, qty: 1, price_unit: 100, ...s14 },
      { product_id: 1, qty: 1, price_unit: 100, ...s5 },
      { product_id: 1, qty: 1, price_unit: 100, ...sEco },
      { product_id: 1, qty: 1, price_unit: 100, ...sCity },
    ],
  });
  db = applyDiff(db, diffDb(db, inv.db), { isAdmin: true });
  const move = read(db, 'account.move', inv.id);

  // Snapshot tax_group_id survives sync and taxGroups carries it
  assert.equal(move.invoice_line_ids[0].tax_group_id, gVat.id);
  assert.ok(taxGroups(move.invoice_line_ids, () => null).every((g) => g.tax_group_id != null));

  // Totals must equal today's totals: untaxed 400, tax 14+5+10+2 = 31, total 431
  assert.equal(move.amount_untaxed, 400);
  assert.equal(move.amount_tax, 31);
  assert.equal(move.amount_total, 431);

  const totals = ledger.invoiceTaxTotals(db, move);
  assert.equal(totals.untaxed, 400);
  assert.equal(totals.tax, 31);
  assert.equal(totals.total, 431);
  assert.deepEqual(
    totals.subtotals.map((s) => ({
      name: s.name,
      amount: s.amount,
      groups: s.groups.map((g) => ({ name: g.name, amount: g.amount })),
    })),
    [
      {
        name: 'Untaxed Amount',
        amount: 400,
        groups: [{ name: 'VAT Group', amount: 19 }],
      },
      {
        name: 'Subtotal after VAT',
        amount: 419,
        groups: [
          { name: 'Eco Tax', amount: 10 },
          { name: 'City Levy', amount: 2 },
        ],
      },
    ],
  );

  // Invoice FormView renders the grouped tax lines and preceding_subtotal
  const ctx = await mountForm(db, { model: 'account.move', leafKey: 'invoices', id: move.id, base: '#/accounting/invoices' });
  try {
    const dl = find(ctx.host, (n) => n.tagName === 'DL' && hasClass(n, 'totals'));
    assert.ok(dl, 'renders totals dl');
    const rows = allFind(dl, (n) => n.tagName === 'DIV').map((div) => [
      find(div, (n) => n.tagName === 'DT')?.textContent?.trim(),
      find(div, (n) => n.tagName === 'DD')?.textContent?.trim(),
    ]);
    assert.deepEqual(rows.map(([k]) => k), [
      'Untaxed Amount',
      'VAT Group',
      'Subtotal after VAT',
      'Eco Tax',
      'City Levy',
      'Total',
      'Amount Due',
    ]);
    assert.ok(rows[0][1].includes('400.00'));
    assert.ok(rows[1][1].includes('19.00'));
    assert.ok(rows[2][1].includes('419.00'));
    assert.ok(rows[3][1].includes('10.00'));
    assert.ok(rows[4][1].includes('2.00'));
    assert.ok(rows[5][1].includes('431.00'));
  } finally {
    await ctx.done();
  }

  // First group having preceding_subtotal replaces 'Untaxed Amount'
  const dbFirstSub = write(db, 'account.tax.group', gVat.id, { preceding_subtotal: 'Base Total' });
  const firstTotals = ledger.invoiceTaxTotals(dbFirstSub, read(dbFirstSub, 'account.move', inv.id));
  assert.equal(firstTotals.subtotals[0].name, 'Base Total');
  assert.equal(firstTotals.subtotals[0].amount, 400);

  // Posted invoice + PrintDoc also render grouped tax totals and preceding_subtotal
  const posted = postMove(db, inv.id);
  const postedMove = read(posted, 'account.move', inv.id);
  assert.equal(postedMove.amount_untaxed, 400);
  assert.equal(postedMove.amount_tax, 31);
  assert.equal(postedMove.amount_total, 431);
  const { PrintDoc } = await import('./views/PrintDoc.jsx');
  const printHost = globalThis.document.createElement('div');
  printHost.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  await initStore();
  await commit(posted);
  const printRoot = createRoot(printHost);
  try {
    await React.act(async () => printRoot.render(React.createElement(PrintDoc, { model: 'account.move', id: inv.id })));
    const paperTotals = find(printHost, (n) => n.tagName === 'DL' && hasClass(n, 'paper-totals'));
    const printKeys = allFind(paperTotals, (n) => n.tagName === 'DT').map((n) => n.textContent.trim());
    assert.deepEqual(printKeys, ['Untaxed Amount', 'VAT Group', 'Subtotal after VAT', 'Eco Tax', 'City Levy', 'Total', 'Amount Due']);
  } finally {
    await React.act(async () => printRoot.unmount());
  }

  // Legacy invoice lines without tax_group_id on the snapshot still group by account.tax.group
  const legacyDb = {
    ...db,
    records: {
      ...db.records,
      'account.move': db.records['account.move'].map((m) => (
        m.id === move.id
          ? { ...m, invoice_line_ids: m.invoice_line_ids.map(({ tax_group_id: _drop, ...rest }) => rest) }
          : m
      )),
    },
  };
  const legacyTotals = ledger.invoiceTaxTotals(legacyDb, read(legacyDb, 'account.move', move.id));
  assert.deepEqual(
    legacyTotals.subtotals.map((s) => ({ name: s.name, amount: s.amount, groups: s.groups.map((g) => ({ name: g.name, amount: g.amount })) })),
    totals.subtotals.map((s) => ({ name: s.name, amount: s.amount, groups: s.groups.map((g) => ({ name: g.name, amount: g.amount })) })),
  );
});

test('TAX-15: Cash Basis Transition Account is shown on account.tax form only when Tax Exigibility is on_payment', async () => {
  assert.equal(models['account.tax'].fields.cash_basis_transition_account_id.hideWhen({ amount_type: 'percent', tax_exigibility: 'on_invoice' }), true);
  assert.equal(models['account.tax'].fields.cash_basis_transition_account_id.hideWhen({ amount_type: 'group', tax_exigibility: 'on_invoice' }), true);
  assert.equal(models['account.tax'].fields.cash_basis_transition_account_id.hideWhen({ amount_type: 'group', tax_exigibility: 'on_payment' }), false);
  assert.equal(models['account.tax'].fields.cash_basis_transition_account_id.hideWhen({ amount_type: 'percent', tax_exigibility: 'on_payment' }), false);

  let db = seed();
  const vat = db.records['account.tax'].find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const groupTax = create(db, 'account.tax', {
    name: 'Group Exigibility Check',
    amount_type: 'group',
    type_tax_use: 'sale',
    tax_exigibility: 'on_invoice',
    children_tax_ids: [vat.id],
  });
  db = groupTax.db;

  const ctx = await mountForm(db, { model: 'account.tax', leafKey: 'taxes', id: groupTax.id, base: '#/accounting/taxes' });
  try {
    const tabButtons = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab');
    await ctx.React.act(async () => props(tabButtons[1]).onClick());

    const getAdvLabels = () => {
      const advPanel = find(ctx.host, (n) => props(n)?.role === 'tabpanel');
      const advGroups = allFind(advPanel, (n) => hasClass(n, 'group'));
      return fieldLabelsOf(advGroups[1]);
    };

    assert.equal(getAdvLabels().includes('Cash Basis Transition Account'), false, 'hidden for group tax when on_invoice');

    const advPanel = find(ctx.host, (n) => props(n)?.role === 'tabpanel');
    const selects = allFind(advPanel, (n) => n.tagName === 'SELECT');
    const exigSelect = selects.find((s) => props(s)?.value === 'on_invoice');
    assert.ok(exigSelect, 'Tax Exigibility select found');
    await ctx.React.act(async () => props(exigSelect).onChange({ target: { value: 'on_payment' } }));

    assert.equal(getAdvLabels().includes('Cash Basis Transition Account'), true, 'shown when switched to on_payment');
  } finally {
    await ctx.done();
  }
});
