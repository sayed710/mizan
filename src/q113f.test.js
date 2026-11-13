import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { models, menusFor } from './models/index.js';
import { payMove } from './models/accounting.js';
import { createCompany } from './models/company.js';
import { journalCards } from './models/finance.js';
import { applyDiff, diffDb } from './sync.js';
import { fromCsv, importCsvRows, toCsv } from './csv.js';
import { journalCardListUrl } from './views/journalDashboard.js';
import { find, setupDom } from './test-support/dom.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const leafFor = (section, key) => menusFor('accounting').find((m) => m.label === section).children.find((c) => c.key === key);
const confirm = (db, id) => models['account.move'].form.buttons.find((b) => b.label === 'Confirm').run(db, read(db, 'account.move', id)).db;
const memoryStorage = () => {
  const mem = new Map();
  return { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); }, clear: () => mem.clear() };
};

// 1. Payment registration must not touch the locked bank field of a posted bill.
test('registering an outbound payment for a posted bill without a bank does not write the locked partner_bank_id', () => {
  let db = seed();
  const bank = create(db, 'res.partner.bank', { partner_id: 7, account_number: 'Q113F-VENDOR-BANK', allow_out_payment: true });
  db = bank.db;
  const bill = create(db, 'account.move', { move_type: 'in_invoice', partner_id: 7, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 1000, tax: 0 }] });
  db = confirm(bill.db, bill.id);
  const draft = create(db, 'account.payment', { partner_id: 7, payment_type: 'outbound', partner_type: 'supplier', amount: 400, date: '2026-10-01', partner_bank_id: bank.id });
  db = draft.db;
  assert.equal(read(db, 'account.move', bill.id).partner_bank_id ?? null, null);
  const paid = payMove(db, bill.id, 400, '2026-10-01', { paymentId: draft.id });
  assert.equal(read(paid, 'account.move', bill.id).partner_bank_id ?? null, null, 'the posted bill keeps its own bank value');
  assert.equal(read(paid, 'account.payment', draft.id).partner_bank_id, bank.id, 'the payment still records the recipient bank');
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, paid), { isAdmin: false, author: 'Clerk' }));
});

test('a real change to a posted bill bank still follows the lock rules', () => {
  let db = seed();
  const bank = create(db, 'res.partner.bank', { partner_id: 7, account_number: 'Q113F-LOCK-BANK' });
  const bill = create(bank.db, 'account.move', { move_type: 'in_invoice', partner_id: 7, invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }] });
  db = confirm(bill.db, bill.id);
  const edited = write(db, 'account.move', bill.id, { partner_bank_id: bank.id });
  assert.throws(() => applyDiff(db, diffDb(db, edited), { isAdmin: false, author: 'Clerk' }), /locked/);
});

// 2. Export labels round trip through import.
for (const [key, section, moveType, dateField] of [['invoices', 'Customers', 'out_invoice', 'invoice_date'], ['bills', 'Vendors', 'in_invoice', 'invoice_date']]) {
  test(`exporting ${key} with the menu labels and importing the file keeps partner and date`, async () => {
    const { colLabel } = await import('./views/List.jsx');
    const leaf = leafFor(section, key);
    const def = models['account.move'];
    const source = create(seed(), 'account.move', { move_type: moveType, partner_id: moveType === 'in_invoice' ? 7 : 3, invoice_date: '2026-03-04', invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 10, tax: 0 }] });
    const record = read(source.db, 'account.move', source.id);
    const cols = def.list.filter((f) => ['partner_id', dateField].includes(f));
    const csv = toCsv([cols.map((f) => colLabel(def.fields, f, leaf.listLabels)), cols.map((f) => record[f])]);
    assert.deepEqual(fromCsv(csv)[0], [moveType === 'in_invoice' ? 'Vendor' : 'Customer', moveType === 'in_invoice' ? 'Bill Date' : 'Invoice Date']);
    const target = seed();
    const imported = importCsvRows(target, 'account.move', leaf.defaults, fromCsv(csv), leaf.listLabels);
    assert.equal(imported.count, 1);
    const known = new Set(search(target, 'account.move').map((m) => m.id));
    const row = search(imported.db, 'account.move').find((m) => !known.has(m.id));
    assert.ok(row, 'a document was imported');
    assert.equal(row.move_type, moveType);
    assert.equal(row.invoice_date, '2026-03-04');
    assert.equal(row.partner_id, record.partner_id);
  });
}

