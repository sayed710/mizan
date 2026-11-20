import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { postMove } from './models/accounting.js';
import { accountId, journalItems, postEntry, reconciledJournalItems } from './models/ledger.js';
import { reconcileLedgerItems, unreconcileLedgerItems } from './models/glReconcile.js';
import { applyPaymentCredit, postPayment } from './models/pay.js';

async function arabicTranslator() {
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} },
  });
  try {
    const { t } = await import(`./i18n.js?fx8-ar=${Date.now()}`);
    return t;
  } finally {
    if (prevDescriptor) Object.defineProperty(globalThis, 'localStorage', prevDescriptor);
    else delete globalThis.localStorage;
  }
}

function itemSelection(db, moveId, account, predicate = () => true) {
  const rows = journalItems(db).filter((l) => l.move_id === moveId && l.account_id === account && predicate(l));
  assert.equal(rows.length, 1, `Expected 1 journal item on move ${moveId} account ${account}, got ${rows.length}`);
  return { move_id: moveId, line_identity: rows[0].line_identity };
}

function arAccount(db, companyId = 1) {
  return read(db, 'res.company', companyId)?.account_default_receivable_id ?? accountId(db, '121000', companyId);
}

function revAccount(db, companyId = 1) {
  return accountId(db, '400000', companyId);
}

function miscJournal(db, companyId = 1) {
  return search(db, 'account.journal').find((j) => j.type === 'general' && (!j.company_id || j.company_id === companyId));
}

function setupCurrencies(initialDb) {
  let db = initialDb;
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const sar = search(db, 'res.currency').find((c) => c.name === 'SAR');
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [
      { date: '2026-01-01', rate: 0.8, company_id: 1 },
      { date: '2026-02-01', rate: 0.5, company_id: 1 },
    ],
  });
  if (sar) {
    db = write(db, 'res.currency', sar.id, {
      rate_ids: [
        { date: '2026-01-01', rate: 3.75, company_id: 1 },
      ],
    });
  }
  return { db, eur, sar };
}

// -----------------------------------------------------------------------------
// Item 1 & 3: Mixed company-currency and foreign-currency reconciliation
// -----------------------------------------------------------------------------
test('Item 1 & 3: Mixed company and foreign currency matches on company currency with proportional foreign residual', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Mixed Partner 1' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Debit item in company currency (USD): 100 USD
  const compDebit = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'USD-Debit-100',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 100 },
      { account_id: rev, credit: 100 },
    ],
  });
  db = compDebit.db;

  // Credit item in foreign currency (EUR): 100 EUR @ 0.8 = 125 USD company currency
  const eurCredit = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'EUR-Credit-125',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 125, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 125, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = eurCredit.db;

  const preMoves = (db.records['account.move'] ?? []).length;
  const settled = reconcileLedgerItems(db, [
    itemSelection(db, compDebit.id, ar),
    itemSelection(db, eurCredit.id, ar),
  ], { date: '2026-01-20' });

  // No exchange difference move should be created for mixed company/foreign reconciliation
  const postMoves = (settled.records['account.move'] ?? []).length;
  assert.equal(postMoves, preMoves, 'No exchange difference move is created for mixed reconciliation');

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 1, 'Exactly one partial reconciliation created');
  const [p] = partials;
  assert.equal(p.amount, 100, 'Company-currency matched amount is 100');
  assert.equal(p.debit_amount_currency, null, 'Company currency debit side has null currency amount');
  // 100 USD matched out of 125 USD (ratio 100/125 = 0.8). 100 EUR * 0.8 = 80 EUR.
  assert.equal(p.credit_amount_currency, 80, 'Foreign credit side consumed 80 EUR');
  assert.equal(p.exchange_move_id, null, 'No exchange move linked');

  const dItem = reconciledJournalItems(settled, read(settled, 'account.move', compDebit.id)).find((l) => l.account_id === ar);
  const cItem = reconciledJournalItems(settled, read(settled, 'account.move', eurCredit.id)).find((l) => l.account_id === ar);

  assert.equal(dItem.amount_residual, 0, 'Company debit is fully settled');
  assert.equal(dItem.amount_residual_currency, 0, 'Company debit currency residual is 0');
  assert.equal(dItem.reconciled, true, 'Company debit is fully reconciled');

  // Credit remaining: 125 - 100 = 25 USD company, 100 - 80 = 20 EUR foreign
  assert.equal(cItem.amount_residual, -25, 'Credit line remaining company balance is -25 USD');
  assert.equal(cItem.amount_residual_currency, -20, 'Credit line remaining currency balance is -20 EUR (proportional)');
  assert.equal(cItem.reconciled, false, 'Credit line is partially open');
});

