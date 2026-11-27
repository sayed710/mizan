import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { applyCreditNote, journalEntriesView, payMove, resetMove, resequenceListAction, resequenceMoves, resequencePreview, resequenceWizard } from './models/accounting.js';
import { applyPaymentCredit, postPayment, unapplyCreditNoteSettlement, unreconcileJournalItems } from './models/pay.js';
import { accountId, journalId, journalItemIdentity, postEntry } from './models/ledger.js';
import { secureEntries } from './models/hash_chain.js';
import { applyDiff, diffDb } from './sync.js';
import { seed } from './seed.js';

const button = (label) => models['account.move'].form.buttons.find((b) => b.label === label);
const sync = (base, next) => applyDiff(base, diffDb(base, next));

function makeDocument(db, {
  move_type = 'out_invoice',
  partner_id = 3,
  invoice_date = '2026-04-01',
  price_unit = 1000,
  currency_id = null,
  ...extra
} = {}) {
  const { db: drafted, id } = create(db, 'account.move', {
    move_type,
    partner_id,
    invoice_date,
    ...(currency_id ? { currency_id } : {}),
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit, tax: 0 }],
    ...extra,
  });
  const posted = button('Confirm').run(drafted, read(drafted, 'account.move', id)).db;
  return { db: posted, id };
}

test('mv1: reset paid customer invoice to draft keeps totals intact, payment stays posted & outstanding, re-post and re-reconcile work (including sync)', () => {
  const { db: invDb, id } = makeDocument(seed(), { price_unit: 1200, invoice_date: '2026-04-01' });
  const paidDb = payMove(invDb, id, 1200, '2026-04-05');

  const paidInv = read(paidDb, 'account.move', id);
  assert.equal(paidInv.amount_paid, 1200);
  assert.equal(paidInv.payment_state, 'paid');
  assert.equal(button('Reset to Draft').when(paidInv, paidDb), true, 'Reset to Draft button must be enabled on paid invoice');

  const paymentBefore = search(paidDb, 'account.payment').find((p) => p.move_id === paidInv.payments[0].move_id);
  assert.equal(paymentBefore.state, 'posted');
  assert.equal(paymentBefore.unapplied, 0);

  const resetDb = button('Reset to Draft').run(paidDb, paidInv).db;
  // Also diff-verifiable through server sync (diffDb + applyDiff).
  const syncedReset = sync(paidDb, resetDb);

  for (const snapshot of [resetDb, syncedReset]) {
    const draftInv = read(snapshot, 'account.move', id);
    assert.equal(draftInv.state, 'draft');
    assert.equal(draftInv.amount_paid, 0);
    assert.equal(draftInv.amount_total, 1200);
    assert.equal(draftInv.invoice_line_ids.length, 1);
    assert.equal(draftInv.line_ids.length, 0);
    assert.equal(draftInv.is_move_sent, false);
    assert.equal(draftInv.payments[0].reversed, true);
    assert.equal(draftInv.payments[0].unapplied, true);

    const paymentAfter = read(snapshot, 'account.payment', paymentBefore.id);
    assert.equal(paymentAfter.state, 'posted', 'payment must remain posted');
    assert.equal(paymentAfter.unapplied, 1200, 'payment must become outstanding again');
  }

  // Re-post and re-reconcile the freed outstanding payment against the invoice.
  const repostedDb = button('Confirm').run(syncedReset, read(syncedReset, 'account.move', id)).db;
  const rereconciledDb = applyPaymentCredit(repostedDb, paymentBefore.id, id, '2026-04-10');
  const settledInv = read(rereconciledDb, 'account.move', id);
  assert.equal(settledInv.state, 'posted');
  assert.equal(settledInv.amount_paid, 1200);
  assert.equal(settledInv.payment_state, 'paid');
  assert.equal(read(rereconciledDb, 'account.payment', paymentBefore.id).unapplied, 0);
  sync(syncedReset, rereconciledDb);
});

