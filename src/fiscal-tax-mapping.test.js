import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setupDom, find } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { menusFor, models } from './models/index.js';
import { amounts } from './models/common.js';
import { postMove } from './models/accounting.js';
import { isBalanced } from './models/ledger.js';
import { fiscalPositionFor, expandTaxIds } from './models/taxes.js';
import { priceLines, startSession } from './models/pos.js';
import { migrate } from './migrations.js';

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

test('invoice line with the Export position gets 0% export instead of 14%', () => {
  const db = seed();
  const exportFp = search(db, 'account.fiscal.position').find((f) => f.name === 'Export');
  const zeroExport = search(db, 'account.tax').find((t) => t.name === '0% Exports');
  const vatSale = search(db, 'account.tax').find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  assert.deepEqual(zeroExport.fiscal_position_ids, [exportFp.id]);
  assert.deepEqual(zeroExport.original_tax_ids, [vatSale.id]);

  const lineField = models['account.move'].fields.invoice_line_ids;
  const domesticLine = lineField.onchange({ product_id: 1, qty: 2 }, 'product_id', db, { move_type: 'out_invoice', company_id: 1 });
  assert.equal(domesticLine.tax_id, vatSale.id);
  assert.equal(domesticLine.tax, 14);

  const exportLine = lineField.onchange({ product_id: 1, qty: 2 }, 'product_id', db, { move_type: 'out_invoice', fiscal_position_id: exportFp.id, company_id: 1 });
  assert.equal(exportLine.tax_id, zeroExport.id);
  assert.equal(exportLine.tax, 0);
  assert.equal(exportLine.tax_name, '0% Exports');
  assert.equal(exportLine.tax_source_id, vatSale.id);
  assert.deepEqual(amounts([exportLine]), { untaxed: 420, tax: 0, total: 420 });
});

test('a global tax without a replacement stays', () => {
  const db = seed();
  const exportFp = search(db, 'account.fiscal.position').find((f) => f.name === 'Export');
  const stamp = search(db, 'account.tax').find((t) => t.name === 'Stamp Duty');
  assert.deepEqual(stamp.fiscal_position_ids, []);

  const prod = create(db, 'product', { name: 'Stamped Service', type: 'service', list_price: 100, tax_id: stamp.id });
  const lineField = models['account.move'].fields.invoice_line_ids;
  const line = lineField.onchange({ product_id: prod.id, qty: 2 }, 'product_id', prod.db, { move_type: 'out_invoice', fiscal_position_id: exportFp.id, company_id: 1 });
  assert.equal(line.tax_id, stamp.id);
  assert.equal(line.tax_type, 'fixed');
  assert.equal(line.tax, 5);
  assert.deepEqual(amounts([line]), { untaxed: 200, tax: 10, total: 210 });
});

test('a tax linked only to another position is dropped', () => {
  const db = seed();
  const domesticFp = search(db, 'account.fiscal.position').find((f) => f.name === 'Domestic');
  const exportFp = search(db, 'account.fiscal.position').find((f) => f.name === 'Export');
  const localTax = create(db, 'account.tax', {
    name: 'Domestic Only 8%',
    type_tax_use: 'sale',
    amount: 8,
    fiscal_position_ids: [domesticFp.id],
    original_tax_ids: [],
  });
  const prod = create(localTax.db, 'product', { name: 'Local Item', type: 'service', list_price: 100, tax_id: localTax.id });
  const lineField = models['account.move'].fields.invoice_line_ids;

  const kept = lineField.onchange({ product_id: prod.id, qty: 1 }, 'product_id', prod.db, { move_type: 'out_invoice', fiscal_position_id: domesticFp.id, company_id: 1 });
  assert.equal(kept.tax_id, localTax.id);
  assert.equal(amounts([kept]).tax, 8);

  const dropped = lineField.onchange({ product_id: prod.id, qty: 1 }, 'product_id', prod.db, { move_type: 'out_invoice', fiscal_position_id: exportFp.id, company_id: 1 });
  assert.equal(dropped.tax_id, null);
  assert.equal(dropped.tax, 0);
  assert.equal(dropped.tax_source_id, localTax.id);
  assert.deepEqual(amounts([dropped]), { untaxed: 100, tax: 0, total: 100 });
});