test('Item 1 & 3: Mixed full offset clears residuals in both currencies and sets shared matching_number', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Mixed Partner Full' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Debit item in foreign currency (EUR): 100 EUR @ 0.8 = 125 USD
  const eurDebit = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'EUR-Debit-125',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 125, currency_id: eur.id, amount_currency: -100 },
    ],
  });
  db = eurDebit.db;

  // Credit item in company currency (USD): exactly 125 USD
  const compCredit = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'USD-Credit-125',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 125 },
      { account_id: rev, debit: 125 },
    ],
  });
  db = compCredit.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, eurDebit.id, ar),
    itemSelection(db, compCredit.id, ar),
  ], { date: '2026-01-20' });

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 1);
  assert.equal(partials[0].amount, 125);
  assert.equal(partials[0].debit_amount_currency, 100, 'Full 100 EUR consumed');
  assert.equal(partials[0].credit_amount_currency, null);
  assert.equal(partials[0].exchange_move_id, null);

  const dItem = reconciledJournalItems(settled, read(settled, 'account.move', eurDebit.id)).find((l) => l.account_id === ar);
  const cItem = reconciledJournalItems(settled, read(settled, 'account.move', compCredit.id)).find((l) => l.account_id === ar);

  assert.equal(dItem.amount_residual, 0);
  assert.equal(dItem.amount_residual_currency, 0);
  assert.equal(dItem.reconciled, true);

  assert.equal(cItem.amount_residual, 0);
  assert.equal(cItem.amount_residual_currency, 0);
  assert.equal(cItem.reconciled, true);

  assert.ok(dItem.matching_number, 'matching_number assigned');
  assert.equal(dItem.matching_number, cItem.matching_number, 'Both lines share the matching_number');
});

// -----------------------------------------------------------------------------
// Item 2: Same foreign currency matching books exchange difference entry
// -----------------------------------------------------------------------------
test('Item 2: Same foreign currency items at different rates match on amount_currency and book exchange difference entry', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'FX Diff Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Invoice in EUR @ 0.8: 100 EUR / 0.8 = 125 USD (dated 2026-01-15)
  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Credit entry in EUR @ 0.5: 100 EUR / 0.5 = 200 USD (dated 2026-02-15)
  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Credit-FX-200',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = creditEntry.db;

  const preMoves = (db.records['account.move'] ?? []).length;
  const settled = reconcileLedgerItems(db, [
    itemSelection(db, inv.id, ar),
    itemSelection(db, creditEntry.id, ar),
  ], { date: '2026-02-20' });

  // Exactly one exchange difference move posted (75 USD gain)
  const postMoves = (settled.records['account.move'] ?? []).length;
  assert.equal(postMoves, preMoves + 1, 'Exchange difference entry was booked');

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 2, 'Two partial links: base match and gap partial');

  const baseP = partials.find((p) => p.amount === 125);
  const gapP = partials.find((p) => p.amount === 75);
  assert.ok(baseP, 'Base partial of 125 USD exists');
  assert.ok(gapP, 'Gap partial of 75 USD exists');

  assert.equal(baseP.debit_amount_currency, 100);
  assert.equal(baseP.credit_amount_currency, 100);
  assert.ok(baseP.exchange_move_id, 'Base partial references exchange move');
  assert.equal(gapP.exchange_move_id, baseP.exchange_move_id, 'Gap partial references same exchange move');

  const fxMove = read(settled, 'account.move', baseP.exchange_move_id);
  assert.equal(fxMove.state, 'posted', 'Exchange move is posted');
  const gainAccount = read(settled, 'res.company', 1)?.income_currency_exchange_account_id;
  const fxArLine = fxMove.line_ids.find((l) => l.account_id === ar);
  const fxGainLine = fxMove.line_ids.find((l) => l.account_id === gainAccount);
  assert.ok(fxArLine && fxGainLine, 'Exchange entry has lines on AR and exchange gain account');
  assert.equal(fxArLine.debit, 75);
  assert.equal(fxGainLine.credit, 75);

  const dItem = reconciledJournalItems(settled, read(settled, 'account.move', inv.id)).find((l) => l.account_id === ar);
  const cItem = reconciledJournalItems(settled, read(settled, 'account.move', creditEntry.id)).find((l) => l.account_id === ar);
  assert.equal(dItem.amount_residual, 0);
  assert.equal(dItem.amount_residual_currency, 0);
  assert.equal(dItem.reconciled, true);
  assert.equal(cItem.amount_residual, 0);
  assert.equal(cItem.amount_residual_currency, 0);
  assert.equal(cItem.reconciled, true);
});