test('mv1: reset partly paid vendor bill & credit note/refund reverses FX entries and restores unapplied / open balances', () => {
  let base = seed();
  const eur = search(base, 'res.currency').find((c) => c.name === 'EUR')
    ?? (() => {
      const created = create(base, 'res.currency', { name: 'EUR', symbol: 'EUR', rounding: 0.01, rate_ids: [] });
      base = created.db;
      return read(base, 'res.currency', created.id);
    })();
  base = write(base, 'res.currency', eur.id, {
    rate_ids: [
      { date: '2026-04-01', rate: 0.5 }, // 1 EUR = 2 company USD
      { date: '2026-04-10', rate: 0.4 }, // 1 EUR = 2.5 company USD -> FX gain/loss on payment
    ],
  });

  // 1) Partly paid foreign-currency customer invoice -> creates an FX difference entry on payment.
  const { db: invDb, id: fxInvId } = makeDocument(base, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-04-01',
    price_unit: 200,
    currency_id: eur.id,
  });
  // Post standalone foreign-currency payment on 2026-04-10 and apply half (100 EUR).
  const payCreate = create(invDb, 'account.payment', {
    payment_type: 'inbound',
    partner_type: 'customer',
    partner_id: 3,
    amount: 100,
    currency_id: eur.id,
    date: '2026-04-10',
    journal_id: journalId(invDb, 'BNK1'),
  });
  const postedPayDb = postPayment(payCreate.db, read(payCreate.db, 'account.payment', payCreate.id));
  const partlyPaidDb = applyPaymentCredit(postedPayDb, payCreate.id, fxInvId, '2026-04-10', 100);

  const partlyInv = read(partlyPaidDb, 'account.move', fxInvId);
  assert.equal(partlyInv.amount_paid, 100);
  assert.equal(partlyInv.payment_state, 'partial');
  const fxMoveId = partlyInv.payments[0].payment_fx_move_id;
  assert.ok(fxMoveId, 'foreign-currency settlement created an FX difference entry');

  const resetFxDb = sync(partlyPaidDb, resetMove(partlyPaidDb, fxInvId).db);
  assert.equal(read(resetFxDb, 'account.move', fxInvId).state, 'draft');
  assert.equal(read(resetFxDb, 'account.move', fxInvId).amount_paid, 0);
  assert.equal(read(resetFxDb, 'account.move', fxInvId).amount_total, 200);
  const fxReversal = search(resetFxDb, 'account.move').find((m) => m.reversed_entry_id === fxMoveId && m.state === 'posted');
  assert.ok(fxReversal, 'exchange difference entry created by reconciliation must be reversed');
  assert.equal(read(resetFxDb, 'account.payment', payCreate.id).unapplied, 250, '100 EUR @ 2.5 USD must be restored as unapplied');

  // Re-post and re-reconcile the foreign-currency payment cleanly.
  const repostedFxDb = button('Confirm').run(resetFxDb, read(resetFxDb, 'account.move', fxInvId)).db;
  const reappliedFxDb = applyPaymentCredit(repostedFxDb, payCreate.id, fxInvId, '2026-04-12', 100);
  assert.equal(read(reappliedFxDb, 'account.move', fxInvId).amount_paid, 100);
  sync(resetFxDb, reappliedFxDb);

  // 2) Partly paid vendor bill & standalone credit note settlement (including FX between invoice & note).
  const { db: billDb, id: billId } = makeDocument(base, {
    move_type: 'in_invoice',
    partner_id: 4,
    invoice_date: '2026-04-01',
    price_unit: 500,
  });
  const paidBillDb = payMove(billDb, billId, 200, '2026-04-03');
  assert.equal(read(paidBillDb, 'account.move', billId).payment_state, 'partial');
  const resetBillDb = sync(paidBillDb, resetMove(paidBillDb, billId).db);
  assert.equal(read(resetBillDb, 'account.move', billId).state, 'draft');
  assert.equal(read(resetBillDb, 'account.move', billId).amount_paid, 0);
  assert.equal(read(resetBillDb, 'account.move', billId).amount_total, 500);

  // 3) Paid credit note (out_refund) + invoice cross-settlement -> resetting the invoice unlinks credit note & reverses FX.
  const { db: inv2Db, id: inv2Id } = makeDocument(base, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-04-01',
    price_unit: 100,
    currency_id: eur.id,
  });
  const { db: cnDb, id: cnId } = makeDocument(inv2Db, {
    move_type: 'out_refund',
    partner_id: 3,
    invoice_date: '2026-04-10',
    price_unit: 100,
    currency_id: eur.id,
  });
  const settledCnDb = applyCreditNote(cnDb, cnId, inv2Id, '2026-04-10', 100);
  const cnFx = search(settledCnDb, 'account.move').find((m) => m.fx_payment_move_id === cnId && m.fx_invoice_id === inv2Id);
  assert.ok(cnFx, 'credit note settlement on different rate creates FX entry');

  const resetInv2Db = sync(settledCnDb, resetMove(settledCnDb, inv2Id).db);
  assert.equal(read(resetInv2Db, 'account.move', inv2Id).state, 'draft');
  assert.equal(read(resetInv2Db, 'account.move', cnId).amount_paid, 0, 'credit note becomes open again');
  assert.ok(search(resetInv2Db, 'account.move').some((m) => m.reversed_entry_id === cnFx.id && m.state === 'posted'), 'credit note FX entry reversed');

  // Re-post invoice and re-apply credit note; also verify refund itself can reset to draft when settled by a refund payment.
  const reInv2Db = button('Confirm').run(resetInv2Db, read(resetInv2Db, 'account.move', inv2Id)).db;
  const resettledCnDb = applyCreditNote(reInv2Db, cnId, inv2Id, '2026-04-12', 100);
  assert.equal(read(resettledCnDb, 'account.move', inv2Id).payment_state, 'paid');

  const { db: refDb, id: refId } = makeDocument(base, { move_type: 'out_refund', partner_id: 3, invoice_date: '2026-04-02', price_unit: 150 });
  const paidRefDb = payMove(refDb, refId, 150, '2026-04-04');
  const resetRefDb = sync(paidRefDb, resetMove(paidRefDb, refId).db);
  assert.equal(read(resetRefDb, 'account.move', refId).state, 'draft');
  assert.equal(read(resetRefDb, 'account.move', refId).amount_paid, 0);
});