test('one tax replaced by two', () => {
  const db0 = seed();
  const splitFp = create(db0, 'account.fiscal.position', { name: 'Dual Levy Regime' });
  const srcTax = create(splitFp.db, 'account.tax', { name: 'Standard 15%', type_tax_use: 'sale', amount: 15 });
  const secondTax = create(srcTax.db, 'account.tax', {
    name: 'State 10%',
    type_tax_use: 'sale',
    amount: 10,
    sequence: 20,
    fiscal_position_ids: [splitFp.id],
    original_tax_ids: [srcTax.id],
  });
  const firstTax = create(secondTax.db, 'account.tax', {
    name: 'City 5%',
    type_tax_use: 'sale',
    amount: 5,
    sequence: 5,
    fiscal_position_ids: [splitFp.id],
    original_tax_ids: [srcTax.id],
  });
  const prod = create(firstTax.db, 'product', { name: 'Split Tax Item', type: 'service', list_price: 200, tax_id: srcTax.id });
  const db = prod.db;

  // 1. expandTaxIds returns both replacements ordered by sequence
  assert.deepEqual(expandTaxIds(db, [srcTax.id], splitFp.id).map((t) => t.id), [firstTax.id, secondTax.id]);

  // 2. Invoice line onchange maps the product tax to both taxes
  const lineField = models['account.move'].fields.invoice_line_ids;
  const invLine = lineField.onchange({ product_id: prod.id, qty: 1 }, 'product_id', db, { move_type: 'out_invoice', fiscal_position_id: splitFp.id, company_id: 1 });
  assert.equal(invLine.tax_id, firstTax.id);
  assert.deepEqual(invLine.tax_ids, [firstTax.id, secondTax.id]);
  assert.equal(invLine.tax_breakdown.length, 2);
  assert.equal(invLine.tax_source_id, srcTax.id);
  assert.deepEqual(amounts([invLine]), { untaxed: 200, tax: 30, total: 230 });

  const move = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    fiscal_position_id: splitFp.id,
    invoice_date: '2026-04-01',
    invoice_line_ids: [invLine],
  });
  const posted = postMove(move.db, move.id);
  const postedMove = read(posted, 'account.move', move.id);
  assert.ok(isBalanced(postedMove.line_ids));
  assert.deepEqual(
    postedMove.line_ids.filter((l) => l.tax_name).map((l) => [l.tax_name, l.credit]),
    [['City 5%', 10], ['State 10%', 20]],
  );

  // 3. Sale order fiscal_position_id onchange preserves multi-tax replacement
  const soChanged = models['sale.order'].onchange(
    { fiscal_position_id: splitFp.id, company_id: 1, order_line: [{ product_id: prod.id, qty: 1, price_unit: 200 }] },
    'fiscal_position_id',
    db,
  );
  assert.deepEqual(soChanged.order_line[0].tax_ids, [firstTax.id, secondTax.id]);
  assert.equal(amounts(soChanged.order_line).tax, 30);

  // 4. POS priceLines applies both replacement taxes
  const posDb = startSession(db, 0).db;
  const posLines = priceLines(posDb, [{ product_id: prod.id, qty: 1 }], null, { fiscalPositionId: splitFp.id });
  assert.equal(amounts(posLines).tax, 30);
});

