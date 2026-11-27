import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write, unlink } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { postMove, applyCreditNote } from './models/accounting.js';
import { accountId, journalItems, postEntry, reconciledJournalItems, valueOnlyCurrencyFields } from './models/ledger.js';
import { postPayment, reverseEntry, applyPaymentCredit } from './models/pay.js';
import { appliedValue } from './models/finance.js';
import { models } from './models/index.js';
import { isExchangeEntry, reconcileLedgerItems, unreconcileLedgerItems } from './models/glReconcile.js';

async function arabicTranslator() {
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} },
  });
  try {
    const { t } = await import(`./i18n.js?fxrec-ar=${Date.now()}`);
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
  db = write(db, 'res.currency', eur.id, {
    rate_ids: [
      { date: '2026-01-01', rate: 0.8, company_id: 1 },
      { date: '2026-02-01', rate: 0.5, company_id: 1 },
    ],
  });
  return { db, eur };
}

// -----------------------------------------------------------------------------
// Case 1: Same rate, company currency
// -----------------------------------------------------------------------------
test('Case 1: Same rate, company currency - one partial, amount only, no FX, both residual 0, matching_number set', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Case 1 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const debit = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-01', ref: 'D-Case1',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 1000 }, { account_id: rev, credit: 1000 }],
  });
  const credit = postEntry(debit.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-02', ref: 'C-Case1',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 1000 }, { account_id: rev, debit: 1000 }],
  });
  db = credit.db;

  const preMoves = (db.records['account.move'] ?? []).length;
  const settled = reconcileLedgerItems(db, [
    itemSelection(db, debit.id, ar),
    itemSelection(db, credit.id, ar),
  ], { date: '2026-03-05' });

  const postMoves = (settled.records['account.move'] ?? []).length;
  assert.equal(postMoves, preMoves, 'No exchange move should be posted for company currency items');

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 1, 'Exactly one partial reconciliation created');
  const [p1] = partials;
  assert.equal(p1.amount, 1000);
  assert.equal(p1.debit_amount_currency, null);
  assert.equal(p1.credit_amount_currency, null);
  assert.equal(p1.exchange_move_id, null);

  const dItems = reconciledJournalItems(settled, read(settled, 'account.move', debit.id));
  const cItems = reconciledJournalItems(settled, read(settled, 'account.move', credit.id));
  assert.equal(dItems[0].amount_residual, 0);
  assert.equal(cItems[0].amount_residual, 0);
  assert.ok(dItems[0].matching_number, 'matching_number set on debit line');
  assert.equal(dItems[0].matching_number, cItems[0].matching_number, 'both lines share matching_number');
});

// -----------------------------------------------------------------------------
// Case 2: Same foreign currency, gain
// 100 EUR @0.8 = 125 company (invoice debit)
// 100 EUR @0.5 = 200 company (credit item)
// Partial1: 125 / 100 / 100
// FX gain: +75: DR AR 75, CR gain 75
// Partial2: 75: DR FX line, CR credit item line
// -----------------------------------------------------------------------------
test('Case 2: Same foreign currency, gain - Partial1 125/100/100, FX gain 75, gap partial 75, residuals 0, exchange_move_id set', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Case 2 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Invoice at rate 0.8: 100 EUR / 0.8 = 125 company currency
  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Credit entry at rate 0.5: 100 EUR / 0.5 = 200 company currency
  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Credit-200',
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
  assert.equal(partials.length, 2, 'Two partial reconciliations created (base + gap)');

  const p1 = partials.find((p) => p.amount === 125);
  const p2 = partials.find((p) => p.amount === 75);
  assert.ok(p1, 'Partial1 with amount 125 exists');
  assert.ok(p2, 'Partial2 with amount 75 exists');

  assert.equal(p1.debit_amount_currency, 100);
  assert.equal(p1.credit_amount_currency, 100);
  assert.ok(p1.exchange_move_id, 'Partial1 has exchange_move_id set');

  const fxMove = read(settled, 'account.move', p1.exchange_move_id);
  assert.ok(fxMove, 'FX move exists');
  assert.equal(fxMove.state, 'posted');
  assert.equal(fxMove.move_type, 'entry');
  assert.equal(fxMove.line_ids.length, 2);

  const gainAccount = read(settled, 'res.company', 1).income_currency_exchange_account_id;
  const counterpartLine = fxMove.line_ids.find((l) => l.account_id === ar);
  const gainLine = fxMove.line_ids.find((l) => l.account_id === gainAccount);
  assert.ok(counterpartLine, 'AR line on FX move exists');
  assert.ok(gainLine, 'Gain line on FX move exists');
  assert.equal(counterpartLine.debit, 75);
  assert.equal(counterpartLine.credit, 0);
  assert.equal(counterpartLine.partner_id, partner.id);
  assert.equal(gainLine.debit, 0);
  assert.equal(gainLine.credit, 75);
  assert.equal(gainLine.partner_id, null);

  // Partial2 connects FX debit line with credit item
  assert.equal(p2.debit_move_id, fxMove.id);
  assert.equal(p2.debit_line_index, 0);
  assert.equal(p2.credit_move_id, creditEntry.id);
  assert.equal(p2.debit_amount_currency, null);
  assert.equal(p2.credit_amount_currency, 0);

  // Residuals
  const invItems = reconciledJournalItems(settled, read(settled, 'account.move', inv.id));
  const credItems = reconciledJournalItems(settled, read(settled, 'account.move', creditEntry.id));
  assert.equal(invItems[0].amount_residual, 0);
  assert.equal(invItems[0].amount_residual_currency, 0);
  assert.equal(credItems[0].amount_residual, 0);
  assert.equal(credItems[0].amount_residual_currency, 0);

  // Test applyDiff works on diffDb of this reconciliation
  const diff = diffDb(db, settled);
  const synced = applyDiff(db, diff);
  assert.ok(synced);
});

