import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { createCompany } from './models/company.js';
import { postMove, total } from './models/accounting.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

function collect(node, predicate, out = []) {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) collect(child, predicate, out);
  return out;
}

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

async function renderSettings(setupDb) {
  const { makeEl } = setupDom();
  const prevConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { Settings } = await import('./views/Settings.jsx');
  await initStore();
  const initialDb = setupDb ? setupDb(seed()) : seed();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  await React.act(async () => {
    await commit(initialDb);
    root.render(React.createElement(Settings));
  });
  return {
    React,
    host,
    getDb,
    commit,
    control: (id) => find(host, (n) => props(n)?.id === id),
    cleanup: async () => {
      await React.act(async () => root.unmount());
      globalThis.confirm = prevConfirm;
    },
  };
}

async function renderMoveForm(initialDb, id, moveType = 'out_invoice') {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const leaf = { model: 'account.move', defaults: { move_type: moveType }, label: 'Invoices' };
  await React.act(async () => {
    await commit(initialDb);
    root.render(React.createElement(FormView, {
      id: id === 'new' ? 'new' : String(id),
      leaf,
      base: '#/accounting/invoices',
      params: new URLSearchParams(),
    }));
  });
  return {
    React,
    host,
    getDb,
    commit,
    control: (ctrlId) => find(host, (n) => props(n)?.id === ctrlId),
    cleanup: async () => {
      await React.act(async () => root.unmount());
    },
  };
}

test('QE-1: quick_edit_mode company field, Settings block, validation, and admin sync guard', async () => {
  const field = models['res.company'].fields.quick_edit_mode;
  assert.ok(field, 'res.company has quick_edit_mode field');
  assert.equal(field.type, 'selection');
  assert.equal(field.label, 'Quick encoding');
  assert.deepEqual(field.options, [
    ['out_invoices', 'Customer Invoices'],
    ['in_invoices', 'Vendor Bills'],
    ['out_and_in_invoices', 'Customer Invoices and Vendor Bills'],
  ]);

  let db = seed();
  assert.equal(read(db, 'res.company', 1).quick_edit_mode ?? '', '', 'empty by default on seeded company');
  const c2 = createCompany(db, { name: 'Quick Edit Branch' });
  db = c2.db;
  assert.equal(read(db, 'res.company', c2.id).quick_edit_mode ?? '', '', 'empty by default on new company');

  // Guard & CONTROL_FIELDS via diffDb + applyDiff
  const nextAdmin = write(db, 'res.company', c2.id, { quick_edit_mode: 'out_and_in_invoices' });
  assert.throws(
    () => applyDiff(db, diffDb(db, nextAdmin), { isAdmin: false, author: 'User' }),
    /Only administrators/i,
  );
  const applied = applyDiff(db, diffDb(db, nextAdmin), { isAdmin: true, author: 'Admin' });
  assert.equal(read(applied, 'res.company', c2.id).quick_edit_mode, 'out_and_in_invoices');

  const invalidAttempt = {
    ...db,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id === c2.id ? { ...c, quick_edit_mode: 'bogus_mode' } : c)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, invalidAttempt), { isAdmin: true, author: 'Admin' }),
    /Invalid value|quick encoding/i,
  );

  // Settings UI block
  const ctx = await renderSettings();
  try {
    const block = find(ctx.host, (n) => props(n)?.['data-block'] === 'quick_encoding');
    assert.ok(block, 'Quick encoding block renders in Settings');
    const h3 = find(block, (n) => n.tagName === 'H3');
    assert.equal(h3?.textContent, 'Quick Encoding');
    const select = ctx.control('quick_edit_mode');
    assert.ok(select, '#quick_edit_mode select exists');
    assert.equal(props(select).value, '');

    await ctx.React.act(async () => {
      props(select).onChange({ target: { value: 'out_invoices' } });
    });
    assert.equal(read(ctx.getDb(), 'res.company', 1).quick_edit_mode, 'out_invoices');

    await ctx.React.act(async () => {
      props(select).onChange({ target: { value: 'in_invoices' } });
    });
    assert.equal(read(ctx.getDb(), 'res.company', 1).quick_edit_mode, 'in_invoices');

    await ctx.React.act(async () => {
      props(select).onChange({ target: { value: '' } });
    });
    assert.equal(read(ctx.getDb(), 'res.company', 1).quick_edit_mode, null);

    const { validateCompanySettingWrite } = await import('./views/Settings.jsx');
    const err = validateCompanySettingWrite(ctx.getDb(), read(ctx.getDb(), 'res.company', 1), { quick_edit_mode: 'invalid' });
    assert.match(err, /quick encoding/i);
  } finally {
    await ctx.cleanup();
  }
});