test('mv1: reset to draft refuses lock dates, secured entries, and forged diffs that omit unreconciling', () => {
  const { db, id } = makeDocument(seed(), { invoice_date: '2026-04-05', price_unit: 400 });
  const paidDb = payMove(db, id, 400, '2026-04-06');

  // Lock date refusal (UI button, resetMove, and forged diffDb+applyDiff)
  const lockedDb = write(paidDb, 'res.company', 1, { lock_date: '2026-04-10' });
  assert.equal(button('Reset to Draft').when(read(lockedDb, 'account.move', id), lockedDb), false);
  assert.throws(() => resetMove(lockedDb, id), /locked/);
  const forgedLockDraft = {
    ...lockedDb,
    records: {
      ...lockedDb.records,
      'account.move': lockedDb.records['account.move'].map((m) => (m.id === id ? { ...m, state: 'draft', line_ids: [], amount_paid: 0 } : m)),
    },
  };
  assert.throws(() => sync(lockedDb, forgedLockDraft), /locked/);

  // Secured (inalterable_hash) entry refusal (use a dedicated sale journal so seed moves do not block securing)
  const secJournal = create(paidDb, 'account.journal', {
    name: 'Secured Sales',
    code: 'SSEC',
    type: 'sale',
    default_account_id: accountId(paidDb, '400000'),
    invoice_sequence_prefix: 'SSEC/',
    invoice_sequence_next_number: 1,
    company_id: 1,
    restrict_mode_hash_table: true,
  });
  const { db: secInvDb, id: secInvId } = makeDocument(secJournal.db, { invoice_date: '2026-04-05', price_unit: 400, journal_id: secJournal.id });
  const secPaidDb = payMove(secInvDb, secInvId, 400, '2026-04-06');
  const securedDb = secureEntries(secPaidDb, { companyId: 1, hashDate: '2026-04-30' });
  const securedMove = read(securedDb, 'account.move', secInvId);
  assert.ok(securedMove.inalterable_hash, 'move is secured');
  assert.equal(button('Reset to Draft').when(securedMove, securedDb), false);
  assert.throws(() => resetMove(securedDb, secInvId), /Secured entries/);
  const forgedHashDraft = {
    ...securedDb,
    records: {
      ...securedDb.records,
      'account.move': securedDb.records['account.move'].map((m) => (m.id === secInvId ? { ...m, state: 'draft', line_ids: [] } : m)),
    },
  };
  assert.throws(() => sync(securedDb, forgedHashDraft), /Secured entries/);

  // Direct write and forged diff resetting state -> draft on paid invoice WITHOUT unreconciling its payment refuse
  assert.throws(() => write(paidDb, 'account.move', id, { state: 'draft', line_ids: [] }), /unreconciled|Paid/);
  const forgedUnreconciled = {
    ...paidDb,
    records: {
      ...paidDb.records,
      'account.move': paidDb.records['account.move'].map((m) => (m.id === id ? { ...m, state: 'draft', line_ids: [] } : m)),
    },
  };
  assert.throws(() => sync(paidDb, forgedUnreconciled), /unreconciled|Paid/);
  const forgedWithoutPaymentCredit = {
    ...paidDb,
    records: {
      ...paidDb.records,
      'account.move': paidDb.records['account.move'].map((m) => (m.id === id
        ? { ...m, state: 'draft', line_ids: [], amount_paid: 0, payments: m.payments.map((p) => ({ ...p, reversed: true, unapplied: true, reversal_date: '2026-04-06' })) }
        : m)),
    },
  };
  assert.throws(() => sync(paidDb, forgedWithoutPaymentCredit), /outstanding credit|reconcil/);
});