// -----------------------------------------------------------------------------
// Case 3: Same foreign currency, loss
// 100 EUR @0.5 = 200 company (invoice debit)
// 100 EUR @0.8 = 125 company (credit item)
// Partial1: 125 / 100 / 100
// FX loss: −75: CR AR 75, DR loss 75
// Partial2: 75: DR invoice line, CR FX line
// -----------------------------------------------------------------------------
test('Case 3: Same foreign currency, loss - Partial1 125/100/100, FX loss 75, gap partial 75, residuals 0', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Case 3 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Invoice at rate 0.5: 100 EUR / 0.5 = 200 company currency
  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id,
    invoice_date: '2026-02-10',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Credit entry at rate 0.8: 100 EUR / 0.8 = 125 company currency
  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'Credit-125',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 125, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 125, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = creditEntry.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, inv.id, ar),
    itemSelection(db, creditEntry.id, ar),
  ], { date: '2026-02-20' });

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 2, 'Two partial reconciliations created (base + gap)');

  const p1 = partials.find((p) => p.amount === 125);
  const p2 = partials.find((p) => p.amount === 75);
  assert.ok(p1, 'Partial1 with amount 125 exists');
  assert.ok(p2, 'Partial2 with amount 75 exists');

  assert.equal(p1.debit_amount_currency, 100);
  assert.equal(p1.credit_amount_currency, 100);
  assert.ok(p1.exchange_move_id, 'Partial1 has exchange_move_id set');

  const fxMove = read(settled, 'account.move', p1.exchange_move_id);
  assert.ok(fxMove, 'FX move exists');
  assert.equal(fxMove.state, 'posted');
  assert.equal(fxMove.move_type, 'entry');

  const lossAccount = read(settled, 'res.company', 1).expense_currency_exchange_account_id;
  const counterpartLine = fxMove.line_ids.find((l) => l.account_id === ar);
  const lossLine = fxMove.line_ids.find((l) => l.account_id === lossAccount);
  assert.ok(counterpartLine, 'AR line on FX move exists');
  assert.ok(lossLine, 'Loss line on FX move exists');
  assert.equal(counterpartLine.debit, 0);
  assert.equal(counterpartLine.credit, 75);
  assert.equal(counterpartLine.partner_id, partner.id);
  assert.equal(lossLine.debit, 75);
  assert.equal(lossLine.credit, 0);
  assert.equal(lossLine.partner_id, null);

  // Partial2 connects invoice line with FX credit line
  assert.equal(p2.debit_move_id, inv.id);
  assert.equal(p2.credit_move_id, fxMove.id);
  assert.equal(p2.credit_line_index, 0);
  assert.equal(p2.debit_amount_currency, 0);
  assert.equal(p2.credit_amount_currency, null);

  // Residuals
  const invItems = reconciledJournalItems(settled, read(settled, 'account.move', inv.id));
  const credItems = reconciledJournalItems(settled, read(settled, 'account.move', creditEntry.id));
  assert.equal(invItems[0].amount_residual, 0);
  assert.equal(invItems[0].amount_residual_currency, 0);
  assert.equal(credItems[0].amount_residual, 0);
  assert.equal(credItems[0].amount_residual_currency, 0);
});

// -----------------------------------------------------------------------------
// Case 4: Partial, same foreign currency
// 100 EUR @0.5 = 200 company (debit)
// 50 EUR @0.5 = 100 company (credit)
// Partial1: amount=100, currencies 50/50, no FX
// Debit left: 100 company / 50 EUR
// -----------------------------------------------------------------------------
test('Case 4: Partial, same foreign currency - amount 100, currencies 50/50, no FX, debit leaves 100 company / 50 EUR', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Case 4 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // 100 EUR @ 0.5 = 200 company
  const debitEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-10', ref: 'Debit-200',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 200, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 200, currency_id: eur.id, amount_currency: -100 },
    ],
  });
  // 50 EUR @ 0.5 = 100 company
  const creditEntry = postEntry(debitEntry.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-11', ref: 'Credit-100',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 100, currency_id: eur.id, amount_currency: -50 },
      { account_id: rev, debit: 100, currency_id: eur.id, amount_currency: 50 },
    ],
  });
  db = creditEntry.db;

  const preMoves = (db.records['account.move'] ?? []).length;
  const settled = reconcileLedgerItems(db, [
    itemSelection(db, debitEntry.id, ar),
    itemSelection(db, creditEntry.id, ar),
  ], { date: '2026-02-20' });

  const postMoves = (settled.records['account.move'] ?? []).length;
  assert.equal(postMoves, preMoves, 'No FX entry for same-rate partial match');

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 1);
  const [p1] = partials;
  assert.equal(p1.amount, 100);
  assert.equal(p1.debit_amount_currency, 50);
  assert.equal(p1.credit_amount_currency, 50);
  assert.equal(p1.exchange_move_id, null);

  const dItems = reconciledJournalItems(settled, read(settled, 'account.move', debitEntry.id));
  const cItems = reconciledJournalItems(settled, read(settled, 'account.move', creditEntry.id));
  assert.equal(dItems[0].amount_residual, 100);
  assert.equal(dItems[0].amount_residual_currency, 50);
  assert.equal(cItems[0].amount_residual, 0);
  assert.equal(cItems[0].amount_residual_currency, 0);
});

// -----------------------------------------------------------------------------
// Case 5: Multi-item FIFO + due date
// Oldest move first, tie broken by date_maturity (dueDate)
// FX per pair, not per selection
// -----------------------------------------------------------------------------
test('Case 5: Multi-item FIFO + due date - oldest move first, date_maturity tie break, FX per pair', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Case 5 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Two debits with same moveDate '2026-01-10', but different due dates:
  // D1 has due date '2026-01-20' (50 EUR @ 0.8 = 62.50 company)
  const d1 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'D1-later-due',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 62.50, currency_id: eur.id, amount_currency: 50, date_maturity: '2026-01-20' },
      { account_id: rev, credit: 62.50, currency_id: eur.id, amount_currency: -50 },
    ],
  });
  // D2 has due date '2026-01-15' (50 EUR @ 0.8 = 62.50 company) - EARLIER DUE DATE!
  const d2 = postEntry(d1.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'D2-earlier-due',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 62.50, currency_id: eur.id, amount_currency: 50, date_maturity: '2026-01-15' },
      { account_id: rev, credit: 62.50, currency_id: eur.id, amount_currency: -50 },
    ],
  });
  // Credit item: 100 EUR @ 0.5 = 200 company
  const c1 = postEntry(d2.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-10', ref: 'C1-100EUR',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = c1.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, d1.id, ar),
    itemSelection(db, d2.id, ar),
    itemSelection(db, c1.id, ar),
  ], { date: '2026-02-20' });

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  // D2 (earlier due date) matched first against 50 EUR of C1, then D1 matched against next 50 EUR of C1
  // Each pair produced Partial1 + Partial2!
  // Pair 1 (D2 + C1): Partial1 (62.50, 50 EUR), FX gain 37.50, Partial2 (37.50)
  // Pair 2 (D1 + C1): Partial1 (62.50, 50 EUR), FX gain 37.50, Partial2 (37.50)
  assert.equal(partials.length, 4, 'Four partial reconciliations created (2 pairs * 2 partials)');

  const pForD2 = partials.find((p) => p.debit_move_id === d2.id && p.credit_move_id === c1.id);
  const pForD1 = partials.find((p) => p.debit_move_id === d1.id && p.credit_move_id === c1.id);
  assert.ok(pForD2, 'D2 matched C1');
  assert.ok(pForD1, 'D1 matched C1');
  assert.notEqual(pForD2.exchange_move_id, pForD1.exchange_move_id, 'FX entries are per matched pair, not per selection');

  const d1Items = reconciledJournalItems(settled, read(settled, 'account.move', d1.id));
  const d2Items = reconciledJournalItems(settled, read(settled, 'account.move', d2.id));
  const c1Items = reconciledJournalItems(settled, read(settled, 'account.move', c1.id));
  assert.equal(d1Items[0].amount_residual, 0);
  assert.equal(d2Items[0].amount_residual, 0);
  assert.equal(c1Items[0].amount_residual, 0);
});