test('the migration converts old rows and reports an empty-destination row', () => {
  const base = seed();
  const vatSale = base.records['account.tax'].find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  const vatPurchase = base.records['account.tax'].find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'purchase');
  const zeroExport = base.records['account.tax'].find((t) => t.name === '0% Exports');
  const zeroImport = base.records['account.tax'].find((t) => t.name === '0% Imports');
  const stamp = base.records['account.tax'].find((t) => t.name === 'Stamp Duty');
  const domesticFp = base.records['account.fiscal.position'].find((f) => f.name === 'Domestic');
  const exportFp = base.records['account.fiscal.position'].find((f) => f.name === 'Export');

  const legacy = {
    ...base,
    schema_version: 36,
    records: {
      ...base.records,
      'account.tax': base.records['account.tax'].map((t) => ({ ...t, fiscal_position_ids: [], original_tax_ids: [] })),
      'account.fiscal.position': base.records['account.fiscal.position'].map((fp) => {
        if (fp.id === exportFp.id) {
          return {
            ...fp,
            tax_ids: [
              { tax_src_id: vatSale.id, tax_dest_id: zeroExport.id },
              { tax_src_id: vatPurchase.id, tax_dest_id: zeroImport.id },
              { tax_src_id: stamp.id, tax_dest_id: null },
            ],
          };
        }
        if (fp.id === domesticFp.id) {
          return {
            ...fp,
            tax_ids: [{ tax_src_id: stamp.id, tax_dest_id: null }],
          };
        }
        return fp;
      }),
    },
  };

  const beforeMsgCount = (legacy.messages ?? []).length;
  const migrated = migrate(legacy);

  const nextZeroExport = read(migrated, 'account.tax', zeroExport.id);
  const nextZeroImport = read(migrated, 'account.tax', zeroImport.id);
  assert.deepEqual(nextZeroExport.fiscal_position_ids, [exportFp.id]);
  assert.deepEqual(nextZeroExport.original_tax_ids, [vatSale.id]);
  assert.deepEqual(nextZeroImport.fiscal_position_ids, [exportFp.id]);
  assert.deepEqual(nextZeroImport.original_tax_ids, [vatPurchase.id]);

  for (const fp of migrated.records['account.fiscal.position']) {
    assert.equal('tax_ids' in fp, false);
  }

  const addedNotes = (migrated.messages ?? []).slice(beforeMsgCount);
  assert.equal(addedNotes.length, 2);
  assert.ok(addedNotes.every((m) => m.model === 'account.fiscal.position' && m.kind === 'note' && m.body.includes('Stamp Duty')));
});

test('zip range detection', () => {
  let db = seed();
  assert.equal(models['res.partner'].fields.zip?.type, 'char');
  assert.ok(models['res.partner'].form.groups[1].includes('zip'));

  const fpCairo = create(db, 'account.fiscal.position', {
    name: 'Cairo Zone',
    country: 'Egypt',
    auto_apply: true,
    sequence: 1,
    zip_from: '11000',
    zip_to: '11999',
  });
  db = fpCairo.db;
  const fpNorth = create(db, 'account.fiscal.position', {
    name: 'Alexandria & North',
    country: 'Egypt',
    auto_apply: true,
    sequence: 2,
    zip_from: '21000',
    zip_to: '29999',
  });
  db = fpNorth.db;
  const fpSouthOpen = create(db, 'account.fiscal.position', {
    name: 'Upper Egypt',
    country: 'Egypt',
    auto_apply: true,
    sequence: 3,
    zip_from: '80000',
    zip_to: '',
  });
  db = fpSouthOpen.db;
  const fpFallback = create(db, 'account.fiscal.position', {
    name: 'Egypt General',
    country: 'Egypt',
    auto_apply: true,
    sequence: 10,
  });
  db = fpFallback.db;

  const pCairo = create(db, 'res.partner', { name: 'Cairo Partner', country: 'Egypt', zip: ' 11511 ' }); db = pCairo.db;
  const pBound = create(db, 'res.partner', { name: 'Boundary Partner', country: 'Egypt', zip: '21000' }); db = pBound.db;
  const pSouth = create(db, 'res.partner', { name: 'Aswan Partner', country: 'Egypt', zip: '81511' }); db = pSouth.db;
  const pOtherZip = create(db, 'res.partner', { name: 'Sinai Partner', country: 'Egypt', zip: '45000' }); db = pOtherZip.db;
  const pNoZip = create(db, 'res.partner', { name: 'No Zip Partner', country: 'Egypt', zip: '' }); db = pNoZip.db;

  assert.equal(fiscalPositionFor(db, pCairo.id, 1), fpCairo.id);
  assert.equal(fiscalPositionFor(db, pBound.id, 1), fpNorth.id);
  assert.equal(fiscalPositionFor(db, pSouth.id, 1), fpSouthOpen.id);
  assert.equal(fiscalPositionFor(db, pOtherZip.id, 1), fpFallback.id);
  assert.equal(fiscalPositionFor(db, pNoZip.id, 1), fpFallback.id);

});