test('mv1: resequence list action supports keep & date ordering, live preview, uniqueness, mixed-journal, secured & lock refusals', () => {
  let db = seed();
  const jMisc = search(db, 'account.journal').find((j) => j.code === 'MISC' && (j.company_id ?? 1) === 1);
  const jOther = create(db, 'account.journal', { name: 'Second Misc', code: 'MSC2', type: 'general', company_id: 1 });
  db = jOther.db;
  const ar = accountId(db, '121000');
  const rev = accountId(db, '400000');

  // Registered in journalEntriesView & account.move listActions, without disturbing invoice views
  assert.ok(journalEntriesView.listActions.some((a) => a.label === 'Resequence' && a.requiresSelection));
  assert.ok(models['account.move'].listActions.some((a) => a.label === 'Resequence'));
  assert.equal(resequenceListAction.label, 'Resequence');

  const p1 = postEntry(db, {
    journal: jMisc.code,
    journal_id: jMisc.id,
    company: 1,
    date: '2026-05-20',
    ref: 'Second chronologically',
    lines: [{ account_id: ar, debit: 100 }, { account_id: rev, credit: 100 }],
  });
  const p2 = postEntry(p1.db, {
    journal: jMisc.code,
    journal_id: jMisc.id,
    company: 1,
    date: '2026-05-10',
    ref: 'First chronologically',
    lines: [{ account_id: ar, debit: 200 }, { account_id: rev, credit: 200 }],
  });
  const p3Other = postEntry(p2.db, {
    journal: 'MSC2',
    journal_id: jOther.id,
    company: 1,
    date: '2026-05-15',
    ref: 'Other journal',
    lines: [{ account_id: ar, debit: 50 }, { account_id: rev, credit: 50 }],
  });
  const baseDb = p3Other.db;
  const n1 = read(baseDb, 'account.move', p1.id).name;
  const n2 = read(baseDb, 'account.move', p2.id).name;

  // Mixed-journal refusal (wizard, resequenceMoves, and forged applyDiff)
  assert.throws(() => resequenceWizard(baseDb, [p1.id, p3Other.id]), /same journal/);
  assert.throws(() => resequenceMoves(baseDb, [p1.id, p3Other.id], { first_name: 'MISC/2026/0010' }), /same journal/);
  const forgedMixed = {
    ...baseDb,
    records: {
      ...baseDb.records,
      'account.move': baseDb.records['account.move'].map((m) => (m.id === p1.id ? { ...m, name: 'MISC/2026/0091' } : m.id === p3Other.id ? { ...m, name: 'MSC2/2026/0092' } : m)),
    },
  };
  assert.throws(() => sync(baseDb, forgedMixed), /same journal/);

  // Draft move refusal
  const draftMove = create(baseDb, 'account.move', { move_type: 'entry', journal_id: jMisc.id, date: '2026-05-25', company_id: 1 });
  assert.throws(() => resequenceMoves(draftMove.db, [p1.id, draftMove.id], { first_name: 'MISC/2026/0010' }), /posted/i);

  // Preview + onchange updates
  const wiz = resequenceWizard(baseDb, [p1.id, p2.id]);
  assert.equal(wiz.title, 'Resequence');
  assert.deepEqual(wiz.fields.map((f) => f.name), ['first_date', 'end_date', 'first_name', 'ordering', 'preview_moves']);
  const keepPreview = resequencePreview(baseDb, [p1.id, p2.id], { first_name: 'MISC/2026/0100', ordering: 'keep' });
  assert.deepEqual(keepPreview.map((r) => [r.id, r.current_name, r.new_name]), [
    [p1.id, n1, 'MISC/2026/0100'],
    [p2.id, n2, 'MISC/2026/0101'],
  ]);
  const changedPreview = wiz.onchange({ first_name: n1, ordering: 'date' }, 'ordering', baseDb).preview_moves;
  assert.deepEqual(changedPreview.map((r) => [r.id, r.new_name]), [
    [p2.id, n1],
    [p1.id, n2],
  ]);

  // Apply keep ordering and verify diffDb + applyDiff
  const keepDb = sync(baseDb, resequenceMoves(baseDb, [p1.id, p2.id], { first_name: 'MISC/2026/0100', ordering: 'keep' }).db);
  assert.equal(read(keepDb, 'account.move', p1.id).name, 'MISC/2026/0100');
  assert.equal(read(keepDb, 'account.move', p2.id).name, 'MISC/2026/0101');
  assert.ok(keepDb.messages.some((m) => m.res_id === p1.id && m.body.includes(`Resequenced from ${n1} to MISC/2026/0100`)));

  // Apply date ordering (swapping two names!) and verify diffDb + applyDiff
  const swappedDb = sync(keepDb, resequenceMoves(keepDb, [p1.id, p2.id], { first_name: 'MISC/2026/0100', ordering: 'date' }).db);
  assert.equal(read(swappedDb, 'account.move', p2.id).name, 'MISC/2026/0100', 'earlier date must receive first number');
  assert.equal(read(swappedDb, 'account.move', p1.id).name, 'MISC/2026/0101', 'later date must receive second number');
  // Keep ordering retains the swapped numbers when starting from a new prefix/base
  const keptSwappedDb = sync(swappedDb, resequenceMoves(swappedDb, [p1.id, p2.id], { first_name: 'MISC/2026/0150', ordering: 'keep' }).db);
  assert.equal(read(keptSwappedDb, 'account.move', p2.id).name, 'MISC/2026/0150');
  assert.equal(read(keptSwappedDb, 'account.move', p1.id).name, 'MISC/2026/0151');
  // Put back to 0100 / 0101 by date for downstream assertions
  const normalizedDb = sync(keptSwappedDb, resequenceMoves(keptSwappedDb, [p1.id, p2.id], { first_name: 'MISC/2026/0100', ordering: 'date' }).db);
  assert.equal(read(normalizedDb, 'account.move', p2.id).name, 'MISC/2026/0100');
  assert.equal(read(normalizedDb, 'account.move', p1.id).name, 'MISC/2026/0101');

  // Uniqueness refusal against unselected posted move
  const collideName = read(swappedDb, 'account.move', p1.id).name;
  assert.throws(() => resequenceMoves(swappedDb, [p2.id], { first_name: collideName, ordering: 'keep' }), /unique/);
  const forgedDup = write(swappedDb, 'account.move', p2.id, { name: collideName });
  assert.throws(() => sync(swappedDb, forgedDup), /unique/);

  // Lock date refusal
  const lockedDb = write(swappedDb, 'res.company', 1, { lock_date: '2026-05-15' });
  assert.throws(() => resequenceMoves(lockedDb, [p2.id], { first_name: 'MISC/2026/0200' }), /locked/);
  const forgedLock = {
    ...lockedDb,
    records: {
      ...lockedDb.records,
      'account.move': lockedDb.records['account.move'].map((m) => (m.id === p2.id ? { ...m, name: 'MISC/2026/0200' } : m)),
    },
  };
  assert.throws(() => sync(lockedDb, forgedLock), /locked/);

  // Secured entry & secured chain refusal (dedicated journal so pre-seeded MISC entries do not precede it)
  const secMisc = create(normalizedDb, 'account.journal', { name: 'Secured Misc', code: 'MSEC', type: 'general', company_id: 1, restrict_mode_hash_table: true });
  const sm1 = postEntry(secMisc.db, { journal: 'MSEC', journal_id: secMisc.id, company: 1, date: '2026-05-10', ref: 'S1', lines: [{ account_id: ar, debit: 10 }, { account_id: rev, credit: 10 }] });
  const sm2 = postEntry(sm1.db, { journal: 'MSEC', journal_id: secMisc.id, company: 1, date: '2026-05-20', ref: 'S2', lines: [{ account_id: ar, debit: 20 }, { account_id: rev, credit: 20 }] });
  const securedDb = secureEntries(sm2.db, { companyId: 1, hashDate: '2026-05-15' });
  assert.ok(read(securedDb, 'account.move', sm1.id).inalterable_hash, 'sm1 is secured');
  assert.ok(!read(securedDb, 'account.move', sm2.id).inalterable_hash, 'sm2 after hashDate is unsecured');
  assert.throws(() => resequenceMoves(securedDb, [sm1.id], { first_name: 'MSEC/2026/0200' }), /Secured entries/);
  // Renumbering unsecured sm2 so it would sort before secured sm1 refuses
  assert.throws(() => resequenceMoves(securedDb, [sm2.id], { first_name: 'MSEC/2026/0000' }), /before the secured entries/);
  const forgedBeforeSecured = {
    ...securedDb,
    records: {
      ...securedDb.records,
      'account.move': securedDb.records['account.move'].map((m) => (m.id === sm2.id ? { ...m, name: 'MSEC/2026/0000' } : m)),
    },
  };
  assert.throws(() => sync(securedDb, forgedBeforeSecured), /before the secured entries|Secured entries/);
});