test('QE-2: quick_edit_total_amount field visibility on draft covered moves only', async () => {
  const field = models['account.move'].fields.quick_edit_total_amount;
  assert.ok(field, 'account.move has quick_edit_total_amount field');
  assert.equal(field.type, 'monetary');
  assert.equal(field.label, 'Total (Tax inc.)');
  assert.equal(field.copy, false);

  let db = seed();
  const createDraft = (targetDb, moveType, companyId = 1) => create(targetDb, 'account.move', {
    move_type: moveType,
    partner_id: moveType.startsWith('in_') ? 4 : 2,
    company_id: companyId,
    invoice_date: '2026-04-01',
    invoice_line_ids: moveType === 'entry' ? [] : [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });

  // 1. Mode empty -> hidden for all move types
  for (const mt of ['out_invoice', 'out_refund', 'in_invoice', 'in_refund', 'entry']) {
    const res = createDraft(db, mt);
    const rec = read(res.db, 'account.move', res.id);
    assert.equal(field.hideWhen(rec, res.db), true, `hidden when mode is empty (${mt})`);
  }

  // 2. out_invoices -> shown on draft out_invoice & out_refund; hidden on bills, entries, posted, cancelled
  db = write(db, 'res.company', 1, { quick_edit_mode: 'out_invoices' });
  const outInv = createDraft(db, 'out_invoice');
  const outRef = createDraft(outInv.db, 'out_refund');
  const inInv = createDraft(outRef.db, 'in_invoice');
  const inRef = createDraft(inInv.db, 'in_refund');
  const entry = createDraft(inRef.db, 'entry');
  db = entry.db;

  assert.equal(field.hideWhen(read(db, 'account.move', outInv.id), db), false);
  assert.equal(field.hideWhen(read(db, 'account.move', outRef.id), db), false);
  assert.equal(field.hideWhen(read(db, 'account.move', inInv.id), db), true);
  assert.equal(field.hideWhen(read(db, 'account.move', inRef.id), db), true);
  assert.equal(field.hideWhen(read(db, 'account.move', entry.id), db), true);

  const postedDb = postMove(db, outInv.id);
  assert.equal(field.hideWhen(read(postedDb, 'account.move', outInv.id), postedDb), true, 'hidden when posted');
  const cancelDb = write(db, 'account.move', outInv.id, { state: 'cancel' });
  assert.equal(field.hideWhen(read(cancelDb, 'account.move', outInv.id), cancelDb), true, 'hidden when cancelled');

  // 3. in_invoices -> shown on draft in_invoice & in_refund; hidden on out_invoice & out_refund
  db = write(db, 'res.company', 1, { quick_edit_mode: 'in_invoices' });
  assert.equal(field.hideWhen(read(db, 'account.move', inInv.id), db), false);
  assert.equal(field.hideWhen(read(db, 'account.move', inRef.id), db), false);
  assert.equal(field.hideWhen(read(db, 'account.move', outInv.id), db), true);
  assert.equal(field.hideWhen(read(db, 'account.move', outRef.id), db), true);

  // 4. out_and_in_invoices -> shown on all 4 invoice/bill/refund types, hidden on entry
  db = write(db, 'res.company', 1, { quick_edit_mode: 'out_and_in_invoices' });
  for (const id of [outInv.id, outRef.id, inInv.id, inRef.id]) {
    assert.equal(field.hideWhen(read(db, 'account.move', id), db), false);
  }
  assert.equal(field.hideWhen(read(db, 'account.move', entry.id), db), true);

  // 5. Multi-company isolation: company 2 without mode keeps field hidden
  const c2 = createCompany(db, { name: 'No Quick Edit Co' });
  const c2Inv = createDraft(c2.db, 'out_invoice', c2.id);
  assert.equal(field.hideWhen(read(c2Inv.db, 'account.move', c2Inv.id), c2Inv.db), true);

  // 6. Rendered FormView shows #f-quick_edit_total_amount when covered and hides it otherwise
  const formShown = await renderMoveForm(db, outInv.id, 'out_invoice');
  try {
    assert.ok(formShown.control('f-quick_edit_total_amount'), 'FormView renders quick_edit_total_amount when enabled');
  } finally {
    await formShown.cleanup();
  }
  const formHidden = await renderMoveForm(postedDb, outInv.id, 'out_invoice');
  try {
    assert.equal(formHidden.control('f-quick_edit_total_amount'), null, 'FormView hides quick_edit_total_amount when posted');
  } finally {
    await formHidden.cleanup();
  }
});

test('QE-3: new invoice line prefills price_unit from remaining amount using default taxes and tax computation helper', async () => {
  let db = seed();
  const saleTax14 = search(db, 'account.tax').find((t) => t.type_tax_use === 'sale' && Number(t.amount) === 14 && !t.price_include);
  const purchTax14 = search(db, 'account.tax').find((t) => t.type_tax_use === 'purchase' && Number(t.amount) === 14 && !t.price_include);
  assert.ok(saleTax14 && purchTax14);

  db = write(db, 'res.company', 1, {
    quick_edit_mode: 'out_and_in_invoices',
    account_sale_tax_id: saleTax14.id,
    account_purchase_tax_id: purchTax14.id,
  });

  const lineDef = models['account.move'].fields.invoice_line_ids;

  // 1. Empty draft customer invoice with quick_edit_total_amount = 114 -> newLine gets 14% tax & price_unit 100
  const inv1 = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    quick_edit_total_amount: 114,
    invoice_line_ids: [],
  });
  let move1 = read(inv1.db, 'account.move', inv1.id);
  const firstLine = lineDef.newLine(move1, inv1.db);
  assert.deepEqual(firstLine.tax_ids, [saleTax14.id]);
  assert.equal(firstLine.price_unit, 100);
  const dbWithLine1 = write(inv1.db, 'account.move', inv1.id, { invoice_line_ids: [firstLine] });
  move1 = read(dbWithLine1, 'account.move', inv1.id);
  assert.equal(total(move1, dbWithLine1), 114);

  // 2. Once totals match, subsequent new lines get NO prefill (price_unit === 0)
  const secondLine = lineDef.newLine(move1, dbWithLine1);
  assert.equal(secondLine.price_unit, 0);

  // 3. Partial existing line (114) and quick_edit_total_amount = 285 -> remaining 171 -> price_unit = 150
  const dbTarget285 = write(dbWithLine1, 'account.move', inv1.id, { quick_edit_total_amount: 285 });
  const partialLine = lineDef.newLine(read(dbTarget285, 'account.move', inv1.id), dbTarget285);
  assert.equal(partialLine.price_unit, 150);
  const dbComplete = write(dbTarget285, 'account.move', inv1.id, { invoice_line_ids: [firstLine, partialLine] });
  assert.equal(total(read(dbComplete, 'account.move', inv1.id), dbComplete), 285);
  assert.equal(lineDef.newLine(read(dbComplete, 'account.move', inv1.id), dbComplete).price_unit, 0);

  // 4. Fiscal position remaps default tax (14% -> 5%) -> quick_edit_total_amount = 105 -> price_unit = 100
  const tax5 = create(db, 'account.tax', {
    name: 'VAT 5%',
    amount: 5,
    type_tax_use: 'sale',
    amount_type: 'percent',
    ...defaultTaxRepartitionLines(null, [], null, db),
  });
  const fp = create(tax5.db, 'account.fiscal.position', { name: 'Reduced 5%', company_id: 1 });
  const mappedTax5 = write(fp.db, 'account.tax', tax5.id, {
    fiscal_position_mapping_ids: [{ fiscal_position_id: fp.id, original_tax_ids: [saleTax14.id] }],
  });
  const invFp = create(mappedTax5, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    fiscal_position_id: fp.id,
    quick_edit_total_amount: 105,
    invoice_line_ids: [],
  });
  const fpLine = lineDef.newLine(read(invFp.db, 'account.move', invFp.id), invFp.db);
  assert.deepEqual(fpLine.tax_ids, [tax5.id]);
  assert.equal(fpLine.price_unit, 100);

  // 5. Price-included default tax (14% price_include: true) -> quick_edit_total_amount = 114 -> total = 114
  const inclTax = create(db, 'account.tax', {
    name: 'VAT 14% Incl',
    amount: 14,
    type_tax_use: 'sale',
    amount_type: 'percent',
    price_include: true,
    ...defaultTaxRepartitionLines(null, [], null, db),
  });
  const dbIncl = write(inclTax.db, 'res.company', 1, { account_sale_tax_id: inclTax.id });
  const invIncl = create(dbIncl, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    quick_edit_total_amount: 114,
    invoice_line_ids: [],
  });
  const inclLine = lineDef.newLine(read(invIncl.db, 'account.move', invIncl.id), invIncl.db);
  const dbInclLine = write(invIncl.db, 'account.move', invIncl.id, { invoice_line_ids: [inclLine] });
  const moveIncl = read(dbInclLine, 'account.move', invIncl.id);
  assert.equal(total(moveIncl, dbInclLine), 114);
  assert.equal(moveIncl.amount_untaxed, 100);
  assert.equal(moveIncl.amount_tax, 14);

  // 6. Compound / tax-on-tax (10% include_base_amount + 5%) -> 115.50 -> price_unit = 100
  const baseTax = create(db, 'account.tax', {
    name: 'Levy 10%',
    amount: 10,
    type_tax_use: 'purchase',
    amount_type: 'percent',
    include_base_amount: true,
    sequence: 1,
    ...defaultTaxRepartitionLines(null, [], null, db),
  });
  const secondTax = create(baseTax.db, 'account.tax', {
    name: 'VAT 5%',
    amount: 5,
    type_tax_use: 'purchase',
    amount_type: 'percent',
    is_base_affected: true,
    sequence: 2,
    ...defaultTaxRepartitionLines(null, [], null, baseTax.db),
  });
  const grpTax = create(secondTax.db, 'account.tax', {
    name: 'Levy + VAT',
    type_tax_use: 'purchase',
    amount_type: 'group',
    children_tax_ids: [baseTax.id, secondTax.id],
    ...defaultTaxRepartitionLines(null, [], null, secondTax.db),
  });
  const dbGroup = write(grpTax.db, 'res.company', 1, { account_purchase_tax_id: grpTax.id });
  const billGrp = create(dbGroup, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 4,
    company_id: 1,
    quick_edit_total_amount: 115.5,
    invoice_line_ids: [],
  });
  const grpLine = lineDef.newLine(read(billGrp.db, 'account.move', billGrp.id), billGrp.db);
  assert.equal(grpLine.price_unit, 100);
  const dbBillGrpLine = write(billGrp.db, 'account.move', billGrp.id, { invoice_line_ids: [grpLine] });
  assert.equal(total(read(dbBillGrpLine, 'account.move', billGrp.id), dbBillGrpLine), 115.5);

  // 7. round_globally precision edge (1000 with 15% tax -> total matches 1000)
  const tax15 = create(db, 'account.tax', {
    name: 'VAT 15%',
    amount: 15,
    type_tax_use: 'sale',
    amount_type: 'percent',
    ...defaultTaxRepartitionLines(null, [], null, db),
  });
  const dbGlob = write(tax15.db, 'res.company', 1, {
    account_sale_tax_id: tax15.id,
    tax_calculation_rounding_method: 'round_globally',
  });
  const invGlob = create(dbGlob, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    quick_edit_total_amount: 1000,
    invoice_line_ids: [],
  });
  const globLine = lineDef.newLine(read(invGlob.db, 'account.move', invGlob.id), invGlob.db);
  const dbGlobLine = write(invGlob.db, 'account.move', invGlob.id, { invoice_line_ids: [globLine] });
  assert.equal(total(read(dbGlobLine, 'account.move', invGlob.id), dbGlobLine), 1000);

  // 8. Interactive FormView test: enter quick_edit_total_amount, click Add a line, second click gives 0
  const invEmpty = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_line_ids: [],
  });
  const form = await renderMoveForm(invEmpty.db, invEmpty.id, 'out_invoice');
  try {
    const qeInput = form.control('f-quick_edit_total_amount');
    assert.ok(qeInput);
    await form.React.act(async () => {
      props(qeInput).onChange({ target: { value: '114' } });
    });
    const addBtn = find(form.host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Add a line');
    assert.ok(addBtn);
    await form.React.act(async () => {
      props(addBtn).onClick();
    });
    const saveBtn = find(form.host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Save');
    assert.ok(saveBtn);
    await form.React.act(async () => {
      props(saveBtn).onClick();
    });
    const savedInv = read(form.getDb(), 'account.move', invEmpty.id);
    assert.equal(savedInv.invoice_line_ids.length, 1);
    assert.equal(savedInv.invoice_line_ids[0].price_unit, 100);
    assert.equal(total(savedInv, form.getDb()), 114);

    // Clicking Add a line again once totals match adds a 0-price line
    const addBtn2 = find(form.host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Add a line');
    await form.React.act(async () => {
      props(addBtn2).onClick();
    });
    const saveBtn2 = find(form.host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Save');
    await form.React.act(async () => {
      props(saveBtn2).onClick();
    });
    const savedInv2 = read(form.getDb(), 'account.move', invEmpty.id);
    assert.equal(savedInv2.invoice_line_ids.length, 2);
    assert.equal(savedInv2.invoice_line_ids[1].price_unit, 0);
  } finally {
    await form.cleanup();
  }
});

test('QE-4: non-blocking mismatch warning on form, cleared when matching, posting is not blocked', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, { quick_edit_mode: 'out_and_in_invoices' });

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_date: '2026-04-01',
    quick_edit_total_amount: 200,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });

  // Mismatch -> warning shown on form
  const recMismatch = read(inv.db, 'account.move', inv.id);
  const warn = models['account.move'].form.warning(recMismatch, inv.db);
  assert.ok(warn && warn.length > 0, 'warning shown when set total differs from computed total');

  const form = await renderMoveForm(inv.db, inv.id, 'out_invoice');
  try {
    const alert = find(form.host, (n) => String(props(n)?.className ?? '').includes('alert-warning'));
    assert.ok(alert && alert.textContent.length > 0, 'FormView renders alert-warning banner');
  } finally {
    await form.cleanup();
  }

  // Matching total -> no warning
  const matchingDb = write(inv.db, 'account.move', inv.id, { quick_edit_total_amount: 100 });
  assert.equal(models['account.move'].form.warning(read(matchingDb, 'account.move', inv.id), matchingDb), '');

  // Unset (null or 0) -> no warning
  const clearedDb = write(inv.db, 'account.move', inv.id, { quick_edit_total_amount: null });
  assert.equal(models['account.move'].form.warning(read(clearedDb, 'account.move', inv.id), clearedDb), '');
  const zeroDb = write(inv.db, 'account.move', inv.id, { quick_edit_total_amount: 0 });
  assert.equal(models['account.move'].form.warning(read(zeroDb, 'account.move', inv.id), zeroDb), '');

  // Existing creditWarning + quickEditWarning coexist cleanly
  // Credit limits apply only when the company enables Sales Credit Limit (Odoo account_use_credit_limit).
  const creditDb = write(write(inv.db, 'res.company', read(inv.db, 'account.move', inv.id).company_id ?? 1, { account_use_credit_limit: true }), 'res.partner', 2, { use_partner_credit_limit: true, credit_limit: 50 });
  const bothWarn = models['account.move'].form.warning(read(creditDb, 'account.move', inv.id), creditDb);
  assert.match(bothWarn, /credit limit/i);
  assert.ok(bothWarn.length > models['account.move'].form.warning(read(clearedDb, 'account.move', inv.id), clearedDb).length);

  // Posting is NOT blocked by mismatch (and persists through diffDb + applyDiff)
  const postedDb = postMove(inv.db, inv.id);
  const synced = applyDiff(inv.db, diffDb(inv.db, postedDb), { isAdmin: true, author: 'Admin' });
  const postedInv = read(synced, 'account.move', inv.id);
  assert.equal(postedInv.state, 'posted');
  // Warning disappears once posted
  assert.equal(models['account.move'].form.warning(postedInv, synced), '');
});

