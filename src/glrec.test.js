import { test } from 'node:test';
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { find, setupDom } from './test-support/dom.js';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';
import { createCompany } from './models/company.js';
import { payMove, postMove } from './models/accounting.js';
import { accountBalance, accountId, journalItemIdentity, journalItems, postEntry, reconciledJournalItems } from './models/ledger.js';
import { applyPaymentCredit, postPayment } from './models/pay.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));

const props = (node) => node?.[Object.keys(node).find((k) => k.startsWith('__reactProps$'))];

function itemSelection(db, moveId, account, predicate = () => true) {
  const rows = journalItems(db).filter((l) => l.move_id === moveId && l.account_id === account && predicate(l));
  assert.equal(rows.length, 1, `Expected 1 journal item on move ${moveId} account ${account}, got ${rows.length}`);
  return { move_id: moveId, line_identity: rows[0].line_identity };
}

function makePostedInvoice(db, { partnerId, moveType = 'out_invoice', price = 1000, date = '2026-03-01', companyId = 1 }) {
  const inv = create(db, 'account.move', {
    partner_id: partnerId,
    company_id: companyId,
    move_type: moveType,
    invoice_date: date,
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: price, tax: 0 }],
  });
  return { db: postMove(inv.db, inv.id), id: inv.id };
}

function miscJournal(db, companyId = 1) {
  return search(db, 'account.journal').find((j) => j.type === 'general' && (!j.company_id || j.company_id === companyId));
}

function arAccount(db, companyId = 1) {
  return read(db, 'res.company', companyId)?.account_default_receivable_id ?? accountId(db, '121000', companyId);
}

function apAccount(db, companyId = 1) {
  return read(db, 'res.company', companyId)?.account_default_payable_id ?? accountId(db, '211000', companyId);
}

function suspenseAccount(db, companyId = 1) {
  return accountId(db, '101404', companyId);
}

test('PKG-08(a): reconcile posted invoice 1000 with manual MISC 1000 via Journal Items sets residual 0, paid, one matching group, leaves Unreconciled', async () => {
  const { reconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 Customer A' });
  db = partner.db;
  const inv = makePostedInvoice(db, { partnerId: partner.id, price: 1000, date: '2026-03-05' });
  db = inv.db;
  const ar = arAccount(db, 1);
  const rev = accountId(db, '400000', 1);
  const misc = miscJournal(db, 1);
  const manual = postEntry(db, {
    journal: misc.code,
    journal_id: misc.id,
    company: 1,
    date: '2026-03-06',
    ref: 'Manual MISC receipt',
    lines: [
      { account_id: ar, partner_id: partner.id, credit: 1000, name: 'MISC credit' },
      { account_id: rev, debit: 1000, name: 'Offset' },
    ],
  });
  db = manual.db;

  const unreconciledBefore = journalItems(db, { reviewMode: 'unreconciled' });
  assert.ok(unreconciledBefore.some((l) => l.move_id === inv.id && l.account_id === ar));
  assert.ok(unreconciledBefore.some((l) => l.move_id === manual.id && l.account_id === ar));

  const next = reconcileLedgerItems(db, [
    itemSelection(db, inv.id, ar),
    itemSelection(db, manual.id, ar),
  ], { date: '2026-03-06' });

  const synced = applyDiff(db, diffDb(db, next), { isAdmin: true });
  const updatedInv = read(synced, 'account.move', inv.id);
  assert.equal(updatedInv.amount_residual, 0);
  assert.equal(updatedInv.payment_state, 'paid');

  const invLine = reconciledJournalItems(synced, updatedInv).find((l) => l.account_id === ar);
  const miscLine = reconciledJournalItems(synced, read(synced, 'account.move', manual.id)).find((l) => l.account_id === ar);
  assert.equal(invLine.reconciled, true);
  assert.equal(miscLine.reconciled, true);
  assert.equal(invLine.amount_residual, 0);
  assert.equal(miscLine.amount_residual, 0);
  assert.ok(invLine.matching_number, 'full reconciliation assigns a matching group');
  assert.equal(invLine.matching_number, miscLine.matching_number, 'both lines share one matching group');

  const unreconciledAfter = journalItems(synced, { reviewMode: 'unreconciled' });
  assert.ok(!unreconciledAfter.some((l) => l.move_id === inv.id && l.account_id === ar));
  assert.ok(!unreconciledAfter.some((l) => l.move_id === manual.id && l.account_id === ar));
});

test('PKG-08(a-ui): JournalItems action reconciles invoice and manual MISC entry and removes both from Unreconciled', async () => {
  const { makeEl } = setupDom();
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();

  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 UI Customer' });
  db = makePostedInvoice(partner.db, { partnerId: partner.id, price: 1000, date: '2026-03-05' }).db;
  const invMove = search(db, 'account.move').find((m) => m.partner_id === partner.id && m.move_type === 'out_invoice');
  const ar = arAccount(db, 1);
  const rev = accountId(db, '400000', 1);
  const misc = miscJournal(db, 1);
  const manual = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-06', ref: 'UI MISC credit',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 1000, name: 'UI MISC line' }, { account_id: rev, debit: 1000, name: 'Offset' }],
  });
  db = manual.db;

  const root = createRoot(host);
  const arName = read(db, 'account.account', ar).name;
  const selectRow = async (moveId) => {
    const row = find(host, (n) => n.tagName === 'TR' && find(n, (a) => a.tagName === 'A' && props(a)?.href === `#/accounting/entries/${moveId}`) && n.textContent.includes(arName));
    assert.ok(row, `Row for move ${moveId} must exist`);
    const cb = find(row, (n) => n.tagName === 'INPUT' && props(n)?.type === 'checkbox');
    await React.act(async () => props(cb).onChange({ target: { checked: true } }));
  };

  try {
    await React.act(async () => {
      await commit(db);
      root.render(React.createElement(JournalItems, { leaf: { reviewMode: 'unreconciled' } }));
    });
    await selectRow(invMove.id);
    await selectRow(manual.id);
    const reconcileBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Reconcile');
    await React.act(async () => props(reconcileBtn).onClick());
    const dateInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && !props(n)?.['aria-label']);
    await React.act(async () => props(dateInput).onChange({ target: { value: '2026-03-06' } }));
    await React.act(async () => props(find(host, (n) => n.tagName === 'FORM')).onSubmit({ preventDefault() {} }));

    const after = getDb();
    assert.equal(read(after, 'account.move', invMove.id).amount_residual, 0);
    assert.equal(read(after, 'account.move', invMove.id).payment_state, 'paid');
    assert.equal(find(host, (n) => n.tagName === 'TR' && n.textContent.includes(arName) && find(n, (a) => a.tagName === 'A' && props(a)?.href === `#/accounting/entries/${invMove.id}`)), null);
    assert.equal(find(host, (n) => n.tagName === 'TR' && n.textContent.includes(arName) && find(n, (a) => a.tagName === 'A' && props(a)?.href === `#/accounting/entries/${manual.id}`)), null);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('PKG-08(b): 1000 vs 600 partial leaves 400 residual on invoice, then Reconcile with write-off of 400 fully reconciles and posts balanced entry', async () => {
  const { reconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 Customer B' });
  const inv = makePostedInvoice(partner.db, { partnerId: partner.id, price: 1000, date: '2026-03-01' });
  db = inv.db;
  const ar = arAccount(db, 1);
  const exp = accountId(db, '600000', 1);
  const misc = miscJournal(db, 1);
  const part = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-05', ref: 'Partial 600',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 600 }, { account_id: exp, debit: 600 }],
  });
  db = part.db;

  db = reconcileLedgerItems(db, [itemSelection(db, inv.id, ar), itemSelection(db, part.id, ar)], { date: '2026-03-05' });
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 400);
  assert.equal(read(db, 'account.move', inv.id).payment_state, 'partial');
  const invAfterPartial = reconciledJournalItems(db, read(db, 'account.move', inv.id)).find((l) => l.account_id === ar);
  const partAfterPartial = reconciledJournalItems(db, read(db, 'account.move', part.id)).find((l) => l.account_id === ar);
  assert.equal(invAfterPartial.reconciled, false);
  assert.equal(invAfterPartial.amount_residual, 400);
  assert.equal(partAfterPartial.reconciled, true);
  assert.equal(partAfterPartial.amount_residual, 0);
  assert.equal(invAfterPartial.matching_number ?? null, null, 'partial reconciliation does not assign full matching group');

  const movesBefore = db.records['account.move'].length;
  db = reconcileLedgerItems(db, [itemSelection(db, inv.id, ar)], {
    date: '2026-03-08',
    writeoff: { accountId: exp, journalId: misc.id, date: '2026-03-08', label: 'Small balance write-off' },
  });
  const synced = applyDiff(db, diffDb(db, db), { isAdmin: true });
  assert.equal(synced.records['account.move'].length, movesBefore + 1);
  const writeoffMove = synced.records['account.move'].find((m) => m.ref === 'Small balance write-off');
  assert.ok(writeoffMove);
  assert.equal(writeoffMove.state, 'posted');
  const woDebit = writeoffMove.line_ids.reduce((s, l) => s + (l.debit || 0), 0);
  const woCredit = writeoffMove.line_ids.reduce((s, l) => s + (l.credit || 0), 0);
  assert.equal(woDebit, 400);
  assert.equal(woCredit, 400);

  const finalInv = read(synced, 'account.move', inv.id);
  assert.equal(finalInv.amount_residual, 0);
  assert.equal(finalInv.payment_state, 'paid');

  const invFinalLine = reconciledJournalItems(synced, finalInv).find((l) => l.account_id === ar);
  const partFinalLine = reconciledJournalItems(synced, read(synced, 'account.move', part.id)).find((l) => l.account_id === ar);
  const woFinalLine = reconciledJournalItems(synced, writeoffMove).find((l) => l.account_id === ar);
  assert.ok(invFinalLine.matching_number);
  assert.equal(invFinalLine.matching_number, partFinalLine.matching_number);
  assert.equal(invFinalLine.matching_number, woFinalLine.matching_number);

  const unreconciled = journalItems(synced, { reviewMode: 'unreconciled' });
  assert.ok(!unreconciled.some((l) => [inv.id, part.id, writeoffMove.id].includes(l.move_id) && l.account_id === ar));
});

