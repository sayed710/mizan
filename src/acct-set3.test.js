import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const { create, read, write, setActiveCompany } = await import('./orm.js');
const { seed } = await import('./seed.js');
const { models } = await import('./models/index.js');
const { createCompany } = await import('./models/company.js');
const { amounts, companyRoundingMethod } = await import('./models/common.js');
const { defaultTaxRepartitionLines, mapTaxIds, productTax, taxPriceInclude, taxSnapshot } = await import('./models/taxes.js');
const { postMove } = await import('./models/accounting.js');
const { accountId } = await import('./models/ledger.js');
const { MIGRATIONS, SCHEMA_VERSION, migrate } = await import('./migrations.js');
const { applyDiff, diffDb } = await import('./sync.js');
const { find, setupDom } = await import('./test-support/dom.js');
const { Settings, validateCompanySettingWrite } = await import('./views/Settings.jsx');
const { importCsvRows } = await import('./csv.js');

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

function collect(node, predicate, out = []) {
  if (!node) return out;
  if (predicate(node)) out.push(node);
  for (const child of node.childNodes ?? []) collect(child, predicate, out);
  return out;
}

async function renderSettings(setupDb) {
  const { makeEl } = setupDom();
  const prevConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
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
    control: (id) => find(host, (n) => props(n)?.id === id),
    cleanup: async () => {
      await React.act(async () => root.unmount());
      globalThis.confirm = prevConfirm;
    },
  };
}

test('PI-1: res.company declares account_price_include with default tax_excluded and Settings Taxes section renders and edits it', async () => {
  const field = models['res.company'].fields.account_price_include;
  assert.ok(field, 'account_price_include field exists on res.company');
  assert.equal(field.type, 'selection');
  assert.equal(field.label, 'Default Sales Price Include');
  assert.deepEqual(field.options, [['tax_included', 'Tax Included'], ['tax_excluded', 'Tax Excluded']]);

  const base = seed();
  assert.equal(read(base, 'res.company', 1).account_price_include, 'tax_excluded');
  const co2 = createCompany(base, { name: 'Branch Two' });
  assert.equal(read(co2.db, 'res.company', co2.id).account_price_include, 'tax_excluded');

  let secondId;
  const ctx = await renderSettings((db0) => {
    const second = createCompany(db0, { name: 'Settings Co' });
    secondId = second.id;
    return { ...second.db, settings: { ...second.db.settings, current_company_id: secondId } };
  });
  try {
    const taxesBlock = find(ctx.host, (n) => props(n)?.['data-block'] === 'taxes');
    assert.ok(taxesBlock, 'Taxes block renders');
    const row = find(taxesBlock, (n) => props(n)?.['data-setting'] === 'account_price_include');
    assert.ok(row, 'account_price_include row renders inside Taxes block');
    const label = find(row, (n) => n.tagName === 'LABEL');
    assert.equal(label?.textContent, 'Default Sales Price Include');

    const select = ctx.control('account_price_include');
    assert.ok(select, '#account_price_include select renders');
    assert.equal(props(select).value, 'tax_excluded');
    const optionValues = collect(select, (n) => n.tagName === 'OPTION').map((o) => [props(o).value, o.textContent]);
    assert.deepEqual(optionValues, [['tax_included', 'Tax Included'], ['tax_excluded', 'Tax Excluded']]);

    await ctx.React.act(async () => props(select).onChange({ target: { value: 'tax_included' } }));
    assert.equal(read(ctx.getDb(), 'res.company', secondId).account_price_include, 'tax_included');
    assert.equal(read(ctx.getDb(), 'res.company', 1).account_price_include, 'tax_excluded');

    assert.ok(validateCompanySettingWrite(ctx.getDb(), read(ctx.getDb(), 'res.company', secondId), { account_price_include: 'invalid' }));
  } finally {
    await ctx.cleanup();
  }

  // Server/sync diff guards: non-admin cannot change account_price_include and invalid selection is rejected.
  const dbBefore = co2.db;
  const changed = write(dbBefore, 'res.company', co2.id, { account_price_include: 'tax_included' });
  assert.throws(
    () => applyDiff(dbBefore, diffDb(dbBefore, changed), { isAdmin: false }),
    /administrator/i,
  );
  const forgedInvalid = {
    ...dbBefore,
    records: {
      ...dbBefore.records,
      'res.company': dbBefore.records['res.company'].map((c) => (c.id === co2.id ? { ...c, account_price_include: 'bogus' } : c)),
    },
  };
  assert.throws(() => applyDiff(dbBefore, diffDb(dbBefore, forgedInvalid), { isAdmin: true }));
});