// 3. Dashboard bank card import carries the journal's own company.
test('importing a statement through an empty bank card of a company 2 journal creates company 2 lines (CSV and OFX)', async () => {
  const c2 = createCompany(seed(), { name: 'Branch Co', currency_id: read(seed(), 'res.company', 1).currency_id });
  const acc = create(c2.db, 'account.account', { code: '101477', name: 'Branch Bank', account_type: 'asset_cash', company_id: c2.id });
  const journal = create(acc.db, 'account.journal', { name: 'Branch Bank J', code: 'BBJ', type: 'bank', company_id: c2.id, default_account_id: acc.id, suspense_account_id: acc.id });
  const { initStore, commit, getDb } = await import('./store.js');
  const { importModelFile } = await import('./views/importModelFile.js');
  await initStore();
  await commit(journal.db);
  const card = journalCards(getDb()).find((c) => c.journal.id === journal.id);
  assert.ok(!card.hasPosted && !card.toReconcile, 'the card is empty');
  // What the dashboard bank card passes: only the journal.
  const defaults = { journal_id: card.journal.id };
  const prevAlert = globalThis.alert;
  globalThis.alert = () => {};
  try {
    const ofx = '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN><DTPOSTED>20260115<TRNAMT>120.50<NAME>Wire<FITID>Q113F-1</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
    await importModelFile('account.bank.statement.line', defaults, { name: 's.ofx', text: async () => ofx });
    await importModelFile('account.bank.statement.line', defaults, { name: 's.csv', text: async () => 'date,amount,payment_ref\n2026-01-16,55,CSV row\n' });
  } finally {
    globalThis.alert = prevAlert;
  }
  const lines = search(getDb(), 'account.bank.statement.line').filter((l) => l.journal_id === journal.id);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.company_id), [c2.id, c2.id]);
});

// 5. Empty cash card opens only its own journal.
test('the empty cash card Cash Transactions link opens entries of that journal only', () => {
  const cash = journalCards(seed()).find((c) => c.kind === 'cash');
  assert.equal(journalCardListUrl(cash), `#/accounting/entries?view=list&rel=journal_id:${cash.journal.id}`);
});

// 6. A misconfigured journal does not blank the dashboard.
test('dashboard renders a misconfigured journal as an error card and every other card normally', async () => {
  const c2 = createCompany(seed(), { name: 'Second Co', currency_id: read(seed(), 'res.company', 1).currency_id });
  const bankAcc = create(c2.db, 'account.account', { code: '101496', name: 'Shared Bank Acc 3', account_type: 'asset_cash', company_id: null });
  const sharedSusp = search(bankAcc.db, 'account.account').find((a) => a.code === '101404');
  const otherOut = create(bankAcc.db, 'account.account', { code: '101497', name: 'C2 Only Out 3', account_type: 'asset_current', company_id: c2.id });
  const shared = create(otherOut.db, 'account.journal', { name: 'Broken Shared Bank', code: 'BRK', type: 'bank', company_id: null, default_account_id: bankAcc.id, suspense_account_id: sharedSusp.id });
  // Simulate legacy misconfigured state directly since journal guards reject cross-company outstanding accounts on write.
  const injectedJournals = shared.db.records['account.journal'].map((j) => (
    j.id === shared.id ? { ...j, outstanding_receipts_account_id: otherOut.id } : j
  ));
  const db = {
    ...shared.db,
    records: { ...shared.db.records, 'account.journal': injectedJournals },
    settings: { ...shared.db.settings, current_company_id: 1, allowed_company_ids: [1, c2.id] },
  };
  const cards = journalCards(db);
  const broken = cards.find((c) => c.journal.id === shared.id);
  assert.equal(broken.kind, 'error');
  assert.match(broken.error, /Outstanding account must belong to the payment company/);
  assert.ok(cards.filter((c) => c.kind !== 'error').length >= 4, 'other journals still compute');
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { initStore, commit } = await import('./store.js');
  const { Dashboard } = await import('./views/Dashboard.jsx');
  await initStore();
  await commit(db);
  const html = renderToStaticMarkup(React.createElement(Dashboard));
  assert.match(html, /<section class="panel journal-card journal-card-error"><h2>Broken Shared Bank<\/h2><p class="journal-error" role="alert">Outstanding account must belong to the payment company/);
  assert.match(html, /Invoiced this month/);
  assert.match(html, /class="panel journal-card"/);
});