test('PKG-08(c): rejects cross-company, different accounts, non-reconcilable, draft, already reconciled, and different partners on receivable with no data change', async () => {
  const { reconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const p1 = create(db, 'res.partner', { name: 'Partner One' });
  const p2 = create(p1.db, 'res.partner', { name: 'Partner Two' });
  db = p2.db;
  const ar1 = arAccount(db, 1);
  const ap1 = apAccount(db, 1);
  const exp1 = accountId(db, '600000', 1);
  const misc1 = miscJournal(db, 1);
  const inv1 = makePostedInvoice(db, { partnerId: p1.id, price: 100, date: '2026-03-01', companyId: 1 });
  db = inv1.db;

  // 1) Different partner on receivable
  const miscDiffPartner = postEntry(db, {
    journal: misc1.code, journal_id: misc1.id, company: 1, date: '2026-03-02', ref: 'Diff partner',
    lines: [{ account_id: ar1, partner_id: p2.id, credit: 100 }, { account_id: exp1, debit: 100 }],
  });
  db = miscDiffPartner.db;
  let before = JSON.stringify(db);
  assert.throws(() => reconcileLedgerItems(db, [itemSelection(db, inv1.id, ar1), itemSelection(db, miscDiffPartner.id, ar1)], { date: '2026-03-02' }), /partner/i);
  assert.equal(JSON.stringify(db), before);

  // 2) Different accounts (AR vs AP)
  const miscAp = postEntry(db, {
    journal: misc1.code, journal_id: misc1.id, company: 1, date: '2026-03-02', ref: 'AP line',
    lines: [{ account_id: ap1, partner_id: p1.id, credit: 100 }, { account_id: exp1, debit: 100 }],
  });
  db = miscAp.db;
  before = JSON.stringify(db);
  assert.throws(() => reconcileLedgerItems(db, [itemSelection(db, inv1.id, ar1), itemSelection(db, miscAp.id, ap1)], { date: '2026-03-02' }), /same account/i);
  assert.equal(JSON.stringify(db), before);

  // 3) Non-reconcilable account
  const nonRecAcc = create(db, 'account.account', { code: '519901', name: 'Non Reconcilable Test', account_type: 'expense', reconcile: false, company_id: 1 });
  db = nonRecAcc.db;
  const nonRecA = postEntry(db, {
    journal: misc1.code, journal_id: misc1.id, company: 1, date: '2026-03-02', ref: 'NonRec A',
    lines: [{ account_id: nonRecAcc.id, debit: 50 }, { account_id: exp1, credit: 50 }],
  });
  const nonRecB = postEntry(nonRecA.db, {
    journal: misc1.code, journal_id: misc1.id, company: 1, date: '2026-03-02', ref: 'NonRec B',
    lines: [{ account_id: nonRecAcc.id, credit: 50 }, { account_id: exp1, debit: 50 }],
  });
  db = nonRecB.db;
  before = JSON.stringify(db);
  assert.throws(() => reconcileLedgerItems(db, [itemSelection(db, nonRecA.id, nonRecAcc.id), itemSelection(db, nonRecB.id, nonRecAcc.id)], { date: '2026-03-02' }), /reconcilable/i);
  assert.equal(JSON.stringify(db), before);

  // 4) Draft lines
  const draft = create(db, 'account.move', {
    move_type: 'entry', state: 'draft', name: '/', journal_id: misc1.id, company_id: 1, date: '2026-03-02', invoice_date: '2026-03-02',
    line_ids: [{ account_id: ar1, partner_id: p1.id, credit: 100, debit: 0 }, { account_id: exp1, credit: 0, debit: 100 }],
  });
  db = draft.db;
  const draftIdentity = journalItemIdentity(read(db, 'account.move', draft.id).line_ids[0]);
  before = JSON.stringify(db);
  assert.throws(() => reconcileLedgerItems(db, [itemSelection(db, inv1.id, ar1), { move_id: draft.id, line_identity: draftIdentity }], { date: '2026-03-02' }), /posted|draft/i);
  assert.equal(JSON.stringify(db), before);

  // 5) Already fully reconciled lines
  const matchSame = postEntry(db, {
    journal: misc1.code, journal_id: misc1.id, company: 1, date: '2026-03-02', ref: 'Match same',
    lines: [{ account_id: ar1, partner_id: p1.id, credit: 100 }, { account_id: exp1, debit: 100 }],
  });
  const anotherCredit = postEntry(matchSame.db, {
    journal: misc1.code, journal_id: misc1.id, company: 1, date: '2026-03-03', ref: 'Extra credit',
    lines: [{ account_id: ar1, partner_id: p1.id, credit: 100 }, { account_id: exp1, debit: 100 }],
  });
  db = reconcileLedgerItems(anotherCredit.db, [itemSelection(anotherCredit.db, inv1.id, ar1), itemSelection(anotherCredit.db, matchSame.id, ar1)], { date: '2026-03-02' });
  before = JSON.stringify(db);
  assert.throws(() => reconcileLedgerItems(db, [itemSelection(db, inv1.id, ar1), itemSelection(db, anotherCredit.id, ar1)], { date: '2026-03-03' }), /already.*reconciled/i);
  assert.equal(JSON.stringify(db), before);

  // 6) Cross-company
  const co2 = createCompany(db, { name: 'PKG08 Company Two' });
  db = co2.db;
  const exp2 = accountId(db, '600000', co2.id);
  const misc2 = miscJournal(db, co2.id);
  const sharedRec = create(db, 'account.account', { code: '119999', name: 'Shared Rec', account_type: 'asset_current', reconcile: true });
  const eCo1 = postEntry(sharedRec.db, {
    journal: misc1.code, journal_id: misc1.id, company: 1, date: '2026-03-02', ref: 'Co1 rec',
    lines: [{ account_id: sharedRec.id, debit: 50 }, { account_id: exp1, credit: 50 }],
  });
  const eCo2 = postEntry(eCo1.db, {
    journal: misc2.code, journal_id: misc2.id, company: co2.id, date: '2026-03-02', ref: 'Co2 rec',
    lines: [{ account_id: sharedRec.id, credit: 50 }, { account_id: exp2, debit: 50 }],
  });
  db = eCo2.db;
  before = JSON.stringify(db);
  assert.throws(() => reconcileLedgerItems(db, [itemSelection(db, eCo1.id, sharedRec.id), itemSelection(db, eCo2.id, sharedRec.id)], { date: '2026-03-02' }), /same company/i);
  assert.equal(JSON.stringify(db), before);
});

test('PKG-08(mixed-partners & FIFO): non-receivable reconcilable account allows mixed partners and matches debits against credits oldest first', async () => {
  const { reconcileLedgerItems, unreconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const p1 = create(db, 'res.partner', { name: 'Adv P1' });
  const p2 = create(p1.db, 'res.partner', { name: 'Adv P2' });
  const advAcc = create(p2.db, 'account.account', { code: '118800', name: 'Employee Advances', account_type: 'asset_current', reconcile: true, company_id: 1 });
  const exp = accountId(advAcc.db, '600000', 1);
  const misc = miscJournal(advAcc.db, 1);

  const dOld = postEntry(advAcc.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-05', ref: 'Old debit 100',
    lines: [{ account_id: advAcc.id, partner_id: p1.id, debit: 100 }, { account_id: exp, credit: 100 }],
  });
  const dNew = postEntry(dOld.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-10', ref: 'New debit 200',
    lines: [{ account_id: advAcc.id, partner_id: p2.id, debit: 200 }, { account_id: exp, credit: 200 }],
  });
  const cMid = postEntry(dNew.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-12', ref: 'Credit 150',
    lines: [{ account_id: advAcc.id, partner_id: null, credit: 150 }, { account_id: exp, debit: 150 }],
  });
  db = reconcileLedgerItems(cMid.db, [
    itemSelection(cMid.db, dNew.id, advAcc.id),
    itemSelection(cMid.db, dOld.id, advAcc.id),
    itemSelection(cMid.db, cMid.id, advAcc.id),
  ], { date: '2026-01-12' });

  const oldLine = reconciledJournalItems(db, read(db, 'account.move', dOld.id)).find((l) => l.account_id === advAcc.id);
  const newLine = reconciledJournalItems(db, read(db, 'account.move', dNew.id)).find((l) => l.account_id === advAcc.id);
  const creditLine = reconciledJournalItems(db, read(db, 'account.move', cMid.id)).find((l) => l.account_id === advAcc.id);
  assert.equal(oldLine.reconciled, true);
  assert.equal(oldLine.amount_residual, 0);
  assert.equal(creditLine.reconciled, true);
  assert.equal(creditLine.amount_residual, 0);
  assert.equal(newLine.reconciled, false);
  assert.equal(newLine.amount_residual, 150);

  // Finish remaining 150 -> entire component now full with one matching_number
  const cRest = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-01-20', ref: 'Credit 150 B',
    lines: [{ account_id: advAcc.id, partner_id: p1.id, credit: 150 }, { account_id: exp, debit: 150 }],
  });
  db = reconcileLedgerItems(cRest.db, [
    itemSelection(cRest.db, dNew.id, advAcc.id),
    itemSelection(cRest.db, cRest.id, advAcc.id),
  ], { date: '2026-01-20' });

  const finalOld = reconciledJournalItems(db, read(db, 'account.move', dOld.id)).find((l) => l.account_id === advAcc.id);
  const finalNew = reconciledJournalItems(db, read(db, 'account.move', dNew.id)).find((l) => l.account_id === advAcc.id);
  const finalC1 = reconciledJournalItems(db, read(db, 'account.move', cMid.id)).find((l) => l.account_id === advAcc.id);
  const finalC2 = reconciledJournalItems(db, read(db, 'account.move', cRest.id)).find((l) => l.account_id === advAcc.id);
  assert.ok(finalOld.matching_number);
  assert.equal(finalOld.matching_number, finalNew.matching_number);
  assert.equal(finalOld.matching_number, finalC1.matching_number);
  assert.equal(finalOld.matching_number, finalC2.matching_number);

  // Unreconciling cRest leaves cRest open (-150), newLine open (150), without reversing entries
  const moveCountBefore = db.records['account.move'].length;
  db = unreconcileLedgerItems(db, [itemSelection(db, cRest.id, advAcc.id)], { date: '2026-01-21' });
  assert.equal(db.records['account.move'].length, moveCountBefore);
  assert.equal(reconciledJournalItems(db, read(db, 'account.move', dNew.id)).find((l) => l.account_id === advAcc.id).amount_residual, 150);
  assert.equal(reconciledJournalItems(db, read(db, 'account.move', cRest.id)).find((l) => l.account_id === advAcc.id).amount_residual, -150);
});

