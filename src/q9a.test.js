import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, postNote, read, search, unlink, write, writeMany, writeManyAtomic } from './orm.js';
import { seed } from './seed.js';
import { createCompany } from './models/company.js';
import { payMove, postMove, postAutoPostMoves } from './models/accounting.js';
import { models } from './models/index.js';
import { accountId, journalId, journalItemIdentity } from './models/ledger.js';
import { applyPaymentCredit, postPayment, unapplyPaymentCredit, unreconcileJournalItems } from './models/pay.js';
import { defaultTaxRepartitionLines, taxSnapshot } from './models/taxes.js';
import { installments } from './models/terms.js';
import { today } from './models/common.js';
import { applyDiff, diffDb } from './sync.js';

test('Qodo 43: reset reverses locked recognition in an open period', () => {
  for (const moveType of ['out_invoice', 'out_refund']) {
    const base = seed();
    const configured = write(base, 'res.company', 1, { deferred_generation_method: 'on_validation', deferred_revenue_account_id: accountId(base, '212000') });
    const invoice = create(configured, 'account.move', {
      move_type: moveType, partner_id: 2, invoice_date: today(),
      invoice_line_ids: [{ name: 'Service', qty: 1, price_unit: 100, tax: 0, account_id: accountId(base, '410000'), deferred_start_date: '2020-01-01', deferred_end_date: '2020-01-31' }],
    });
    let db = postMove(invoice.db, invoice.id);
    const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === invoice.id);
    const original = read(db, 'account.move', schedule.board[0].move_id);
    db = write(db, 'res.company', 1, { lock_date: '2020-12-31' });
    const beforeReset = db;
    const reset = models['account.move'].form.buttons.find((button) => button.label === 'Reset to Draft');
    db = reset.run(db, read(db, 'account.move', invoice.id)).db;
    const reversed = read(db, 'account.deferral', schedule.id);
    const reversal = read(db, 'account.move', reversed.board[0].reversal_move_id);
    assert.equal(reversal.invoice_date, today());
    assert.equal(reversal.reversed_entry_id, original.id);
    assert.deepEqual(reversal.line_ids.map((line) => [line.account_id, line.debit, line.credit]), original.line_ids.map((line) => [line.account_id, line.credit, line.debit]));
    assert.deepEqual(read(db, 'account.move', original.id), read(beforeReset, 'account.move', original.id));
    assert.equal(reversed.state, 'cancel');
  }
});

test('Qodo 38: explicit balance terms survive sync and allocate the remainder on posted invoices', () => {
  const base = seed();
  const term = create(base, 'account.payment.term', { name: 'Deposit and balance', line_ids: [
    { value_type: 'percent', value: 30, nb_days: 0, delay_type: 'days_after' },
    { value_type: 'balance', value: 0, nb_days: 30, delay_type: 'days_after' },
  ] });
  const saved = applyDiff(base, diffDb(base, term.db), { isAdmin: true });
  const savedTerm = read(saved, 'account.payment.term', term.id);
  assert.equal(savedTerm.line_ids[1].value_type, 'balance');
  assert.deepEqual(installments(savedTerm, 100.01, '2026-01-01').map((row) => row.amount), [30, 70.01]);
  assert.match(savedTerm.preview, /700\.00/);
  const invoice = create(saved, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_payment_term_id: term.id, invoice_line_ids: [{ qty: 1, price_unit: 100.01, tax: 0 }] });
  const posted = postMove(invoice.db, invoice.id);
  const counterparts = read(posted, 'account.move', invoice.id).line_ids.filter((line) => read(posted, 'account.account', line.account_id)?.account_type === 'asset_receivable');
  assert.deepEqual(counterparts.map((line) => [line.date_maturity, line.debit]), [['2026-01-01', 30], ['2026-01-31', 70.01]]);
  assert.throws(() => installments({ line_ids: [savedTerm.line_ids[1], savedTerm.line_ids[0]] }, 100, '2026-01-01'), /balance.*last/i);
  assert.throws(() => installments({ line_ids: [savedTerm.line_ids[1], savedTerm.line_ids[1]] }, 100, '2026-01-01'), /balance.*last/i);
  assert.throws(() => installments({ line_ids: [{ ...savedTerm.line_ids[0], value: 101 }, savedTerm.line_ids[1]] }, 100, '2026-01-01'), /allocate 100%/);
  assert.throws(() => installments({ line_ids: [{ ...savedTerm.line_ids[0], value_type: 'fixed', value: 50 }, { ...savedTerm.line_ids[0], value: 60 }, savedTerm.line_ids[1]] }, 100, '2026-01-01'), /allocate 100%/);
});