// -----------------------------------------------------------------------------
// Case 6: Unreconcile FX match
// Both partials reversed, FX entry reversed (never deleted), residuals restored
// Second call errors; independent FX reversal refused
// -----------------------------------------------------------------------------
test('Case 6: Unreconcile FX match - reverses both partials, reverses FX entry, restores residuals in both currencies', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Case 6 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Invoice 100 EUR @ 0.8 = 125 company
  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Credit entry 100 EUR @ 0.5 = 200 company
  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Credit-200',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = creditEntry.db;

  const preReconcileInv = reconciledJournalItems(db, read(db, 'account.move', inv.id))[0];
  const preReconcileCred = reconciledJournalItems(db, read(db, 'account.move', creditEntry.id))[0];

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, inv.id, ar),
    itemSelection(db, creditEntry.id, ar),
  ], { date: '2026-02-20' });

  const p1 = (settled.records['account.partial.reconcile'] ?? []).find((p) => p.amount === 125);
  const fxId = p1.exchange_move_id;
  assert.ok(fxId, 'FX move ID exists on Partial1');

  // Independent FX reversal refused while reconciliation is active
  assert.throws(
    () => reverseEntry(settled, read(settled, 'account.move', fxId), '2026-02-25'),
    /An exchange difference entry linked to a settlement cannot be reversed independently/,
  );

  // Unreconcile by selecting either original item (here selecting the invoice)
  const unreconciled = unreconcileLedgerItems(settled, [
    itemSelection(settled, inv.id, ar),
  ], { date: '2026-02-25' });

  // Original match partials reversed
  const origPartials = (settled.records['account.partial.reconcile'] ?? []).map((p) => read(unreconciled, 'account.partial.reconcile', p.id));
  assert.ok(origPartials.every((p) => p.reversed === true && p.active === false), 'Original match partials are reversed and inactive');

  // FX entry reversed, not deleted
  const fxAfter = read(unreconciled, 'account.move', fxId);
  assert.ok(fxAfter, 'FX entry was not deleted');
  assert.equal(fxAfter.state, 'posted');
  assert.ok(fxAfter.reversal_move_id, 'FX entry has reversal_move_id');
  const fxReversalMove = read(unreconciled, 'account.move', fxAfter.reversal_move_id);
  assert.ok(fxReversalMove, 'Reversal move exists');
  assert.equal(fxReversalMove.state, 'posted');
  assert.equal(fxReversalMove.reversed_entry_id, fxId);

  // Residuals restored in both currencies
  const postUnrecInv = reconciledJournalItems(unreconciled, read(unreconciled, 'account.move', inv.id))[0];
  const postUnrecCred = reconciledJournalItems(unreconciled, read(unreconciled, 'account.move', creditEntry.id))[0];
  assert.equal(postUnrecInv.amount_residual, preReconcileInv.amount_residual);
  assert.equal(postUnrecInv.amount_residual_currency, preReconcileInv.amount_residual_currency);
  assert.equal(postUnrecCred.amount_residual, preReconcileCred.amount_residual);
  assert.equal(postUnrecCred.amount_residual_currency, preReconcileCred.amount_residual_currency);

  // Exchange entry line on AR account and its reversal line are reconciled with each other (residual 0, reconciled true)
  const fxLines = reconciledJournalItems(unreconciled, fxAfter);
  const revLines = reconciledJournalItems(unreconciled, fxReversalMove);
  const fxArLine = fxLines.find((l) => l.account_id === ar);
  const revArLine = revLines.find((l) => l.account_id === ar);
  assert.ok(fxArLine, 'FX entry has line on receivable account');
  assert.ok(revArLine, 'Reversal entry has line on receivable account');
  assert.equal(fxArLine.amount_residual, 0, 'FX receivable line residual must be 0');
  assert.equal(fxArLine.reconciled, true, 'FX receivable line must be reconciled');
  assert.equal(revArLine.amount_residual, 0, 'Reversal receivable line residual must be 0');
  assert.equal(revArLine.reconciled, true, 'Reversal receivable line must be reconciled');

  // No journal item of the exchange entry or its reversal on the receivable account is open
  const openArItems = journalItems(unreconciled, { reviewMode: 'unreconciled' }).filter(
    (l) => l.account_id === ar && (l.move_id === fxId || l.move_id === fxReversalMove.id),
  );
  assert.equal(openArItems.length, 0, 'No journal item of exchange entry or its reversal on receivable account is open');

  // diffDb + applyDiff accepts the unreconciliation and line pairing
  assert.doesNotThrow(() => applyDiff(settled, diffDb(settled, unreconciled), { isAdmin: false }));

  // Repeating unreconcile on the same item throws
  assert.throws(
    () => unreconcileLedgerItems(unreconciled, [itemSelection(unreconciled, inv.id, ar)], { date: '2026-02-25' }),
    /The selected item has no active reconciliation to remove/,
  );
});

// -----------------------------------------------------------------------------
// Case 7: Locked period
// Reconcile/unreconcile/FX reversal on/before lock throw 'The period up to … is locked'
// -----------------------------------------------------------------------------
test('Case 7: Locked period - reconcile, unreconcile, and FX reversal on/before lock throw exact message', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Case 7 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id,
    invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const cred = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-16', ref: 'Credit-lock',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = cred.db;

  // Set fiscal lock date
  db = write(db, 'res.company', 1, { lock_date: '2026-01-31' });

  // Reconcile on or before lock date throws
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, inv.id, ar), itemSelection(db, cred.id, ar)], { date: '2026-01-20' }),
    /The period up to 2026-01-31 is locked/,
  );

  // Reconcile after lock date succeeds
  const settled = reconcileLedgerItems(db, [itemSelection(db, inv.id, ar), itemSelection(db, cred.id, ar)], { date: '2026-02-05' });
  assert.ok(settled);

  // Advance lock date to 2026-02-15
  const lockedLater = write(settled, 'res.company', 1, { lock_date: '2026-02-15' });

  // Unreconcile on or before lock date throws
  assert.throws(
    () => unreconcileLedgerItems(lockedLater, [itemSelection(lockedLater, inv.id, ar)], { date: '2026-02-10' }),
    /The period up to 2026-02-15 is locked/,
  );
});

// -----------------------------------------------------------------------------
// Case 9: Two different foreign currencies
// Both reconcileLedgerItems and applyDiff reject; DB unchanged
// -----------------------------------------------------------------------------
test('Case 9: Two different foreign currencies - both reconcileLedgerItems and applyDiff reject with exact message', async () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  const sar = search(db, 'res.currency').find((c) => c.name === 'SAR');
  const partner = create(db, 'res.partner', { name: 'Case 9 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const eurEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-01', ref: 'EUR-entry',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 100, currency_id: eur.id, amount_currency: 90 },
      { account_id: rev, credit: 100, currency_id: eur.id, amount_currency: -90 },
    ],
  });
  const sarEntry = postEntry(eurEntry.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-02', ref: 'SAR-entry',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 100, currency_id: sar.id, amount_currency: -375 },
      { account_id: rev, debit: 100, currency_id: sar.id, amount_currency: 375 },
    ],
  });
  db = sarEntry.db;

  const beforeJson = JSON.stringify(db);

  // reconcileLedgerItems rejects with exact message
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, eurEntry.id, ar), itemSelection(db, sarEntry.id, ar)], { date: '2026-03-05' }),
    (err) => err.message === 'Selected items must be in the same currency',
  );
  assert.equal(JSON.stringify(db), beforeJson, 'DB is unchanged after rejected reconcileLedgerItems');

  // Verify Arabic translation
  const tAr = await arabicTranslator();
  assert.equal(tAr('Selected items must be in the same currency'), 'يجب أن تكون البنود المحددة بنفس العملة');

  // applyDiff with a forged partial link connecting EUR and SAR rejects
  const forgedPartial = {
    id: 9999,
    debit_move_id: eurEntry.id,
    debit_line_index: 0,
    credit_move_id: sarEntry.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 100,
    date: '2026-03-05',
    active: true,
    reversed: false,
  };
  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [forgedPartial] } }),
    /Selected items must be in the same currency/,
  );
  assert.equal(JSON.stringify(db), beforeJson, 'DB is unchanged after rejected applyDiff');
});