test('PKG-08(d): Unreconcile removes GL matchings and write-off matchings without reversing entries and restores invoice residuals', async () => {
  const { reconcileLedgerItems, unreconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 Unrec Partner' });
  const inv = makePostedInvoice(partner.db, { partnerId: partner.id, price: 1000, date: '2026-03-01' });
  const ar = arAccount(inv.db, 1);
  const exp = accountId(inv.db, '600000', 1);
  const misc = miscJournal(inv.db, 1);
  const part = postEntry(inv.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-04', ref: 'MISC 600',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 600 }, { account_id: exp, debit: 600 }],
  });
  db = reconcileLedgerItems(part.db, [itemSelection(part.db, inv.id, ar), itemSelection(part.db, part.id, ar)], {
    date: '2026-03-05',
    writeoff: { accountId: exp, journalId: misc.id, date: '2026-03-05', label: 'Write-off 400' },
  });
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);
  const countBeforeUnrec = db.records['account.move'].length;

  const afterUnrec = unreconcileLedgerItems(db, [itemSelection(db, inv.id, ar)], { date: '2026-03-06' });
  const synced = applyDiff(db, diffDb(db, afterUnrec), { isAdmin: true });

  assert.equal(synced.records['account.move'].length, countBeforeUnrec, 'Unreconcile must not post reversing entries');
  assert.equal(read(synced, 'account.move', inv.id).amount_residual, 1000);
  assert.equal(read(synced, 'account.move', inv.id).payment_state, 'not_paid');
  const invLine = reconciledJournalItems(synced, read(synced, 'account.move', inv.id)).find((l) => l.account_id === ar);
  const partLine = reconciledJournalItems(synced, read(synced, 'account.move', part.id)).find((l) => l.account_id === ar);
  assert.equal(invLine.reconciled, false);
  assert.equal(invLine.amount_residual, 1000);
  assert.equal(partLine.reconciled, false);
  assert.equal(partLine.amount_residual, -600);
  assert.equal(invLine.matching_number ?? null, null);
});

