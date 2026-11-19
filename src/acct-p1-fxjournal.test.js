import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const { companyCurrencyRecord } = await import('./money.js');
const { create, read, search, write } = await import('./orm.js');
const { seed } = await import('./seed.js');
const { models } = await import('./models/index.js');
const { createCompany } = await import('./models/company.js');
const { postMove } = await import('./models/accounting.js');
const { journalItems, postEntry, valueOnlyCurrencyFields, reconciledJournalItems } = await import('./models/ledger.js');
const { postPayment, applyPaymentCredit } = await import('./models/pay.js');
const { reconcileLedgerItems } = await import('./models/glReconcile.js');
const { applyDiff, diffDb } = await import('./sync.js');
const { find, setupDom } = await import('./test-support/dom.js');

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

function setupCurrencies(initialDb) {
  let db = initialDb;
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [
      { date: '2026-01-01', rate: 0.8 }, // 100 EUR = 125 company currency (SAR)
      { date: '2026-02-01', rate: 0.5 }, // 100 EUR = 200 company currency (SAR)
      { date: '2026-03-01', rate: 0.625 }, // 100 EUR = 160 company currency (SAR)
    ],
  });
  return { db, eur: read(db, 'res.currency', eur.id) };
}

async function renderSettingsView(initialDb) {
  const { makeEl } = setupDom();
  const prevConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { Settings } = await import('./views/Settings.jsx');
  await initStore();
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

// ---------------------------------------------------------------------------
// 1. Company field and guard validation
// ---------------------------------------------------------------------------

test('currency_exchange_journal_id is defined on res.company and validated via companyGuard and applyDiff', () => {
  let db = seed();
  const companyField = models['res.company'].fields.currency_exchange_journal_id;
  assert.ok(companyField, 'res.company must have currency_exchange_journal_id field');
  assert.equal(companyField.type, 'many2one');
  assert.equal(companyField.relation, 'account.journal');
  assert.equal(companyField.label, 'Exchange Difference Journal');

  const comp1 = read(db, 'res.company', 1);
  const dedicatedJournal = create(db, 'account.journal', {
    name: 'Foreign Exchange Difference',
    code: 'FXD',
    type: 'general',
    company_id: 1,
  });
  db = dedicatedJournal.db;

  // Setting a valid general journal of the company succeeds via diffDb + applyDiff as admin
  const validNext = write(db, 'res.company', comp1.id, { currency_exchange_journal_id: dedicatedJournal.id });
  const diff = diffDb(db, validNext);
  const applied = applyDiff(db, diff, { isAdmin: true });
  assert.equal(read(applied, 'res.company', 1).currency_exchange_journal_id, dedicatedJournal.id);

  // Reject setting a non-general journal (e.g. sale journal)
  const saleJournal = search(db, 'account.journal').find((j) => j.type === 'sale' && (j.company_id === 1 || !j.company_id));
  assert.throws(
    () => write(db, 'res.company', comp1.id, { currency_exchange_journal_id: saleJournal.id }),
    /Exchange Difference Journal must be an active general journal shared with or belonging to this company/i,
  );

  // Reject setting a general journal belonging to another company
  const comp2 = createCompany(db, { name: 'Company Two' });
  db = comp2.db;
  const comp2Journal = create(db, 'account.journal', {
    name: 'Co2 General Journal',
    code: 'C2GEN',
    type: 'general',
    company_id: comp2.id,
  });
  db = comp2Journal.db;

  assert.throws(
    () => write(db, 'res.company', 1, { currency_exchange_journal_id: comp2Journal.id }),
    /Exchange Difference Journal must be an active general journal shared with or belonging to this company/i,
  );

  // Reject setting non-existent journal id
  assert.throws(
    () => write(db, 'res.company', 1, { currency_exchange_journal_id: 999999 }),
    /Exchange Difference Journal must be an active general journal shared with or belonging to this company/i,
  );
});

test('Only administrators can change currency_exchange_journal_id via diffDb + applyDiff', () => {
  let db = seed();
  const journal = create(db, 'account.journal', {
    name: 'Admin FX Journal',
    code: 'AFXJ',
    type: 'general',
    company_id: 1,
  });
  db = journal.db;

  const attempt = {
    ...db,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (
        c.id === 1 ? { ...c, currency_exchange_journal_id: journal.id } : c
      )),
    },
  };
  const diff = diffDb(db, attempt);

  assert.throws(
    () => applyDiff(db, diff, { isAdmin: false }),
    /Only administrators/i,
  );

  const applied = applyDiff(db, diff, { isAdmin: true });
  assert.equal(read(applied, 'res.company', 1).currency_exchange_journal_id, journal.id);
});