test('mv1: Arabic translations exist for new resequence and reset messages', async () => {
  const prevStorage = globalThis.localStorage;
  const prevLocation = globalThis.location;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem: () => {} };
  globalThis.location = { href: 'http://localhost/', search: '', replace: () => {}, reload: () => {} };
  try {
    const { t } = await import(`./i18n.js?mv1=${Date.now()}`);
    for (const label of [
      'Resequence',
      'First Date',
      'End Date',
      'First New Sequence',
      'Ordering',
      'Keep current order',
      'Reorder by accounting date',
      'Preview Modifications',
      'Current Number',
      'New Number',
      'Paid invoices cannot be reset or cancelled until their settlements are unreconciled',
      'Only entries from the same journal can be resequenced together',
      'Sequence numbers must be unique per posted entry',
      'Secured entries cannot be resequenced',
      'Cannot derive sequence prefix for this period',
      'A posted payment can only reference a non-posted invoice that it previously settled',
    ]) {
      const translated = t(label);
      assert.notEqual(translated, label, `Expected Arabic translation for "${label}"`);
      assert.ok(/[\u0600-\u06FF]/.test(translated), `Expected Arabic script for "${label}", got "${translated}"`);
    }
    const note = t('Resequenced from MISC/2026/0001 to MISC/2026/0010');
    assert.ok(note.includes('MISC/2026/0001') && note.includes('MISC/2026/0010') && /[\u0600-\u06FF]/.test(note));
  } finally {
    globalThis.localStorage = prevStorage;
    globalThis.location = prevLocation;
  }
});

test('mv1: resetting an invoice matched via direct bank payment clears both bank match and invoice settlement', () => {
  const base = seed();
  const bankAcc = accountId(base, '101401');
  const directJournalRes = create(base, 'account.journal', {
    name: 'Direct Bank',
    code: 'DBNK',
    type: 'bank',
    company_id: 1,
    default_account_id: bankAcc,
    outstanding_receipts_account_id: null,
    outstanding_payments_account_id: null,
  });
  const { db: invDb, id: invId } = makeDocument(directJournalRes.db, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-06-01',
    price_unit: 150,
  });
  let db = payMove(invDb, invId, 150, '2026-06-03', { journalId: directJournalRes.id });
  const payment = search(db, 'account.payment').find((p) => p.invoice_id === invId);
  assert.ok(payment?.move_id);
  assert.equal(payment.outstanding_account_id ?? null, null);

  const lineId = Math.max(0, ...(db.records['account.bank.statement.line'] ?? []).map((l) => l.id)) + 1;
  const directLine = {
    id: lineId,
    journal_id: directJournalRes.id,
    company_id: 1,
    date: '2026-06-03',
    payment_ref: 'Direct invoice payment match',
    amount: 150,
    state: 'reconciled',
    move_id: invId,
    payment_id: payment.id,
    payment_ids: [payment.id],
    bank_move_id: payment.move_id,
    open_amount: 0,
    allocations: [{ invoice_id: invId, payment_move_id: payment.move_id, amount: 150 }],
  };
  db = {
    ...db,
    records: {
      ...db.records,
      'account.bank.statement.line': [...(db.records['account.bank.statement.line'] ?? []), directLine],
    },
  };

  const resetDb = resetMove(db, invId).db;
  const syncedReset = sync(db, resetDb);

  for (const snapshot of [resetDb, syncedReset]) {
    const draftInv = read(snapshot, 'account.move', invId);
    assert.equal(draftInv.state, 'draft');
    assert.equal(draftInv.amount_paid, 0);
    assert.ok(draftInv.payments.every((row) => row.reversed && row.unapplied), 'invoice must have no active settlement');

    const clearedLine = read(snapshot, 'account.bank.statement.line', lineId);
    assert.equal(clearedLine.state, 'to_check');
    assert.equal(clearedLine.bank_move_id, null);
    assert.equal(clearedLine.payment_id, null);
    assert.deepEqual(clearedLine.allocations, []);

    const payAfter = read(snapshot, 'account.payment', payment.id);
    assert.equal(payAfter.state, 'posted');
    assert.equal(payAfter.unapplied, 150);
  }
});

