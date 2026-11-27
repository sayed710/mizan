import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { seed } from './seed.js';
import { create, read, search, write } from './orm.js';
import { createCompany, setCompanies } from './models/company.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { accountId, balanceSheet, journalId, profitAndLoss } from './models/ledger.js';
import { journalCards } from './models/finance.js';
import { trialBalance } from './models/reports.js';
import { companyViewDb } from './companyView.js';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import { diffDb, applyDiff } from './sync.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('company 1 accounting seed retains the original records byte for byte', () => {
  const expected = readFileSync(new URL('./acct-co1-seed-fixture.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '').trim();
  const db = seed();
  const keys = Object.keys(JSON.parse(expected));
  assert.equal(JSON.stringify(Object.fromEntries(keys.map((key) => [key, db.records[key]]))), expected);
});

test('new company chart installs company-scoped chart, journals, taxes, terms, and defaults with repeated codes', () => {
  const base = seed();
  const company = createCompany(base, { name: 'Second Company' });
  const db = applyDiff(base, diffDb(base, company.db), { isAdmin: true });
  const co = read(db, 'res.company', company.id);

  assert.equal(db.records['account.account'].filter((r) => r.company_id === company.id).length, 42);
  assert.equal(db.records['account.journal'].filter((r) => r.company_id === company.id).length, 7);
  assert.equal(db.records['account.tax'].filter((r) => r.company_id === company.id).length, 7);
  assert.equal(db.records['account.tax.group'].filter((r) => r.company_id === company.id).length, 2);
  assert.equal(db.records['account.fiscal.position'].filter((r) => r.company_id === company.id).length, 2);
  assert.equal(db.records['account.payment.term'].filter((r) => r.company_id === company.id).length, 10);

  // Repeated codes across companies resolve independently
  for (const code of ['121000', '211000', '400000', '600000', '450100', '690100', '101404', '101405', '251000', '131000']) {
    assert.equal(read(db, 'account.account', accountId(db, code, company.id)).company_id, company.id);
  }
  for (const code of ['INV', 'BILL', 'BNK1', 'CSH1', 'MISC', 'SAL', 'POSS']) {
    assert.equal(read(db, 'account.journal', journalId(db, code, company.id)).company_id, company.id);
  }

  // Default accounts and journals are wired on res.company
  assert.equal(co.account_default_receivable_id, accountId(db, '121000', company.id));
  assert.equal(co.account_default_payable_id, accountId(db, '211000', company.id));
  assert.equal(co.income_currency_exchange_account_id, accountId(db, '450100', company.id));
  assert.equal(co.expense_currency_exchange_account_id, accountId(db, '690100', company.id));
  assert.equal(co.account_journal_suspense_account_id, accountId(db, '101404', company.id));
  assert.equal(co.transfer_account_id, accountId(db, '101405', company.id));
  assert.equal(co.default_sale_journal_id, journalId(db, 'INV', company.id));
  assert.equal(co.default_purchase_journal_id, journalId(db, 'BILL', company.id));
  assert.equal(co.default_general_journal_id, journalId(db, 'MISC', company.id));
  assert.equal(co.currency_exchange_journal_id, journalId(db, 'MISC', company.id));
  assert.ok(co.account_sale_tax_id && read(db, 'account.tax', co.account_sale_tax_id).company_id === company.id);
  assert.ok(co.account_purchase_tax_id && read(db, 'account.tax', co.account_purchase_tax_id).company_id === company.id);
});