test('PKG-08(e): two-pane bank reconciliation widget shows statement lines, switches tabs, validates candidates/payments/manual and removes reconciled line', async () => {
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { initStore, commit, getDb } = await import('./store.js');
  const { Dashboard } = await import('./views/Dashboard.jsx');
  const { BankReconcile } = await import('./views/BankReconcile.jsx');
  const { menusFor } = await import('./models/index.js');
  await initStore();

  // Check menu & Dashboard wiring
  const accMenus = menusFor('accounting');
  const closing = accMenus.find((m) => m.label === 'Accounting').children.find((m) => m.label === 'Closing');
  assert.equal(closing.children.find((m) => m.key === 'reconcile').type, 'bankReconcile');

  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.type === 'bank' && j.code === 'BNK1');
  const susp = suspenseAccount(db, 1);
  const exp = accountId(db, '600000', 1);
  db = write(db, 'account.journal', bank.id, {
    suspense_account_id: susp,
    outstanding_receipts_account_id: accountId(db, '101402', 1),
    outstanding_payments_account_id: accountId(db, '101403', 1),
  });
  const partner = create(db, 'res.partner', { name: 'Bank Widget Partner' });
  const partner2 = create(partner.db, 'res.partner', { name: 'Bank Widget Payment Partner' });
  const inv = makePostedInvoice(partner2.db, { partnerId: partner.id, price: 750, date: '2026-03-01' });
  const pmt = create(inv.db, 'account.payment', {
    partner_id: partner2.id, company_id: 1, journal_id: bank.id, amount: 225, date: '2026-03-02', payment_type: 'inbound', partner_type: 'customer',
  });
  db = postPayment(pmt.db, read(pmt.db, 'account.payment', pmt.id));
  const st1 = create(db, 'account.bank.statement.line', {
    journal_id: bank.id, company_id: 1, date: '2026-03-03', amount: 750, payment_ref: 'STMT-CANDIDATE-750', partner_id: partner.id,
  });
  const st2 = create(st1.db, 'account.bank.statement.line', {
    journal_id: bank.id, company_id: 1, date: '2026-03-04', amount: 225, payment_ref: 'STMT-PAYMENT-225',
  });
  const st3 = create(st2.db, 'account.bank.statement.line', {
    journal_id: bank.id, company_id: 1, date: '2026-03-05', amount: -45, payment_ref: 'STMT-FEE-45',
  });
  db = st3.db;

  await commit(db);
  const dashHtml = renderToStaticMarkup(React.createElement(Dashboard));
  assert.match(dashHtml, new RegExp(`href="#/accounting/reconcile\\?journal=${bank.id}"`));

  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  try {
    await React.act(async () => root.render(React.createElement(BankReconcile, { leaf: { key: 'reconcile', type: 'bankReconcile' } })));
    assert.ok(host.textContent.includes('STMT-CANDIDATE-750'));
    assert.ok(host.textContent.includes('STMT-PAYMENT-225'));
    assert.ok(host.textContent.includes('STMT-FEE-45'));

    // Select st1 on left pane -> shows counterpart candidate (inv of 750)
    const st1Btn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('STMT-CANDIDATE-750'));
    assert.ok(st1Btn);
    await React.act(async () => props(st1Btn).onClick());
    const invName = read(getDb(), 'account.move', inv.id).name;
    assert.ok(host.textContent.includes(invName));
    const candRow = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(invName));
    await React.act(async () => props(candRow).onClick());
    const validateBtn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Validate');
    await React.act(async () => props(validateBtn).onClick());
    const alert1 = find(host, (n) => props(n)?.role === 'alert');
    assert.equal(alert1?.textContent ?? '', '');

    assert.equal(read(getDb(), 'account.bank.statement.line', st1.id).state, 'reconciled');
    assert.equal(read(getDb(), 'account.move', inv.id).amount_residual, 0);
    assert.ok(!host.textContent.includes('STMT-CANDIDATE-750'), 'reconciled line is removed from left pane');

    // Select st2 -> Outstanding Payments tab -> validate pmt (225)
    const st2Btn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('STMT-PAYMENT-225'));
    await React.act(async () => props(st2Btn).onClick());
    const payTab = find(host, (n) => props(n)?.role === 'tab' && n.textContent.includes('Outstanding Payments'));
    await React.act(async () => props(payTab).onClick());
    const pmtName = read(getDb(), 'account.payment', pmt.id).name;
    const pmtRow = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(pmtName));
    await React.act(async () => props(pmtRow).onClick());
    await React.act(async () => props(find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Validate')).onClick());
    assert.equal(find(host, (n) => props(n)?.role === 'alert')?.textContent ?? '', '');
    assert.equal(read(getDb(), 'account.bank.statement.line', st2.id).state, 'reconciled');
    assert.ok(!host.textContent.includes('STMT-PAYMENT-225'));

    // Select st3 -> Manual Operation tab -> pick expense account and validate
    const st3Btn = find(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes('STMT-FEE-45'));
    await React.act(async () => props(st3Btn).onClick());
    const manualTab = find(host, (n) => props(n)?.role === 'tab' && n.textContent.includes('Manual Operation'));
    await React.act(async () => props(manualTab).onClick());
    const accSelect = find(host, (n) => n.tagName === 'SELECT' && props(n)?.['aria-label'] === 'Counterpart Account');
    await React.act(async () => props(accSelect).onChange({ target: { value: String(exp) } }));
    await React.act(async () => props(find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Validate')).onClick());
    assert.equal(read(getDb(), 'account.bank.statement.line', st3.id).state, 'reconciled');
    assert.ok(!host.textContent.includes('STMT-FEE-45'));
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('PKG-08(f): vendor bill payable reconciliation, direct write-off, lock-date rejection, and Arabic translations', async () => {
  const { reconcileLedgerItems, unreconcileLedgerItems } = await import('./models/glReconcile.js');

  let db = seed();
  const vendor = create(db, 'res.partner', { name: 'PKG08 Vendor' });
  const bill = makePostedInvoice(vendor.db, { partnerId: vendor.id, moveType: 'in_invoice', price: 1000, date: '2026-03-01' });
  const ap = apAccount(bill.db, 1);
  const exp = accountId(bill.db, '600000', 1);
  const disc = accountId(bill.db, '400000', 1);
  const misc = miscJournal(bill.db, 1);
  const debitMisc = postEntry(bill.db, {
    journal: misc.code,
    journal_id: misc.id,
    company: 1,
    date: '2026-03-02',
    ref: 'Vendor debit adjustment',
    lines: [{ account_id: ap, partner_id: vendor.id, debit: 1000 }, { account_id: exp, credit: 1000 }],
  });
  db = reconcileLedgerItems(debitMisc.db, [itemSelection(debitMisc.db, bill.id, ap), itemSelection(debitMisc.db, debitMisc.id, ap)], { date: '2026-03-02' });
  assert.equal(read(db, 'account.move', bill.id).amount_residual, 0);
  assert.equal(read(db, 'account.move', bill.id).payment_state, 'paid');

  // Direct single-step 1000 bill vs 600 debit with 400 write-off
  const bill2 = makePostedInvoice(db, { partnerId: vendor.id, moveType: 'in_invoice', price: 1000, date: '2026-03-05' });
  const debit600 = postEntry(bill2.db, {
    journal: misc.code,
    journal_id: misc.id,
    company: 1,
    date: '2026-03-06',
    ref: 'Partial debit 600',
    lines: [{ account_id: ap, partner_id: vendor.id, debit: 600 }, { account_id: exp, credit: 600 }],
  });
  db = reconcileLedgerItems(debit600.db, [itemSelection(debit600.db, bill2.id, ap), itemSelection(debit600.db, debit600.id, ap)], {
    date: '2026-03-06',
    writeoff: { journalId: misc.id, accountId: disc, date: '2026-03-06', label: 'Supplier rebate 400' },
  });
  assert.equal(read(db, 'account.move', bill2.id).amount_residual, 0);
  assert.equal(read(db, 'account.move', bill2.id).payment_state, 'paid');

  // Lock-date guard prevents reconciling or unreconciling on or before lock_date
  db = write(db, 'res.company', 1, { lock_date: '2026-03-10' });
  const beforeLock = JSON.stringify(db);
  assert.throws(() => unreconcileLedgerItems(db, [itemSelection(db, bill.id, ap)], { date: '2026-03-05' }), /locked/i);
  assert.equal(JSON.stringify(db), beforeLock);

  // Arabic translations are present and distinct from English
  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {} };
  try {
    const { t } = await import(`./i18n.js?ar-glrec=${Date.now()}`);
    for (const phrase of [
      'Reconcile with write-off',
      'Bank Reconciliation',
      'Unreconciled Transactions',
      'Counterpart Candidates',
      'Manual Operation',
      'Selected journal items must belong to the same company',
      'Selected receivable or payable items must have the same partner',
      'The selected item has no active reconciliation to remove',
      'General-ledger reconciliation requires items in the company currency; reconcile foreign-currency documents from their payment or credit-note workflow',
      'An explicit reconciliation amount is only supported when reconciling one debit item with one credit item',
      'This removes the matching: payments stay posted with their credit available again, and GL entries (including write-offs created by Reconcile with write-off) stay posted with their open balance restored. Standalone Write Off entries and direct bank matches are reversed on the selected date.',
    ]) {
      const translated = t(phrase);
      assert.ok(translated && translated !== phrase, `Missing distinct Arabic translation for "${phrase}"`);
    }
  } finally {
    globalThis.localStorage = prevStorage;
  }
});

test('PKG-08(A): account.partial.reconcile is the single link store, company-scoped, PROTECTED/accounting-owned, and move.gl_matchings is removed', async () => {
  const { reconcileLedgerItems } = await import('./models/glReconcile.js');
  const { models, menuModelsForApps, writableModelsForApps } = await import('./models/index.js');

  assert.ok(models['account.partial.reconcile'], 'account.partial.reconcile model must be registered');
  assert.ok(models['account.partial.reconcile'].fields.company_id, 'account.partial.reconcile must be company-scoped');
  assert.equal('gl_matchings' in models['account.move'].fields, false, 'account.move.gl_matchings field must be removed');
  assert.equal('gl_reconcile' in models['account.move'].fields.payments.fields, false, 'gl_reconcile flag must be removed');
  assert.equal(models['account.move'].fields.payments.fields.partial_reconcile_id?.relation, 'account.partial.reconcile');
  assert.equal(menuModelsForApps(['accounting']).has('account.partial.reconcile'), false, 'account.partial.reconcile must have no menu entry');
  assert.equal(writableModelsForApps(['accounting']).has('account.partial.reconcile'), true, 'accounting owns account.partial.reconcile');
  assert.equal(writableModelsForApps(['sales']).has('account.partial.reconcile'), false, 'non-accounting apps cannot write account.partial.reconcile');
  assert.equal(writableModelsForApps(['todo']).has('account.partial.reconcile'), false, 'todo cannot write account.partial.reconcile');

  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 SingleStore Partner' });
  const inv = makePostedInvoice(partner.db, { partnerId: partner.id, price: 500, date: '2026-03-01' });
  const ar = arAccount(inv.db, 1);
  const rev = accountId(inv.db, '400000', 1);
  const misc = miscJournal(inv.db, 1);
  const credit = postEntry(inv.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-02', ref: 'MISC 500',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 500 }, { account_id: rev, debit: 500 }],
  });
  db = reconcileLedgerItems(credit.db, [itemSelection(credit.db, inv.id, ar), itemSelection(credit.db, credit.id, ar)], { date: '2026-03-02' });
  const partials = db.records['account.partial.reconcile'] ?? [];
  assert.equal(partials.length, 1);
  assert.equal(partials[0].amount, 500);
  assert.equal(read(db, 'account.move', inv.id).gl_matchings, undefined);
  assert.equal(read(db, 'account.move', credit.id).gl_matchings, undefined);
  const payRow = read(db, 'account.move', inv.id).payments[0];
  assert.equal(payRow.partial_reconcile_id, partials[0].id);
  assert.equal(payRow.gl_reconcile, undefined);
});

test('PKG-08(B): server-side applyDiff rejects forged account.partial.reconcile links and forged move.payments unapply/GL rows', async () => {
  const { reconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 Guard Partner' });
  const ar = arAccount(partner.db, 1);
  const rev = accountId(partner.db, '400000', 1);
  const exp = accountId(partner.db, '600000', 1);
  const misc = miscJournal(partner.db, 1);

  const inv = makePostedInvoice(partner.db, { partnerId: partner.id, price: 400, date: '2026-03-01' });
  const credit = postEntry(inv.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-02', ref: 'Credit 400',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 400 }, { account_id: rev, debit: 400 }],
  });
  const draft = create(credit.db, 'account.move', {
    move_type: 'entry', journal_id: misc.id, company_id: 1, date: '2026-03-02',
    line_ids: [{ account_id: ar, partner_id: partner.id, debit: 100 }, { account_id: exp, credit: 100 }],
  });
  const co2 = createCompany(draft.db, { name: 'Guard Co2', currency_id: draft.db.settings?.currency_id });
  const co2Journal = create(co2.db, 'account.journal', { name: 'Co2 Misc', code: 'M2', type: 'general', company_id: co2.id });
  const co2Ar = arAccount(co2Journal.db, co2.id);
  const co2Exp = accountId(co2Journal.db, '600000', co2.id);
  const co2Move = postEntry(co2Journal.db, {
    journal: 'M2', journal_id: co2Journal.id, company: co2.id, date: '2026-03-02', ref: 'Co2 Entry',
    lines: [{ account_id: co2Ar, partner_id: partner.id, debit: 100 }, { account_id: co2Exp, credit: 100 }],
  });
  db = co2Move.db;

  const baseLink = {
    id: 9001, debit_move_id: inv.id, debit_line_index: 0,
    credit_move_id: credit.id, credit_line_index: 0,
    account_id: ar, company_id: 1, amount: 100, date: '2026-03-02', active: true, reversed: false,
  };
  const invLineIdx = read(db, 'account.move', inv.id).line_ids.findIndex((l) => l.account_id === ar);
  baseLink.debit_line_index = invLineIdx;

  // 1. Draft move rejected
  assert.throws(() => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...baseLink, debit_move_id: draft.id, debit_line_index: 0 }] } }, { isAdmin: true }), /posted/i);
  // 2. Wrong company rejected
  assert.throws(() => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...baseLink, debit_move_id: co2Move.id, debit_line_index: 0 }] } }, { isAdmin: true }), /company/i);
  // 3. Missing line index rejected
  assert.throws(() => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...baseLink, debit_line_index: 99 }] } }, { isAdmin: true }), /line index/i);
  // 4. Wrong sign direction (credit on debit_move_id, debit on credit_move_id) rejected
  assert.throws(() => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...baseLink, debit_move_id: credit.id, debit_line_index: 0, credit_move_id: inv.id, credit_line_index: invLineIdx }] } }, { isAdmin: true }), /debit balance.*credit balance/i);
  // 5. Non-reconcilable account rejected
  assert.throws(() => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...baseLink, debit_line_index: 1, credit_line_index: 1, account_id: exp }] } }, { isAdmin: true }), /reconcilable|match the link account/i);
  // 6. Zero/negative amount rejected
  assert.throws(() => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...baseLink, amount: 0 }] } }, { isAdmin: true }), /greater than zero/i);
  // 7. Exceeding line balance rejected
  assert.throws(() => applyDiff(db, { upserts: { 'account.partial.reconcile': [{ ...baseLink, amount: 500 }] } }, { isAdmin: true }), /exceed/i);

  // Reconcile 400 properly via reconcileLedgerItems, then test mutation, sum-overflow, delete, and forged row unapply
  const linkedDb = reconcileLedgerItems(db, [itemSelection(db, inv.id, ar), itemSelection(db, credit.id, ar)], { date: '2026-03-02' });
  const realLink = linkedDb.records['account.partial.reconcile'][0];
  // 8. Second link exceeding balance rejected
  assert.throws(() => applyDiff(linkedDb, { upserts: { 'account.partial.reconcile': [{ ...realLink, id: realLink.id + 1, amount: 1 }] } }, { isAdmin: true }), /exceed/i);
  // 9. Editing amount/date after creation rejected
  assert.throws(() => applyDiff(linkedDb, { upserts: { 'account.partial.reconcile': [{ ...realLink, amount: 200 }] } }, { isAdmin: true }), /cannot be edited/i);
  // 10. Deleting active link rejected
  assert.throws(() => applyDiff(linkedDb, { deletes: { 'account.partial.reconcile': [realLink.id] } }, { isAdmin: true }), /cannot be deleted/i);
  // 11. Forged unapply on move.payments without reversing the partial link (or using forged gl_reconcile flag) rejected
  const paidInv = read(linkedDb, 'account.move', inv.id);
  const forgedUnapply = {
    ...paidInv,
    amount_paid: 0,
    payments: paidInv.payments.map((p) => ({ ...p, reversed: true, unapplied: true, reversal_date: '2026-03-03', gl_reconcile: true })),
  };
  assert.throws(() => applyDiff(linkedDb, { upserts: { 'account.move': [forgedUnapply] } }, { isAdmin: true }), /Registered payments|outstanding credit/i);
  // 12. Forged new payments row with bogus partial_reconcile_id or mismatched amount rejected
  const openInv = makePostedInvoice(db, { partnerId: partner.id, price: 200, date: '2026-03-01' });
  const partial150 = reconcileLedgerItems(openInv.db, [itemSelection(openInv.db, openInv.id, ar), itemSelection(openInv.db, credit.id, ar)], { date: '2026-03-02', amount: 150 });
  const link150 = partial150.records['account.partial.reconcile'][0];
  const forgedNewRowDb = {
    ...partial150,
    records: {
      ...partial150.records,
      'account.move': partial150.records['account.move'].map((m) => (m.id === openInv.id
        ? { ...m, amount_paid: 200, payments: [...(m.payments ?? []), { date: '2026-03-02', amount: 50, move_id: credit.id, company_amount: 50, partial_reconcile_id: link150.id }] }
        : m)),
    },
  };
  assert.throws(() => applyDiff(partial150, diffDb(partial150, forgedNewRowDb), { isAdmin: true }), /partial reconciliation/i);
});