test('Qodo 25: monthly and quarterly recurring reversals preserve elapsed days after February clamping', () => {
  for (const [frequency, start, originalReversal, occurrenceDate, reversalDate] of [
    ['monthly', '2097-01-30', '2097-03-01', '2097-02-28', '2097-03-30'],
    ['quarterly', '2096-11-30', '2096-12-31', '2097-02-28', '2097-03-31'],
  ]) {
    const base = seed();
    const entry = create(base, 'account.move', {
      move_type: 'entry', journal_id: journalId(base, 'MISC'), date: start, invoice_date: start,
      auto_post: frequency, auto_post_until: occurrenceDate, auto_reverse: true, reverse_date: originalReversal,
      line_ids: [
        { account_id: accountId(base, '600000'), debit: 50, credit: 0 },
        { account_id: accountId(base, '101401'), debit: 0, credit: 50 },
      ],
    });
    let db = postMove(entry.db, entry.id);
    const occurrence = search(db, 'account.move').find((m) => m.auto_post_origin_id === entry.id && m.date === occurrenceDate);
    assert.ok(occurrence, `${frequency}: recurring entry exists`);
    assert.equal(occurrence.reverse_date, reversalDate);
    db = postAutoPostMoves(db, occurrenceDate);
    const reversal = search(db, 'account.move').find((m) => m.reversed_entry_id === occurrence.id);
    assert.equal(reversal?.state, 'draft');
    assert.equal(reversal.invoice_date, reversalDate);
    db = postAutoPostMoves(db, reversalDate);
    assert.equal(read(db, 'account.move', reversal.id).state, 'posted');
  }
});

test('Qodo 24: deleted branch entries retain company-specific audit protection', () => {
  const branch = createCompany(seed(), { name: 'Audited branch' });
  const db = write(branch.db, 'res.company', branch.id, { audit_trail: true });
  const entry = create(db, 'account.move', { company_id: branch.id, move_type: 'entry', ref: 'Draft entry' });
  const deleted = unlink(entry.db, 'account.move', [entry.id]);
  const saved = applyDiff(entry.db, diffDb(entry.db, deleted), { isAdmin: true });
  assert.equal(read(saved, 'account.move', entry.id), undefined);
  const notes = saved.messages.filter((m) => m.model === 'account.move' && m.res_id === entry.id);
  assert.ok(notes.some((m) => m.body === 'Record deleted'));
  assert.ok(notes.every((m) => m.company_id === branch.id));
  const attempted = applyDiff(saved, { removedMessages: notes.map((m) => m.id) }, { isAdmin: true });
  assert.ok(notes.every((note) => attempted.messages.some((m) => m.id === note.id)));
});

test('Qodo 24: deleted unaudited branch notes remain removable even when company one is audited', () => {
  const audited = write(seed(), 'res.company', 1, { audit_trail: true });
  const branch = createCompany(audited, { name: 'Unaudited branch' });
  const entry = create(branch.db, 'account.move', { company_id: branch.id, move_type: 'entry' });
  const deleted = unlink(entry.db, 'account.move', [entry.id]);
  const saved = applyDiff(entry.db, diffDb(entry.db, deleted), { isAdmin: true });
  const notes = saved.messages.filter((m) => m.model === 'account.move' && m.res_id === entry.id);
  assert.ok(notes.length);
  const attempted = applyDiff(saved, { removedMessages: notes.map((m) => m.id) }, { isAdmin: true });
  assert.ok(notes.every((note) => !attempted.messages.some((m) => m.id === note.id)));
});

