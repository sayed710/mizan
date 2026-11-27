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
import { newDefaults } from './views/formDefaults.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

test('company 1 accounting seed retains the original records byte for byte', () => {
  const expected = readFileSync(new URL('./acct-co1-seed-fixture.json', import.meta.url), 'utf8').replace(/^\uFEFF/, '').trim();
  const db = seed();
  const keys = Object.keys(JSON.parse(expected));
  for (const journal of db.records['account.journal']) {
    assert.equal(journal.color, 0);
    assert.equal(journal.show_on_dashboard, true);
  }
  const actual = Object.fromEntries(keys.map((key) => [
    key,
    key === 'account.journal'
      ? db.records[key].map(({ color: _c, show_on_dashboard: _s, ...journal }) => journal)
      : db.records[key],
  ]));
  assert.equal(JSON.stringify(actual), expected);
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

test('sync allows matching posted invoice numbers across different companies while rejecting duplicates in the same company', () => {
  const base = seed();
  let server = base;
  const c1FirstName = server.records['account.move'].find((m) => m.move_type === 'out_invoice' && m.state === 'posted')?.name;
  assert.ok(c1FirstName, 'seed has a posted company 1 invoice');
  // Scope company 1 invoice journals to company 1 so a second company also gets the INV/ prefix at counter 1.
  for (const code of ['INV', 'BILL']) {
    const j = server.records['account.journal'].find((row) => row.code === code);
    server = write(server, 'account.journal', j.id, { company_id: 1 });
  }
  const company2 = createCompany(server, { name: 'Second Company' });
  server = applyDiff(server, diffDb(server, company2.db), { isAdmin: true });
  const c2InvJournal = read(server, 'account.journal', journalId(server, 'INV', company2.id));
  assert.equal(c2InvJournal.invoice_sequence_prefix, 'INV/');
  assert.equal(c2InvJournal.invoice_sequence_next_number, 1);

  const c2Sale = create(server, 'account.move', {
    company_id: company2.id,
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: `${c1FirstName.split('/')[1]}-11-27`,
    invoice_line_ids: [{ name: 'C2 Sale', qty: 1, price_unit: 150, tax: 0 }],
  });
  const c2Posted = postMove(c2Sale.db, c2Sale.id);
  assert.equal(read(c2Posted, 'account.move', c2Sale.id).name, c1FirstName);
  server = applyDiff(server, diffDb(server, c2Posted), { isAdmin: true });
  assert.equal(read(server, 'account.move', c2Sale.id).state, 'posted');
  assert.equal(read(server, 'account.move', c2Sale.id).name, c1FirstName);

  // Same-company duplicate posted invoice number is still rejected on sync (in both company 1 and company 2).
  for (const cid of [1, company2.id]) {
    const dup = create(server, 'account.move', {
      company_id: cid,
      move_type: 'out_invoice',
      partner_id: 3,
      name: c1FirstName,
      invoice_date: `${c1FirstName.split('/')[1]}-11-27`,
      invoice_line_ids: [{ name: 'Dup', qty: 1, price_unit: 50, tax: 0 }],
    });
    assert.throws(
      () => applyDiff(server, diffDb(server, postMove(dup.db, dup.id)), { isAdmin: true }),
      /already assigned/,
    );
  }
});

test('journal sequence guard rejects collisions with shared journals and chart template disambiguates prefixes', () => {
  const base = seed();
  const sharedInv = base.records['account.journal'].find((j) => j.code === 'INV');
  assert.equal(sharedInv.company_id, undefined);

  const company2 = createCompany(base, { name: 'Second Company' });
  const c2Inv = read(company2.db, 'account.journal', journalId(company2.db, 'INV', company2.id));
  const c2Bill = read(company2.db, 'account.journal', journalId(company2.db, 'BILL', company2.id));
  const c2Pos = read(company2.db, 'account.journal', journalId(company2.db, 'POSS', company2.id));
  assert.notEqual(c2Inv.invoice_sequence_prefix, sharedInv.invoice_sequence_prefix);
  assert.notEqual(c2Inv.refund_sequence_prefix, sharedInv.refund_sequence_prefix);
  assert.equal(c2Inv.invoice_sequence_prefix, `INV-${company2.id}/`);
  assert.equal(c2Bill.invoice_sequence_prefix, `BILL-${company2.id}/`);
  assert.equal(c2Pos.invoice_sequence_prefix, `POS-${company2.id}/`);

  assert.throws(
    () => create(company2.db, 'account.journal', {
      name: 'Colliding Company 2 Journal',
      code: 'C2DUP',
      type: 'sale',
      company_id: company2.id,
      default_account_id: accountId(company2.db, '400000', company2.id),
      invoice_sequence_prefix: 'INV/',
      invoice_sequence_next_number: 1,
    }),
    /Each journal sequence prefix must be unique/,
  );
  assert.throws(
    () => create(company2.db, 'account.journal', {
      name: 'Colliding Shared Journal',
      code: 'SHDUP',
      type: 'sale',
      default_account_id: accountId(company2.db, '400000', 1),
      invoice_sequence_prefix: c2Inv.invoice_sequence_prefix,
      invoice_sequence_next_number: 1,
    }),
    /Each journal sequence prefix must be unique/,
  );
});

test('seeded journals and new journal defaults set color and show_on_dashboard explicitly', () => {
  const db = seed();
  for (const journal of db.records['account.journal']) {
    assert.equal(journal.color, 0);
    assert.equal(journal.show_on_dashboard, true);
  }
  const noCompanyDb = { ...db, records: { ...db.records, 'res.company': [] } };
  const defaults = newDefaults(noCompanyDb, 'account.journal', {}, new URLSearchParams(), null);
  assert.equal(defaults.color, 0);
  assert.equal(defaults.show_on_dashboard, true);
});