test('mv1: unapplying one credit-note settlement leaves unrelated exchange entries from other applications active', () => {
  let base = seed();
  const eur = search(base, 'res.currency').find((c) => c.name === 'EUR')
    ?? (() => {
      const created = create(base, 'res.currency', { name: 'EUR', symbol: 'EUR', rounding: 0.01, rate_ids: [] });
      base = created.db;
      return read(base, 'res.currency', created.id);
    })();
  base = write(base, 'res.currency', eur.id, {
    rate_ids: [
      { date: '2026-04-01', rate: 0.5 }, // 1 EUR = 2.0 USD
      { date: '2026-04-10', rate: 0.4 }, // 1 EUR = 2.5 USD
      { date: '2026-04-15', rate: 0.25 }, // 1 EUR = 4.0 USD
    ],
  });

  const { db: invDb, id: invId } = makeDocument(base, {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-04-01',
    price_unit: 200,
    currency_id: eur.id,
  });
  const { db: cnDb, id: cnId } = makeDocument(invDb, {
    move_type: 'out_refund',
    partner_id: 3,
    invoice_date: '2026-04-10',
    price_unit: 200,
    currency_id: eur.id,
  });

  // Two distinct applications at different dates (one with FX at 2026-04-10, second with zero gap or own FX at 2026-04-15)
  const settled1 = applyCreditNote(cnDb, cnId, invId, '2026-04-10', 80);
  const fx1 = search(settled1, 'account.move').find((m) => m.fx_payment_move_id === cnId && m.fx_invoice_id === invId);
  assert.ok(fx1, 'first application created exchange entry fx1');

  // Change EUR rate before 2nd application date isn't needed for credit note (rate is fixed at doc date),
  // so 2nd application also creates its own distinct exchange entry fx2; also test zero-gap 2nd application separately.
  const settled2 = applyCreditNote(settled1, cnId, invId, '2026-04-15', 60);
  const fxMoves = search(settled2, 'account.move').filter((m) => m.fx_payment_move_id === cnId && m.fx_invoice_id === invId);
  assert.equal(fxMoves.length, 2, 'two applications created two distinct exchange entries');
  const fx2 = fxMoves.find((m) => m.id !== fx1.id);
  assert.ok(fx2);

  const invRows = read(settled2, 'account.move', invId).payments;
  assert.equal(invRows.length, 2);
  assert.equal(invRows[0].payment_fx_move_id, fx1.id);
  assert.equal(invRows[1].payment_fx_move_id, fx2.id);

  // Unapply ONLY the first settlement row
  const afterUnapply = sync(settled2, unapplyCreditNoteSettlement(settled2, invId, cnId, '2026-04-12', { rowId: invRows[0].id }));
  assert.ok(search(afterUnapply, 'account.move').some((m) => m.reversed_entry_id === fx1.id && m.state === 'posted'), 'fx1 must be reversed');
  assert.ok(!search(afterUnapply, 'account.move').some((m) => m.reversed_entry_id === fx2.id && m.state !== 'cancel'), 'fx2 of unselected application must remain active');
  const invAfter = read(afterUnapply, 'account.move', invId);
  assert.equal(invAfter.amount_paid, 60);
  assert.equal(invAfter.payments.filter((p) => !p.reversed).length, 1);
  assert.equal(invAfter.payments.filter((p) => !p.reversed)[0].payment_fx_move_id, fx2.id);

  // Also test when a 2nd application has NO exchange entry (e.g. same-rate credit note or zero-gap row): unapplying it must not reverse fx1.
  const settledZeroGap = applyCreditNote(settled1, cnId, invId, '2026-04-16', 120);
  // Simulate a same-date zero-gap second row (payment_fx_move_id: null) alongside fx1-owned row1
  const invWithZeroGap = {
    ...settled1,
    records: {
      ...settled1.records,
      'account.move': settled1.records['account.move'].map((m) => {
        if (m.id === invId) {
          return { ...m, amount_paid: 140, payments: [...m.payments, { id: 2, date: '2026-04-16', amount: 60, move_id: cnId, cash_basis_move_id: null }] };
        }
        if (m.id === cnId) {
          return { ...m, amount_paid: 140, payments: [...m.payments, { id: 2, date: '2026-04-16', amount: 60, move_id: invId, cash_basis_move_id: null }] };
        }
        return m;
      }),
    },
  };
  assert.ok(settledZeroGap);
  const unappliedZeroGap = sync(invWithZeroGap, unapplyCreditNoteSettlement(invWithZeroGap, cnId, invId, '2026-04-17', { rowId: 2, otherRowId: 2 }));
  assert.ok(!search(unappliedZeroGap, 'account.move').some((m) => m.reversed_entry_id === fx1.id && m.state !== 'cancel'), 'fx1 owned by row 1 must not be reversed when unapplying row 2');
});