test('Company guard rejects an archived journal as Exchange Difference Journal', () => {
  let db = seed();
  const archived = create(db, 'account.journal', {
    name: 'Archived FX Journal',
    code: 'ARCFX',
    type: 'general',
    company_id: 1,
    active: false,
  });
  db = archived.db;

  assert.throws(
    () => write(db, 'res.company', 1, { currency_exchange_journal_id: archived.id }),
    /Exchange Difference Journal must be an active general journal/i,
  );

  const attempt = {
    ...db,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (
        c.id === 1 ? { ...c, currency_exchange_journal_id: archived.id } : c
      )),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, attempt), { isAdmin: true }),
    /Exchange Difference Journal must be an active general journal/i,
  );
});

test('A journal referenced as Exchange Difference Journal cannot be archived, retyped or moved to another company', () => {
  const journal = create(seed(), 'account.journal', {
    name: 'Locked FX Journal',
    code: 'LFXJ',
    type: 'general',
    company_id: 1,
  });
  let db = write(journal.db, 'res.company', 1, { currency_exchange_journal_id: journal.id });
  const other = createCompany(db, { name: 'Company Two' });
  db = other.db;

  for (const change of [{ active: false }, { type: 'sale' }, { company_id: other.id }]) {
    assert.throws(
      () => write(db, 'account.journal', journal.id, change),
      /Clear the Exchange Difference Journal of company/i,
    );
    const attempt = {
      ...db,
      records: {
        ...db.records,
        'account.journal': db.records['account.journal'].map((j) => (
          j.id === journal.id ? { ...j, ...change } : j
        )),
      },
    };
    assert.throws(
      () => applyDiff(db, diffDb(db, attempt), { isAdmin: true }),
      /Clear the Exchange Difference Journal of company/i,
    );
  }

  // A shared FX journal cannot be narrowed to one company while another uses it
  const shared = create(other.db, 'account.journal', {
    name: 'Shared FX Journal',
    code: 'SFXJ',
    type: 'general',
    company_id: null,
  });
  let sharedDb = write(shared.db, 'res.company', 1, { currency_exchange_journal_id: shared.id });
  sharedDb = write(sharedDb, 'res.company', other.id, { currency_exchange_journal_id: shared.id });
  for (const companyId of [1, other.id]) {
    const attempt = {
      ...sharedDb,
      records: {
        ...sharedDb.records,
        'account.journal': sharedDb.records['account.journal'].map((j) => (
          j.id === shared.id ? { ...j, company_id: companyId } : j
        )),
      },
    };
    assert.throws(
      () => applyDiff(sharedDb, diffDb(sharedDb, attempt), { isAdmin: true }),
      /Clear the Exchange Difference Journal of company/i,
    );
  }

  // Once cleared on the company, the journal can be archived
  const cleared = write(db, 'res.company', 1, { currency_exchange_journal_id: null });
  assert.equal(read(write(cleared, 'account.journal', journal.id, { active: false }), 'account.journal', journal.id).active, false);
});

// ---------------------------------------------------------------------------
// 2. Settings UI Currencies Section
// ---------------------------------------------------------------------------