test('PKG-08(C): Reconcile passes Amount in Invoice Currency via UI and reconcileLedgerItems, delegates payment/credit note, caps 1:1 general, rejects >2 with amount', async () => {
  const { reconcileLedgerItems } = await import('./models/glReconcile.js');
  const { makeEl } = setupDom();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { initStore, commit, getDb } = await import('./store.js');
  const { JournalItems } = await import('./views/JournalItems.jsx');
  await initStore();

  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 Amount Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = accountId(db, '400000', 1);
  const misc = miscJournal(db, 1);
  const bnk = search(db, 'account.journal').find((j) => j.type === 'bank' && (!j.company_id || j.company_id === 1));

  // 1. UI + 2-item invoice + payment delegates with explicit amount:
  // post the payment before the invoice exists so postPayment leaves its credit open for manual UI reconciliation
  const pmtDraft = create(db, 'account.payment', {
    partner_id: partner.id, company_id: 1, payment_type: 'inbound', partner_type: 'customer',
    journal_id: bnk.id, amount: 500, date: '2026-03-02',
  });
  const pmtPostedDb = postPayment(pmtDraft.db, read(pmtDraft.db, 'account.payment', pmtDraft.id));
  const inv1 = makePostedInvoice(pmtPostedDb, { partnerId: partner.id, price: 500, date: '2026-03-01' });
  const uiBase = inv1.db;
  const host = makeEl('div');
  host.ownerDocument = globalThis.document;
  const root = createRoot(host);
  const arName = read(uiBase, 'account.account', ar).name;
  const selectRow = async (moveId) => {
    const row = find(host, (n) => n.tagName === 'TR' && n.textContent.includes(arName) && find(n, (a) => a.tagName === 'A' && props(a)?.href === `#/accounting/entries/${moveId}`));
    assert.ok(row, `Row for move ${moveId} must exist`);
    const cb = find(row, (k) => k.tagName === 'INPUT' && props(k)?.type === 'checkbox');
    await React.act(async () => props(cb).onChange({ target: { checked: true } }));
  };
  try {
    await React.act(async () => {
      await commit(uiBase);
      root.render(React.createElement(JournalItems, { leaf: { reviewMode: 'unreconciled' } }));
    });
    const pmtMoveId = read(uiBase, 'account.payment', pmtDraft.id).move_id;
    await selectRow(inv1.id);
    await selectRow(pmtMoveId);
    await React.act(async () => props(find(host, (n) => n.tagName === 'BUTTON' && n.textContent === 'Reconcile')).onClick());
    const dateInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'date' && !props(n)?.['aria-label']);
    await React.act(async () => props(dateInput).onChange({ target: { value: '2026-03-02' } }));
    const amtInput = find(host, (n) => n.tagName === 'INPUT' && props(n)?.type === 'number');
    await React.act(async () => props(amtInput).onChange({ target: { value: '200' } }));
    await React.act(async () => props(find(host, (n) => n.tagName === 'FORM')).onSubmit({ preventDefault() {} }));
    assert.equal(read(getDb(), 'account.move', inv1.id).amount_residual, 300, 'UI Amount input settled 200 and left 300 open');
    assert.equal(read(getDb(), 'account.payment', pmtDraft.id).unapplied, 300);
    assert.equal((getDb().records['account.partial.reconcile'] ?? []).length, 0, '2-item payment delegation uses payment workflow');
  } finally {
    await React.act(async () => root.unmount());
  }

  // 2. 2-item invoice + credit note delegates with partial amount
  const inv2 = makePostedInvoice(db, { partnerId: partner.id, price: 400, date: '2026-03-01' });
  const standaloneNote = create(inv2.db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_refund', invoice_date: '2026-03-02',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 300, tax: 0 }],
  });
  const postedNoteDb = postMove(standaloneNote.db, standaloneNote.id);
  const partialNoteDb = reconcileLedgerItems(
    postedNoteDb,
    [itemSelection(postedNoteDb, inv2.id, ar), itemSelection(postedNoteDb, standaloneNote.id, ar)],
    { date: '2026-03-02', amount: 120 },
  );
  assert.equal(read(partialNoteDb, 'account.move', inv2.id).amount_residual, 280);
  assert.equal(read(partialNoteDb, 'account.move', standaloneNote.id).amount_residual, 180);
  assert.equal((partialNoteDb.records['account.partial.reconcile'] ?? []).length, 0);

  // 3. General 1 debit + 1 credit supports partial amount and caps at smaller residual
  const inv3 = makePostedInvoice(db, { partnerId: partner.id, price: 1000, date: '2026-03-01' });
  const mCredit600 = postEntry(inv3.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-02', ref: 'MISC 600',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 600 }, { account_id: rev, debit: 600 }],
  });
  const partialGen = reconcileLedgerItems(
    mCredit600.db,
    [itemSelection(mCredit600.db, inv3.id, ar), itemSelection(mCredit600.db, mCredit600.id, ar)],
    { date: '2026-03-02', amount: 250 },
  );
  assert.equal(read(partialGen, 'account.move', inv3.id).amount_residual, 750);
  assert.equal(reconciledJournalItems(partialGen, read(partialGen, 'account.move', mCredit600.id)).find((l) => l.account_id === ar).amount_residual, -350);

  // Capped at smaller residual (remaining 350 vs requested 900)
  const cappedGen = reconcileLedgerItems(
    partialGen,
    [itemSelection(partialGen, inv3.id, ar), itemSelection(partialGen, mCredit600.id, ar)],
    { date: '2026-03-02', amount: 900 },
  );
  assert.equal(read(cappedGen, 'account.move', inv3.id).amount_residual, 400);
  assert.equal(reconciledJournalItems(cappedGen, read(cappedGen, 'account.move', mCredit600.id)).find((l) => l.account_id === ar).reconciled, true);

  // 4. General >2 selection rejects explicit amount with a clear error
  const d1 = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-01', ref: 'D1',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 200 }, { account_id: rev, credit: 200 }],
  });
  const d2 = postEntry(d1.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-02', ref: 'D2',
    lines: [{ account_id: ar, partner_id: partner.id, debit: 200 }, { account_id: rev, credit: 200 }],
  });
  const c1 = postEntry(d2.db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-03', ref: 'C1',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 400 }, { account_id: rev, debit: 400 }],
  });
  assert.throws(
    () => reconcileLedgerItems(c1.db, [itemSelection(c1.db, d1.id, ar), itemSelection(c1.db, d2.id, ar), itemSelection(c1.db, c1.id, ar)], { date: '2026-03-03', amount: 150 }),
    /one debit item with one credit item/i,
  );
});