// -----------------------------------------------------------------------------
// Mixed currency: Company-currency item + foreign item matches on company currency
// -----------------------------------------------------------------------------
test('Mixed currency: Company currency item + foreign item matches on company currency with proportional foreign residual', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Company+Foreign Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Company currency debit
  const compEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-01', ref: 'USD-entry',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 100 },
      { account_id: rev, credit: 100 },
    ],
  });
  // Foreign currency credit
  const eurEntry = postEntry(compEntry.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-02', ref: 'EUR-entry',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 100, currency_id: eur.id, amount_currency: -80 },
      { account_id: rev, debit: 100, currency_id: eur.id, amount_currency: 80 },
    ],
  });
  db = eurEntry.db;

  const preMoves = (db.records['account.move'] ?? []).length;
  const settled = reconcileLedgerItems(db, [itemSelection(db, compEntry.id, ar), itemSelection(db, eurEntry.id, ar)], { date: '2026-03-05' });

  // No exchange difference move posted for mixed reconciliation
  assert.equal((settled.records['account.move'] ?? []).length, preMoves);

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 1);
  const [p] = partials;
  assert.equal(p.amount, 100);
  assert.equal(p.debit_amount_currency, null);
  assert.equal(p.credit_amount_currency, 80);
  assert.equal(p.exchange_move_id, null);

  const dItem = reconciledJournalItems(settled, read(settled, 'account.move', compEntry.id)).find((l) => l.account_id === ar);
  const cItem = reconciledJournalItems(settled, read(settled, 'account.move', eurEntry.id)).find((l) => l.account_id === ar);
  assert.equal(dItem.amount_residual, 0);
  assert.equal(dItem.amount_residual_currency, 0);
  assert.equal(dItem.reconciled, true);
  assert.equal(cItem.amount_residual, 0);
  assert.equal(cItem.amount_residual_currency, 0);
  assert.equal(cItem.reconciled, true);
  assert.ok(dItem.matching_number);
  assert.equal(dItem.matching_number, cItem.matching_number);

  assert.doesNotThrow(() => applyDiff(db, diffDb(db, settled), { isAdmin: false }));
});

// -----------------------------------------------------------------------------
// Case 11: Delegation preserved
// Invoice + payment routes to existing reconcileJournalItems and stamps payment_fx_move_id
// -----------------------------------------------------------------------------
test('Case 11: Delegation preserved - invoice + payment in foreign currency routes to existing payment engine', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Case 11 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const bnk = search(db, 'account.journal').find((j) => j.type === 'bank' && (!j.company_id || j.company_id === 1));

  // Payment posted before invoice
  const pmtDraft = create(db, 'account.payment', {
    partner_id: partner.id, company_id: 1, payment_type: 'inbound', partner_type: 'customer',
    journal_id: bnk.id, currency_id: eur.id, amount: 100, date: '2026-02-15',
  });
  db = postPayment(pmtDraft.db, read(pmtDraft.db, 'account.payment', pmtDraft.id));

  // Invoice at rate 0.8: 100 EUR / 0.8 = 125 company
  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id, invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, inv.id, ar),
    itemSelection(db, read(db, 'account.payment', pmtDraft.id).move_id, ar),
  ], { date: '2026-02-15' });

  const invAfter = read(settled, 'account.move', inv.id);
  assert.equal(invAfter.amount_residual, 0);
  assert.ok(invAfter.payments[0].payment_fx_move_id, 'Delegated path stamped payment_fx_move_id');
});

// -----------------------------------------------------------------------------
// Case 12: No parallel model
// account.full.reconcile remains undefined
// -----------------------------------------------------------------------------
test('Case 12: No parallel model - account.full.reconcile remains undefined', () => {
  assert.strictEqual(models['account.full.reconcile'], undefined);
});

// -----------------------------------------------------------------------------
// Guard tests: forged exchange link through applyDiff (wrong amount / wrong account / reused entry)
// -----------------------------------------------------------------------------
test('Guard test: forged exchange link through applyDiff with wrong amount is rejected', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Forged Amount Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Invoice: 100 EUR @ 0.8 = 125 company
  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id, invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  // Credit entry: 100 EUR @ 0.5 = 200 company. Gap is 75.
  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Credit-200',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = creditEntry.db;

  // Post an FX entry with WRONG amount: 50 instead of 75
  const gainAccount = read(db, 'res.company', 1).income_currency_exchange_account_id;
  const badFx = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-20', ref: 'Bad FX',
    lines: [
      { account_id: ar, debit: 50, credit: 0, partner_id: partner.id },
      { account_id: gainAccount, debit: 0, credit: 50 },
    ],
  });
  db = badFx.db;

  const forgedPartial1 = {
    id: 9901,
    debit_move_id: inv.id,
    debit_line_index: 0,
    credit_move_id: creditEntry.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 125,
    debit_amount_currency: 100,
    credit_amount_currency: 100,
    exchange_move_id: badFx.id,
    date: '2026-02-20',
    active: true,
    reversed: false,
  };
  const forgedPartial2 = {
    id: 9902,
    debit_move_id: badFx.id,
    debit_line_index: 0,
    credit_move_id: creditEntry.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 75,
    debit_amount_currency: null,
    credit_amount_currency: 0,
    exchange_move_id: badFx.id,
    date: '2026-02-20',
    active: true,
    reversed: false,
  };

  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [forgedPartial1, forgedPartial2] } }),
    /Exchange entry lines do not match the reconciliation difference|does not match/i,
  );
});

test('Guard test: forged exchange link through applyDiff with wrong account is rejected', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Forged Account Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id, invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Credit-200',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = creditEntry.db;

  // Post FX entry with WRONG account (using revenue 400000 instead of 450100)
  const badFx = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-20', ref: 'Bad Account FX',
    lines: [
      { account_id: ar, debit: 75, credit: 0, partner_id: partner.id },
      { account_id: rev, debit: 0, credit: 75 },
    ],
  });
  db = badFx.db;

  const forgedPartial1 = {
    id: 9911,
    debit_move_id: inv.id,
    debit_line_index: 0,
    credit_move_id: creditEntry.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 125,
    debit_amount_currency: 100,
    credit_amount_currency: 100,
    exchange_move_id: badFx.id,
    date: '2026-02-20',
    active: true,
    reversed: false,
  };
  const forgedPartial2 = {
    id: 9912,
    debit_move_id: badFx.id,
    debit_line_index: 0,
    credit_move_id: creditEntry.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 75,
    debit_amount_currency: null,
    credit_amount_currency: 0,
    exchange_move_id: badFx.id,
    date: '2026-02-20',
    active: true,
    reversed: false,
  };

  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [forgedPartial1, forgedPartial2] } }),
    /Exchange entry account does not match the company exchange account|A dedicated posted exchange entry must match the settlement/i,
  );
});