test('Settings renders Exchange Difference Journal under Currencies and writes to res.company', async () => {
  let db = seed();
  const fxJournal = create(db, 'account.journal', {
    name: 'FX Exchange Journal',
    code: 'FX1',
    type: 'general',
    company_id: 1,
  });
  db = fxJournal.db;

  const ctx = await renderSettingsView(db);
  try {
    const row = find(ctx.host, (n) => props(n)?.['data-setting'] === 'currency_exchange_journal_id');
    assert.ok(row, 'currency_exchange_journal_id row must render in Settings');
    const label = find(row, (n) => n.tagName === 'LABEL');
    assert.equal(label?.textContent, 'Exchange Difference Journal');

    const select = ctx.control('currency_exchange_journal_id');
    assert.ok(select, 'currency_exchange_journal_id select control must render');

    // Select the newly created FX journal
    await ctx.React.act(async () => {
      props(select)?.onChange?.({ target: { value: String(fxJournal.id) } });
    });

    const updatedComp = read(ctx.getDb(), 'res.company', 1);
    assert.equal(updatedComp.currency_exchange_journal_id, fxJournal.id);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. valueOnlyCurrencyFields helper unit test
// ---------------------------------------------------------------------------

test('valueOnlyCurrencyFields returns foreign currency with amount_currency 0 for foreign settlement', () => {
  const setup = setupCurrencies(seed());
  const db = setup.db;
  const eur = setup.eur;
  const compCurrency = companyCurrencyRecord(db, 1);

  const regularAccount = search(db, 'account.account').find((a) => a.code === '121000' && a.company_id === 1);
  const forcedAccount = create(db, 'account.account', {
    code: '121099',
    name: 'Forced EUR',
    account_type: 'asset_receivable',
    company_id: 1,
    currency_id: eur.id,
  });

  // Forced account without passing currencyId
  assert.deepEqual(
    valueOnlyCurrencyFields(forcedAccount.db, forcedAccount.id, 1),
    { currency_id: eur.id, amount_currency: 0 },
  );

  // Regular account (not forced) with foreign currencyId passed
  assert.deepEqual(
    valueOnlyCurrencyFields(db, regularAccount.id, 1, eur.id),
    { currency_id: eur.id, amount_currency: 0 },
  );

  // Regular account with company currency passed -> returns empty {}
  assert.deepEqual(
    valueOnlyCurrencyFields(db, regularAccount.id, 1, compCurrency.id),
    {},
  );

  // Regular account with no currencyId passed -> returns empty {}
  assert.deepEqual(
    valueOnlyCurrencyFields(db, regularAccount.id, 1),
    {},
  );
});

// ---------------------------------------------------------------------------
// 4. Payment settlement foreign exchange entry journal and line currency
// ---------------------------------------------------------------------------

test('Payment settlement realized exchange difference entry posts into currency_exchange_journal_id and carries foreign currency with amount_currency 0', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;

  // Create dedicated FX journal
  const fxJournal = create(db, 'account.journal', {
    name: 'Dedicated FX Journal',
    code: 'FXDIFF',
    type: 'general',
    company_id: 1,
  });
  db = fxJournal.db;
  db = write(db, 'res.company', 1, { currency_exchange_journal_id: fxJournal.id });

  const partner = create(db, 'res.partner', { name: 'Euro Customer', is_company: true });
  db = partner.db;

  // Invoice on 2026-01-01 at rate 0.8: 100 EUR = 125 SAR
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    currency_id: eur.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ name: 'Consulting', qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Payment on 2026-02-01 at rate 0.5: 100 EUR = 200 SAR -> 75 SAR exchange difference
  const bnk = search(db, 'account.journal').find((j) => j.type === 'bank' && (!j.company_id || j.company_id === 1));
  const pmt = create(db, 'account.payment', {
    partner_id: partner.id, company_id: 1, payment_type: 'inbound', partner_type: 'customer',
    journal_id: bnk.id, currency_id: eur.id, amount: 100, date: '2026-02-01',
  });
  db = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id), { autoAllocate: false });
  db = applyPaymentCredit(db, pmt.id, inv.id, '2026-02-01');

  const settledInv = read(db, 'account.move', inv.id);
  assert.equal(settledInv.amount_residual, 0, 'Invoice company-currency residual must be 0');

  // Verify exchange difference move
  const fxEntry = search(db, 'account.move').find((m) => m.move_type === 'entry' && m.fx_invoice_id === inv.id);
  assert.ok(fxEntry, 'Exchange difference entry must exist');
  assert.equal(fxEntry.journal_id, fxJournal.id, 'Exchange entry must post into currency_exchange_journal_id');

  // Verify counterpart line carries foreign currency with amount_currency 0
  const arAccount = read(db, 'res.company', 1).account_default_receivable_id;
  const arLine = fxEntry.line_ids.find((l) => l.account_id === arAccount);
  assert.ok(arLine, 'Counterpart receivable line must exist on exchange entry');
  assert.equal(arLine.currency_id, eur.id, 'Counterpart line must carry settlement foreign currency_id');
  assert.equal(arLine.amount_currency, 0, 'Counterpart line must have amount_currency 0');

  // Verify residuals on all invoice lines in both currencies
  const invItems = reconciledJournalItems(db, settledInv);
  const arInvItem = invItems.find((l) => l.account_id === arAccount);
  assert.equal(arInvItem.amount_residual, 0, 'AR line residual in company currency must be 0');
  assert.equal(arInvItem.amount_residual_currency, 0, 'AR line residual in foreign currency must be 0');
});