// 7. Default taxes are validated only when changed.
test('archiving a referenced default tax does not block unrelated company edits, but choosing it does', () => {
  let db = seed();
  const tax = search(db, 'account.tax').find((t) => t.type_tax_use === 'sale' && t.active !== false);
  db = write(db, 'res.company', 1, { account_sale_tax_id: tax.id });
  db = write(db, 'account.tax', tax.id, { active: false });
  assert.doesNotThrow(() => write(db, 'res.company', 1, { name: 'Renamed Co' }));
  const other = create(db, 'account.tax', { name: 'Archived sale', amount: 3, type_tax_use: 'sale', active: false });
  assert.throws(() => write(other.db, 'res.company', 1, { account_sale_tax_id: other.id }), /Default Sales Tax must be an active sale tax/);
  assert.throws(() => write(db, 'res.company', 1, { account_purchase_tax_id: tax.id }), /Default Purchase Tax must be an active purchase tax/);
});

// 8. A line taxed by a bare rate shows that rate.
test('an invoice line with a numeric tax and no tax record shows the percentage in the Taxes cell', async () => {
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit } = await import('./store.js');
  const { FormView } = await import('./views/FormView.jsx');
  await initStore();
  const bill = create(seed(), 'account.move', { move_type: 'in_invoice', partner_id: 7, invoice_line_ids: [{ name: 'Digitized', qty: 1, price_unit: 100, tax: 14 }] });
  assert.equal(read(bill.db, 'account.move', bill.id).invoice_line_ids[0].tax_id ?? null, null);
  await commit(bill.db);
  const host = globalThis.document.createElement('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(FormView, { leaf: leafFor('Vendors', 'bills'), id: bill.id, base: '#/accounting/bills', params: new URLSearchParams('view=form') })));
    const cell = find(host, (n) => n.tagName === 'TD' && n.textContent.includes('14%'));
    assert.ok(cell, 'the 14% rate is visible on the line');
  } finally {
    await React.act(async () => root.unmount());
    globalThis.localStorage = prevStorage;
  }
});

// 9. Empty-state help only on a truly empty list.
test('list empty help shows only without a search or filter', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { initStore, commit } = await import('./store.js');
  const { ActionView } = await import('./views/ActionView.jsx');
  await initStore();
  const base = seed();
  await commit({ ...base, records: { ...base.records, 'account.move': base.records['account.move'].filter((m) => m.move_type !== 'out_invoice') } });
  const html = (query) => renderToStaticMarkup(React.createElement(ActionView, { leaf: leafFor('Customers', 'invoices'), base: '#/accounting/invoices', params: new URLSearchParams(query) }));
  assert.match(html('view=list'), /Create a customer invoice/);
  const filtered = html('view=list&filter=draft');
  assert.doesNotMatch(filtered, /Create a customer invoice/);
  assert.match(filtered, /No record found/);
});