test('new company posts taxed invoice, registers payment, reconciles bank line, and appears in reports', () => {
  const original = seed();
  const company = createCompany(original, { name: 'Second Company' });
  let db = applyDiff(original, diffDb(original, company.db), { isAdmin: true });
  const settings = read(db, 'res.company', company.id);

  const invoice = create(db, 'account.move', {
    company_id: company.id,
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-11-27',
    invoice_line_ids: [{ name: 'Sale', qty: 1, price_unit: 100, tax_id: settings.account_sale_tax_id, tax: 14 }],
  });
  db = postMove(invoice.db, invoice.id);
  const postedInvoice = read(db, 'account.move', invoice.id);
  assert.equal(postedInvoice.amount_total, 114);
  assert.equal(postedInvoice.journal_id, settings.default_sale_journal_id);

  // Register payment through the Register Payment wizard
  const regBtn = models['account.move'].form.buttons.find((b) => b.label === 'Register Payment');
  const wiz = regBtn.wizard(db, postedInvoice);
  const bankJournalId = journalId(db, 'BNK1', company.id);
  assert.equal(wiz.fields.find((f) => f.name === 'journal_id').default, bankJournalId);
  db = regBtn.run(db, postedInvoice, { amount: '114', date: '2026-11-27', journal_id: bankJournalId }).db;
  assert.equal(read(db, 'account.move', invoice.id).payment_state, 'paid');

  // Reconcile a bank statement line on the new company's bank journal against a second invoice
  const invoice2 = create(db, 'account.move', {
    company_id: company.id,
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-11-27',
    invoice_line_ids: [{ name: 'Second Sale', qty: 1, price_unit: 200, tax_id: settings.account_sale_tax_id, tax: 14 }],
  });
  db = postMove(invoice2.db, invoice2.id);
  const stmtLine = create(db, 'account.bank.statement.line', {
    company_id: company.id,
    journal_id: bankJournalId,
    date: '2026-11-28',
    payment_ref: 'Bank wire inv 2',
    amount: 228,
    move_id: invoice2.id,
  });
  const matchBtn = models['account.bank.statement.line'].form.buttons.find((b) => b.label === 'Match');
  db = matchBtn.run(stmtLine.db, read(stmtLine.db, 'account.bank.statement.line', stmtLine.id)).db;
  assert.equal(read(db, 'account.bank.statement.line', stmtLine.id).state, 'reconciled');
  assert.equal(read(db, 'account.move', invoice2.id).amount_residual, 0);

  // Appears in reports scoped to the new company
  const tb = trialBalance(db, { company_id: company.id });
  assert.ok(tb.rows.some((r) => r.account.code === '251000' && r.credit === 42));
  assert.ok(tb.rows.some((r) => r.account.code === '400000' && r.credit === 300));
  const scopedDb = companyViewDb(setCompanies(db, { current: company.id, allowed: [company.id] }));
  const pnl = profitAndLoss(scopedDb, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pnl.net, 300);
  const bs = balanceSheet(scopedDb, '2026-12-31');
  assert.equal(bs.totalAssets, 342);
});

test('dashboard hides journals with show_on_dashboard off and applies color classes', async () => {
  let db = seed();
  const invJournal = search(db, 'account.journal').find((j) => j.code === 'INV');
  const bankJournal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', invJournal.id, { show_on_dashboard: false });
  db = write(db, 'account.journal', bankJournal.id, { color: 3 });

  assert.ok(!journalCards(db).some((card) => card.journal.id === invJournal.id));
  const bankCard = journalCards(db).find((card) => card.journal.id === bankJournal.id);
  assert.equal(bankCard.journal.color, 3);

  const { initStore, commit } = await import('./store.js');
  await initStore();
  await commit(setCompanies(db, { current: 1, allowed: [1] }));
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { Dashboard } = await import('./views/Dashboard.jsx');
  const html = renderToStaticMarkup(React.createElement(Dashboard));
  assert.ok(!html.includes(invJournal.name), 'Hidden journal must not render on dashboard');
  assert.ok(html.includes('journal-color-3'), 'Colored journal must render its color class');
});

test('migration 85 backfills color and show_on_dashboard on existing journals', () => {
  const base = seed();
  const legacy = {
    ...base,
    schema_version: 84,
    records: {
      ...base.records,
      'account.journal': base.records['account.journal'].map(({ color: _c, show_on_dashboard: _s, ...j }) => j),
    },
  };
  const migrated = migrate(legacy, SCHEMA_VERSION);
  assert.equal(migrated.schema_version, 85);
  for (const j of migrated.records['account.journal']) {
    assert.equal(j.color, 0);
    assert.equal(j.show_on_dashboard, true);
  }
});