test('Qodo 23: transfers track untracked edits for either audited company and attribute them to the destination', () => {
  const audited = write(seed(), 'res.company', 1, { audit_trail: true });
  const branch = createCompany(audited, { name: 'Unaudited branch' });
  const methods = [
    (db, id, values) => write(db, 'account.move', id, values),
    (db, id, values) => writeMany(db, 'account.move', new Map([[id, values]])),
    (db, id, values) => writeManyAtomic(db, 'account.move', new Map([[id, values]])),
  ];
  for (const update of methods) for (const [from, to] of [[branch.id, 1], [1, branch.id]]) {
    const entry = create(branch.db, 'account.move', { move_type: 'entry', company_id: from, ref: 'before' });
    const local = update(entry.db, entry.id, { company_id: to, ref: 'after' });
    const messages = local.messages.slice(entry.db.messages.length).filter((m) => m.model === 'account.move' && m.res_id === entry.id);
    const note = messages.find((m) => m.body.includes('Reference: before → after'));
    assert.ok(note, `reference change must be audited for transfer ${from} → ${to}`);
    assert.equal(note.company_id, to);
    const synced = applyDiff(entry.db, diffDb(entry.db, local), { isAdmin: true });
    assert.equal(synced.messages.find((m) => m.id === note.id)?.company_id, to);
  }
  const ordinary = create(branch.db, 'account.move', { move_type: 'entry', company_id: branch.id, ref: 'before' });
  const changed = write(ordinary.db, 'account.move', ordinary.id, { ref: 'after' });
  assert.ok(!changed.messages.slice(ordinary.db.messages.length).some((m) => m.res_id === ordinary.id && m.body.includes('Reference:')));
});

test('Qodo 22: syncing chatter checks audit protection without computing invoice fields', () => {
  const base = write(seed(), 'res.company', 1, { audit_trail: true });
  const invoice = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  let db = invoice.db;
  for (let i = 0; i < 5; i++) db = postNote(db, 'account.move', invoice.id, `Note ${i}`);
  const note = db.messages.find((m) => m.model === 'account.move' && m.res_id === invoice.id);
  const field = models['account.move'].fields.amount_total;
  const original = field.compute;
  let computations = 0;
  field.compute = (...args) => { if (args[0].id === invoice.id) computations++; return original(...args); };
  try {
    const saved = applyDiff(db, { removedMessages: [note.id] }, { isAdmin: true });
    assert.ok(saved.messages.some((m) => m.id === note.id));
    assert.equal(computations, 0, 'audit checks must not recompute the invoice for each message');
  } finally {
    field.compute = original;
  }
});

test('Qodo 22: server renumbering audits the raw move and retains its tracking message', () => {
  let base = write(seed(), 'res.company', 1, { audit_trail: true });
  const first = create(base, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  const second = create(first.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 200, tax: 0 }] });
  base = applyDiff(base, diffDb(base, second.db));
  const a = postMove(base, first.id);
  const b = postMove(base, second.id);
  const server = applyDiff(base, diffDb(base, a));
  const model = models['account.move'];
  const original = model.audited;
  let renameAudited = false;
  model.audited = (db, move) => {
    if (move?.id === second.id && move.state === 'posted') {
      assert.equal(move, db.records['account.move'].find((r) => r.id === second.id));
      renameAudited = true;
    }
    return original(db, move);
  };
  try {
    const saved = applyDiff(server, diffDb(base, b));
    assert.ok(renameAudited);
    assert.ok(saved.messages.some((m) => m.model === 'account.move' && m.res_id === second.id && m.body.includes('assigned by the server')));
  } finally {
    model.audited = original;
  }
});