// -----------------------------------------------------------------------------
// Item 4: Partial matches leave right residual, unreconciling restores and reverses FX
// -----------------------------------------------------------------------------
test('Item 4: Mixed partial match leaves correct residuals and unreconciling restores original state', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Mixed Unrec Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Foreign Invoice: 100 EUR @ 0.8 = 125 USD (dated 2026-01-10)
  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id,
    invoice_date: '2026-01-10',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Company currency credit entry: 50 USD (dated 2026-01-15)
  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'Credit-50',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 50 },
      { account_id: rev, debit: 50 },
    ],
  });
  db = creditEntry.db;

  // Reconcile 50 USD against 125 USD (100 EUR)
  const settled = reconcileLedgerItems(db, [
    itemSelection(db, inv.id, ar),
    itemSelection(db, creditEntry.id, ar),
  ], { date: '2026-01-20' });

  // Check partial residuals:
  // 50 / 125 = 0.4. 100 EUR * 0.4 = 40 EUR consumed. Remaining = 60 EUR, 75 USD.
  const invLineAfter = reconciledJournalItems(settled, read(settled, 'account.move', inv.id)).find((l) => l.account_id === ar);
  assert.equal(invLineAfter.amount_residual, 75, 'Invoice company residual is 75 USD');
  assert.equal(invLineAfter.amount_residual_currency, 60, 'Invoice currency residual is 60 EUR');

  const invDocAfter = read(settled, 'account.move', inv.id);
  assert.equal(invDocAfter.amount_residual, 60, 'Invoice document residual is 60 EUR');

  // Now unreconcile
  const unreconciled = unreconcileLedgerItems(settled, [
    itemSelection(settled, inv.id, ar),
  ], { date: '2026-01-25' });

  const activePartials = (unreconciled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(activePartials.length, 0, 'No active partial reconciliations remain');

  const invRestored = reconciledJournalItems(unreconciled, read(unreconciled, 'account.move', inv.id)).find((l) => l.account_id === ar);
  const creditRestored = reconciledJournalItems(unreconciled, read(unreconciled, 'account.move', creditEntry.id)).find((l) => l.account_id === ar);

  assert.equal(invRestored.amount_residual, 125, 'Invoice company residual restored to 125 USD');
  assert.equal(invRestored.amount_residual_currency, 100, 'Invoice currency residual restored to 100 EUR');
  assert.equal(read(unreconciled, 'account.move', inv.id).amount_residual, 100, 'Invoice document residual restored to 100 EUR');

  assert.equal(creditRestored.amount_residual, -50, 'Credit company residual restored to -50 USD');
});

test('Item 4: Same foreign currency with FX difference: unreconciling reverses the exchange entry and clearing partial', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'FX Unrec Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Invoice: 100 EUR @ 0.8 = 125 USD (date: 2026-01-15)
  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Credit entry: 100 EUR @ 0.5 = 200 USD (date: 2026-02-15)
  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Credit-EUR',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = creditEntry.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, inv.id, ar),
    itemSelection(db, creditEntry.id, ar),
  ], { date: '2026-02-20' });

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  const fxId = partials.find((p) => p.exchange_move_id)?.exchange_move_id;
  assert.ok(fxId, 'Exchange entry exists');

  // Unreconcile
  const unreconciled = unreconcileLedgerItems(settled, [
    itemSelection(settled, inv.id, ar),
  ], { date: '2026-02-25' });

  // Original FX move has a posted reversal
  const reversalMove = search(unreconciled, 'account.move').find((m) => m.state === 'posted' && m.reversed_entry_id === fxId);
  assert.ok(reversalMove, 'Exchange entry has a posted reversal entry');

  // Active partials now only contain the clearing partial between the FX entry and its reversal
  const activePartials = (unreconciled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(activePartials.length, 1, 'Only clearing partial between FX and its reversal remains active');
  assert.equal(activePartials[0].amount, 75);

  const invRestored = reconciledJournalItems(unreconciled, read(unreconciled, 'account.move', inv.id)).find((l) => l.account_id === ar);
  const creditRestored = reconciledJournalItems(unreconciled, read(unreconciled, 'account.move', creditEntry.id)).find((l) => l.account_id === ar);

  assert.equal(invRestored.amount_residual, 125);
  assert.equal(invRestored.amount_residual_currency, 100);
  assert.equal(creditRestored.amount_residual, -200);
  assert.equal(creditRestored.amount_residual_currency, -100);
});

