import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { createCompany } from './models/company.js';
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

test('Accounting Settings renders Odoo block order with descriptions, currency link and no duplicated moved items', async () => {
  const ctx = await renderSettings();
  try {
    const accountingSection = find(ctx.host, (n) => n.tagName === 'SECTION' && props(n)?.className === 'settings-accounting');
    assert.ok(accountingSection, 'Accounting section renders');
    const h2 = find(accountingSection, (n) => n.tagName === 'H2');
    assert.equal(h2?.textContent, 'Accounting');

    const blocks = collect(accountingSection, (n) => props(n)?.['data-block']);
    assert.deepEqual(
      blocks.map((b) => props(b)['data-block']),
      ['taxes', 'currencies', 'customer_payments', 'vendor_bills', 'fiscal_periods'],
    );
    assert.deepEqual(
      blocks.map((b) => find(b, (n) => n.tagName === 'H3')?.textContent),
      ['Taxes', 'Currencies', 'Customer Payments', 'Vendor Bills', 'Fiscal Periods'],
    );

    const rows = collect(accountingSection, (n) => props(n)?.['data-setting']);
    assert.ok(rows.length >= 16);
    for (const row of rows) {
      const label = find(row, (n) => n.tagName === 'LABEL');
      const desc = find(row, (n) => n.tagName === 'P' && String(props(n)?.className ?? '').includes('setting-desc'));
      assert.ok(label?.textContent, `Setting ${props(row)['data-setting']} has title`);
      assert.ok(desc?.textContent, `Setting ${props(row)['data-setting']} has description`);
    }

    const curLink = find(accountingSection, (n) => n.tagName === 'A' && props(n)?.href === '#/accounting/currencies');
    assert.ok(curLink, 'Currencies link is present');

    const movedIds = ['currency', 'lock_date', 'sale_lock_date', 'purchase_lock_date', 'tax_lock_date', 'hard_lock_date', 'invoice_qr', 'company_vat', 'company_iban', 'three_way_matching', 'audit_trail'];
    for (const id of movedIds) {
      const matches = collect(ctx.host, (n) => props(n)?.id === id);
      assert.equal(matches.length, 1, `Moved setting ${id} rendered exactly once`);
      assert.ok(find(accountingSection, (n) => props(n)?.id === id), `Moved setting ${id} lives inside Accounting section`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('Accounting Settings writes every shown setting to the active res.company record and rejects invalid writes', async () => {
  let secondCompanyId;
  const ctx = await renderSettings((base) => {
    const second = createCompany(base, { name: 'Second Branch Co' });
    secondCompanyId = second.id;
    // Switch active company to verify edits target active company only, not hardcoded company 1.
    return { ...second.db, settings: { ...second.db.settings, current_company_id: secondCompanyId } };
  });
  try {
    const db0 = ctx.getDb();
    const saleTax = search(db0, 'account.tax').find((x) => x.type_tax_use === 'sale' && x.active !== false && !x.company_id);
    const purchTax = search(db0, 'account.tax').find((x) => x.type_tax_use === 'purchase' && x.active !== false && !x.company_id);
    assert.ok(saleTax && purchTax);

    const change = async (id, value, key = 'value') => {
      const el = ctx.control(id);
      assert.ok(el, `Control #${id} exists`);
      await ctx.React.act(async () => props(el).onChange({ target: { [key]: value } }));
    };

    await change('account_sale_tax_id', String(saleTax.id));
    await change('account_purchase_tax_id', String(purchTax.id));
    await change('tax_calculation_rounding_method', 'round_globally');
    await change('tax_periodicity', 'trimester');
    await change('tax_start_date', '2026-01-01');
    await change('company_vat', '300012345600003');
    await change('invoice_qr', 'zatca');
    await change('company_iban', 'SA0380000000608010167519');
    await change('three_way_matching', true, 'checked');
    await change('lock_date', '2026-03-31');
    await change('sale_lock_date', '2026-04-30');
    await change('purchase_lock_date', '2026-05-31');
    await change('tax_lock_date', '2026-06-30');
    await change('hard_lock_date', '2026-02-28');
    await change('audit_trail', true, 'checked');

    const updated = read(ctx.getDb(), 'res.company', secondCompanyId);
    assert.equal(updated.account_sale_tax_id, saleTax.id);
    assert.equal(updated.account_purchase_tax_id, purchTax.id);
    assert.equal(updated.tax_calculation_rounding_method, 'round_globally');
    assert.equal(updated.tax_periodicity, 'trimester');
    assert.equal(updated.tax_start_date, '2026-01-01');
    assert.equal(updated.vat, '300012345600003');
    assert.equal(updated.invoice_qr, 'zatca');
    assert.equal(updated.company_iban, 'SA0380000000608010167519');
    assert.equal(updated.three_way_matching, true);
    assert.equal(updated.lock_date, '2026-03-31');
    assert.equal(updated.sale_lock_date, '2026-04-30');
    assert.equal(updated.purchase_lock_date, '2026-05-31');
    assert.equal(updated.tax_lock_date, '2026-06-30');
    assert.equal(updated.hard_lock_date, '2026-02-28');
    assert.equal(updated.audit_trail, true);

    // Company 1 stays untouched by active-company edits.
    const co1 = read(ctx.getDb(), 'res.company', 1);
    assert.notEqual(co1.vat, '300012345600003');
    assert.equal(co1.tax_calculation_rounding_method, undefined);

    // Clearing optional tax/method/date fields works cleanly too.
    await change('account_sale_tax_id', '');
    await change('account_purchase_tax_id', '');
    await change('tax_calculation_rounding_method', 'round_per_line');
    await change('invoice_qr', 'epc');
    await change('three_way_matching', false, 'checked');
    const cleared = read(ctx.getDb(), 'res.company', secondCompanyId);
    assert.equal(cleared.account_sale_tax_id, null);
    assert.equal(cleared.account_purchase_tax_id, null);
    assert.equal(cleared.tax_calculation_rounding_method, 'round_per_line');
    assert.equal(cleared.invoice_qr, 'epc');
    assert.equal(cleared.three_way_matching, false);

    // Invalid input is rejected before writing without corrupting res.company.
    await change('tax_start_date', 'not-a-date');
    assert.equal(read(ctx.getDb(), 'res.company', secondCompanyId).tax_start_date, '2026-01-01');
    const status = find(ctx.host, (n) => props(n)?.role === 'status');
    assert.match(status?.textContent ?? '', /valid date/i);

    await change('tax_calculation_rounding_method', 'bogus_rounding');
    assert.equal(read(ctx.getDb(), 'res.company', secondCompanyId).tax_calculation_rounding_method, 'round_per_line');
    const status2 = find(ctx.host, (n) => props(n)?.role === 'status');
    assert.match(status2?.textContent ?? '', /rounding method/i);

    // Creating a tax with wrong type cannot bypass companyGuard.
    const wrongTax = create(ctx.getDb(), 'account.tax', { name: 'Wrong', type_tax_use: 'purchase', amount: 5 });
    assert.throws(() => write(wrongTax.db, 'res.company', secondCompanyId, { account_sale_tax_id: wrongTax.id }), /Default Sales Tax/);
  } finally {
    await ctx.cleanup();
  }
});

test('With a company record, the Currencies block shows the currency read-only and offers no select', async () => {
  const ctx = await renderSettings();
  try {
    const currenciesBlock = find(ctx.host, (n) => props(n)?.['data-block'] === 'currencies');
    assert.ok(currenciesBlock, 'Currencies block renders');
    assert.equal(find(currenciesBlock, (n) => n.tagName === 'SELECT'), null, 'No select rendered when company record exists');
    const ro = find(currenciesBlock, (n) => n.tagName === 'SPAN' && props(n)?.id === 'currency' && props(n)?.className === 'readonly');
    assert.ok(ro, 'Read-only currency display renders');
    const companyCurrency = read(ctx.getDb(), 'res.currency', read(ctx.getDb(), 'res.company', 1).currency_id).name;
    assert.equal(ro.textContent, companyCurrency);
    assert.ok(currenciesBlock.textContent.includes('The company currency is part of its accounting: amounts are not converted, so it is set on the company record before posting.'));
    assert.ok(find(currenciesBlock, (n) => n.tagName === 'A' && props(n)?.href === '#/accounting/currencies'));
    assert.ok(find(currenciesBlock, (n) => n.tagName === 'A' && props(n)?.href === '#/open/res.company/1' && n.textContent === 'Open the company'));
  } finally {
    await ctx.cleanup();
  }
});

test('Settings omits skipped Odoo features and omits any setting whose res.company field is missing', async () => {
  const companyFields = models['res.company'].fields;
  const savedVat = companyFields.vat;
  const savedThreeWay = companyFields.three_way_matching;
  delete companyFields.vat;
  delete companyFields.three_way_matching;
  const ctx = await renderSettings();
  try {
    const labels = collect(ctx.host, (n) => ['LABEL', 'H2', 'H3'].includes(n.tagName)).map((n) => n.textContent);
    for (const omitted of [
      'Fiscal Localization', 'Verify VAT Numbers', 'Cash Basis', 'Customer Invoices',
      'Snail Mail', 'Default Incoterm', 'Sale Credit Limit', 'Units & Packagings',
      'Invoice Online Payment', 'Batch Payments', 'Vendor Payments',
      'Digitization', 'Accounting Firms Mode', 'Quick encoding',
    ]) {
      assert.equal(labels.includes(omitted), false, `Skipped Odoo setting "${omitted}" is not rendered`);
    }
    assert.equal(ctx.control('company_vat'), null, 'Setting with missing vat field is not rendered');
    assert.equal(ctx.control('three_way_matching'), null, 'Setting with missing three_way_matching field is not rendered');
    assert.equal(find(ctx.host, (n) => props(n)?.['data-block'] === 'vendor_bills'), null, 'Block with no available fields is not rendered');
  } finally {
    companyFields.vat = savedVat;
    companyFields.three_way_matching = savedThreeWay;
    await ctx.cleanup();
  }
});

test('Settings Accounting labels and descriptions have Arabic translations in i18n.js', () => {
  const i18nSrc = fs.readFileSync('src/i18n.js', 'utf8');
  for (const key of [
    'Taxes', 'Default Sales Tax', 'Default Purchase Tax', 'Rounding Method',
    'Round per Line', 'Round Globally', 'Tax Periodicity', 'Tax Period Start',
    'Company Tax ID', 'Currencies', 'Main Currency', 'Customer Payments',
    'Payment QR Codes', 'Bank Account (IBAN)', 'Vendor Bills', 'Three-Way Matching',
    'Fiscal Periods', 'Lock Date', 'Sales Lock Date', 'Purchase Lock Date',
    'Tax Return Lock Date', 'Hard Lock Date', 'Restrictive Audit Trail',
    'Default tax applied automatically to new customer invoice and sales order lines.',
    'Default tax applied automatically to new vendor bill and purchase order lines.',
    'Round tax amounts per invoice line or globally per tax group on the document.',
    'How often periodic tax returns are generated for the company.',
    'First date from which periodic tax return periods are scheduled.',
    'Company VAT registration number printed on invoices, tax reports and ZATCA QR codes.',
    'The company currency is part of its accounting: amounts are not converted, so it is set on the company record before posting.',
    'Open the company',
    'Add a scannable payment QR code to printed customer invoices.',
    'Company IBAN encoded into SEPA (EPC) payment QR codes on customer invoices.',
    'Verify that vendor bill quantities match the purchase order and receipt before marking bills ready to pay.',
    'Prevent creating, editing or deleting accounting entries on or before this date.',
    'Prevent creating or modifying customer invoices and credit notes on or before this date.',
    'Prevent creating or modifying vendor bills and refunds on or before this date.',
    'Lock tax-impacting entries up to the submitted tax return period.',
    'Permanent closing date that cannot be moved back or removed once set.',
    'Prevent altering posted entries, logs and sequences once permanently enabled.',
  ]) {
    assert.ok(i18nSrc.includes(key), `i18n includes translation for "${key}"`);
  }
});