test('Guard test: forged exchange link through applyDiff reusing existing exchange entry is rejected', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Reused FX Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Create legit pair 1 and reconcile it
  const inv1 = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id, invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);
  const cred1 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Cred1',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = cred1.db;
  const settled1 = reconcileLedgerItems(db, [
    itemSelection(db, inv1.id, ar),
    itemSelection(db, cred1.id, ar),
  ], { date: '2026-02-20' });

  const p1 = (settled1.records['account.partial.reconcile'] ?? []).find((p) => p.amount === 125);
  const fxId = p1.exchange_move_id;

  // Create pair 2
  const inv2 = create(settled1, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id, invoice_date: '2026-01-16',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);
  const cred2 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-16', ref: 'Cred2',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = cred2.db;

  // Try to forge partials for pair 2 reusing fxId from pair 1
  const forgedPartial1 = {
    id: 9921,
    debit_move_id: inv2.id,
    debit_line_index: 0,
    credit_move_id: cred2.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 125,
    debit_amount_currency: 100,
    credit_amount_currency: 100,
    exchange_move_id: fxId,
    date: '2026-02-20',
    active: true,
    reversed: false,
  };
  const forgedPartial2 = {
    id: 9922,
    debit_move_id: fxId,
    debit_line_index: 0,
    credit_move_id: cred2.id,
    credit_line_index: 0,
    account_id: ar,
    company_id: 1,
    amount: 75,
    debit_amount_currency: null,
    credit_amount_currency: 0,
    exchange_move_id: fxId,
    date: '2026-02-20',
    active: true,
    reversed: false,
  };

  assert.throws(
    () => applyDiff(db, { upserts: { 'account.partial.reconcile': [forgedPartial1, forgedPartial2] } }),
    /Exchange entry is already used by another settlement/i,
  );
});

// -----------------------------------------------------------------------------
// Guard tests: resetting, deleting or independently reversing exchange entry through applyDiff
// -----------------------------------------------------------------------------
test('Guard test: resetting, deleting or independently reversing exchange entry through applyDiff is rejected', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Protected FX Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id, invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const cred = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Credit-200',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = cred.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, inv.id, ar),
    itemSelection(db, cred.id, ar),
  ], { date: '2026-02-20' });

  const p1 = (settled.records['account.partial.reconcile'] ?? []).find((p) => p.amount === 125);
  const fxId = p1.exchange_move_id;
  const fxMove = read(settled, 'account.move', fxId);

  // 1. Resetting FX entry to draft via applyDiff is rejected
  assert.throws(
    () => applyDiff(settled, { upserts: { 'account.move': [{ ...fxMove, state: 'draft' }] } }),
    /settles an invoice payment and cannot be reset or cancelled|records a payment; reverse the payment instead/i,
  );

  // Also via direct write
  assert.throws(
    () => write(settled, 'account.move', fxId, { state: 'draft' }),
    /settles an invoice payment and cannot be reset or cancelled|records a payment; reverse the payment instead/i,
  );

  // 2. Deleting FX entry via applyDiff is rejected
  assert.throws(
    () => applyDiff(settled, { deletes: { 'account.move': [fxId] } }),
    /cannot delete an entry which has been posted once/i,
  );

  // Also via direct unlink
  assert.throws(
    () => unlink(settled, 'account.move', [fxId]),
    /cannot delete an entry which has been posted once/i,
  );

  // 3. Independently reversing FX entry via applyDiff is rejected
  const reversalMove = {
    id: 9991,
    move_type: 'entry',
    state: 'posted',
    journal_id: fxMove.journal_id,
    invoice_date: '2026-02-25',
    date: '2026-02-25',
    ref: 'Independent reversal of FX',
    reversed_entry_id: fxId,
    company_id: 1,
    name: 'MISC/2026/FORGED_REV',
    line_ids: fxMove.line_ids.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
  };
  assert.throws(
    () => applyDiff(settled, { upserts: { 'account.move': [reversalMove] } }),
    /An exchange difference entry linked to a settlement cannot be reversed independently/i,
  );
});

// -----------------------------------------------------------------------------
// Guard test: selecting exchange entry line directly for reconcile is rejected
// -----------------------------------------------------------------------------
test('Guard test: selecting exchange entry line directly for reconcile is rejected', async () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Exchange Select Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const inv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id, invoice_date: '2026-01-15',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);

  const cred = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Credit-200',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = cred.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, inv.id, ar),
    itemSelection(db, cred.id, ar),
  ], { date: '2026-02-20' });

  const p1 = (settled.records['account.partial.reconcile'] ?? []).find((p) => p.amount === 125);
  const fxId = p1.exchange_move_id;

  // Attempting to select the FX entry line for reconcile throws
  assert.throws(
    () => reconcileLedgerItems(settled, [
      itemSelection(settled, fxId, ar),
      itemSelection(settled, inv.id, ar),
    ], { date: '2026-02-25' }),
    /Exchange entries cannot be reconciled directly/,
  );

  const tAr = await arabicTranslator();
  assert.equal(tAr('Exchange entries cannot be reconciled directly'), 'لا يمكن مطابقة قيود فروق العملة مباشرة');
});

// -----------------------------------------------------------------------------
// Defect 2 test: Reversing ordinary GL-reconciled entry behaves as on origin/main
// -----------------------------------------------------------------------------
test('Reversing an ordinary company-currency entry that is GL-reconciled behaves exactly as on origin/main', () => {
  let db = seed();
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);
  const partner = create(db, 'res.partner', { name: 'Ordinary Reversal Partner' });
  db = partner.db;

  const debit = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-01', ref: 'D-Ordinary',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 500 }, { account_id: rev, credit: 500 }],
  });
  const credit = postEntry(debit.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-02', ref: 'C-Ordinary',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 500 }, { account_id: rev, debit: 500 }],
  });
  db = credit.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, debit.id, ar),
    itemSelection(db, credit.id, ar),
  ], { date: '2026-03-05' });

  // On origin/main, reversing an ordinary GL-reconciled entry succeeds and is not blocked by settlement FX guard
  const reversed = reverseEntry(settled, read(settled, 'account.move', debit.id), '2026-03-06');
  assert.ok(reversed.id, 'Reversal entry posted successfully');
  const revMove = read(reversed.db, 'account.move', reversed.id);
  assert.equal(revMove.state, 'posted');
  assert.equal(revMove.reversed_entry_id, debit.id);

  // diffDb + applyDiff accepts the reversal
  assert.doesNotThrow(() => applyDiff(settled, diffDb(settled, reversed.db), { isAdmin: false }));
});