// -----------------------------------------------------------------------------
// Item 5: Guards preserved
// -----------------------------------------------------------------------------
test('Item 5: Multiple foreign currencies (EUR + SAR) rejected', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const { eur, sar } = setup;
  const partner = create(db, 'res.partner', { name: 'Multi FX Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // EUR debit
  const eurEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'EUR-D',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 125, currency_id: eur.id, amount_currency: -100 },
    ],
  });
  // SAR credit
  const sarEntry = postEntry(eurEntry.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'SAR-C',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 100, currency_id: sar.id, amount_currency: -375 },
      { account_id: rev, debit: 100, currency_id: sar.id, amount_currency: 375 },
    ],
  });
  db = sarEntry.db;

  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, eurEntry.id, ar), itemSelection(db, sarEntry.id, ar)], { date: '2026-01-20' }),
    (err) => err.message === 'Selected items must be in the same currency',
  );
});

test('Item 5: Mixed company + EUR + SAR rejected with same currency message', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const { eur, sar } = setup;
  const partner = create(db, 'res.partner', { name: 'Three Currencies Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const usdEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'USD-D',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 100 },
      { account_id: rev, credit: 100 },
    ],
  });
  const eurEntry = postEntry(usdEntry.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'EUR-C',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 50, currency_id: eur.id, amount_currency: -40 },
      { account_id: rev, debit: 50, currency_id: eur.id, amount_currency: 40 },
    ],
  });
  const sarEntry = postEntry(eurEntry.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'SAR-C',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 50, currency_id: sar.id, amount_currency: -187.5 },
      { account_id: rev, debit: 50, currency_id: sar.id, amount_currency: 187.5 },
    ],
  });
  db = sarEntry.db;

  assert.throws(
    () => reconcileLedgerItems(db, [
      itemSelection(db, usdEntry.id, ar),
      itemSelection(db, eurEntry.id, ar),
      itemSelection(db, sarEntry.id, ar),
    ], { date: '2026-01-20' }),
    (err) => err.message === 'Selected items must be in the same currency',
  );
});

test('Item 1 & 3: FIFO multi-item matching with mixed currency (1 foreign item matched across 2 company items)', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'FIFO Mixed Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Foreign debit: 200 EUR @ 0.8 = 250 USD
  const eurDebit = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-05', ref: 'EUR-D-250',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 250, currency_id: eur.id, amount_currency: 200 },
      { account_id: rev, credit: 250, currency_id: eur.id, amount_currency: -200 },
    ],
  });
  // Company credit 1: 100 USD (earlier date)
  const usdCredit1 = postEntry(eurDebit.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-06', ref: 'USD-C-100',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 100 },
      { account_id: rev, debit: 100 },
    ],
  });
  // Company credit 2: 150 USD (later date)
  const usdCredit2 = postEntry(usdCredit1.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-07', ref: 'USD-C-150',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 150 },
      { account_id: rev, debit: 150 },
    ],
  });
  db = usdCredit2.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, eurDebit.id, ar),
    itemSelection(db, usdCredit1.id, ar),
    itemSelection(db, usdCredit2.id, ar),
  ], { date: '2026-01-10' });

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 2, 'Two partial matches in FIFO order');

  // Pair 1: EUR-D vs USD-C1 -> amount: 100 USD, debit_amount_currency: 80 EUR
  const p1 = partials.find((p) => p.credit_move_id === usdCredit1.id);
  assert.ok(p1);
  assert.equal(p1.amount, 100);
  assert.equal(p1.debit_amount_currency, 80);
  assert.equal(p1.credit_amount_currency, null);

  // Pair 2: EUR-D vs USD-C2 -> amount: 150 USD, debit_amount_currency: 120 EUR
  const p2 = partials.find((p) => p.credit_move_id === usdCredit2.id);
  assert.ok(p2);
  assert.equal(p2.amount, 150);
  assert.equal(p2.debit_amount_currency, 120);
  assert.equal(p2.credit_amount_currency, null);

  const dItem = reconciledJournalItems(settled, read(settled, 'account.move', eurDebit.id)).find((l) => l.account_id === ar);
  const c1Item = reconciledJournalItems(settled, read(settled, 'account.move', usdCredit1.id)).find((l) => l.account_id === ar);
  const c2Item = reconciledJournalItems(settled, read(settled, 'account.move', usdCredit2.id)).find((l) => l.account_id === ar);

  assert.equal(dItem.amount_residual, 0);
  assert.equal(dItem.amount_residual_currency, 0);
  assert.equal(dItem.reconciled, true);

  assert.equal(c1Item.amount_residual, 0);
  assert.equal(c1Item.reconciled, true);

  assert.equal(c2Item.amount_residual, 0);
  assert.equal(c2Item.reconciled, true);

  assert.ok(dItem.matching_number);
  assert.equal(dItem.matching_number, c1Item.matching_number);
  assert.equal(dItem.matching_number, c2Item.matching_number);
});