// ---------------------------------------------------------------------------
// 5. Credit note foreign exchange entry journal and line currency
// ---------------------------------------------------------------------------

test('Credit note realized exchange difference entry posts into currency_exchange_journal_id and carries foreign currency with amount_currency 0', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;

  const fxJournal = create(db, 'account.journal', {
    name: 'Credit Note FX Journal',
    code: 'CNFX',
    type: 'general',
    company_id: 1,
  });
  db = fxJournal.db;
  db = write(db, 'res.company', 1, { currency_exchange_journal_id: fxJournal.id });

  const partner = create(db, 'res.partner', { name: 'EUR CN Customer', is_company: true });
  db = partner.db;

  // Invoice at rate 0.8: 100 EUR = 125 SAR
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    currency_id: eur.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Credit note at rate 0.625: 100 EUR = 160 SAR -> 35 SAR exchange difference
  const cn = create(db, 'account.move', {
    move_type: 'out_refund',
    company_id: 1,
    partner_id: partner.id,
    currency_id: eur.id,
    reversed_entry_id: inv.id,
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(cn.db, cn.id);

  const fxEntry = search(db, 'account.move').find((m) => m.ref === `Exchange difference ${read(db, 'account.move', cn.id).name}`);
  assert.ok(fxEntry, 'Credit note exchange difference entry must exist');
  assert.equal(fxEntry.journal_id, fxJournal.id, 'Credit note exchange entry must post into currency_exchange_journal_id');

  const arAccount = read(db, 'res.company', 1).account_default_receivable_id;
  const arLine = fxEntry.line_ids.find((l) => l.account_id === arAccount);
  assert.ok(arLine, 'Counterpart receivable line must exist on credit note exchange entry');
  assert.equal(arLine.currency_id, eur.id, 'Counterpart line must carry settlement foreign currency_id');
  assert.equal(arLine.amount_currency, 0, 'Counterpart line must have amount_currency 0');

  // Residuals in both currencies must be 0 on both documents
  const invItems = reconciledJournalItems(db, read(db, 'account.move', inv.id));
  const cnItems = reconciledJournalItems(db, read(db, 'account.move', cn.id));
  assert.equal(invItems.find((l) => l.account_id === arAccount).amount_residual, 0);
  assert.equal(invItems.find((l) => l.account_id === arAccount).amount_residual_currency, 0);
  assert.equal(cnItems.find((l) => l.account_id === arAccount).amount_residual, 0);
  assert.equal(cnItems.find((l) => l.account_id === arAccount).amount_residual_currency, 0);
});

// ---------------------------------------------------------------------------
// 6. GL reconciliation realized exchange difference entry
// ---------------------------------------------------------------------------

test('GL reconcile realized exchange difference entry posts into currency_exchange_journal_id and carries foreign currency with amount_currency 0', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;

  const fxJournal = create(db, 'account.journal', {
    name: 'GL Reconcile FX Journal',
    code: 'GLFX',
    type: 'general',
    company_id: 1,
  });
  db = fxJournal.db;
  db = write(db, 'res.company', 1, { currency_exchange_journal_id: fxJournal.id });

  const partner = create(db, 'res.partner', { name: 'GL EUR Partner', is_company: true });
  db = partner.db;

  const arAccount = read(db, 'res.company', 1).account_default_receivable_id;
  const rev = search(db, 'account.account').find((a) => a.code === '400000');
  const misc = search(db, 'account.journal').find((j) => j.type === 'general' && j.id !== fxJournal.id);

  // Debit entry at rate 0.8: 100 EUR = 125 SAR
  const debitEntry = postEntry(db, {
    journal_id: misc.id, company: 1, date: '2026-01-01', ref: 'EUR debit item',
    lines: [
      { account_id: arAccount, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev.id, credit: 125 },
    ],
  });
  db = debitEntry.db;

  // Credit entry at rate 0.5: 100 EUR = 200 SAR
  const creditEntry = postEntry(db, {
    journal_id: misc.id, company: 1, date: '2026-02-01', ref: 'EUR credit item',
    lines: [
      { account_id: arAccount, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev.id, debit: 200 },
    ],
  });
  db = creditEntry.db;

  const debitRow = journalItems(db).find((l) => l.move_id === debitEntry.id && l.account_id === arAccount);
  const creditRow = journalItems(db).find((l) => l.move_id === creditEntry.id && l.account_id === arAccount);

  // Reconcile via GL reconcile
  const reconciled = reconcileLedgerItems(db, [
    { move_id: debitEntry.id, line_identity: debitRow.line_identity },
    { move_id: creditEntry.id, line_identity: creditRow.line_identity },
  ], { date: '2026-02-01' });

  // Verify exchange difference move
  const fxMoves = search(reconciled, 'account.move').filter((m) => (
    m.move_type === 'entry' && m.ref?.startsWith('Exchange difference')
  ));
  assert.equal(fxMoves.length, 1, 'Exactly one GL exchange difference move must be posted');
  const fxMove = fxMoves[0];
  assert.equal(fxMove.journal_id, fxJournal.id, 'GL exchange difference entry must post into currency_exchange_journal_id');

  const arLine = fxMove.line_ids.find((l) => l.account_id === arAccount);
  assert.ok(arLine, 'Counterpart receivable line must exist on GL exchange entry');
  assert.equal(arLine.currency_id, eur.id, 'Counterpart line must carry settlement foreign currency_id');
  assert.equal(arLine.amount_currency, 0, 'Counterpart line must have amount_currency 0');

  // Verify residuals in both currencies are 0 on both original moves
  const afterDebit = reconciledJournalItems(reconciled, read(reconciled, 'account.move', debitEntry.id)).find((l) => l.account_id === arAccount);
  const afterCredit = reconciledJournalItems(reconciled, read(reconciled, 'account.move', creditEntry.id)).find((l) => l.account_id === arAccount);
  assert.equal(afterDebit.amount_residual, 0);
  assert.equal(afterDebit.amount_residual_currency, 0);
  assert.equal(afterCredit.amount_residual, 0);
  assert.equal(afterCredit.amount_residual_currency, 0);
});