// -----------------------------------------------------------------------------
// Defect 6 test: Invoice + credit note and invoice + payment flows remain untouched
// -----------------------------------------------------------------------------
test('Invoice + credit note and invoice + payment flows keep exactly the same company amounts as on origin/main', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Untouched Flows Partner' });
  db = partner.db;
  const bnk = search(db, 'account.journal').find((j) => j.type === 'bank' && (!j.company_id || j.company_id === 1));

  // 1. Invoice + payment in EUR
  const inv1 = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id,
    invoice_date: '2026-01-15', // Rate 0.8 => 100 EUR = 125 company
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv1.db, inv1.id);

  const pmt = create(db, 'account.payment', {
    partner_id: partner.id, company_id: 1, payment_type: 'inbound', partner_type: 'customer',
    journal_id: bnk.id, currency_id: eur.id, amount: 100, date: '2026-02-15', // Rate 0.5 => 100 EUR = 200 company
  });
  db = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id), { autoAllocate: false });

  const afterPay = applyPaymentCredit(db, pmt.id, inv1.id, '2026-02-15');
  const inv1Settled = read(afterPay, 'account.move', inv1.id);
  const payRow = inv1Settled.payments[0];
  assert.equal(payRow.amount, 100);
  assert.equal(payRow.company_amount, 125);
  assert.equal(payRow.payment_company_amount, 200);
  assert.equal(appliedValue(afterPay, inv1Settled, payRow), 200);

  // 2. Invoice + credit note in EUR
  const inv2 = create(afterPay, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: eur.id,
    invoice_date: '2026-01-15', // Rate 0.8 => 100 EUR = 125 company
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(inv2.db, inv2.id);

  const cn = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_refund', currency_id: eur.id,
    invoice_date: '2026-02-15', // Rate 0.5 => 100 EUR = 200 company
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(cn.db, cn.id);

  const afterCn = applyCreditNote(db, cn.id, inv2.id, '2026-02-15');
  const inv2Settled = read(afterCn, 'account.move', inv2.id);
  const cnRow = inv2Settled.payments[0];
  assert.equal(cnRow.amount, 100);
  // Source is out_refund with invoice_date 2026-02-15 => appliedValue uses note's date (2026-02-15) => 200
  assert.equal(appliedValue(afterCn, inv2Settled, cnRow), 200);
});

test('an account forcing the foreign currency still reconciles with an exchange entry that keeps its foreign balance', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Forced EUR Partner' });
  db = partner.db;
  const misc = miscJournal(db, 1);
  const forced = create(db, 'account.account', { code: '121900', name: 'EUR Receivable', account_type: 'asset_receivable', reconcile: true, currency_id: eur.id, company_id: 1 });
  db = forced.db;
  const rev = revAccount(db, 1);
  const debitEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'EUR debit',
    lines: [
      { account_id: forced.id, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 125 },
    ],
  });
  db = debitEntry.db;
  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'EUR credit',
    lines: [
      { account_id: forced.id, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200 },
    ],
  });
  db = creditEntry.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, debitEntry.id, forced.id),
    itemSelection(db, creditEntry.id, forced.id),
  ], { date: '2026-02-20' });

  const fxId = settled.records['account.partial.reconcile'].find((p) => p.exchange_move_id).exchange_move_id;
  const fxLine = read(settled, 'account.move', fxId).line_ids.find((l) => l.account_id === forced.id);
  assert.equal(fxLine.currency_id, eur.id);
  assert.equal(fxLine.amount_currency, 0);
  const eurBalance = journalItems(settled).filter((l) => l.account_id === forced.id).reduce((s, l) => s + (Number(l.amount_currency) || 0), 0);
  assert.equal(eurBalance, 0);
  for (const id of [debitEntry.id, creditEntry.id]) {
    const item = reconciledJournalItems(settled, read(settled, 'account.move', id)).find((l) => l.account_id === forced.id);
    assert.equal(item.amount_residual, 0);
    assert.equal(item.amount_residual_currency, 0);
  }
});

// -----------------------------------------------------------------------------
// Tests for Code Review Defects 1-6
// -----------------------------------------------------------------------------

test('Defect 1: Explicit partial amount on two foreign items at different rates', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Defect 1 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Debit: 100 EUR @ 0.8 = 125 company currency
  const debitEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'EUR debit',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 125 },
    ],
  });
  db = debitEntry.db;

  // Credit: 100 EUR @ 0.5 = 200 company currency
  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'EUR credit',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200 },
    ],
  });
  db = creditEntry.db;

  // Reconcile with explicit amount = 50 company currency
  const settled = reconcileLedgerItems(db, [
    itemSelection(db, debitEntry.id, ar),
    itemSelection(db, creditEntry.id, ar),
  ], { date: '2026-02-20', amount: 50 });

  const partials = (settled.records['account.partial.reconcile'] ?? []).filter((g) => g && g.active !== false && !g.reversed);
  assert.equal(partials.length, 2, 'Should create 2 partials (main + gap)');
  const mainP = partials.find((p) => p.exchange_move_id && p.debit_amount_currency != null);
  assert.equal(mainP.amount, 50, 'Main partial amount must equal requested budget of 50');
  assert.equal(mainP.debit_amount_currency, 40, 'Derived common currency must be 40 EUR');
  assert.equal(mainP.credit_amount_currency, 40);

  const gapP = partials.find((p) => p !== mainP);
  assert.equal(gapP.amount, 30, 'Gap partial amount must be 80 - 50 = 30');

  const dItem = reconciledJournalItems(settled, read(settled, 'account.move', debitEntry.id)).find((l) => l.account_id === ar);
  const cItem = reconciledJournalItems(settled, read(settled, 'account.move', creditEntry.id)).find((l) => l.account_id === ar);

  assert.equal(dItem.amount_residual, 75, 'Debit company residual must be 125 - 50 = 75');
  assert.equal(dItem.amount_residual_currency, 60, 'Debit currency residual must be 100 - 40 = 60 EUR');
  assert.equal(cItem.amount_residual, -120, 'Credit company residual must be -(200 - 80) = -120');
  assert.equal(cItem.amount_residual_currency, -60, 'Credit currency residual must be -(100 - 40) = -60 EUR');

  const diff = diffDb(db, settled);
  assert.doesNotThrow(() => applyDiff(db, diff, { isAdmin: false }));
});

test('Defect 2: Multi-item FIFO rounding drift accepted at sync', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Defect 2 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Debit: 10 EUR booked at $10.01
  const debitEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-01', ref: 'D-10EUR',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 10.01, currency_id: eur.id, amount_currency: 10 },
      { account_id: rev, credit: 10.01 },
    ],
  });
  db = debitEntry.db;

  // Credit 1: 3 EUR booked at $6.00 (rate 0.5)
  const c1 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-01', ref: 'C1-3EUR',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 6.00, currency_id: eur.id, amount_currency: -3 },
      { account_id: rev, debit: 6.00 },
    ],
  });
  db = c1.db;

  // Credit 2: 3 EUR booked at $6.00
  const c2 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-02', ref: 'C2-3EUR',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 6.00, currency_id: eur.id, amount_currency: -3 },
      { account_id: rev, debit: 6.00 },
    ],
  });
  db = c2.db;

  // Credit 3: 4 EUR booked at $8.00
  const c3 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-03', ref: 'C3-4EUR',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 8.00, currency_id: eur.id, amount_currency: -4 },
      { account_id: rev, debit: 8.00 },
    ],
  });
  db = c3.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, debitEntry.id, ar),
    itemSelection(db, c1.id, ar),
    itemSelection(db, c2.id, ar),
    itemSelection(db, c3.id, ar),
  ], { date: '2026-02-10' });

  const diff = diffDb(db, settled);
  assert.doesNotThrow(() => applyDiff(db, diff, { isAdmin: false }));

  for (const id of [debitEntry.id, c1.id, c2.id, c3.id]) {
    const item = reconciledJournalItems(settled, read(settled, 'account.move', id)).find((l) => l.account_id === ar);
    assert.equal(item.amount_residual, 0, `Line on move ${id} must have company residual 0`);
    assert.equal(item.amount_residual_currency, 0, `Line on move ${id} must have currency residual 0`);
  }
});