test('Item 3: Explicit partial amount on mixed company/foreign reconciliation', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Explicit Amt Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Foreign Debit: 100 EUR @ 0.8 = 125 USD
  const eurDebit = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-05', ref: 'EUR-D',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 125, currency_id: eur.id, amount_currency: -100 },
    ],
  });
  // Company Credit: 200 USD
  const usdCredit = postEntry(eurDebit.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-06', ref: 'USD-C',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200 },
      { account_id: rev, debit: 200 },
    ],
  });
  db = usdCredit.db;

  // Request explicit amount: 50 USD
  const settled = reconcileLedgerItems(db, [
    itemSelection(db, eurDebit.id, ar),
    itemSelection(db, usdCredit.id, ar),
  ], { date: '2026-01-10', amount: 50 });

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 1);
  assert.equal(partials[0].amount, 50);
  // 50 / 125 = 0.4. 100 EUR * 0.4 = 40 EUR.
  assert.equal(partials[0].debit_amount_currency, 40);
  assert.equal(partials[0].credit_amount_currency, null);

  const dItem = reconciledJournalItems(settled, read(settled, 'account.move', eurDebit.id)).find((l) => l.account_id === ar);
  const cItem = reconciledJournalItems(settled, read(settled, 'account.move', usdCredit.id)).find((l) => l.account_id === ar);

  assert.equal(dItem.amount_residual, 75, 'EUR debit remaining company balance is 75 USD');
  assert.equal(dItem.amount_residual_currency, 60, 'EUR debit remaining currency balance is 60 EUR');

  assert.equal(cItem.amount_residual, -150, 'USD credit remaining balance is -150 USD');
});

test('Item 5: Preserved guards: different accounts, different partners, already reconciled', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const p1 = create(db, 'res.partner', { name: 'P1' });
  const p2 = create(p1.db, 'res.partner', { name: 'P2' });
  db = p2.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Different partners on AR
  const e1 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'E1',
    lines: [
      { account_id: ar, partner_id: p1.id, debit: 100 },
      { account_id: rev, credit: 100 },
    ],
  });
  const e2 = postEntry(e1.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'E2',
    lines: [
      { account_id: ar, partner_id: p2.id, credit: 100, currency_id: eur.id, amount_currency: -80 },
      { account_id: rev, debit: 100, currency_id: eur.id, amount_currency: 80 },
    ],
  });
  db = e2.db;

  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, e1.id, ar), itemSelection(db, e2.id, ar)], { date: '2026-01-15' }),
    (err) => err.message === 'Selected receivable or payable items must have the same partner',
  );

  // Different accounts
  const ap = accountId(db, '211000', 1);
  const e3 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'E3',
    lines: [
      { account_id: ap, partner_id: p1.id, credit: 100 },
      { account_id: rev, debit: 100 },
    ],
  });
  db = e3.db;

  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, e1.id, ar), itemSelection(db, e3.id, ap)], { date: '2026-01-15' }),
    (err) => err.message === 'Selected journal items must be on the same account',
  );

  // Already reconciled items
  const e4 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'E4',
    lines: [
      { account_id: ar, partner_id: p1.id, credit: 100 },
      { account_id: rev, debit: 100 },
    ],
  });
  db = reconcileLedgerItems(e4.db, [itemSelection(e4.db, e1.id, ar), itemSelection(e4.db, e4.id, ar)], { date: '2026-01-15' });

  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, e1.id, ar), itemSelection(db, e4.id, ar)], { date: '2026-01-15' }),
    (err) => err.message === 'Selected journal items must not already be fully reconciled',
  );
});