test('mv1: equal-amount same-day credit-note settlements all unapply cleanly on invoice reset and symmetric unreconcile', () => {
  const { db: invDb, id: invId } = makeDocument(seed(), {
    move_type: 'out_invoice',
    partner_id: 3,
    invoice_date: '2026-04-01',
    price_unit: 300,
  });
  const { db: cnDb, id: cnId } = makeDocument(invDb, {
    move_type: 'out_refund',
    partner_id: 3,
    invoice_date: '2026-04-05',
    price_unit: 200,
  });
  const app1 = applyCreditNote(cnDb, cnId, invId, '2026-04-10', 100);
  const app2 = applyCreditNote(app1, cnId, invId, '2026-04-10', 100);
  assert.equal(read(app2, 'account.move', invId).payments.length, 2);
  assert.equal(read(app2, 'account.move', invId).amount_paid, 200);

  // Resetting the invoice must release BOTH equal-amount same-day applications and return invoice to draft.
  const resetDb = sync(app2, resetMove(app2, invId).db);
  const draftInv = read(resetDb, 'account.move', invId);
  assert.equal(draftInv.state, 'draft');
  assert.equal(draftInv.amount_paid, 0);
  assert.ok(draftInv.payments.every((p) => p.reversed && p.unapplied));
  const cnAfter = read(resetDb, 'account.move', cnId);
  assert.equal(cnAfter.amount_paid, 0);
  assert.ok(cnAfter.payments.every((p) => p.reversed && p.unapplied));

  // Symmetric unreconcile selecting both invoice and credit note receivable items must also release both legacy (id-less) rows cleanly.
  const legacyDb = {
    ...app2,
    records: {
      ...app2.records,
      'account.move': app2.records['account.move'].map((m) => (m.id === invId || m.id === cnId
        ? { ...m, payments: m.payments.map(({ id: _drop, ...rest }) => rest) }
        : m)),
    },
  };
  const ar = accountId(legacyDb, '121000');
  const invLine = read(legacyDb, 'account.move', invId).line_ids.find((l) => l.account_id === ar);
  const cnLine = read(legacyDb, 'account.move', cnId).line_ids.find((l) => l.account_id === ar);
  const symDb = unreconcileJournalItems(legacyDb, [
    { move_id: invId, line_identity: journalItemIdentity(invLine) },
    { move_id: cnId, line_identity: journalItemIdentity(cnLine) },
  ], { date: '2026-04-12' });
  assert.equal(read(symDb, 'account.move', invId).amount_paid, 0);
  assert.equal(read(symDb, 'account.move', cnId).amount_paid, 0);
  assert.ok(read(symDb, 'account.move', invId).payments.every((p) => p.reversed && p.unapplied));
  assert.ok(read(symDb, 'account.move', cnId).payments.every((p) => p.reversed && p.unapplied));
});

test('mv1: posted payments cannot link to unrelated draft documents via direct writes or sync', () => {
  const base = seed();
  // Create a standalone posted vendor payment and an unrelated draft bill (same partner, same company, same type).
  const draftBill = create(base, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 4,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 500, tax: 0 }],
  });
  const otherPartnerDraft = create(draftBill.db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 3,
    invoice_date: '2026-05-01',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 500, tax: 0 }],
  });
  const payCreated = create(otherPartnerDraft.db, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: 4,
    amount: 500,
    date: '2026-05-02',
    journal_id: journalId(otherPartnerDraft.db, 'BNK1'),
  });
  const postedDb = postPayment(payCreated.db, read(payCreated.db, 'account.payment', payCreated.id));

  // Direct write attempting to point posted payment to an unrelated draft bill must fail.
  assert.throws(() => write(postedDb, 'account.payment', payCreated.id, { invoice_id: draftBill.id }), /invoice|posted|settled/i);
  assert.throws(() => write(postedDb, 'account.payment', payCreated.id, { invoice_id: otherPartnerDraft.id }), /partner|invoice/i);

  // Forged diff attempting to bypass write() must also fail in paymentInvariant.
  const forged = {
    ...postedDb,
    records: {
      ...postedDb.records,
      'account.payment': postedDb.records['account.payment'].map((p) => (p.id === payCreated.id ? { ...p, invoice_id: draftBill.id } : p)),
    },
  };
  assert.throws(() => sync(postedDb, forged), /invoice|posted|settled/i);

  // Direct create of a posted payment referencing a draft bill must also fail.
  const postedPay = read(postedDb, 'account.payment', payCreated.id);
  assert.throws(() => create(postedDb, 'account.payment', {
    payment_type: 'outbound',
    partner_type: 'supplier',
    partner_id: 4,
    amount: 500,
    date: '2026-05-02',
    journal_id: postedPay.journal_id,
    move_id: postedPay.move_id,
    state: 'posted',
    invoice_id: draftBill.id,
  }), /invoice|posted|settled/i);

  // Legitimate reset of a paid bill keeps its payment.invoice_id valid across direct write and sync.
  const { db: postedBillDb, id: paidBillId } = makeDocument(postedDb, {
    move_type: 'in_invoice',
    partner_id: 4,
    invoice_date: '2026-05-01',
    price_unit: 300,
  });
  const paidBillDb = payMove(postedBillDb, paidBillId, 300, '2026-05-03');
  const billPayment = search(paidBillDb, 'account.payment').find((p) => p.invoice_id === paidBillId);
  const resetBillDb = sync(paidBillDb, resetMove(paidBillDb, paidBillId).db);
  assert.equal(read(resetBillDb, 'account.move', paidBillId).state, 'draft');
  assert.doesNotThrow(() => write(resetBillDb, 'account.payment', billPayment.id, { memo: 'updated after reset' }));
});