test('QE i18n: Arabic translations exist for all new labels, options, descriptions, errors and warnings without duplicate keys', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  try {
    const { t } = await import(`./i18n.js?qe_ar=${Date.now()}`);
    for (const s of [
      'Quick encoding',
      'Quick Encoding',
      'Customer Invoices',
      'Vendor Bills',
      'Customer Invoices and Vendor Bills',
      'Total (Tax inc.)',
      'Select a valid quick encoding mode',
      'Enter the tax-included total on draft invoices and bills to prefill new lines with the remaining amount.',
    ]) {
      assert.notEqual(t(s), s, `Arabic translation exists for "${s}"`);
    }
    const sampleWarn = t('The entered total ({entered}) does not match the computed total ({computed}).', { entered: '200.00', computed: '100.00' });
    assert.ok(sampleWarn.includes('200.00') && sampleWarn.includes('100.00'));
    assert.notEqual(sampleWarn, 'The entered total (200.00) does not match the computed total (100.00).');
  } finally {
    globalThis.localStorage = prevStorage;
  }

  const content = fs.readFileSync('src/i18n.js', 'utf8');
  const arBlock = content.slice(content.indexOf('const ar = {'), content.indexOf('export function t('));
  const seen = new Set();
  const dups = [];
  for (const line of arBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const match = trimmed.match(/^(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))\s*:/);
    if (match) {
      const key = match[1] ?? match[2] ?? match[3];
      if (seen.has(key)) dups.push(key);
      seen.add(key);
    }
  }
  assert.deepEqual(dups, [], 'No duplicate keys in src/i18n.js');
});