test('Item 5: Server-side guard via diffDb + applyDiff on mixed partial', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Guard Diff Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Debit: 100 USD (company currency)
  const dMove = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'D-Move',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 100 },
      { account_id: rev, credit: 100 },
    ],
  });
  // Credit: 100 EUR @ 0.8 = 125 USD (foreign currency)
  const cMove = postEntry(dMove.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'C-Move',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 125, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 125, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = cMove.db;

  // Legitimate reconcile via diffDb + applyDiff works
  const reconciledDb = reconcileLedgerItems(db, [itemSelection(db, dMove.id, ar), itemSelection(db, cMove.id, ar)], { date: '2026-01-15' });
  const diff = diffDb(db, reconciledDb);
  const syncedDb = applyDiff(db, diff);
  assert.equal(
    (syncedDb.records['account.partial.reconcile'] ?? []).length,
    (reconciledDb.records['account.partial.reconcile'] ?? []).length,
    'Legitimate mixed reconcile applies cleanly through diffDb + applyDiff',
  );

  // Forged partial with wrong currency amount: credit line matched 100 USD of 125 USD (80 EUR), but forged carries 50 EUR
  const forgedWrongCurr = {
    id: 9901,
    debit_move_id: dMove.id,
    debit_line_index: 0,
    credit_move_id: cMove.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 100,
    debit_amount_currency: null,
    credit_amount_currency: 50, // wrong! Expected 80
    exchange_move_id: null,
    date: '2026-01-15',
    active: true,
    reversed: false,
  };
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [forgedWrongCurr] } }),
    /Partial reconciliation currency amount does not match the expected foreign residual/i,
  );

  // Forged partial with currency amount on company currency side
  const forgedCompanyCurrencyAmt = {
    ...forgedWrongCurr,
    credit_amount_currency: 80,
    debit_amount_currency: 100, // company currency debit cannot have currency amount!
  };
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [forgedCompanyCurrencyAmt] } }),
    /Exchange difference and currency amounts are not valid for company-currency reconciliation/i,
  );
});

// -----------------------------------------------------------------------------
// Code Review Bug 1: Credit note pairing check on different-currency matching
// -----------------------------------------------------------------------------
test('Review Bug 1: EUR credit note linked to invoice A selected with same-partner USD invoice B is refused with pairing error', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'CN Pair Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);

  // EUR invoice A, paid in full before noteA is posted so noteA remains open with reversed_entry_id: invA.id
  const invA = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invA.db, invA.id);

  const bnk = search(db, 'account.journal').find((j) => j.type === 'bank' && (!j.company_id || j.company_id === 1));
  const pmt = create(db, 'account.payment', {
    partner_id: partner.id, company_id: 1, payment_type: 'inbound', partner_type: 'customer',
    journal_id: bnk.id, currency_id: eur.id, amount: 100, date: '2026-01-20',
  });
  db = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id), { autoAllocate: false });
  db = applyPaymentCredit(db, pmt.id, invA.id, '2026-01-20');

  // EUR credit note linked to invoice A (open because invA is already paid)
  const noteA = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_refund', currency_id: eur.id,
    reversed_entry_id: invA.id,
    invoice_date: '2026-02-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(noteA.db, noteA.id);

  // USD invoice B (different invoice, same partner)
  const invB = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: null,
    invoice_date: '2026-02-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(invB.db, invB.id);

  const snapshotLinks = db.records['account.partial.reconcile'] ?? [];
  const snapshotMoves = db.records['account.move'] ?? [];

  // Attempt reconcile via reconcileLedgerItems -> must be refused with creditNotePairError message
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, noteA.id, ar), itemSelection(db, invB.id, ar)], { date: '2026-02-20' }),
    /This credit note is linked to another invoice/,
  );

  // Assert database is completely unchanged
  assert.equal((db.records['account.partial.reconcile'] ?? []).length, snapshotLinks.length);
  assert.equal((db.records['account.move'] ?? []).length, snapshotMoves.length);

  // Assert forged link between noteA and invB is also rejected through diffDb + applyDiff
  const postedNoteA = read(db, 'account.move', noteA.id);
  const postedInvB = read(db, 'account.move', invB.id);
  const noteArIdx = (postedNoteA.line_ids ?? []).findIndex((l) => l.account_id === ar);
  const invBArIdx = (postedInvB.line_ids ?? []).findIndex((l) => l.account_id === ar);
  const forged = {
    id: 9910,
    debit_move_id: invB.id,
    debit_line_index: invBArIdx,
    credit_move_id: noteA.id,
    credit_line_index: noteArIdx,
    account_id: ar,
    company_id: 1,
    amount: 100,
    debit_amount_currency: null,
    credit_amount_currency: 50,
    exchange_move_id: null,
    date: '2026-02-20',
    active: true,
    reversed: false,
  };
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [forged] } }),
    /This credit note is linked to another invoice/,
  );
  assert.equal((db.records['account.partial.reconcile'] ?? []).length, snapshotLinks.length);
});