test('Qodo 9: selecting a legacy payment outstanding item releases its booked credit', () => {
  const base = seed();
  const outstanding = create(base, 'account.account', { name: 'Outstanding receipts', code: 'Q9AOUT', account_type: 'asset_current', company_id: 1, reconcile: true });
  const configured = write(outstanding.db, 'res.company', 1, { outstanding_receipts_account_id: outstanding.id });
  const invoice = create(configured, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  let db = payMove(postMove(invoice.db, invoice.id), invoice.id, 100, '2026-01-02');
  const row = read(db, 'account.move', invoice.id).payments[0];
  const payment = search(db, 'account.payment').find((p) => p.move_id === row.move_id);
  // Reproduce an application stored by the older payMove, before this field existed.
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === invoice.id ? { ...m, payments: m.payments.map(({ payment_company_amount: _, ...rest }) => rest) } : m) } };
  const source = read(db, 'account.move', row.move_id);
  const line = source.line_ids.find((l) => l.account_id === outstanding.id);
  const next = unreconcileJournalItems(db, [{ move_id: source.id, line_identity: journalItemIdentity(line) }], { date: '2026-01-03' });
  assert.equal(read(next, 'account.move', invoice.id).amount_residual, 100);
  assert.equal(read(next, 'account.payment', payment.id).unapplied, 100);
  const synced = applyDiff(db, diffDb(db, next), { isAdmin: false });
  assert.equal(read(synced, 'account.payment', payment.id).unapplied, 100);
});

test('Qodo 9: ambiguous legacy overpayments fail without changing credit', () => {
  const base = seed();
  const outstanding = create(base, 'account.account', { name: 'Outstanding overpayment', code: 'Q9AOVER', account_type: 'asset_current', company_id: 1, reconcile: true });
  const configured = write(outstanding.db, 'res.company', 1, { outstanding_receipts_account_id: outstanding.id });
  const invoice = create(configured, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  let db = payMove(postMove(invoice.db, invoice.id), invoice.id, 150, '2026-01-02');
  const row = read(db, 'account.move', invoice.id).payments[0];
  const payment = search(db, 'account.payment').find((p) => p.move_id === row.move_id);
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === invoice.id ? { ...m, payments: m.payments.map(({ payment_company_amount: _, ...rest }) => rest) } : m) } };
  const source = read(db, 'account.move', row.move_id);
  const line = source.line_ids.find((l) => l.account_id === outstanding.id);
  assert.throws(() => unreconcileJournalItems(db, [{ move_id: source.id, line_identity: journalItemIdentity(line) }], { date: '2026-01-03' }), /cannot be determined from its booked entry/);
  assert.equal(read(db, 'account.payment', payment.id).unapplied, 50);
  assert.equal(read(db, 'account.move', invoice.id).amount_residual, 0);
});