test('QE finding 1 regression: missing currency suppresses mismatch warning and does not crash invoice form', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, { quick_edit_mode: 'out_and_in_invoices' });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    quick_edit_total_amount: 100,
    invoice_line_ids: [],
  });
  // Unconfigure company currency so documentCurrency throws "Configure the company currency"
  const noCurrDb = {
    ...inv.db,
    records: {
      ...inv.db.records,
      'res.company': inv.db.records['res.company'].map((c) => (c.id === 1 ? { ...c, currency_id: null } : c)),
    },
  };
  const rec = read(noCurrDb, 'account.move', inv.id);
  // Before fix: quickEditMismatch calls documentCurrency without catch, throwing Configure company currency
  assert.equal(models['account.move'].form.warning(rec, noCurrDb), '');
  // Adding a new line also suppresses mismatch calculation cleanly and returns a default line with price_unit 0
  const newLine = models['account.move'].fields.invoice_line_ids.newLine(rec, noCurrDb);
  assert.equal(newLine.price_unit, 0);
  const form = await renderMoveForm(noCurrDb, inv.id, 'out_invoice');
  try {
    assert.ok(form.host);
  } finally {
    await form.cleanup();
  }
});

test('QE finding 2 regression: discounted invoice with mixed early-payment discount term matches entered total', async () => {
  let db = seed();
  db = write(db, 'res.company', 1, { quick_edit_mode: 'out_and_in_invoices' });
  const saleTax14 = (db.records?.['account.tax'] ?? []).find((t) => t.id === 1 || t.name === 'VAT 14%')
    ?? create(db, 'account.tax', { name: 'VAT 14%', amount: 14, type_tax_use: 'sale', amount_type: 'percent', ...defaultTaxRepartitionLines(null, [], null, db) });
  db = write(db, 'res.company', 1, { account_sale_tax_id: saleTax14.id });

  const term = create(db, 'account.payment.term', {
    name: '10% Early Mixed',
    early_discount: true,
    discount_percentage: 10,
    discount_percent: 10,
    discount_days: 10,
    discount_tax_computation: 'mixed',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  });
  db = term.db;

  const lineDef = models['account.move'].fields.invoice_line_ids;

  // Case A: Target 112.60 with 14% exclusive tax and 10% mixed discount -> unit price should be 100, total 112.60
  const invA = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_payment_term_id: term.id,
    quick_edit_total_amount: 112.60,
    invoice_line_ids: [],
  });
  const moveA = read(invA.db, 'account.move', invA.id);
  const lineA = lineDef.newLine(moveA, invA.db);
  assert.equal(lineA.price_unit, 100);
  const dbLineA = write(invA.db, 'account.move', invA.id, { invoice_line_ids: [lineA] });
  const savedA = read(dbLineA, 'account.move', invA.id);
  assert.equal(total(savedA, dbLineA), 112.60);
  assert.equal(models['account.move'].form.warning(savedA, dbLineA), '');

  // Case B: In round_globally, target 114 with 14% tax and 10% mixed discount -> total() matches entered target 114
  const dbGlob = write(db, 'res.company', 1, { tax_calculation_rounding_method: 'round_globally' });
  const invB = create(dbGlob, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_payment_term_id: term.id,
    quick_edit_total_amount: 114,
    invoice_line_ids: [],
  });
  const moveB = read(invB.db, 'account.move', invB.id);
  const lineB = lineDef.newLine(moveB, invB.db);
  // Before fix: derived price using undiscounted tax was 100, so total was 112.60 != 114
  assert.notEqual(lineB.price_unit, 100);
  const dbLineB = write(invB.db, 'account.move', invB.id, { invoice_line_ids: [lineB] });
  const savedB = read(dbLineB, 'account.move', invB.id);
  assert.equal(total(savedB, dbLineB), 114);
  assert.equal(models['account.move'].form.warning(savedB, dbLineB), '');

  // Case C: Tax-included default tax (14% price_include: true) with 10% mixed discount -> target 112.60 -> unit price 114, total 112.60
  const inclTax = create(db, 'account.tax', {
    name: 'VAT 14% Incl Mixed',
    amount: 14,
    type_tax_use: 'sale',
    amount_type: 'percent',
    price_include: true,
    ...defaultTaxRepartitionLines(null, [], null, db),
  });
  const dbIncl = write(inclTax.db, 'res.company', 1, { account_sale_tax_id: inclTax.id });
  const invC = create(dbIncl, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_payment_term_id: term.id,
    quick_edit_total_amount: 112.60,
    invoice_line_ids: [],
  });
  const moveC = read(invC.db, 'account.move', invC.id);
  const lineC = lineDef.newLine(moveC, invC.db);
  assert.equal(lineC.price_unit, 114);
  const dbLineC = write(invC.db, 'account.move', invC.id, { invoice_line_ids: [lineC] });
  const savedC = read(dbLineC, 'account.move', invC.id);
  assert.equal(total(savedC, dbLineC), 112.60);
  assert.equal(models['account.move'].form.warning(savedC, dbLineC), '');
});