test('the fiscal position form shows the two tabs and no tax mapping', async () => {
  const baseDb = seed();
  const exportFp = search(baseDb, 'account.fiscal.position').find((f) => f.name === 'Export');
  const leaf = findLeafByKey(menusFor('accounting'), 'fiscal-positions');
  const { FormView } = await import('./views/FormView.jsx');
  const { ActionView } = await import('./views/ActionView.jsx');

  const ctx = await mountView(
    (React) => React.createElement(FormView, {
      leaf,
      id: exportFp.id,
      base: '#/accounting/fiscal-positions',
      params: new URLSearchParams('view=form'),
    }),
    baseDb,
  );
  try {
    assert.equal('tax_ids' in models['account.fiscal.position'].fields, false);
    const titleInput = find(ctx.host, (n) => n.tagName === 'INPUT' && props(n)?.value === 'Export');
    assert.ok(titleInput, 'renders title name input');

    const topGroups = allFind(ctx.host, (n) => n.tagName === 'DIV' && hasClass(n, 'group')).slice(0, 2);
    assert.deepEqual(
      fieldLabelsOf(topGroups[0]),
      ['Detect Automatically', 'VAT Required', 'Foreign Tax ID', 'Country', 'Zip Range'],
    );
    const zipInputs = allFind(topGroups[0], (n) => n.tagName === 'INPUT' && ['f-zip_from', 'f-zip_to'].includes(props(n)?.id));
    assert.equal(zipInputs.length, 2, 'renders zip_from and zip_to inside Zip Range');

    const tabButtons = allFind(ctx.host, (n) => n.tagName === 'BUTTON' && props(n)?.role === 'tab');
    assert.deepEqual(tabButtons.map((b) => b.textContent.trim()), ['Account Mapping', 'Legal Notes']);
    assert.equal(allFind(ctx.host, (n) => n.textContent?.trim() === 'Tax Mapping').length, 0);

    const accTable = find(ctx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'lines'));
    const headers = allFind(accTable, (n) => n.tagName === 'TH' && !hasClass(n, 'o2m-cols-th'))
      .map((th) => th.textContent.trim())
      .filter(Boolean);
    assert.deepEqual(headers, ['Product Account', 'Account to use instead']);

    const chatter = find(ctx.host, (n) => hasClass(n, 'chatter'));
    assert.ok(chatter, 'keeps the chatter');
  } finally {
    await ctx.done();
  }

  // List view has sequence handle order, name, country, auto_apply
  const reorderedDb = write(baseDb, 'account.fiscal.position', exportFp.id, { sequence: 1 });
  const listCtx = await mountView(
    (React) => React.createElement(ActionView, {
      leaf,
      base: '#/accounting/fiscal-positions',
      params: new URLSearchParams('view=list'),
    }),
    reorderedDb,
  );
  try {
    const table = find(listCtx.host, (n) => n.tagName === 'TABLE' && hasClass(n, 'list'));
    const headers = allFind(table, (n) => n.tagName === 'TH').map((th) => th.textContent.trim()).filter(Boolean);
    assert.deepEqual(headers, ['Sequence', 'Fiscal Position', 'Country', 'Detect Automatically']);
    const firstRowName = allFind(table, (n) => n.tagName === 'TBODY')[0]?.childNodes?.[0]?.childNodes?.[2]?.textContent?.trim();
    assert.equal(firstRowName, 'Export', 'orders list by sequence');
  } finally {
    await listCtx.done();
  }
});
