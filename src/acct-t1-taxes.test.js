import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, write } from './orm.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { amounts } from './models/common.js';
import { postMove } from './models/accounting.js';
import { accountId, isBalanced } from './models/ledger.js';
import { computeLineTaxes, defaultTaxRepartitionLines, fiscalPositionFor, lineTaxOf, lineUntaxed, taxSnapshot } from './models/taxes.js';
import { createCompany, ensureMainCompany, interCompanyRules } from './models/company.js';
import { cartTotals } from './models/shop.js';

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

async function mountTaxForm(initialDb, id) {
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
  const leaf = findLeafByKey(menusFor('accounting'), 'taxes');
  await React.act(async () => root.render(React.createElement(FormView, {
    leaf,
    id,
    base: '#/accounting/taxes',
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

test('1. division tax computation supports excluded, included, sequential base flags, groups, and Arabic label', async () => {
  const options = models['account.tax'].fields.amount_type.options;
  assert.deepEqual(
    options.find(([val]) => val === 'division'),
    ['division', 'Percentage of Price Tax Included'],
  );

  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {}, removeItem: () => {}, clear: () => {} };
  try {
    const { t } = await import('./i18n.js?lang=ar-division');
    assert.notEqual(t('Percentage of Price Tax Included'), 'Percentage of Price Tax Included');
  } finally {
    globalThis.localStorage = prevStorage;
  }

  let db = seed();
  const taxAcc = accountId(db, '251000');
  const divExcl = create(db, 'account.tax', {
    name: 'Div 10% Excl',
    amount_type: 'division',
    amount: 10,
    price_include: false,
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = divExcl.db;
  const divIncl = create(db, 'account.tax', {
    name: 'Div 10% Incl',
    amount_type: 'division',
    amount: 10,
    price_include: true,
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = divIncl.db;
  const div21Incl = create(db, 'account.tax', {
    name: 'Div 21% Incl',
    amount_type: 'division',
    amount: 21,
    price_include: true,
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = div21Incl.db;

  // Excluded from price: tax = base * rate / (100 - rate)
  const exclLine = { product_id: 1, qty: 1, price_unit: 90, discount: 0, ...taxSnapshot(read(db, 'account.tax', divExcl.id)) };
  assert.deepEqual(amounts([exclLine]), { untaxed: 90, tax: 10, total: 100 });

  const exclDiscLine = { product_id: 1, qty: 2, price_unit: 90, discount: 10, ...taxSnapshot(read(db, 'account.tax', divExcl.id)) };
  assert.deepEqual(amounts([exclDiscLine]), { untaxed: 162, tax: 18, total: 180 });

  // Included in price: tax = price * rate / 100, base = price - tax
  const inclLine = { product_id: 1, qty: 1, price_unit: 100, discount: 0, ...taxSnapshot(read(db, 'account.tax', divIncl.id)) };
  assert.deepEqual(amounts([inclLine]), { untaxed: 90, tax: 10, total: 100 });
  const computedIncl = computeLineTaxes(inclLine, { roundingMethod: 'round_per_line' });
  assert.equal(computedIncl.untaxed, 90);
  assert.equal(computedIncl.tax, 10);
  assert.equal(computedIncl.total, 100);

  const incl21Line = { product_id: 1, qty: 1, price_unit: 100, discount: 0, ...taxSnapshot(read(db, 'account.tax', div21Incl.id)) };
  assert.deepEqual(amounts([incl21Line]), { untaxed: 79, tax: 21, total: 100 });

  // Group tax with division (include_base_amount) + percent (is_base_affected)
  const divBase = create(db, 'account.tax', {
    name: 'Div 10% Base',
    sequence: 1,
    amount_type: 'division',
    amount: 10,
    price_include: true,
    include_base_amount: true,
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = divBase.db;
  const vatAfter = create(db, 'account.tax', {
    name: 'VAT 14% After',
    sequence: 2,
    amount_type: 'percent',
    amount: 14,
    price_include: true,
    is_base_affected: true,
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = vatAfter.db;
  const grpIncl = create(db, 'account.tax', {
    name: 'Div+VAT Incl Group',
    amount_type: 'group',
    children_tax_ids: [divBase.id, vatAfter.id],
  });
  db = grpIncl.db;

  // Base0 = 90 -> Div 10% = 10 -> VAT base = 100 -> VAT 14% = 14 -> total = 114
  const grpLine = { product_id: 1, qty: 1, price_unit: 114, discount: 0, ...taxSnapshot(read(db, 'account.tax', grpIncl.id), db) };
  const grpComputed = computeLineTaxes(grpLine, { roundingMethod: 'round_per_line' });
  assert.equal(grpComputed.untaxed, 90);
  assert.equal(grpComputed.tax, 24);
  assert.equal(grpComputed.total, 114);
  assert.deepEqual(grpComputed.taxes.map((t) => [t.tax_name, t.base, t.amount]), [
    ['Div 10% Base', 90, 10],
    ['VAT 14% After', 100, 14],
  ]);

  // Unaffected subsequent tax (is_base_affected: false)
  const divExclBase = create(db, 'account.tax', {
    name: 'Div 10% Excl Base',
    sequence: 1,
    amount_type: 'division',
    amount: 10,
    price_include: false,
    include_base_amount: true,
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = divExclBase.db;
  const pctUnaffected = create(db, 'account.tax', {
    name: 'Pct 10% Unaffected',
    sequence: 2,
    amount_type: 'percent',
    amount: 10,
    price_include: false,
    is_base_affected: false,
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = pctUnaffected.db;
  const grpExcl = create(db, 'account.tax', {
    name: 'Div+Pct Excl Group',
    amount_type: 'group',
    children_tax_ids: [divExclBase.id, pctUnaffected.id],
  });
  db = grpExcl.db;
  const grpExclLine = { product_id: 1, qty: 1, price_unit: 90, discount: 0, ...taxSnapshot(read(db, 'account.tax', grpExcl.id), db) };
  const grpExclComputed = computeLineTaxes(grpExclLine, { roundingMethod: 'round_per_line' });
  assert.equal(grpExclComputed.untaxed, 90);
  assert.equal(grpExclComputed.tax, 19);
  assert.equal(grpExclComputed.total, 109);

  // Invoice posting uses the division tax computation cleanly
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-04-01',
    invoice_line_ids: [inclLine],
  });
  const posted = postMove(inv.db, inv.id);
  const move = read(posted, 'account.move', inv.id);
  assert.ok(isBalanced(move.line_ids));
  assert.equal(move.line_ids.find((l) => l.account_id === taxAcc)?.credit, 10);
});

test('2. fiscal position account mappings reject cross-company source or destination accounts over diffDb + applyDiff', () => {
  let db = seed();
  const c2 = create(db, 'res.company', { name: 'Second Co', currency_id: read(db, 'res.company', 1).currency_id });
  db = c2.db;

  const accC1Src = create(db, 'account.account', { name: 'C1 Income', code: '401001', account_type: 'income', company_id: 1 });
  db = accC1Src.db;
  const accC1Dest = create(db, 'account.account', { name: 'C1 Alt Income', code: '401002', account_type: 'income', company_id: 1 });
  db = accC1Dest.db;
  const accC2Src = create(db, 'account.account', { name: 'C2 Income', code: '402001', account_type: 'income', company_id: c2.id });
  db = accC2Src.db;
  const accC2Dest = create(db, 'account.account', { name: 'C2 Alt Income', code: '402002', account_type: 'income', company_id: c2.id });
  db = accC2Dest.db;
  const accShared = create(db, 'account.account', { name: 'Shared Income', code: '409001', account_type: 'income' });
  db = accShared.db;

  // Valid: same company (C2 -> C2) and shared account (C2 -> shared)
  const validFp = create(db, 'account.fiscal.position', {
    name: 'Valid C2 FP',
    company_id: c2.id,
    account_ids: [{ account_src_id: accC2Src.id, account_dest_id: accC2Dest.id }],
  });
  const syncedValid = applyDiff(db, diffDb(db, validFp.db), { isAdmin: true });
  assert.equal(read(syncedValid, 'account.fiscal.position', validFp.id).name, 'Valid C2 FP');

  const validShared = write(syncedValid, 'account.fiscal.position', validFp.id, {
    account_ids: [{ account_src_id: accC2Src.id, account_dest_id: accShared.id }],
  });
  assert.doesNotThrow(() => applyDiff(syncedValid, diffDb(syncedValid, validShared), { isAdmin: true }));

  // A source account from another company is allowed: lines can carry it before company resolution (see q110g finding 16).
  const foreignSrc = {
    ...syncedValid,
    records: {
      ...syncedValid.records,
      'account.fiscal.position': syncedValid.records['account.fiscal.position'].map((fp) => (
        fp.id === validFp.id ? { ...fp, account_ids: [{ account_src_id: accC1Src.id, account_dest_id: accC2Dest.id }] } : fp
      )),
    },
  };
  assert.doesNotThrow(() => applyDiff(syncedValid, diffDb(syncedValid, foreignSrc), { isAdmin: true }));

  // Forged diff: C1 destination account in C2 fiscal position
  const forgedBadDest = {
    ...syncedValid,
    records: {
      ...syncedValid.records,
      'account.fiscal.position': syncedValid.records['account.fiscal.position'].map((fp) => (
        fp.id === validFp.id ? { ...fp, account_ids: [{ account_src_id: accC2Src.id, account_dest_id: accC1Dest.id }] } : fp
      )),
    },
  };
  assert.throws(
    () => applyDiff(syncedValid, diffDb(syncedValid, forgedBadDest), { isAdmin: true }),
    /company|belong/i,
  );

  // Forged diff: changing fiscal position company_id to C1 when mappings belong to C2
  const forgedSwitchCompany = {
    ...syncedValid,
    records: {
      ...syncedValid.records,
      'account.fiscal.position': syncedValid.records['account.fiscal.position'].map((fp) => (
        fp.id === validFp.id ? { ...fp, company_id: 1 } : fp
      )),
    },
  };
  assert.throws(
    () => applyDiff(syncedValid, diffDb(syncedValid, forgedSwitchCompany), { isAdmin: true }),
    /company|belong/i,
  );
  // A shared position (no company) may map to any company's account; the mapping is checked when it is applied.
  const shared = create(syncedValid, 'account.fiscal.position', { name: 'Shared FP', account_ids: [{ account_src_id: accC1Src.id, account_dest_id: accC2Dest.id }] });
  assert.doesNotThrow(() => applyDiff(syncedValid, diffDb(syncedValid, { ...shared.db, records: { ...shared.db.records, 'account.fiscal.position': shared.db.records['account.fiscal.position'].map((fp) => (fp.id === shared.id ? { ...fp, company_id: null } : fp)) } }), { isAdmin: true }));
});

test('3. auto-apply fiscal position without country acts as fallback only when no country or zip match applies', () => {
  let db = seed();
  // Fallback has lower sequence (1) than specific country match (20)
  const fpFallback = create(db, 'account.fiscal.position', {
    name: 'Global Fallback',
    auto_apply: true,
    sequence: 1,
    country: '',
  });
  db = fpFallback.db;

  const fpFrance = create(db, 'account.fiscal.position', {
    name: 'France',
    auto_apply: true,
    sequence: 20,
    country: 'France',
  });
  db = fpFrance.db;

  const fpFranceParis = create(db, 'account.fiscal.position', {
    name: 'France Paris',
    auto_apply: true,
    sequence: 10,
    country: 'France',
    zip_from: '75000',
    zip_to: '75999',
  });
  db = fpFranceParis.db;

  const pParis = create(db, 'res.partner', { name: 'Paris Customer', country: 'France', zip: '75001' }); db = pParis.db;
  const pLyon = create(db, 'res.partner', { name: 'Lyon Customer', country: 'France', zip: '69001' }); db = pLyon.db;
  const pSpain = create(db, 'res.partner', { name: 'Madrid Customer', country: 'Spain', zip: '28001' }); db = pSpain.db;
  const pNoCountry = create(db, 'res.partner', { name: 'No Country Customer', country: '' }); db = pNoCountry.db;

  assert.equal(fiscalPositionFor(db, pParis.id, 1), fpFranceParis.id, 'specific zip+country match beats country-only and fallback');
  assert.equal(fiscalPositionFor(db, pLyon.id, 1), fpFrance.id, 'country match beats lower-sequence no-country fallback');
  assert.equal(fiscalPositionFor(db, pSpain.id, 1), fpFallback.id, 'no-country fallback applies when no country match exists');
  assert.equal(fiscalPositionFor(db, pNoCountry.id, 1), fpFallback.id, 'no-country fallback applies when partner has no country');

  // VAT requirement still applies to fallback positions
  const fpFallbackVat = create(db, 'account.fiscal.position', {
    name: 'Global VAT Fallback',
    auto_apply: true,
    sequence: 0,
    country: '',
    vat_required: true,
  });
  db = fpFallbackVat.db;
  const pSpainVat = create(db, 'res.partner', { name: 'Madrid VAT', country: 'Spain', vat: 'ES123456' }); db = pSpainVat.db;
  assert.equal(fiscalPositionFor(db, pSpain.id, 1), fpFallback.id);
  assert.equal(fiscalPositionFor(db, pSpainVat.id, 1), fpFallbackVat.id);
});

test('4. tax form shows Cash Basis Transition Account only when tax exigibility is Based on Payment', async () => {
  const db = seed();
  const vatTax = db.records['account.tax'].find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  assert.equal(vatTax.tax_exigibility, 'on_invoice');

  assert.equal(models['account.tax'].fields.cash_basis_transition_account_id.hideWhen({ tax_exigibility: 'on_invoice' }), true);
  assert.equal(models['account.tax'].fields.cash_basis_transition_account_id.hideWhen({ tax_exigibility: 'on_payment' }), false);

  const ctx = await mountTaxForm(db, vatTax.id);
  try {
    const tabButtons = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab');
    await ctx.React.act(async () => props(tabButtons[1]).onClick());

    const getAdvLabels = () => {
      const advPanel = find(ctx.host, (n) => props(n)?.role === 'tabpanel');
      const advGroups = allFind(advPanel, (n) => hasClass(n, 'group'));
      return fieldLabelsOf(advGroups[1]);
    };

    assert.equal(getAdvLabels().includes('Cash Basis Transition Account'), false);

    // Switch Tax Exigibility to on_payment -> Cash Basis Transition Account appears
    const advPanel = find(ctx.host, (n) => props(n)?.role === 'tabpanel');
    const selects = allFind(advPanel, (n) => n.tagName === 'SELECT');
    const exigSelect = selects.find((s) => props(s)?.value === 'on_invoice');
    assert.ok(exigSelect, 'Tax Exigibility select found');
    await ctx.React.act(async () => props(exigSelect).onChange({ target: { value: 'on_payment' } }));

    assert.equal(getAdvLabels().includes('Cash Basis Transition Account'), true);
  } finally {
    await ctx.done();
  }
});

test('5. a division tax must stay below 100% over diffDb + applyDiff', () => {
  const db = seed();
  const ok = create(db, 'account.tax', { name: 'Div 99', amount_type: 'division', amount: 99, type_tax_use: 'sale' });
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, ok.db), { isAdmin: true }));
  const forged = { ...ok.db, records: { ...ok.db.records, 'account.tax': ok.db.records['account.tax'].map((t) => (t.id === ok.id ? { ...t, amount: 100 } : t)) } };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }), /below 100%/);
});

test('6. an inter-company purchase with a price-included division tax keeps the sold net price', () => {
  const main = ensureMainCompany(seed());
  let db = createCompany(main, { name: 'Buyer Co', currency_id: read(main, 'res.company', 1).currency_id, intercompany_rule: 'sale_purchase' }).db;
  const div = create(db, 'account.tax', { name: 'Div 20 Incl', amount_type: 'division', amount: 20, type_tax_use: 'purchase', price_include: true, company_id: 2 });
  db = write(div.db, 'product', 2, { company_id: null, supplier_tax_id: div.id });
  const sale = create(db, 'sale.order', { company_id: 1, partner_id: read(db, 'res.company', 2).partner_id, order_line: [{ product_id: 2, qty: 1, price_unit: 100, discount: 0, tax: 0, tax_type: 'percent', tax_include: false }] });
  const out = interCompanyRules(write(sale.db, 'sale.order', sale.id, { state: 'sale' }), sale.id);
  const [line] = read(out, 'purchase.order', read(out, 'sale.order', sale.id).auto_purchase_id).order_line;
  assert.equal(line.price_unit, 125);
  assert.equal(Math.round(lineUntaxed(line) * 100) / 100, 100);
  assert.equal(Math.round(lineTaxOf(line) * 100) / 100, 25);
});

test('7. website carts use the same fallback fiscal position as sales orders', () => {
  let db = seed();
  const saleTax = db.records['account.tax'].find((t) => t.type_tax_use === 'sale' && Number(t.amount) === 14 && !t.price_include);
  const fp = create(db, 'account.fiscal.position', { name: 'Any Country', auto_apply: true, sequence: -1 });
  const mapped = create(fp.db, 'account.tax', { name: 'Mapped Zero', amount_type: 'percent', amount: 0, type_tax_use: 'sale', fiscal_position_ids: [fp.id], original_tax_ids: [saleTax.id] });
  db = write(mapped.db, 'product', 2, { tax_id: saleTax.id });
  const cart = cartTotals(db, [{ product_id: 2, qty: 1 }], { partnerCountry: 'Nowhere' });
  assert.equal(cart.orderLines[0].tax_id, mapped.id);
  assert.equal(cart.tax, 0);
});