test('PKG-08(F): general path rejects foreign-currency items cleanly while delegated FX invoice+payment posts exchange difference', async () => {
  const { reconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 FX Partner' });
  db = partner.db;
  const fxCurr = create(db, 'res.currency', {
    name: 'FXE', symbol: '€', rounding: 0.01,
    rate_ids: [{ date: '2026-03-01', rate: 0.5 }, { date: '2026-03-10', rate: 0.8 }],
  });
  db = fxCurr.db;
  const ar = arAccount(db, 1);
  const rev = accountId(db, '400000', 1);
  const misc = miscJournal(db, 1);

  const fcInv = create(db, 'account.move', {
    partner_id: partner.id, company_id: 1, move_type: 'out_invoice', currency_id: fxCurr.id, invoice_date: '2026-03-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  db = postMove(fcInv.db, fcInv.id);
  const companyMisc = postEntry(db, {
    journal: misc.code, journal_id: misc.id, company: 1, date: '2026-03-02', ref: 'USD entry',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 200 }, { account_id: rev, debit: 200 }],
  });
  assert.throws(
    () => reconcileLedgerItems(companyMisc.db, [itemSelection(companyMisc.db, fcInv.id, ar), itemSelection(companyMisc.db, companyMisc.id, ar)], { date: '2026-03-02' }),
    /company currency/i,
  );

  // Different-rate payment on the FC invoice via delegated path still closes with FX difference:
  // post the standalone FX payment before the invoice exists so it keeps its unapplied credit for manual reconciliation
  const fxPartner = create(db, 'res.partner', { name: 'PKG08 FX Delegated Partner' });
  const bnk = search(fxPartner.db, 'account.journal').find((j) => j.type === 'bank' && (!j.company_id || j.company_id === 1));
  const pmtDraft = create(fxPartner.db, 'account.payment', {
    partner_id: fxPartner.id, company_id: 1, payment_type: 'inbound', partner_type: 'customer',
    journal_id: bnk.id, currency_id: fxCurr.id, amount: 100, date: '2026-03-10',
  });
  const pmtOnlyDb = postPayment(pmtDraft.db, read(pmtDraft.db, 'account.payment', pmtDraft.id));
  const fcInv2 = create(pmtOnlyDb, 'account.move', {
    partner_id: fxPartner.id, company_id: 1, move_type: 'out_invoice', currency_id: fxCurr.id, invoice_date: '2026-03-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, tax: 0 }],
  });
  const pmtAndInvDb = postMove(fcInv2.db, fcInv2.id);
  const settled = reconcileLedgerItems(pmtAndInvDb, [itemSelection(pmtAndInvDb, fcInv2.id, ar), itemSelection(pmtAndInvDb, read(pmtAndInvDb, 'account.payment', pmtDraft.id).move_id, ar)], { date: '2026-03-10' });
  assert.equal(read(settled, 'account.move', fcInv2.id).amount_residual, 0);
  assert.ok(read(settled, 'account.move', fcInv2.id).payments[0].payment_fx_move_id, 'FX difference entry must be posted');
});

test('PKG-08(G): matching group numbers stay invariant when unrelated groups are created or unreconciled', async () => {
  const { reconcileLedgerItems, unreconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 Stable Numbers Partner' });
  const ar = arAccount(partner.db, 1);
  const rev = accountId(partner.db, '400000', 1);
  const misc = miscJournal(partner.db, 1);

  const pair = (d, date) => {
    const debit = postEntry(d, {
      journal: misc.code, journal_id: misc.id, company: 1, date, ref: `D-${date}`,
      lines: [{ account_id: ar, partner_id: partner.id, debit: 100 }, { account_id: rev, credit: 100 }],
    });
    const credit = postEntry(debit.db, {
      journal: misc.code, journal_id: misc.id, company: 1, date, ref: `C-${date}`,
      lines: [{ account_id: ar, partner_id: partner.id, credit: 100 }, { account_id: rev, debit: 100 }],
    });
    return { db: credit.db, dId: debit.id, cId: credit.id };
  };

  const p1 = pair(partner.db, '2026-03-05');
  const p2 = pair(p1.db, '2026-03-10');
  db = reconcileLedgerItems(p2.db, [itemSelection(p2.db, p1.dId, ar), itemSelection(p2.db, p1.cId, ar)], { date: '2026-03-05' });
  db = reconcileLedgerItems(db, [itemSelection(db, p2.dId, ar), itemSelection(db, p2.cId, ar)], { date: '2026-03-10' });

  const g2Before = reconciledJournalItems(db, read(db, 'account.move', p2.dId)).find((l) => l.account_id === ar).matching_number;
  assert.ok(g2Before);

  // Create an earlier-dated unrelated group p0 -> p2 keeps its exact matching_number
  const p0 = pair(db, '2026-02-01');
  db = reconcileLedgerItems(p0.db, [itemSelection(p0.db, p0.dId, ar), itemSelection(p0.db, p0.cId, ar)], { date: '2026-02-01' });
  assert.equal(reconciledJournalItems(db, read(db, 'account.move', p2.dId)).find((l) => l.account_id === ar).matching_number, g2Before);

  // Unreconcile unrelated group p1 -> p2 still keeps its exact matching_number
  db = unreconcileLedgerItems(db, [itemSelection(db, p1.dId, ar)], { date: '2026-03-06' });
  assert.equal(reconciledJournalItems(db, read(db, 'account.move', p2.dId)).find((l) => l.account_id === ar).matching_number, g2Before);
});

test('PKG-08(H): bookToAccount supports full, partial + second close, foreign-currency partial, and rejects invalid amounts', async () => {
  const { bookToAccount } = await import('./models/bank.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 Bank Partial Partner' });
  db = partner.db;
  const bnk = search(db, 'account.journal').find((j) => j.type === 'bank' && (!j.company_id || j.company_id === 1));
  const susp = suspenseAccount(db, 1);
  db = write(db, 'account.journal', bnk.id, { suspense_account_id: susp });
  const exp = accountId(db, '600000', 1);
  const rev = accountId(db, '400000', 1);

  const st1 = create(db, 'account.bank.statement.line', {
    journal_id: bnk.id, company_id: 1, date: '2026-03-01', payment_ref: 'FULL-100', amount: 100, partner_id: partner.id,
  });
  const st2 = create(st1.db, 'account.bank.statement.line', {
    journal_id: bnk.id, company_id: 1, date: '2026-03-02', payment_ref: 'PART-200', amount: -200, partner_id: partner.id,
  });
  db = st2.db;
  const stFull = read(db, 'account.bank.statement.line', st1.id);
  const stPart = read(db, 'account.bank.statement.line', st2.id);

  // 1. Full amount matches legacy behavior
  db = bookToAccount(db, { ...stFull, counterpart_account_id: rev }).db;
  assert.equal(read(db, 'account.bank.statement.line', stFull.id).state, 'reconciled');
  assert.equal(read(db, 'account.bank.statement.line', stFull.id).open_amount, 0);

  // 2. Reject 0, negative, and above open_amount
  assert.throws(() => bookToAccount(db, { ...stPart, counterpart_account_id: exp }, { amount: 0 }), /positive and within/i);
  assert.throws(() => bookToAccount(db, { ...stPart, counterpart_account_id: exp }, { amount: -10 }), /positive and within/i);
  assert.throws(() => bookToAccount(db, { ...stPart, counterpart_account_id: exp }, { amount: 201 }), /positive and within/i);

  // 3. Partial amount leaves to_check with open_amount=120; second manual close finishes it
  db = bookToAccount(db, { ...stPart, counterpart_account_id: exp }, { amount: 80, label: 'First slice' }).db;
  const afterFirst = read(db, 'account.bank.statement.line', stPart.id);
  assert.equal(afterFirst.state, 'to_check');
  assert.equal(afterFirst.open_amount, 120);
  assert.ok(afterFirst.bank_move_id);

  db = bookToAccount(db, { ...afterFirst, counterpart_account_id: rev }, { amount: 120, label: 'Second slice' }).db;
  const afterSecond = read(db, 'account.bank.statement.line', stPart.id);
  assert.equal(afterSecond.state, 'reconciled');
  assert.equal(afterSecond.open_amount, 0);
  assert.equal(afterSecond.allocations.length, 2);

  // 4. Foreign-currency bank journal partial (FXB 100 @ rate 0.5 = 200 USD)
  const fxBankCurr = create(db, 'res.currency', { name: 'FXB', symbol: '€', rounding: 0.01, rate_ids: [{ date: '2026-03-01', rate: 0.5 }] });
  const fxBankAcc = create(fxBankCurr.db, 'account.account', { code: '101509', name: 'FXB Bank Acc', account_type: 'asset_cash', company_id: 1 });
  const fxBankJournal = create(fxBankAcc.db, 'account.journal', { name: 'FXB Bank', code: 'BNKE', type: 'bank', company_id: 1, currency_id: fxBankCurr.id, default_account_id: fxBankAcc.id, suspense_account_id: susp });
  const fxSt = create(fxBankJournal.db, 'account.bank.statement.line', {
    journal_id: fxBankJournal.id, company_id: 1, date: '2026-03-01', payment_ref: 'FX-100', amount: 100, partner_id: partner.id,
  });
  let fxDb = fxSt.db;
  const fxLine = read(fxDb, 'account.bank.statement.line', fxSt.id);
  fxDb = bookToAccount(fxDb, { ...fxLine, counterpart_account_id: rev }, { amount: 80 }).db;
  const fxAfter1 = read(fxDb, 'account.bank.statement.line', fxLine.id);
  assert.equal(fxAfter1.state, 'to_check');
  assert.equal(fxAfter1.open_amount, 120);
  const fxMove1 = read(fxDb, 'account.move', fxAfter1.move_id);
  assert.equal(Math.abs(fxMove1.line_ids.find((l) => l.account_id === rev).amount_currency), 40);

  fxDb = bookToAccount(fxDb, { ...fxAfter1, counterpart_account_id: rev }, { amount: 120 }).db;
  const fxAfter2 = read(fxDb, 'account.bank.statement.line', fxLine.id);
  assert.equal(fxAfter2.state, 'reconciled');
  assert.equal(fxAfter2.open_amount, 0);
  const fxMove2 = read(fxDb, 'account.move', fxAfter2.move_id);
  assert.equal(Math.abs(fxMove2.line_ids.find((l) => l.account_id === rev).amount_currency), 60);
});

test('PKG-08(J): unreconciling Reconcile with write-off keeps the write-off entry posted with open balance restored', async () => {
  const { reconcileLedgerItems, unreconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 Writeoff StayPosted Partner' });
  const inv = makePostedInvoice(partner.db, { partnerId: partner.id, price: 500, date: '2026-03-01' });
  const ar = arAccount(inv.db, 1);
  const exp = accountId(inv.db, '600000', 1);
  const misc = miscJournal(inv.db, 1);
  const beforeIds = new Set(inv.db.records['account.move'].map((m) => m.id));
  db = reconcileLedgerItems(inv.db, [itemSelection(inv.db, inv.id, ar)], {
    date: '2026-03-02',
    writeoff: { journalId: misc.id, accountId: exp, date: '2026-03-02', label: 'Small diff WO' },
  });
  const woMove = db.records['account.move'].find((m) => !beforeIds.has(m.id) && m.ref === 'Small diff WO');
  assert.ok(woMove && woMove.state === 'posted');

  db = unreconcileLedgerItems(db, [itemSelection(db, inv.id, ar)], { date: '2026-03-03' });
  const woAfter = read(db, 'account.move', woMove.id);
  assert.equal(woAfter.state, 'posted', 'Write-off entry created by Reconcile with write-off stays posted');
  const woArItem = reconciledJournalItems(db, woAfter).find((l) => l.account_id === ar);
  assert.equal(woArItem.reconciled, false);
  assert.equal(woArItem.amount_residual, -500);
});

test('PKG-08(L): cash-basis-tax invoice reconciled with manual entry via GL and unreconciled restores exact tax balances', async () => {
  const { reconcileLedgerItems, unreconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 CashBasis Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = accountId(db, '400000', 1);
  const transition = accountId(db, '251100', 1);
  const taxAccount = accountId(db, '251000', 1);
  const misc = miscJournal(db, 1);
  const tax = create(db, 'account.tax', {
    name: 'PKG08 Cash VAT 10%',
    company_id: 1,
    type_tax_use: 'sale',
    amount: 10,
    tax_exigibility: 'on_payment',
    cash_basis_transition_account_id: transition,
    ...defaultTaxRepartitionLines(taxAccount),
  });
  db = tax.db;

  const invCreate = create(db, 'account.move', {
    partner_id: partner.id,
    company_id: 1,
    move_type: 'out_invoice',
    invoice_date: '2026-03-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 100, ...taxSnapshot(read(db, 'account.tax', tax.id)) }],
  });
  db = postMove(invCreate.db, invCreate.id);
  const manual = postEntry(db, {
    journal: misc.code,
    journal_id: misc.id,
    company: 1,
    date: '2026-03-05',
    ref: 'Cash-basis manual receipt',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 110 }, { account_id: rev, debit: 110 }],
  });
  db = manual.db;

  const taxAccRec = read(db, 'account.account', taxAccount);
  const transAccRec = read(db, 'account.account', transition);
  const taxBalBefore = accountBalance(db, taxAccRec);
  const transBalBefore = accountBalance(db, transAccRec);

  const reconciled = reconcileLedgerItems(db, [itemSelection(db, invCreate.id, ar), itemSelection(db, manual.id, ar)], { date: '2026-03-05' });
  const row = read(reconciled, 'account.move', invCreate.id).payments[0];
  assert.ok(row.cash_basis_move_id, 'GL settlement must release cash-basis taxes');
  assert.notEqual(accountBalance(reconciled, taxAccRec), taxBalBefore);
  assert.notEqual(accountBalance(reconciled, transAccRec), transBalBefore);

  const unreconciled = unreconcileLedgerItems(reconciled, [itemSelection(reconciled, invCreate.id, ar)], { date: '2026-03-06' });
  const synced = applyDiff(reconciled, diffDb(reconciled, unreconciled), { isAdmin: false });
  assert.equal(accountBalance(synced, taxAccRec), taxBalBefore);
  assert.equal(accountBalance(synced, transAccRec), transBalBefore);
  assert.equal(read(synced, 'account.move', invCreate.id).amount_residual, 110);
});

test('PKG-08(M): unreconcile removes both ordinary payment and GL matchings on the same invoice line', async () => {
  const { reconcileLedgerItems, unreconcileLedgerItems } = await import('./models/glReconcile.js');
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 Mixed Partner' });
  db = partner.db;
  const ar = arAccount(db, 1);
  const rev = accountId(db, '400000', 1);
  const misc = miscJournal(db, 1);
  const bnk = search(db, 'account.journal').find((j) => j.type === 'bank' && (!j.company_id || j.company_id === 1));

  const pmtDraft = create(db, 'account.payment', {
    partner_id: partner.id,
    company_id: 1,
    payment_type: 'inbound',
    partner_type: 'customer',
    journal_id: bnk.id,
    amount: 400,
    date: '2026-03-02',
  });
  db = postPayment(pmtDraft.db, read(pmtDraft.db, 'account.payment', pmtDraft.id));
  const inv = makePostedInvoice(db, { partnerId: partner.id, price: 1000, date: '2026-03-01' });
  db = applyPaymentCredit(inv.db, pmtDraft.id, inv.id, '2026-03-02');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 600);
  assert.equal(read(db, 'account.payment', pmtDraft.id).unapplied, 0);

  const manual = postEntry(db, {
    journal: misc.code,
    journal_id: misc.id,
    company: 1,
    date: '2026-03-03',
    ref: 'Manual 600',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 600 }, { account_id: rev, debit: 600 }],
  });
  db = reconcileLedgerItems(manual.db, [itemSelection(manual.db, inv.id, ar), itemSelection(manual.db, manual.id, ar)], { date: '2026-03-03' });
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);

  const afterUnrec = unreconcileLedgerItems(db, [itemSelection(db, inv.id, ar)], { date: '2026-03-04' });
  const synced = applyDiff(db, diffDb(db, afterUnrec), { isAdmin: true });
  const pmtMoveId = read(synced, 'account.payment', pmtDraft.id).move_id;
  assert.equal(read(synced, 'account.move', inv.id).amount_residual, 1000);
  assert.equal(read(synced, 'account.payment', pmtDraft.id).unapplied, 400);
  assert.equal(read(synced, 'account.move', pmtMoveId).state, 'posted');
  assert.equal(read(synced, 'account.move', manual.id).state, 'posted');

  assert.throws(
    () => unreconcileLedgerItems(synced, [itemSelection(synced, inv.id, ar)], { date: '2026-03-05' }),
    /no active reconciliation to remove/i,
  );
});