// -----------------------------------------------------------------------------
// Code Review Bug 2: Foreign residual fully consumed with positive company remainder
// -----------------------------------------------------------------------------
test('Review Bug 2: 100 USD / 3 EUR debit vs 99.99 USD credit books 0.01 exchange difference and clears both residuals', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'FX Remainder Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Debit item: 100 USD company, 3 EUR foreign
  const dMove = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'USD100-EUR3',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 100, currency_id: eur.id, amount_currency: 3 },
      { account_id: rev, credit: 100, currency_id: eur.id, amount_currency: -3 },
    ],
  });
  db = dMove.db;

  // Credit item: 99.99 USD company currency
  const cMove = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'USD99.99',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 99.99 },
      { account_id: rev, debit: 99.99 },
    ],
  });
  db = cMove.db;

  const preMoves = (db.records['account.move'] ?? []).length;
  const settled = reconcileLedgerItems(db, [itemSelection(db, dMove.id, ar), itemSelection(db, cMove.id, ar)], { date: '2026-01-20' });

  // Saved through diffDb + applyDiff
  const diff = diffDb(db, settled);
  const synced = applyDiff(db, diff);

  // Exactly one exchange entry posted of 0.01 USD
  assert.equal((synced.records['account.move'] ?? []).length, preMoves + 1);
  const partials = (synced.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 2, 'Main partial + gap partial created');

  const mainP = partials.find((g) => g.debit_move_id === dMove.id && g.credit_move_id === cMove.id);
  assert.ok(mainP, 'Main partial between dMove and cMove exists');
  assert.equal(mainP.amount, 99.99);
  assert.equal(mainP.debit_amount_currency, 3);
  assert.equal(mainP.credit_amount_currency, null);
  assert.ok(mainP.exchange_move_id, 'Main partial links exchange_move_id');

  const gapP = partials.find((g) => g.id !== mainP.id);
  assert.ok(gapP, 'Gap partial exists');
  assert.equal(gapP.amount, 0.01);
  assert.equal(gapP.debit_amount_currency, 0);
  assert.equal(gapP.credit_amount_currency, null);
  assert.equal(gapP.exchange_move_id, mainP.exchange_move_id);

  const fxMove = read(synced, 'account.move', mainP.exchange_move_id);
  assert.equal(fxMove.state, 'posted');
  const fxArLine = (fxMove.line_ids ?? []).find((l) => l.account_id === ar);
  assert.ok(fxArLine, 'Exchange entry has line on AR account');
  assert.equal(Number(fxArLine.credit), 0.01);
  assert.equal(Number(fxArLine.debit), 0);

  // Both items end fully reconciled in both currencies
  const dItem = reconciledJournalItems(synced, read(synced, 'account.move', dMove.id)).find((l) => l.account_id === ar);
  const cItem = reconciledJournalItems(synced, read(synced, 'account.move', cMove.id)).find((l) => l.account_id === ar);
  assert.equal(dItem.amount_residual, 0, 'Debit residual in company currency is 0');
  assert.equal(dItem.amount_residual_currency, 0, 'Debit residual in foreign currency is 0');
  assert.equal(dItem.reconciled, true);
  assert.equal(cItem.amount_residual, 0, 'Credit residual in company currency is 0');
  assert.equal(cItem.amount_residual_currency, 0, 'Credit residual in foreign currency is 0');
  assert.equal(cItem.reconciled, true);

  // Unreconcile restores original open balances and reverses exchange difference entry
  const unreconciled = unreconcileLedgerItems(synced, [itemSelection(synced, dMove.id, ar), itemSelection(synced, cMove.id, ar)], { date: '2026-01-25' });
  const unrecDiff = diffDb(synced, unreconciled);
  const unrecSynced = applyDiff(synced, unrecDiff);

  const dItemRestored = reconciledJournalItems(unrecSynced, read(unrecSynced, 'account.move', dMove.id)).find((l) => l.account_id === ar);
  const cItemRestored = reconciledJournalItems(unrecSynced, read(unrecSynced, 'account.move', cMove.id)).find((l) => l.account_id === ar);
  assert.equal(dItemRestored.amount_residual, 100);
  assert.equal(dItemRestored.amount_residual_currency, 3);
  assert.equal(dItemRestored.reconciled, false);
  assert.equal(cItemRestored.amount_residual, -99.99);
  assert.equal(cItemRestored.reconciled, false);
});

