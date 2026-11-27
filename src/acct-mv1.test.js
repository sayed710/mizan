import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { applyCreditNote, journalEntriesView, payMove, resetMove, resequenceListAction, resequenceMoves, resequencePreview, resequenceWizard } from './models/accounting.js';
import { applyPaymentCredit, postPayment } from './models/pay.js';
import { accountId, journalId, postEntry } from './models/ledger.js';
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