test('Qodo 9: legacy credit uses the booked liquidity amount, not a later exchange rate', () => {
  const base = seed();
  const outstanding = create(base, 'account.account', { name: 'FX outstanding', code: 'Q9AOUTFX', account_type: 'asset_current', company_id: 1, reconcile: true });
  const gain = create(outstanding.db, 'account.account', { name: 'FX gain', code: 'Q9AOLDGAIN', account_type: 'income_other', company_id: 1 });
  const configured = write(gain.db, 'res.company', 1, { outstanding_receipts_account_id: outstanding.id, income_currency_exchange_account_id: gain.id });
  const currency = create(configured, 'res.currency', { name: 'Legacy FX', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const invoice = create(currency.db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  let db = payMove(postMove(invoice.db, invoice.id), invoice.id, 100, '2026-02-01');
  const row = read(db, 'account.move', invoice.id).payments[0];
  const payment = search(db, 'account.payment').find((p) => p.move_id === row.move_id);
  db = { ...db, records: { ...db.records, 'account.move': db.records['account.move'].map((m) => m.id === invoice.id ? { ...m, payments: m.payments.map(({ payment_company_amount: _, ...rest }) => rest) } : m) } };
  db = write(db, 'res.currency', currency.id, { rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 4 }] });
  const source = read(db, 'account.move', row.move_id);
  const line = source.line_ids.find((l) => l.account_id === outstanding.id);
  const next = unreconcileJournalItems(db, [{ move_id: source.id, line_identity: journalItemIdentity(line) }], { date: '2026-02-02' });
  assert.equal(read(next, 'account.payment', payment.id).unapplied, 100);
});

test('Qodo 26: cancelling a scheduled reversal restores the source reversal action', () => {
  const base = seed();
  const entry = create(base, 'account.move', {
    move_type: 'entry', journal_id: journalId(base, 'MISC'), date: '2099-01-01', invoice_date: '2099-01-01',
    auto_reverse: true, reverse_date: '2099-01-02',
    line_ids: [
      { account_id: accountId(base, '600000'), debit: 50, credit: 0 },
      { account_id: accountId(base, '101401'), debit: 0, credit: 50 },
    ],
  });
  const posted = postMove(entry.db, entry.id);
  const reversalId = read(posted, 'account.move', entry.id).reversal_move_id;
  const buttons = models['account.move'].form.buttons;
  const cancel = buttons.find((b) => b.label === 'Cancel');
  const reverse = buttons.find((b) => b.label === 'Reverse Entry');
  const cancelled = cancel.run(posted, read(posted, 'account.move', reversalId)).db;
  assert.equal(read(cancelled, 'account.move', reversalId).state, 'cancel');
  assert.equal(read(cancelled, 'account.move', entry.id).reversal_move_id, null);
  assert.ok(reverse.when(read(cancelled, 'account.move', entry.id), cancelled));
  const saved = applyDiff(posted, diffDb(posted, cancelled), { isAdmin: true });
  assert.equal(read(saved, 'account.move', entry.id).reversal_move_id, null);
  const replacement = reverse.run(saved, read(saved, 'account.move', entry.id), { date: '2099-01-03', scheduled: true });
  assert.equal(read(replacement.db, 'account.move', entry.id).reversal_move_id, replacement.id);
  assert.equal(read(replacement.db, 'account.move', replacement.id).state, 'draft');
  const legacy = write(cancelled, 'account.move', entry.id, { reversal_move_id: reversalId });
  assert.ok(reverse.when(read(legacy, 'account.move', entry.id), legacy));
});

test('Qodo 6: a scheduled reversal cannot post after its source is cancelled', () => {
  const base = seed();
  const entry = create(base, 'account.move', {
    move_type: 'entry', journal_id: journalId(base, 'MISC'), date: '2099-01-01', invoice_date: '2099-01-01',
    auto_reverse: true, reverse_date: '2099-01-02',
    line_ids: [
      { account_id: accountId(base, '600000'), debit: 50, credit: 0 },
      { account_id: accountId(base, '101401'), debit: 0, credit: 50 },
    ],
  });
  let db = postMove(entry.db, entry.id);
  const reversalId = read(db, 'account.move', entry.id).reversal_move_id;
  assert.equal(read(db, 'account.move', reversalId).state, 'draft');
  const buttons = models['account.move'].form.buttons;
  for (const label of ['Reset to Draft', 'Cancel']) {
    const button = buttons.find((b) => b.label === label);
    const source = read(db, 'account.move', entry.id);
    assert.ok(button.when(source, db));
    db = button.run(db, source).db;
  }
  assert.equal(read(db, 'account.move', entry.id).state, 'cancel');
  assert.throws(() => postMove(db, reversalId), /entry this reverses is no longer posted/i);
  const after = postAutoPostMoves(db, '2099-01-02');
  assert.equal(read(after, 'account.move', reversalId).state, 'draft');
  assert.ok(after.messages.some((m) => m.model === 'account.move' && m.res_id === reversalId && /Auto-post failed: The entry this reverses is no longer posted/.test(m.body)));
});

test('Qodo 2: sync rejects forged settlement reversals while accepting genuine unapplication', () => {
  const base = seed();
  const accounts = search(base, 'account.account');
  const transition = accounts.find((a) => a.code === '251100').id;
  const taxAccount = accounts.find((a) => a.code === '251000').id;
  const tax = create(base, 'account.tax', { name: 'Cash tax', company_id: 1, type_tax_use: 'sale', amount: 10, tax_exigibility: 'on_payment', cash_basis_transition_account_id: transition, ...defaultTaxRepartitionLines(taxAccount) });
  const payment = create(tax.db, 'account.payment', { partner_id: 1, partner_type: 'customer', payment_type: 'inbound', amount: 110, date: '2026-01-02' });
  let db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, ...taxSnapshot(read(tax.db, 'account.tax', tax.id)) }] });
  db = applyPaymentCredit(postMove(invoice.db, invoice.id), payment.id, invoice.id);
  const row = read(db, 'account.move', invoice.id).payments.at(-1);
  assert.ok(row.cash_basis_move_id);
  const local = unapplyPaymentCredit(db, invoice.id, row.move_id, row.date);
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, local), { isAdmin: false }));
  const reversal = local.records['account.move'].find((m) => m.reversed_entry_id === row.cash_basis_move_id);
  assert.ok(reversal);
  for (const changes of [
    { line_ids: reversal.line_ids.map((l) => ({ ...l, debit: l.credit, credit: l.debit })) },
    { line_ids: [] },
    { invoice_date: '2026-01-01', date: '2026-01-01' },
    { company_id: 999999 },
  ]) {
    const forged = { ...local, records: { ...local.records, 'account.move': local.records['account.move'].map((m) => m.id === reversal.id ? { ...m, ...changes } : m) } };
    assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: false }));
  }
});