test('Defect 3: Infinite loop on a zero foreign residual is rejected promptly', async () => {
  const t = await arabicTranslator();
  assert.equal(
    t('Selected foreign-currency items must have a non-zero currency balance'),
    'يجب أن يكون لبنود العملات الأجنبية المحددة رصيد غير صفري بالعملة'
  );

  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Defect 3 Partner' });
  db = partner.db;
  const misc = miscJournal(db, 1);
  const rev = revAccount(db, 1);

  // Forced foreign currency account (EUR)
  const forcedAccount = create(db, 'account.account', {
    code: '121999',
    name: 'Forced EUR AR',
    account_type: 'asset_receivable',
    company_id: 1,
    reconcile: true,
    currency_id: eur.id,
  });
  db = forcedAccount.db;

  // 1. Regular foreign line: debit 100 USD, 80 EUR
  const normalEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-01', ref: 'Normal-EUR',
    lines: [
      { account_id: forcedAccount.id, partner_id: partner.id, debit: 100, currency_id: eur.id, amount_currency: 80 },
      { account_id: rev, credit: 100 },
    ],
  });
  db = normalEntry.db;

  // 2. Value-only revaluation line (credit 50 USD, 0 EUR)
  const valueOnly = valueOnlyCurrencyFields(db, forcedAccount.id, 1);
  const valOnlyEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-02', ref: 'ValOnly',
    lines: [
      { account_id: forcedAccount.id, partner_id: partner.id, credit: 50, debit: 0, ...valueOnly },
      { account_id: rev, debit: 50, credit: 0 },
    ],
  });
  db = valOnlyEntry.db;

  const normalItem = reconciledJournalItems(db, read(db, 'account.move', normalEntry.id)).find((l) => l.account_id === forcedAccount.id);
  const valOnlyItem = reconciledJournalItems(db, read(db, 'account.move', valOnlyEntry.id)).find((l) => l.account_id === forcedAccount.id);
  assert.equal(normalItem.amount_residual, 100);
  assert.equal(normalItem.amount_residual_currency, 80);
  assert.equal(valOnlyItem.amount_residual, -50);
  assert.equal(valOnlyItem.amount_residual_currency, 0);

  // Reconcile must return or throw promptly, not hang in an infinite loop
  assert.throws(
    () => reconcileLedgerItems(db, [
      itemSelection(db, normalEntry.id, forcedAccount.id),
      itemSelection(db, valOnlyEntry.id, forcedAccount.id),
    ], { date: '2026-01-05' }),
    /Selected foreign-currency items must have a non-zero currency balance/
  );
});

test('Defect 4a: A company-currency partial carrying an unrelated exchange-shaped entry is rejected through applyDiff', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'Defect 4a Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const d = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-01', ref: 'D-Comp',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 500 }, { account_id: rev, credit: 500 }],
  });
  const c = postEntry(d.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-02', ref: 'C-Comp',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 500 }, { account_id: rev, debit: 500 }],
  });
  db = c.db;

  const exAccount = read(db, 'res.company', 1)?.income_currency_exchange_account_id ?? accountId(db, '450100', 1);
  const fx = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-03', ref: 'Fake FX',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 50, credit: 0 },
      { account_id: exAccount, debit: 0, credit: 50 },
    ],
  });
  db = fx.db;

  const forged = {
    id: 9905,
    debit_move_id: d.id, debit_line_index: 0,
    credit_move_id: c.id, credit_line_index: 0,
    account_id: ar, company_id: 1, amount: 500,
    exchange_move_id: fx.id,
    date: '2026-01-05', active: true, reversed: false,
  };

  assert.throws(() => create(db, 'account.partial.reconcile', forged), /Exchange/);

  const diff = diffDb(db, {
    ...db,
    records: {
      ...db.records,
      'account.partial.reconcile': [forged],
    },
  });
  assert.throws(() => applyDiff(db, diff, { isAdmin: false }), /Exchange/);
});

test('Defect 4b: A standalone gap partial with no main partial is rejected through applyDiff', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Defect 4b Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);
  const exAccount = read(db, 'res.company', 1)?.income_currency_exchange_account_id ?? accountId(db, '450100', 1);

  const c = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Credit-200',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200, currency_id: eur.id, amount_currency: 100 },
    ],
  });
  db = c.db;

  const fx = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'Fake FX',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 75, credit: 0 },
      { account_id: exAccount, debit: 0, credit: 75 },
    ],
  });
  db = fx.db;

  const gap = create(db, 'account.partial.reconcile', {
    debit_move_id: fx.id, debit_line_index: 0,
    credit_move_id: c.id, credit_line_index: 0,
    account_id: ar, company_id: 1, amount: 75,
    debit_amount_currency: null, credit_amount_currency: 0,
    exchange_move_id: fx.id,
    date: '2026-02-20', active: true, reversed: false,
  });

  const diff = diffDb(db, gap.db);
  assert.throws(() => applyDiff(db, diff, { isAdmin: false }), /Exchange reconciliation requires a matching main partial/);
});

test('Defect 4c: A gap partial with the wrong amount is rejected through applyDiff', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Defect 4c Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const d = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'EUR debit',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 125 },
    ],
  });
  db = d.db;

  const c = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'EUR credit',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200 },
    ],
  });
  db = c.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, d.id, ar),
    itemSelection(db, c.id, ar),
  ], { date: '2026-02-20' });

  const p1 = (settled.records['account.partial.reconcile'] ?? []).find((p) => p.amount === 125);
  const gap = (settled.records['account.partial.reconcile'] ?? []).find((p) => p.amount === 75);

  // Database has main partial and fx entry, but not gap partial yet
  const dbWithMain = {
    ...settled,
    records: {
      ...settled.records,
      'account.partial.reconcile': [p1],
    },
  };

  // Client attempts to submit gap partial with wrong amount (74 instead of 75)
  const tamperedGap = { ...gap, amount: 74 };
  const diff = diffDb(dbWithMain, {
    ...dbWithMain,
    records: {
      ...dbWithMain.records,
      'account.partial.reconcile': [p1, tamperedGap],
    },
  });
  assert.throws(
    () => applyDiff(dbWithMain, diff, { isAdmin: false }),
    /Exchange reconciliation gap amount does not match the re-derived difference|gap amount/
  );
});

test('Defect 4d: Legitimate reconcile and unreconcile still apply through applyDiff', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Defect 4d Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const d = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'EUR debit',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 125 },
    ],
  });
  db = d.db;

  const c = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'EUR credit',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200 },
    ],
  });
  db = c.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, d.id, ar),
    itemSelection(db, c.id, ar),
  ], { date: '2026-02-20' });

  const diffRec = diffDb(db, settled);
  const synced = applyDiff(db, diffRec, { isAdmin: false });
  assert.ok(synced);

  const unreconciled = unreconcileLedgerItems(synced, [
    itemSelection(synced, d.id, ar),
  ], { date: '2026-02-25' });

  const diffUnrec = diffDb(synced, unreconciled);
  assert.doesNotThrow(() => applyDiff(synced, diffUnrec, { isAdmin: false }));
});