test('PI-2: account.tax price_include_override and taxPriceInclude canonical helper govern snapshots and entries', async () => {
  const overrideField = models['account.tax'].fields.price_include_override;
  assert.ok(overrideField, 'price_include_override field exists on account.tax');
  assert.equal(overrideField.type, 'selection');
  assert.equal(overrideField.label, 'Included in Price');
  assert.deepEqual(overrideField.options, [['tax_included', 'Tax Included'], ['tax_excluded', 'Tax Excluded']]);

  let db = seed();
  const taxAcc = accountId(db, '251000', 1);
  const defaultTax = create(db, 'account.tax', {
    name: 'Default VAT 14%',
    amount_type: 'percent',
    amount: 14,
    type_tax_use: 'sale',
    company_id: 1,
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = defaultTax.db;
  const forceIncl = create(db, 'account.tax', {
    name: 'Forced Incl 14%',
    amount_type: 'percent',
    amount: 14,
    type_tax_use: 'sale',
    company_id: 1,
    price_include_override: 'tax_included',
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = forceIncl.db;
  const forceExcl = create(db, 'account.tax', {
    name: 'Forced Excl 14%',
    amount_type: 'percent',
    amount: 14,
    type_tax_use: 'sale',
    company_id: 1,
    price_include_override: 'tax_excluded',
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = forceExcl.db;

  // Company default is tax_excluded:
  assert.equal(taxPriceInclude(db, read(db, 'account.tax', defaultTax.id)), false);
  assert.equal(read(db, 'account.tax', defaultTax.id).price_include, false);
  assert.equal(taxPriceInclude(db, read(db, 'account.tax', forceIncl.id)), true);
  assert.equal(read(db, 'account.tax', forceIncl.id).price_include, true);
  assert.equal(taxPriceInclude(db, read(db, 'account.tax', forceExcl.id)), false);
  assert.equal(read(db, 'account.tax', forceExcl.id).price_include, false);

  // Flip company default to tax_included:
  db = write(db, 'res.company', 1, { account_price_include: 'tax_included' });
  assert.equal(taxPriceInclude(db, read(db, 'account.tax', defaultTax.id)), true);
  assert.equal(read(db, 'account.tax', defaultTax.id).price_include, true);
  assert.equal(taxSnapshot(read(db, 'account.tax', defaultTax.id), db).tax_include, true);
  assert.equal(mapTaxIds(db, [defaultTax.id], null, 1).tax_include, true);
  // Explicit tax_excluded override stays false:
  assert.equal(taxPriceInclude(db, read(db, 'account.tax', forceExcl.id)), false);
  assert.equal(read(db, 'account.tax', forceExcl.id).price_include, false);
  assert.equal(taxSnapshot(read(db, 'account.tax', forceExcl.id), db).tax_include, false);

  // Manual journal entry tax extraction uses taxPriceInclude too:
  const bankAcc = accountId(db, '101401', 1);
  const revAcc = accountId(db, '400000', 1);
  const entry = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    date: '2026-04-01',
    line_ids: [
      { account_id: bankAcc, debit: 114, credit: 0 },
      { account_id: revAcc, debit: 0, credit: 114, tax_ids: [defaultTax.id] },
    ],
  });
  const postedEntry = read(postMove(entry.db, entry.id), 'account.move', entry.id);
  const revLine = postedEntry.line_ids.find((l) => l.account_id === revAcc);
  const taxLine = postedEntry.line_ids.find((l) => l.tax_id === defaultTax.id);
  assert.equal(revLine.credit, 100);
  assert.equal(taxLine.credit, 14);

  // Diff guard rejects bogus price_include_override
  const forged = {
    ...db,
    records: {
      ...db.records,
      'account.tax': db.records['account.tax'].map((t) => (t.id === defaultTax.id ? { ...t, price_include_override: 'bogus' } : t)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: true }));
});

test('PI-3: migration sets price_include_override from legacy price_include (true -> tax_included, false -> empty) and preserves behaviour', () => {
  const base = seed();
  assert.equal(SCHEMA_VERSION, MIGRATIONS.at(-1).version);
  assert.ok(SCHEMA_VERSION >= 64);

  const legacy = {
    ...base,
    schema_version: 63,
    records: {
      ...base.records,
      'res.company': base.records['res.company'].map(({ account_price_include: _api, ...c }) => c),
      'account.tax': (base.records['account.tax'] ?? []).map((t) => {
        const { price_include_override: _pio, ...rest } = t;
        return { ...rest, price_include: t.name === 'VAT 14% Included' };
      }),
    },
  };

  const migrated = migrate(legacy);
  assert.equal(migrated.schema_version, 83);

  const incl = migrated.records['account.tax'].find((t) => t.name === 'VAT 14% Included');
  const excl = migrated.records['account.tax'].find((t) => t.name === 'VAT 14%' && t.type_tax_use === 'sale');
  assert.equal(incl.price_include_override, 'tax_included');
  assert.equal(excl.price_include_override ?? null, null);
  assert.equal('price_include' in incl, false);
  assert.equal('price_include' in excl, false);

  assert.equal(read(migrated, 'account.tax', incl.id).price_include, true);
  assert.equal(read(migrated, 'account.tax', excl.id).price_include, false);

  // Changing company default after migration affects excl (no override) but keeps incl working as before.
  const flipped = write(migrated, 'res.company', 1, { account_price_include: 'tax_included' });
  assert.equal(read(flipped, 'account.tax', excl.id).price_include, true);
  assert.equal(read(flipped, 'account.tax', incl.id).price_include, true);

  // Idempotent on re-run
  assert.equal(migrate(migrated), migrated);
});

test('PI-4: changing company account_price_include changes un-overridden tax computations only for that company', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Company B' });
  db = c2.db;

  const acc1 = accountId(db, '251000', 1);
  const acc2 = create(db, 'account.account', { code: '251009', name: 'VAT Co2', account_type: 'liability_current', company_id: c2.id });
  db = acc2.db;

  const t1Auto = create(db, 'account.tax', {
    name: 'Co1 Auto VAT',
    amount_type: 'percent',
    amount: 14,
    type_tax_use: 'sale',
    company_id: 1,
    ...defaultTaxRepartitionLines(acc1, []),
  });
  db = t1Auto.db;
  const t1ExclOverride = create(db, 'account.tax', {
    name: 'Co1 Override Excl',
    amount_type: 'percent',
    amount: 14,
    type_tax_use: 'sale',
    company_id: 1,
    price_include_override: 'tax_excluded',
    ...defaultTaxRepartitionLines(acc1, []),
  });
  db = t1ExclOverride.db;
  const t2Auto = create(db, 'account.tax', {
    name: 'Co2 Auto VAT',
    amount_type: 'percent',
    amount: 14,
    type_tax_use: 'sale',
    company_id: c2.id,
    ...defaultTaxRepartitionLines(acc2.id, []),
  });
  db = t2Auto.db;

  const prod1 = create(db, 'product', { name: 'Widget Co1', list_price: 114, tax_id: t1Auto.id });
  db = prod1.db;
  const prod1Override = create(db, 'product', { name: 'Widget Co1 Excl', list_price: 100, tax_id: t1ExclOverride.id });
  db = prod1Override.db;
  const prod2 = create(db, 'product', { name: 'Widget Co2', list_price: 100, tax_id: t2Auto.id });
  db = prod2.db;

  // Before change: both companies default to tax_excluded.
  const line1Before = { product_id: prod1.id, qty: 1, price_unit: 114, ...productTax(db, read(db, 'product', prod1.id), 'sale', null, 1) };
  assert.deepEqual(amounts([line1Before], null, { roundingMethod: companyRoundingMethod(db, 1) }), { untaxed: 114, tax: 15.96, total: 129.96 });

  // Change Company 1 only to tax_included:
  db = write(db, 'res.company', 1, { account_price_include: 'tax_included' });

  const line1After = { product_id: prod1.id, qty: 1, price_unit: 114, ...productTax(db, read(db, 'product', prod1.id), 'sale', null, 1) };
  assert.deepEqual(amounts([line1After], null, { roundingMethod: companyRoundingMethod(db, 1) }), { untaxed: 100, tax: 14, total: 114 });

  // Company 1 tax with explicit tax_excluded override stays excluded:
  const line1Excl = { product_id: prod1Override.id, qty: 1, price_unit: 100, ...productTax(db, read(db, 'product', prod1Override.id), 'sale', null, 1) };
  assert.deepEqual(amounts([line1Excl], null, { roundingMethod: companyRoundingMethod(db, 1) }), { untaxed: 100, tax: 14, total: 114 });

  // Company 2 tax without override stays excluded because Company 2's setting is still tax_excluded:
  const line2 = { product_id: prod2.id, qty: 1, price_unit: 100, ...productTax(db, read(db, 'product', prod2.id), 'sale', null, c2.id) };
  assert.deepEqual(amounts([line2], null, { roundingMethod: companyRoundingMethod(db, c2.id) }), { untaxed: 100, tax: 14, total: 114 });

  // Flip Company 1 back to tax_excluded and Company 2 to tax_included -> only Company 2 changes:
  db = write(db, 'res.company', 1, { account_price_include: 'tax_excluded' });
  db = write(db, 'res.company', c2.id, { account_price_include: 'tax_included' });
  const line1Restored = { product_id: prod1.id, qty: 1, price_unit: 114, ...productTax(db, read(db, 'product', prod1.id), 'sale', null, 1) };
  assert.deepEqual(amounts([line1Restored], null, { roundingMethod: companyRoundingMethod(db, 1) }), { untaxed: 114, tax: 15.96, total: 129.96 });
  const line2Included = { product_id: prod2.id, qty: 1, price_unit: 114, ...productTax(db, read(db, 'product', prod2.id), 'sale', null, c2.id) };
  assert.deepEqual(amounts([line2Included], null, { roundingMethod: companyRoundingMethod(db, c2.id) }), { untaxed: 100, tax: 14, total: 114 });
});

test('Finding 1: draft entry taxes refresh on company default change in both directions without altering posted entries and edits recover gross', () => {
  let db = seed();
  const bankAcc = accountId(db, '101401', 1);
  const revAcc = accountId(db, '400000', 1);
  const taxAcc = accountId(db, '251000', 1);

  // Standard tax with no override (follows company default):
  const defaultTax = create(db, 'account.tax', {
    name: 'Auto VAT 14%',
    amount_type: 'percent',
    amount: 14,
    type_tax_use: 'sale',
    company_id: 1,
    ...defaultTaxRepartitionLines(taxAcc, []),
  });
  db = defaultTax.db;

  // Direction A: starts as tax_excluded
  assert.equal(read(db, 'res.company', 1).account_price_include, 'tax_excluded');

  const draftEntry = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    date: '2026-05-01',
    line_ids: [
      { account_id: bankAcc, debit: 114, credit: 0 },
      { account_id: revAcc, debit: 0, credit: 100, tax_ids: [defaultTax.id] },
    ],
  });
  db = draftEntry.db;

  const postedEntry = create(db, 'account.move', {
    move_type: 'entry',
    company_id: 1,
    date: '2026-05-01',
    line_ids: [
      { account_id: bankAcc, debit: 114, credit: 0 },
      { account_id: revAcc, debit: 0, credit: 100, tax_ids: [defaultTax.id] },
    ],
  });
  db = postMove(postedEntry.db, postedEntry.id);

  // Verify initial draft entry lines under tax_excluded:
  const draftInitial = read(db, 'account.move', draftEntry.id);
  const draftRevInitial = draftInitial.line_ids.find((l) => l.account_id === revAcc);
  const draftTaxInitial = draftInitial.line_ids.find((l) => l.tax_id === defaultTax.id);
  assert.equal(draftRevInitial.credit, 100);
  assert.equal(draftTaxInitial.credit, 14);
  assert.equal(draftTaxInitial.tax_include, false);

  // Company default changes from tax_excluded -> tax_included:
  db = write(db, 'res.company', 1, { account_price_include: 'tax_included' });

  // 1) Draft entry was refreshed automatically:
  const draftAfterIncl = read(db, 'account.move', draftEntry.id);
  const draftRevAfterIncl = draftAfterIncl.line_ids.find((l) => l.account_id === revAcc);
  const draftTaxAfterIncl = draftAfterIncl.line_ids.find((l) => l.tax_id === defaultTax.id);
  assert.equal(draftRevAfterIncl.credit, 87.72);
  assert.equal(draftTaxAfterIncl.credit, 12.28);
  assert.equal(draftTaxAfterIncl.tax_include, true);

  // 2) Posted entry was NOT changed:
  const postedAfter = read(db, 'account.move', postedEntry.id);
  const postedRev = postedAfter.line_ids.find((l) => l.account_id === revAcc);
  const postedTax = postedAfter.line_ids.find((l) => l.tax_id === defaultTax.id);
  assert.equal(postedRev.credit, 100);
  assert.equal(postedTax.credit, 14);

  // 3) Editing the draft entry retains the recovered calculation:
  db = write(db, 'account.move', draftEntry.id, { ref: 'Draft edit 1' });
  const draftEdited = read(db, 'account.move', draftEntry.id);
  const draftRevEdited = draftEdited.line_ids.find((l) => l.account_id === revAcc);
  const draftTaxEdited = draftEdited.line_ids.find((l) => l.tax_id === defaultTax.id);
  assert.equal(draftRevEdited.credit, 87.72);
  assert.equal(draftTaxEdited.credit, 12.28);

  // Direction B: flip back from tax_included -> tax_excluded:
  db = write(db, 'res.company', 1, { account_price_include: 'tax_excluded' });

  // Draft entry recovers gross (87.72 + 12.28 = 100) and recomputes under tax_excluded:
  const draftRestored = read(db, 'account.move', draftEntry.id);
  const draftRevRestored = draftRestored.line_ids.find((l) => l.account_id === revAcc);
  const draftTaxRestored = draftRestored.line_ids.find((l) => l.tax_id === defaultTax.id);
  assert.equal(draftRevRestored.credit, 100);
  assert.equal(draftTaxRestored.credit, 14);
  assert.equal(draftTaxRestored.tax_include, false);

  // Posted entry remains untouched:
  const postedRestored = read(db, 'account.move', postedEntry.id);
  assert.equal(postedRestored.line_ids.find((l) => l.account_id === revAcc).credit, 100);
});

test('Finding 2: migration preserves truthy non-boolean legacy price_include scalars under excluded company default', () => {
  const base = seed();
  const taxAcc = accountId(base, '251000', 1);

  const legacy = {
    ...base,
    schema_version: 63,
    records: {
      ...base.records,
      'res.company': base.records['res.company'].map((c) => ({ ...c, account_price_include: 'tax_excluded' })),
      'account.tax': [
        { id: 901, name: 'Tax Num 1', amount_type: 'percent', amount: 14, type_tax_use: 'sale', company_id: 1, price_include: 1, ...defaultTaxRepartitionLines(taxAcc, []) },
        { id: 902, name: 'Tax Str True', amount_type: 'percent', amount: 14, type_tax_use: 'sale', company_id: 1, price_include: 'true', ...defaultTaxRepartitionLines(taxAcc, []) },
        { id: 903, name: 'Tax Str Yes', amount_type: 'percent', amount: 14, type_tax_use: 'sale', company_id: 1, price_include: 'yes', ...defaultTaxRepartitionLines(taxAcc, []) },
        { id: 904, name: 'Tax Num 0', amount_type: 'percent', amount: 14, type_tax_use: 'sale', company_id: 1, price_include: 0, ...defaultTaxRepartitionLines(taxAcc, []) },
        { id: 905, name: 'Tax Str False', amount_type: 'percent', amount: 14, type_tax_use: 'sale', company_id: 1, price_include: 'false', ...defaultTaxRepartitionLines(taxAcc, []) },
        { id: 906, name: 'Tax Bool False', amount_type: 'percent', amount: 14, type_tax_use: 'sale', company_id: 1, price_include: false, ...defaultTaxRepartitionLines(taxAcc, []) },
      ],
    },
  };

  const migrated = migrate(legacy);

  const t901 = read(migrated, 'account.tax', 901);
  const t902 = read(migrated, 'account.tax', 902);
  const t903 = read(migrated, 'account.tax', 903);
  const t904 = read(migrated, 'account.tax', 904);
  const t905 = read(migrated, 'account.tax', 905);
  const t906 = read(migrated, 'account.tax', 906);

  assert.equal(t901.price_include_override, 'tax_included');
  assert.equal(t902.price_include_override, 'tax_included');
  assert.equal(t903.price_include_override, 'tax_included');
  assert.equal(t904.price_include_override ?? null, null);
  assert.equal(t905.price_include_override ?? null, null);
  assert.equal(t906.price_include_override ?? null, null);

  assert.equal(taxPriceInclude(migrated, t901), true);
  assert.equal(taxPriceInclude(migrated, t902), true);
  assert.equal(taxPriceInclude(migrated, t903), true);
  assert.equal(taxPriceInclude(migrated, t904), false);
  assert.equal(taxPriceInclude(migrated, t905), false);
  assert.equal(taxPriceInclude(migrated, t906), false);
});

test('Finding 3: shared taxes on invoice lines use document company default rather than active company default', () => {
  let db = seed();
  const c2 = createCompany(db, { name: 'Subsidiary Co' });
  db = c2.db;

  // Company 1 defaults to tax_excluded; Company 2 defaults to tax_included
  db = write(db, 'res.company', 1, { account_price_include: 'tax_excluded' });
  db = write(db, 'res.company', c2.id, { account_price_include: 'tax_included' });

  // Create shared tax (company_id: null) without override
  const taxAcc1 = accountId(db, '251000', 1);
  const sharedTax = create(db, 'account.tax', {
    name: 'Shared VAT 14%',
    amount_type: 'percent',
    amount: 14,
    type_tax_use: 'sale',
    company_id: null,
    ...defaultTaxRepartitionLines(taxAcc1, []),
  });
  db = sharedTax.db;

  // Active company is Company 1:
  setActiveCompany(1);

  // 1) Onchange tax_id on document belonging to Company 2
  const doc2 = { company_id: c2.id, move_type: 'out_invoice' };
  const lineSingle = models['account.move'].fields.invoice_line_ids.onchange({ tax_id: sharedTax.id }, 'tax_id', db, doc2);
  assert.equal(lineSingle.tax_include, true, 'Shared tax on Company 2 document gets tax_included from document company');

  // 2) Onchange tax_ids on document belonging to Company 2
  const lineMulti = models['account.move'].fields.invoice_line_ids.onchange({ tax_ids: [sharedTax.id] }, 'tax_ids', db, doc2);
  assert.equal(lineMulti.tax_breakdown[0].tax_include, true, 'Shared breakdown on Company 2 document gets tax_included from document company');

  // 3) newLine with default tax for Company 2:
  db = write(db, 'res.company', c2.id, { account_sale_tax_id: sharedTax.id });
  const newLineForCo2 = models['account.move'].fields.invoice_line_ids.newLine(doc2, db);
  assert.equal(newLineForCo2.tax_include, true, 'newLine default tax snapshot uses document company default');

  // Reset activeCompany
  setActiveCompany(null);
});

test('Findings 4 & 5: CSV imports with Included in Price column resolve boolean-like values, and explicit price_include: false sets tax_excluded override', () => {
  let db = seed();
  db = write(db, 'res.company', 1, { account_price_include: 'tax_included' });

  // Finding 5: creating tax with explicit price_include: false under tax_included company default
  const exclCreated = create(db, 'account.tax', {
    name: 'Explicit False Tax',
    amount: 14,
    type_tax_use: 'sale',
    company_id: 1,
    price_include: false,
  });
  db = exclCreated.db;
  const exclRec = read(db, 'account.tax', exclCreated.id);
  assert.equal(exclRec.price_include_override, 'tax_excluded', 'Explicit price_include: false sets tax_excluded override');
  assert.equal(taxPriceInclude(db, exclRec), false, 'Explicit price_include: false overrides tax_included company default');

  // Creating without price_include inherits company default (override stays null):
  const defaultCreated = create(db, 'account.tax', {
    name: 'Unset Override Tax',
    amount: 14,
    type_tax_use: 'sale',
    company_id: 1,
  });
  db = defaultCreated.db;
  const defaultRec = read(db, 'account.tax', defaultCreated.id);
  assert.equal(defaultRec.price_include_override ?? null, null);
  assert.equal(taxPriceInclude(db, defaultRec), true, 'Un-overridden tax inherits tax_included company default');

  // Finding 4: CSV import with column header 'Included in Price'
  const rows = [
    ['Tax Name', 'Amount', 'Type Tax Use', 'Included in Price'],
    ['CSV Tax True', '14', 'sale', 'true'],
    ['CSV Tax Yes', '14', 'sale', 'yes'],
    ['CSV Tax One', '14', 'sale', '1'],
    ['CSV Tax False', '14', 'sale', 'false'],
    ['CSV Tax No', '14', 'sale', 'no'],
    ['CSV Tax Zero', '14', 'sale', '0'],
  ];
  const { db: importedDb } = importCsvRows(db, 'account.tax', models['account.tax'].defaults(), rows);

  const tTrue = importedDb.records['account.tax'].find((t) => t.name === 'CSV Tax True');
  const tYes = importedDb.records['account.tax'].find((t) => t.name === 'CSV Tax Yes');
  const tOne = importedDb.records['account.tax'].find((t) => t.name === 'CSV Tax One');
  const tFalse = importedDb.records['account.tax'].find((t) => t.name === 'CSV Tax False');
  const tNo = importedDb.records['account.tax'].find((t) => t.name === 'CSV Tax No');
  const tZero = importedDb.records['account.tax'].find((t) => t.name === 'CSV Tax Zero');

  assert.equal(tTrue.price_include_override, 'tax_included');
  assert.equal(tYes.price_include_override, 'tax_included');
  assert.equal(tOne.price_include_override, 'tax_included');
  assert.equal(tFalse.price_include_override, 'tax_excluded');
  assert.equal(tNo.price_include_override, 'tax_excluded');
  assert.equal(tZero.price_include_override, 'tax_excluded');
});

test('CSV import rejects unknown Included in Price text instead of storing it', () => {
  const db = seed();
  const rows = [['Tax Name', 'Amount', 'Type Tax Use', 'Included in Price'], ['CSV Tax Maybe', '14', 'sale', 'maybe']];
  assert.throws(() => importCsvRows(db, 'account.tax', models['account.tax'].defaults(), rows), /Select a valid price include override/);
});