test('Qodo 2: exchange settlement reversal must mirror its original entry', () => {
  const base = seed();
  const gain = create(base, 'account.account', { name: 'FX gain', code: 'Q9AFX', account_type: 'income_other', company_id: 1 });
  const configured = write(gain.db, 'res.company', 1, { income_currency_exchange_account_id: gain.id });
  const currency = create(configured, 'res.currency', { name: 'FX test', rate_ids: [{ date: '2026-01-01', rate: 2 }, { date: '2026-02-01', rate: 1 }] });
  const payment = create(currency.db, 'account.payment', { partner_id: 1, partner_type: 'customer', payment_type: 'inbound', amount: 20, date: '2026-02-01' });
  let db = postPayment(payment.db, read(payment.db, 'account.payment', payment.id));
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 1, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  db = applyPaymentCredit(postMove(invoice.db, invoice.id), payment.id, invoice.id, '2026-02-01');
  const row = read(db, 'account.move', invoice.id).payments.at(-1);
  assert.ok(row.payment_fx_move_id);
  const local = unapplyPaymentCredit(db, invoice.id, row.move_id, '2026-02-02');
  assert.doesNotThrow(() => applyDiff(db, diffDb(db, local), { isAdmin: false }));
  const reversal = local.records['account.move'].find((m) => m.reversed_entry_id === row.payment_fx_move_id);
  const forged = { ...local, records: { ...local.records, 'account.move': local.records['account.move'].map((m) => m.id === reversal.id ? { ...m, line_ids: m.line_ids.map((l) => ({ ...l, debit: l.credit, credit: l.debit })) } : m) } };
  assert.throws(() => applyDiff(db, diffDb(db, forged), { isAdmin: false }), /reverse its exchange and cash-basis entries/);
});