test('QE regression: negative remaining on existing discounted invoice with mixed discount scales price and handles zero denominator', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { quick_edit_mode: 'out_and_in_invoices' });
  const saleTax14 = (db.records?.['account.tax'] ?? []).find((t) => t.id === 1 || t.name === 'VAT 14%')
    ?? create(db, 'account.tax', { name: 'VAT 14%', amount: 14, type_tax_use: 'sale', amount_type: 'percent', ...defaultTaxRepartitionLines(null, [], null, db) });
  db = write(db, 'res.company', 1, { account_sale_tax_id: saleTax14.id });

  const term = create(db, 'account.payment.term', {
    name: '10% Early Mixed Lower',
    early_discount: true,
    discount_percentage: 10,
    discount_percent: 10,
    discount_days: 10,
    discount_tax_computation: 'mixed',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  });
  db = term.db;

  const lineDef = models['account.move'].fields.invoice_line_ids;

  // Existing discounted invoice (200 + 14% * 0.9 = 225.20), target lowered to 112.60 -> remaining -112.60 -> price_unit -100
  const invA = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_payment_term_id: term.id,
    invoice_line_ids: [],
  });
  const baseLineA = { ...lineDef.newLine(read(invA.db, 'account.move', invA.id), invA.db), name: 'Existing', qty: 1, price_unit: 200 };
  const dbA = write(invA.db, 'account.move', invA.id, { invoice_line_ids: [baseLineA], quick_edit_total_amount: 112.60 });
  const moveA = read(dbA, 'account.move', invA.id);
  assert.equal(total(moveA, dbA), 225.20);
  const lineA = lineDef.newLine(moveA, dbA);
  assert.equal(lineA.price_unit, -100);
  const dbLineA = write(dbA, 'account.move', invA.id, { invoice_line_ids: [...moveA.invoice_line_ids, lineA] });
  const savedA = read(dbLineA, 'account.move', invA.id);
  assert.equal(total(savedA, dbLineA), 112.60);
  assert.equal(models['account.move'].form.warning(savedA, dbLineA), '');

  // Same in round_globally with lower target 114 (remaining -111.20)
  const dbGlob = write(db, 'res.company', 1, { tax_calculation_rounding_method: 'round_globally' });
  const invB = create(dbGlob, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_payment_term_id: term.id,
    invoice_line_ids: [],
  });
  const baseLineB = { ...lineDef.newLine(read(invB.db, 'account.move', invB.id), invB.db), name: 'Existing', qty: 1, price_unit: 200 };
  const dbB = write(invB.db, 'account.move', invB.id, { invoice_line_ids: [baseLineB], quick_edit_total_amount: 114 });
  const moveB = read(dbB, 'account.move', invB.id);
  const lineB = lineDef.newLine(moveB, dbB);
  assert.notEqual(lineB.price_unit, -97.54);
  const dbLineB = write(dbB, 'account.move', invB.id, { invoice_line_ids: [...moveB.invoice_line_ids, lineB] });
  const savedB = read(dbLineB, 'account.move', invB.id);
  assert.equal(total(savedB, dbLineB), 114);
  assert.equal(models['account.move'].form.warning(savedB, dbLineB), '');

  // Tax-included 14% tax with existing line 228 (total 225.20), target lowered to 112.60 -> price_unit -114
  const inclTax = create(db, 'account.tax', {
    name: 'VAT 14% Incl Mixed Lower',
    amount: 14,
    type_tax_use: 'sale',
    amount_type: 'percent',
    price_include: true,
    ...defaultTaxRepartitionLines(null, [], null, db),
  });
  const dbIncl = write(inclTax.db, 'res.company', 1, { account_sale_tax_id: inclTax.id });
  const invC = create(dbIncl, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_payment_term_id: term.id,
    invoice_line_ids: [],
  });
  const baseLineC = { ...lineDef.newLine(read(invC.db, 'account.move', invC.id), invC.db), name: 'Existing', qty: 1, price_unit: 228 };
  const dbC = write(invC.db, 'account.move', invC.id, { invoice_line_ids: [baseLineC], quick_edit_total_amount: 112.60 });
  const moveC = read(dbC, 'account.move', invC.id);
  assert.equal(total(moveC, dbC), 225.20);
  const lineC = lineDef.newLine(moveC, dbC);
  assert.equal(lineC.price_unit, -114);
  const dbLineC = write(dbC, 'account.move', invC.id, { invoice_line_ids: [...moveC.invoice_line_ids, lineC] });
  const savedC = read(dbLineC, 'account.move', invC.id);
  assert.equal(total(savedC, dbLineC), 112.60);
  assert.equal(models['account.move'].form.warning(savedC, dbLineC), '');

  // Safe zero-denominator case: effectiveTotal === 0 (e.g. -200% tax with 50% mixed discount) never produces NaN/Infinity
  const negTax = create(db, 'account.tax', {
    name: 'Neg 200%',
    amount: -200,
    type_tax_use: 'sale',
    amount_type: 'percent',
    ...defaultTaxRepartitionLines(null, [], null, db),
  });
  const halfTerm = create(negTax.db, 'account.payment.term', {
    name: '50% Early Mixed',
    early_discount: true,
    discount_percentage: 50,
    discount_percent: 50,
    discount_days: 10,
    discount_tax_computation: 'mixed',
    line_ids: [{ value: 100, value_type: 'percent', nb_days: 30, delay_type: 'days_after' }],
  });
  const zeroDenomDb = write(halfTerm.db, 'res.company', 1, { account_sale_tax_id: negTax.id });
  const invZero = create(zeroDenomDb, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    company_id: 1,
    invoice_payment_term_id: halfTerm.id,
    quick_edit_total_amount: 100,
    invoice_line_ids: [],
  });
  const lineZero = lineDef.newLine(read(invZero.db, 'account.move', invZero.id), invZero.db);
  assert.ok(Number.isFinite(lineZero.price_unit));
});

test('QE finding 3 regression: Settings block heading uses Title Case "Quick Encoding" matching sibling headings', async () => {
  const ctx = await renderSettings();
  try {
    const block = find(ctx.host, (n) => props(n)?.['data-block'] === 'quick_encoding');
    assert.ok(block, 'quick_encoding block renders in Settings');
    const h3 = find(block, (n) => n.tagName === 'H3');
    assert.equal(h3?.textContent, 'Quick Encoding');

    const accountingSection = find(ctx.host, (n) => n.tagName === 'SECTION' && props(n)?.className === 'settings-accounting');
    const blocks = collect(accountingSection, (n) => props(n)?.['data-block']);
    const headings = blocks.map((b) => find(b, (n) => n.tagName === 'H3')?.textContent);
    assert.ok(headings.includes('Quick Encoding'));
    assert.ok(!headings.includes('Quick encoding'));
  } finally {
    await ctx.cleanup();
  }
});