// -----------------------------------------------------------------------------
// Code Review Bug 3: Proportional foreign share rounds to zero refused beforehand
// -----------------------------------------------------------------------------
test('Review Bug 3: Small match whose proportional foreign share rounds to zero is refused before partial/writeoff', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Small Share Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Debit item: 1000 USD company, 100 EUR foreign
  const dMove = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'USD1000-EUR100',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 1000, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 1000, currency_id: eur.id, amount_currency: -100 },
    ],
  });
  db = dMove.db;

  // Credit item: 0.01 USD company currency. 100 EUR * 0.01 / 1000 = 0.001 EUR -> rounds to 0.00 EUR!
  const cMove = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'USD0.01',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 0.01 },
      { account_id: rev, debit: 0.01 },
    ],
  });
  db = cMove.db;

  const preMoves = (db.records['account.move'] ?? []).length;
  const prePartials = (db.records['account.partial.reconcile'] ?? []).length;

  // Refused by reconcileLedgerItems with clear message, leaving db unchanged
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, dMove.id, ar), itemSelection(db, cMove.id, ar)], { date: '2026-01-20' }),
    /The applied amount cannot be represented in the foreign currency after rounding/,
  );
  assert.equal((db.records['account.move'] ?? []).length, preMoves);
  assert.equal((db.records['account.partial.reconcile'] ?? []).length, prePartials);

  // If write-off is requested on this match, refusal happens BEFORE any write-off move is created
  const woAccount = accountId(db, '680000', 1) || rev;
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, dMove.id, ar), itemSelection(db, cMove.id, ar)], {
      date: '2026-01-20',
      writeoff: {
        journalId: misc.id,
        accountId: woAccount,
        label: 'Write-off small round test',
      },
    }),
    /The applied amount cannot be represented in the foreign currency after rounding/,
  );
  assert.equal((db.records['account.move'] ?? []).length, preMoves, 'No write-off move created');
  assert.equal((db.records['account.partial.reconcile'] ?? []).length, prePartials);

  // Forged partial with 0 currency amount is rejected through applyDiff and diffDb + applyDiff
  const forgedZeroCurr = {
    id: 9920,
    debit_move_id: dMove.id,
    debit_line_index: 0,
    credit_move_id: cMove.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 0.01,
    debit_amount_currency: 0, // 0 is rejected!
    credit_amount_currency: null,
    exchange_move_id: null,
    date: '2026-01-20',
    active: true,
    reversed: false,
  };
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [forgedZeroCurr] } }),
    /Currency amounts on foreign partial reconciliation must match and be positive/,
  );
  const forgedDb = {
    ...db,
    records: {
      ...db.records,
      'account.partial.reconcile': [...(db.records['account.partial.reconcile'] ?? []), forgedZeroCurr],
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, forgedDb), { isAdmin: true }),
    /Currency amounts on foreign partial reconciliation must match and be positive/,
  );
  assert.equal((db.records['account.move'] ?? []).length, preMoves);
  assert.equal((db.records['account.partial.reconcile'] ?? []).length, prePartials);
});

test('Arabic translations for reconciliation errors are present and accurate', async () => {
  const t = await arabicTranslator();
  assert.equal(
    t('Selected items must be in the same currency'),
    'يجب أن تكون البنود المحددة بنفس العملة',
  );
  assert.equal(
    t('Partial reconciliation currency amount does not match the expected foreign residual'),
    'مبلغ العملة للمطابقة الجزئية لا يطابق الرصيد الأجنبي المتبقي المتوقع',
  );
  assert.equal(
    t('The applied amount cannot be represented in the foreign currency after rounding'),
    'لا يمكن تمثيل المبلغ المطبق بالعملة الأجنبية بعد التقريب',
  );
});