test('PKG-08(O): applyDiff rejects a forged partial link against an invoice already fully paid by ordinary payment', () => {
  let db = seed();
  const partner = create(db, 'res.partner', { name: 'PKG08 Overmatch Partner' });
  const ar = arAccount(partner.db, 1);
  const rev = accountId(partner.db, '400000', 1);
  const misc = miscJournal(partner.db, 1);

  const inv = makePostedInvoice(partner.db, { partnerId: partner.id, price: 500, date: '2026-03-01' });
  db = payMove(inv.db, inv.id, 500, '2026-03-02');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);

  const credit = postEntry(db, {
    journal: misc.code,
    journal_id: misc.id,
    company: 1,
    date: '2026-03-03',
    ref: 'Extra credit 100',
    lines: [{ account_id: ar, partner_id: partner.id, credit: 100 }, { account_id: rev, debit: 100 }],
  });
  db = credit.db;
  const invLineIdx = read(db, 'account.move', inv.id).line_ids.findIndex((l) => l.account_id === ar);

  assert.throws(
    () => applyDiff(db, {
      upserts: {
        'account.partial.reconcile': [{
          id: 9901,
          debit_move_id: inv.id,
          debit_line_index: invLineIdx,
          credit_move_id: credit.id,
          credit_line_index: 0,
          account_id: ar,
          company_id: 1,
          amount: 100,
          date: '2026-03-03',
          active: true,
          reversed: false,
        }],
      },
    }, { isAdmin: true }),
    /exceed/i,
  );
});