test('mv1: resequencing across year boundaries formats short years, month resets, and fiscal-year ranges properly', () => {
  let db = seed();
  const jMisc = search(db, 'account.journal').find((j) => j.code === 'MISC' && (j.company_id ?? 1) === 1);
  const ar = accountId(db, '121000');
  const rev = accountId(db, '400000');

  const e1 = postEntry(db, { journal: jMisc.code, journal_id: jMisc.id, company: 1, date: '2024-12-20', ref: 'Y24', lines: [{ account_id: ar, debit: 10 }, { account_id: rev, credit: 10 }] });
  const e2 = postEntry(e1.db, { journal: jMisc.code, journal_id: jMisc.id, company: 1, date: '2025-01-05', ref: 'Y25', lines: [{ account_id: ar, debit: 20 }, { account_id: rev, credit: 20 }] });
  db = e2.db;

  // 1) Two-digit year (INV/24/0005 -> INV/25/0001)
  const shortYearPreview = resequencePreview(db, [e1.id, e2.id], { first_name: 'INV/24/0005', ordering: 'date' });
  assert.deepEqual(shortYearPreview.map((r) => r.new_name), ['INV/24/0005', 'INV/25/0001']);
  const shortYearApplied = sync(db, resequenceMoves(db, [e1.id, e2.id], { first_name: 'INV/24/0005', ordering: 'date' }).db);
  assert.equal(read(shortYearApplied, 'account.move', e1.id).name, 'INV/24/0005');
  assert.equal(read(shortYearApplied, 'account.move', e2.id).name, 'INV/25/0001');

  // 2) Two-digit year + month (INV/24/12/0005 -> INV/25/01/0001)
  const shortMonthPreview = resequencePreview(shortYearApplied, [e1.id, e2.id], { first_name: 'INV/24/12/0005', ordering: 'date' });
  assert.deepEqual(shortMonthPreview.map((r) => r.new_name), ['INV/24/12/0005', 'INV/25/01/0001']);

  // 3) Fiscal year range on a company ending March 31 (Apr 1 - Mar 31)
  const fyCo = write(shortYearApplied, 'res.company', 1, { fiscalyear_last_month: 3, fiscalyear_last_day: 31 });
  const f1 = postEntry(fyCo, { journal: jMisc.code, journal_id: jMisc.id, company: 1, date: '2025-11-10', ref: 'FY1', lines: [{ account_id: ar, debit: 30 }, { account_id: rev, credit: 30 }] });
  const f2 = postEntry(f1.db, { journal: jMisc.code, journal_id: jMisc.id, company: 1, date: '2026-02-15', ref: 'FY2', lines: [{ account_id: ar, debit: 40 }, { account_id: rev, credit: 40 }] });
  const f3 = postEntry(f2.db, { journal: jMisc.code, journal_id: jMisc.id, company: 1, date: '2026-04-05', ref: 'FY3', lines: [{ account_id: ar, debit: 50 }, { account_id: rev, credit: 50 }] });
  const fyDb = f3.db;

  // f1 (Nov 2025) and f2 (Feb 2026) belong to FY 2025-2026 -> 0005, 0006; f3 (Apr 2026) starts FY 2026-2027 -> 0001.
  const fyPreview = resequencePreview(fyDb, [f1.id, f2.id, f3.id], { first_name: 'BILL/2025-2026/0005', ordering: 'date' });
  assert.deepEqual(fyPreview.map((r) => r.new_name), ['BILL/2025-2026/0005', 'BILL/2025-2026/0006', 'BILL/2026-2027/0001']);

  // Mixed-width year_range (INV/2025-26/0005 -> INV/2026-27/0001)
  const mixedWidthPreview = resequencePreview(fyDb, [f1.id, f2.id, f3.id], { first_name: 'INV/2025-26/0005', ordering: 'date' });
  assert.deepEqual(mixedWidthPreview.map((r) => r.new_name), ['INV/2025-26/0005', 'INV/2025-26/0006', 'INV/2026-27/0001']);

  // year_range_month across fiscal boundary (BILL/2025-26/02/0005 -> BILL/2026-27/04/0001)
  const fyMonthApplied = sync(fyDb, resequenceMoves(fyDb, [f2.id, f3.id], { first_name: 'BILL/2025-26/02/0005', ordering: 'date' }).db);
  assert.equal(read(fyMonthApplied, 'account.move', f2.id).name, 'BILL/2025-26/02/0005');
  assert.equal(read(fyMonthApplied, 'account.move', f3.id).name, 'BILL/2026-27/04/0001');

  // Calendar-year company using year_range format still advances year_end cleanly (never BILL/2026-2026/0001)
  const calCo = write(fyMonthApplied, 'res.company', 1, { fiscalyear_last_month: 12, fiscalyear_last_day: 31 });
  const calRangePreview = resequencePreview(calCo, [f1.id, f2.id], { first_name: 'BILL/2025-2026/0005', ordering: 'date' });
  assert.deepEqual(calRangePreview.map((r) => r.new_name), ['BILL/2025-2026/0005', 'BILL/2026-2027/0001']);

  // Colliding prefix across distinct periods (starting name carries the 2nd period's year on a 1st-period move) is rejected
  assert.throws(() => resequencePreview(db, [e1.id, e2.id], { first_name: 'INV/2025/0005', ordering: 'date' }), /prefix|period/i);
});