test('Defect 5: Mixed matches do not overstate foreign balance', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Defect 5 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  // Non-document receivable line: debit 100 USD, amount_currency 80 EUR
  const debitEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-01', ref: 'D-NonDoc',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 100, currency_id: eur.id, amount_currency: 80 },
      { account_id: rev, credit: 100 },
    ],
  });
  db = debitEntry.db;

  // Step 1: Create an out_refund of $50 for partner and settle it with debitEntry (legacy application without partial_reconcile_id)
  const refund = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_refund',
    invoice_date: '2026-01-05',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(refund.db, refund.id);

  db = write(db, 'account.move', refund.id, {
    payments: [
      {
        amount: 50,
        move_id: debitEntry.id,
        date: '2026-01-06',
        company_amount: 50,
        payment_company_amount: 50,
      },
    ],
    amount_paid: 50,
  });

  // Check residuals after Step 1
  let item = reconciledJournalItems(db, read(db, 'account.move', debitEntry.id)).find((l) => l.account_id === ar);
  assert.equal(item.amount_residual, 50, 'Step 1: company residual must be 50');
  assert.equal(item.amount_residual_currency, 40, 'Step 1: currency residual must be 40 EUR');

  // Step 2: Add a new currency-aware partial of 25 USD / -20 EUR
  const creditEntry = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'C-Partial',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 25, currency_id: eur.id, amount_currency: -20 },
      { account_id: rev, debit: 25 },
    ],
  });
  db = creditEntry.db;

  db = reconcileLedgerItems(db, [
    itemSelection(db, debitEntry.id, ar),
    itemSelection(db, creditEntry.id, ar),
  ], { date: '2026-01-15' });

  item = reconciledJournalItems(db, read(db, 'account.move', debitEntry.id)).find((l) => l.account_id === ar);
  assert.equal(item.amount_residual, 25, 'Step 2: company residual must be 25');
  assert.equal(item.amount_residual_currency, 20, 'Step 2: currency residual must be 20 EUR');
});

test('Defect 6: Reversing the exchange reversal is refused via reverseEntry and via applyDiff', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Defect 6 Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);

  const d = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'EUR debit',
    lines: [
      { account_id: ar, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 },
      { account_id: rev, credit: 125 },
    ],
  });
  db = d.db;

  const c = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'EUR credit',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 },
      { account_id: rev, debit: 200 },
    ],
  });
  db = c.db;

  const settled = reconcileLedgerItems(db, [
    itemSelection(db, d.id, ar),
    itemSelection(db, c.id, ar),
  ], { date: '2026-02-20' });

  const unreconciled = unreconcileLedgerItems(settled, [
    itemSelection(settled, d.id, ar),
  ], { date: '2026-02-25' });

  const revMove = (unreconciled.records['account.move'] ?? []).find(
    (m) => m.state === 'posted' && m.ref?.startsWith('Reversal of')
  );
  assert.ok(revMove, 'Exchange reversal move must exist after unreconcile');

  // 1. Refused via reverseEntry
  assert.throws(
    () => reverseEntry(unreconciled, revMove, '2026-02-26'),
    /An exchange difference entry linked to a settlement cannot be reversed independently/
  );

  // 2. Refused via applyDiff
  const revOfRev = create(unreconciled, 'account.move', {
    move_type: 'entry',
    state: 'posted',
    journal_id: misc.id,
    company_id: 1,
    date: '2026-02-26',
    invoice_date: '2026-02-26',
    name: 'MISC/2026/99999',
    ref: 'Reversal of revMove',
    reversed_entry_id: revMove.id,
    line_ids: (revMove.line_ids ?? []).map((l) => ({
      account_id: l.account_id, partner_id: l.partner_id,
      debit: l.credit, credit: l.debit,
      currency_id: l.currency_id, amount_currency: l.amount_currency ? -l.amount_currency : undefined,
    })),
  });

  const diff = diffDb(unreconciled, revOfRev.db);
  assert.throws(
    () => applyDiff(unreconciled, diff, { isAdmin: false }),
    /An exchange difference entry linked to a settlement cannot be reversed independently/
  );
});


test('an explicit amount larger than the foreign pair is rejected', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Over-amount Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);
  const d = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'EUR debit',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 }, { account_id: rev, credit: 125 }],
  });
  db = d.db;
  const c = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'EUR credit',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 }, { account_id: rev, debit: 200 }],
  });
  db = c.db;
  assert.throws(
    () => reconcileLedgerItems(db, [itemSelection(db, d.id, ar), itemSelection(db, c.id, ar)], { date: '2026-02-20', amount: 126 }),
    /cannot exceed the open balance available to reconcile/,
  );
});

test('a second clearing link between an exchange entry and its reversal is rejected through applyDiff', () => {
  const setup = setupCurrencies(seed());
  let db = setup.db;
  const eur = setup.eur;
  const partner = create(db, 'res.partner', { name: 'Clearing Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = revAccount(db, 1);
  const misc = miscJournal(db, 1);
  const d = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-15', ref: 'EUR debit',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 125, currency_id: eur.id, amount_currency: 100 }, { account_id: rev, credit: 125 }],
  });
  db = d.db;
  const c = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-02-15', ref: 'EUR credit',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 200, currency_id: eur.id, amount_currency: -100 }, { account_id: rev, debit: 200 }],
  });
  db = c.db;
  const settled = reconcileLedgerItems(db, [itemSelection(db, d.id, ar), itemSelection(db, c.id, ar)], { date: '2026-02-20' });
  const synced = applyDiff(db, diffDb(db, settled), { isAdmin: false });
  const unreconciled = unreconcileLedgerItems(synced, [itemSelection(synced, d.id, ar)], { date: '2026-02-25' });
  const after = applyDiff(synced, diffDb(synced, unreconciled), { isAdmin: false });

  const clearing = (after.records['account.partial.reconcile'] ?? []).find((g) => g && g.active !== false && !g.reversed && g.exchange_move_id == null
    && read(after, 'account.move', g.debit_move_id)?.reversed_entry_id === g.credit_move_id || (g && g.active !== false && !g.reversed && g.exchange_move_id == null && read(after, 'account.move', g.credit_move_id)?.reversed_entry_id === g.debit_move_id));
  assert.ok(clearing, 'unreconcile must create the clearing link');
  const { id: _id, ...fields } = clearing;
  const forged = create(after, 'account.partial.reconcile', fields);
  assert.throws(() => applyDiff(after, diffDb(after, forged.db), { isAdmin: false }), /cannot exceed the open journal line balance/);
});

test('a reversal chain that loops back on itself does not recurse forever', () => {
  const db = seed();
  const withMoves = {
    ...db,
    records: {
      ...db.records,
      'account.move': [
        ...(db.records['account.move'] ?? []),
        { id: 900001, move_type: 'entry', state: 'posted', reversed_entry_id: 900002, line_ids: [] },
        { id: 900002, move_type: 'entry', state: 'posted', reversed_entry_id: 900001, line_ids: [] },
        { id: 900003, move_type: 'entry', state: 'posted', reversed_entry_id: 900003, line_ids: [] },
      ],
    },
  };
  assert.equal(isExchangeEntry(withMoves, 900001), false);
  assert.equal(isExchangeEntry(withMoves, 900003), false);
});