// ---------------------------------------------------------------------------
// 7. When currency_exchange_journal_id is not set, fallback uses default general journal without picking by code
// ---------------------------------------------------------------------------

test('When currency_exchange_journal_id is not set, fallback uses company default general journal even if code is not MISC', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;

  // Rename MISC journal code to 'GEN_OPS' and ensure currency_exchange_journal_id is unset
  const misc = search(db, 'account.journal').find((j) => j.code === 'MISC' && (!j.company_id || j.company_id === 1));
  db = write(db, 'account.journal', misc.id, { code: 'GEN_OPS', name: 'General Operations' });
  db = write(db, 'res.company', 1, { currency_exchange_journal_id: null, default_general_journal_id: misc.id });

  const partner = create(db, 'res.partner', { name: 'Fallback Customer', is_company: true });
  db = partner.db;

  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    company_id: 1,
    partner_id: partner.id,
    currency_id: eur.id,
    invoice_date: '2026-01-01',
    invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Pay 100 EUR at rate 0.5 -> generates exchange difference
  const bnk = search(db, 'account.journal').find((j) => j.type === 'bank' && (!j.company_id || j.company_id === 1));
  const pmt = create(db, 'account.payment', {
    partner_id: partner.id, company_id: 1, payment_type: 'inbound', partner_type: 'customer',
    journal_id: bnk.id, currency_id: eur.id, amount: 100, date: '2026-02-01',
  });
  db = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id), { autoAllocate: false });
  db = applyPaymentCredit(db, pmt.id, inv.id, '2026-02-01');

  const fxEntry = search(db, 'account.move').find((m) => m.move_type === 'entry' && m.fx_invoice_id === inv.id);
  assert.ok(fxEntry, 'Exchange entry must exist');
  assert.equal(fxEntry.journal_id, misc.id, 'Must fall back to company default general journal');
  assert.ok(fxEntry.name.startsWith('GEN_OPS/'), `Entry name should start with journal code GEN_OPS, got ${fxEntry.name}`);
});
