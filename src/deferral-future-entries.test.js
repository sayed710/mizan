import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { accountId, postEntry } from './models/ledger.js';
import { creditNote, postAutoPostMoves, postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { deferralEntryRef, deferredModels, postDueEntries, registerDeferredPostMoveHook } from './models/deferred.js';
import { fieldReadonly } from './field-metadata.js';
import { seed } from './seed.js';
import { applyDiff, diffDb } from './sync.js';

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function setupCompany(db) {
  return write(db, 'res.company', 1, {
    generate_deferred_expense_entries_method: 'on_validation',
    generate_deferred_revenue_entries_method: 'on_validation',
    deferred_generation_method: 'on_validation',
    deferred_amount_computation_method: 'full_months',
    deferred_expense_account_id: accountId(db, '132000'),
    deferred_revenue_account_id: accountId(db, '212000'),
  });
}

function createDeferredBill(db, {
  startDate = '2026-12-01',
  endDate = '2027-11-30',
  amount = 1200,
  lineName = 'Annual IT Services',
} = {}) {
  return create(db, 'account.move', {
    move_type: 'in_invoice',
    partner_id: 2,
    invoice_date: '2026-11-16',
    invoice_date_due: '2026-11-16',
    invoice_line_ids: [{
      name: lineName,
      qty: 1,
      price_unit: amount,
      tax: 0,
      account_id: accountId(db, '600000'),
      deferred_start_date: startDate,
      deferred_end_date: endDate,
    }],
  });
}

function createDeferredInvoice(db, {
  startDate = '2026-10-01',
  endDate = '2027-09-30',
  amount = 1200,
  lineName = 'Annual Consulting Subscription',
} = {}) {
  return create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 2,
    invoice_date: '2026-11-16',
    invoice_date_due: '2026-11-16',
    invoice_line_ids: [{
      name: lineName,
      qty: 1,
      price_unit: amount,
      tax: 0,
      account_id: accountId(db, '400000'),
      deferred_start_date: startDate,
      deferred_end_date: endDate,
    }],
  });
}

test('confirming vendor bill with 12-month future deferral creates future draft entries with auto_post at_date', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);

  const bill = read(db, 'account.move', billDraft.id);
  assert.equal(bill.state, 'posted');

  const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === bill.id);
  assert.ok(schedule, 'schedule created on confirmation');
  assert.equal(schedule.state, 'running', 'schedule is running because entries are not yet posted');
  assert.equal(schedule.board.length, 12, '12 board lines created');

  // Verify schedule name does not contain UUID
  assert.doesNotMatch(schedule.name, UUID_REGEX, 'schedule name must not contain UUID');
  assert.ok(schedule.name.includes(bill.name), 'schedule name includes source bill name');

  // All 12 board lines are dated in the future (> 2026-11-16)
  for (const line of schedule.board) {
    assert.ok(line.move_id, 'each board line references its move_id');
    assert.equal(line.posted, false, 'future-dated board line is not posted yet');
    const move = read(db, 'account.move', line.move_id);
    assert.ok(move, 'move exists in account.move');
    assert.equal(move.state, 'draft', 'future entry is created as draft');
    assert.equal(move.auto_post, 'at_date', 'draft entry has auto_post at_date');
    assert.equal(move.name, '/', 'draft entry has name /');
    assert.doesNotMatch(move.ref, UUID_REGEX, 'ref must not contain UUID');
    const [y, m] = line.date.split('-');
    assert.equal(move.ref, `Deferral of ${bill.name} (${m}/${y})`, 'ref names source doc and period');
  }
});

test('mixed past and future deferral posts due entries immediately and leaves future ones draft', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'revenue');
  const invDraft = createDeferredInvoice(db, { startDate: '2026-10-01', endDate: '2027-09-30', amount: 1200 });
  db = postMove(invDraft.db, invDraft.id);

  const invoice = read(db, 'account.move', invDraft.id);
  const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === invoice.id);
  assert.ok(schedule);
  assert.equal(schedule.state, 'running');
  assert.equal(schedule.board.length, 12);

  // Line 0 is 2026-10-31 <= 2026-11-16: posted
  const line0 = schedule.board[0];
  assert.equal(line0.date, '2026-10-31');
  assert.equal(line0.posted, true, 'line dated before today is posted');
  const move0 = read(db, 'account.move', line0.move_id);
  assert.equal(move0.state, 'posted', 'move is posted');
  assert.notEqual(move0.name, '/', 'posted move has sequence name');
  assert.doesNotMatch(move0.ref, UUID_REGEX, 'ref must not contain UUID');
  assert.equal(move0.ref, `Deferral of ${invoice.name} (10/2026)`);

  // Lines 1..11 are dated in the future: draft with auto_post at_date
  for (let i = 1; i < 12; i++) {
    const line = schedule.board[i];
    assert.equal(line.posted, false, `future line ${i} is unposted`);
    const move = read(db, 'account.move', line.move_id);
    assert.equal(move.state, 'draft');
    assert.equal(move.auto_post, 'at_date');
    assert.doesNotMatch(move.ref, UUID_REGEX);
  }
});

test('scheduled auto-post runner posts due entries at later dates and board/schedule reflect it', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const scheduleId = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id).id;

  // Run auto-post runner at 2026-12-31: exactly 1 entry becomes due
  db = postAutoPostMoves(db, '2026-12-31');
  let schedule = read(db, 'account.deferral', scheduleId);
  assert.equal(schedule.board[0].posted, true, 'first board line updated to posted');
  assert.equal(schedule.board[1].posted, false, 'second board line still unposted');
  assert.equal(schedule.state, 'running', 'schedule still running');
  const move0 = read(db, 'account.move', schedule.board[0].move_id);
  assert.equal(move0.state, 'posted', 'move posted by runner');

  // Advance to 2027-06-30 (months 0..6: 7 entries posted)
  db = postAutoPostMoves(db, '2027-06-30');
  schedule = read(db, 'account.deferral', scheduleId);
  for (let i = 0; i <= 6; i++) {
    assert.equal(schedule.board[i].posted, true, `month ${i} is posted`);
    assert.equal(read(db, 'account.move', schedule.board[i].move_id).state, 'posted');
  }
  for (let i = 7; i < 12; i++) {
    assert.equal(schedule.board[i].posted, false, `month ${i} is still draft`);
  }
  assert.equal(schedule.state, 'running', 'schedule still running with 5 remaining');

  // Advance through final period end 2027-11-30: all 12 entries posted, schedule is done
  db = postAutoPostMoves(db, '2027-11-30');
  schedule = read(db, 'account.deferral', scheduleId);
  assert.ok(schedule.board.every((l) => l.posted), 'all 12 board lines are posted');
  assert.equal(schedule.state, 'done', 'schedule state transitions to done when all moves are posted');
});

test('manual Post Due Entries posts existing scheduled drafts without creating duplicates', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const scheduleId = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id).id;

  const initialMovesCount = search(db, 'account.move').length;

  // Set today to 2026-12-31 and invoke postDueEntries manually
  t.mock.timers.setTime(new Date('2026-12-31T12:00:00Z').getTime());
  let schedule = read(db, 'account.deferral', scheduleId);
  db = postDueEntries(db, schedule, '2026-12-31');

  const afterFirstPostCount = search(db, 'account.move').length;
  assert.equal(afterFirstPostCount, initialMovesCount, 'no new moves created; existing draft was posted');

  schedule = read(db, 'account.deferral', scheduleId);
  assert.equal(schedule.board[0].posted, true, 'line 0 is posted');
  assert.equal(read(db, 'account.move', schedule.board[0].move_id).state, 'posted');
  assert.equal(schedule.board[1].posted, false, 'line 1 is still draft');

  // Calling postDueEntries again at same date must be idempotent and not create duplicate entries
  db = postDueEntries(db, schedule, '2026-12-31');
  const afterSecondPostCount = search(db, 'account.move').length;
  assert.equal(afterSecondPostCount, initialMovesCount, 'second call created no duplicate entries');
});

test('cancelling the source bill cancels unposted draft entries and leaves no orphan drafts', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const scheduleId = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id).id;
  const scheduleBefore = read(db, 'account.deferral', scheduleId);
  const draftMoveIds = scheduleBefore.board.map((l) => l.move_id);

  // Reset to draft first, then cancel
  db = write(db, 'account.move', billDraft.id, { state: 'draft' });
  db = write(db, 'account.move', billDraft.id, { state: 'cancel' });

  // Verify all 12 draft deferral entries are cancelled with auto_post no
  for (const moveId of draftMoveIds) {
    const move = read(db, 'account.move', moveId);
    assert.equal(move.state, 'cancel', 'linked draft entry is cancelled');
    assert.equal(move.auto_post, 'no', 'auto_post set to no');
  }

  // Ensure there are no orphan active auto_post draft moves
  const orphanDrafts = search(db, 'account.move').filter((m) => m.state === 'draft' && m.auto_post === 'at_date');
  assert.equal(orphanDrafts.length, 0, 'no orphan drafts left in the system');

  // Verify deferral schedule state is cancel
  const scheduleAfter = read(db, 'account.deferral', scheduleId);
  assert.equal(scheduleAfter.state, 'cancel', 'schedule is cancelled');
});

test('resetting the source bill to draft cancels unposted draft deferrals cleanly', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const scheduleId = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id).id;
  const draftMoveIds = read(db, 'account.deferral', scheduleId).board.map((l) => l.move_id);

  // Reset bill to draft
  db = write(db, 'account.move', billDraft.id, { state: 'draft' });

  for (const moveId of draftMoveIds) {
    const move = read(db, 'account.move', moveId);
    assert.equal(move.state, 'cancel', 'linked draft entry is cancelled');
    assert.equal(move.auto_post, 'no');
  }

  const orphanDrafts = search(db, 'account.move').filter((m) => m.state === 'draft' && m.auto_post === 'at_date');
  assert.equal(orphanDrafts.length, 0, 'no orphan draft deferrals');
});

test('credit notes against bill/invoice with draft deferrals cancel drafts and leave no orphan drafts', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'revenue');
  // Starts in past (2026-10-01): 1 posted entry, 11 future draft entries
  const invDraft = createDeferredInvoice(db, { startDate: '2026-10-01', endDate: '2027-09-30', amount: 1200 });
  db = postMove(invDraft.db, invDraft.id);
  // Mark invoice paid so credit note is not auto-offset and can be reset to draft
  const p = create(db, 'account.payment', {
    partner_id: 2,
    partner_type: 'customer',
    payment_type: 'inbound',
    amount: 1200,
    date: '2026-11-16',
  });
  db = postPayment(p.db, read(p.db, 'account.payment', p.id));
  db = write(db, 'account.move', invDraft.id, { amount_paid: 1200 });

  const scheduleId = search(db, 'account.deferral').find((d) => d.source_move_id === invDraft.id).id;
  const board = read(db, 'account.deferral', scheduleId).board;
  assert.equal(board[0].posted, true);
  const futureDraftIds = board.slice(1).map((l) => l.move_id);

  // Create full refund / credit note
  const cnDraft = creditNote(db, read(db, 'account.move', invDraft.id), { date: '2026-11-20' });
  const cnId = cnDraft.credit_note_id ?? cnDraft.id;
  db = postMove(cnDraft.db, cnId);

  // Future drafts must be cancelled with auto_post no
  for (const moveId of futureDraftIds) {
    const m = read(db, 'account.move', moveId);
    assert.equal(m.state, 'cancel', 'draft entry cancelled on full credit');
    assert.equal(m.auto_post, 'no');
  }
  const orphanDrafts = search(db, 'account.move').filter((m) => m.state === 'draft' && m.auto_post === 'at_date');
  assert.equal(orphanDrafts.length, 0, 'no orphan drafts remain');

  // Resetting the credit note restores draft deferrals
  db = write(db, 'account.move', cnId, { state: 'draft' });
  for (const moveId of futureDraftIds) {
    const m = read(db, 'account.move', moveId);
    assert.equal(m.state, 'draft', 'draft entry restored');
    assert.equal(m.auto_post, 'at_date', 'auto_post at_date restored');
  }
});

test('deferral entry ref format and Arabic translations', async () => {
  const dummySchedule = { name: 'BILL/2026/00002', board: [] };
  const dummyDb = { records: { 'account.move': [{ id: 10, name: 'BILL/2026/00002' }] }, settings: {} };
  dummySchedule.source_move_id = 10;

  const enRef = deferralEntryRef(dummyDb, dummySchedule, '2026-12-31');
  assert.equal(enRef, 'Deferral of BILL/2026/00002 (12/2026)');

  const fallbackSchedule = { name: 'MANUAL/DEFERRAL/01', board: [] };
  assert.equal(deferralEntryRef(dummyDb, fallbackSchedule, '2026-05-31'), 'Deferral of MANUAL/DEFERRAL/01 (05/2026)');

  const prevStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === 'mizan-lang' ? 'ar' : null), setItem() {} };
  const { t: arT } = await import(`./i18n.js?ar=${Date.now()}`);
  globalThis.localStorage = prevStorage;

  const arRef = arT('Deferral of {document} ({period})', { document: 'BILL/2026/00002', period: '12/2026' });
  assert.ok(arRef.includes('BILL/2026/00002'));
  assert.ok(arRef.includes('12/2026'));
  assert.ok(arRef.startsWith('تأجيل'));
});

test('postDueEntries fails loudly if a due draft exists and no hook is registered', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const schedule = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);

  // Advance time so the first period (2026-12-31) becomes due
  t.mock.timers.setTime(new Date('2026-12-31T12:00:00Z').getTime());

  // When postMoveFn is explicitly null:
  assert.throws(
    () => postDueEntries(db, schedule, '2026-12-31', null),
    /A posting hook is required to post due deferral entries/,
  );

  // When no global hook is registered:
  try {
    registerDeferredPostMoveHook(null);
    assert.throws(
      () => postDueEntries(db, schedule, '2026-12-31'),
      /A posting hook is required to post due deferral entries/,
    );
  } finally {
    registerDeferredPostMoveHook(postMove);
  }
});

test('server sync path (applyDiff) accepts all deferral workflows without rejection', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  const viaServer = (prev, next) => applyDiff(prev, diffDb(prev, next), { author: 'Admin', isAdmin: true });

  let db = setupCompany(seed(), 'expense');

  // 1. Posting the 12-month deferred bill (posted due entries + draft future entries accepted)
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  const localPostedBill = postMove(billDraft.db, billDraft.id);
  let serverDb = viaServer(billDraft.db, localPostedBill);
  const billId = billDraft.id;

  const serverBill = read(serverDb, 'account.move', billId);
  assert.equal(serverBill.state, 'posted');
  const serverSched = search(serverDb, 'account.deferral').find((d) => d.source_move_id === billId);
  assert.ok(serverSched);
  assert.equal(serverSched.board.length, 12);
  assert.ok(serverSched.board.every((l) => l.move_id && !l.posted));

  // 2. The auto-post runner posting a due draft later (2026-12-31)
  t.mock.timers.setTime(new Date('2026-12-31T12:00:00Z').getTime());
  const localAutoPost = postAutoPostMoves(serverDb, '2026-12-31');
  serverDb = viaServer(serverDb, localAutoPost);
  let updatedSched = read(serverDb, 'account.deferral', serverSched.id);
  assert.equal(updatedSched.board[0].posted, true);
  assert.equal(read(serverDb, 'account.move', updatedSched.board[0].move_id).state, 'posted');

  // 3. Post Due Entries (2027-01-31)
  t.mock.timers.setTime(new Date('2027-01-31T12:00:00Z').getTime());
  const localPostDue = postDueEntries(serverDb, updatedSched, '2027-01-31');
  serverDb = viaServer(serverDb, localPostDue);
  updatedSched = read(serverDb, 'account.deferral', serverSched.id);
  assert.equal(updatedSched.board[1].posted, true);
  assert.equal(read(serverDb, 'account.move', updatedSched.board[1].move_id).state, 'posted');

  // 4. Resetting the bill to draft
  const localReset = write(serverDb, 'account.move', billId, { state: 'draft' });
  serverDb = viaServer(serverDb, localReset);
  assert.equal(read(serverDb, 'account.move', billId).state, 'draft');
  const resetSched = read(serverDb, 'account.deferral', serverSched.id);
  assert.equal(resetSched.state, 'cancel');
  for (let i = 2; i < 12; i++) {
    const draftMove = read(serverDb, 'account.move', resetSched.board[i].move_id);
    assert.equal(draftMove.state, 'cancel');
    assert.equal(draftMove.auto_post, 'no');
  }

  // 5. Cancelling the bill (from draft)
  const localCancel = write(serverDb, 'account.move', billId, { state: 'cancel' });
  serverDb = viaServer(serverDb, localCancel);
  assert.equal(read(serverDb, 'account.move', billId).state, 'cancel');

  // 6. Partial credit note that rescales draft entries
  t.mock.timers.setTime(new Date('2026-11-16T12:00:00Z').getTime());
  let db2 = setupCompany(seed(), 'expense');
  const bill2 = createDeferredBill(db2, { startDate: '2026-10-01', endDate: '2027-09-30', amount: 1200 });
  let bill2Db = postMove(bill2.db, bill2.id);
  const p = create(bill2Db, 'account.payment', {
    partner_id: 2,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 1200,
    date: '2026-11-16',
  });
  bill2Db = postPayment(p.db, read(p.db, 'account.payment', p.id));
  bill2Db = write(bill2Db, 'account.move', bill2.id, { amount_paid: 1200 });
  serverDb = viaServer(bill2.db, bill2Db);

  const sched2 = search(serverDb, 'account.deferral').find((d) => d.source_move_id === bill2.id);
  assert.equal(sched2.board[0].posted, true);

  // Partial credit note for $300 (25% reduction of remaining)
  const cn = creditNote(serverDb, read(serverDb, 'account.move', bill2.id), { date: '2026-11-20' });
  const cnId = cn.credit_note_id ?? cn.id;
  const cnDraft = read(cn.db, 'account.move', cnId);
  const cnWithPartialLines = write(cn.db, 'account.move', cnId, {
    invoice_line_ids: [{ ...cnDraft.invoice_line_ids[0], price_unit: 300 }],
  });
  const localPostedCN = postMove(cnWithPartialLines, cnId);
  serverDb = viaServer(serverDb, localPostedCN);

  const rescaledSched = read(serverDb, 'account.deferral', sched2.id);
  assert.equal(rescaledSched.state, 'running');
  // Verify draft entries were rescaled and accepted by server
  for (let i = 1; i < 12; i++) {
    const draftMove = read(serverDb, 'account.move', rescaledSched.board[i].move_id);
    assert.equal(draftMove.state, 'draft');
    assert.ok(draftMove.line_ids.length > 0);
  }

  // 7. Revert of a credit note adjustment (reset credit note to draft)
  const localResetCN = write(serverDb, 'account.move', cnId, { state: 'draft' });
  serverDb = viaServer(serverDb, localResetCN);
  const revertedSched = read(serverDb, 'account.deferral', sched2.id);
  assert.equal(revertedSched.state, 'running');
  assert.equal(revertedSched.credit_adjustments?.length ?? 0, 0);
  assert.equal(revertedSched.board[0].posted, true);
  for (let i = 1; i < 12; i++) {
    const draftMove = read(serverDb, 'account.move', revertedSched.board[i].move_id);
    assert.equal(draftMove.state, 'draft');
    assert.equal(revertedSched.board[i].amount, 100);
  }
});

test('raw state cancel with live drafts rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);
  assert.equal(sched.state, 'running');

  // ORM write rejected:
  assert.throws(
    () => write(db, 'account.deferral', sched.id, { state: 'cancel' }),
    /A cancelled schedule cannot have draft recognition entries/,
  );

  // applyDiff rejected:
  const rawCancelledDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) => (d.id === sched.id ? { ...d, state: 'cancel' } : d)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, rawCancelledDb), { author: 'Admin', isAdmin: true }),
    /A cancelled schedule cannot have draft recognition entries/,
  );
});

test('editing a future line amount on a running schedule rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);
  assert.equal(sched.state, 'running');

  const tamperedBoard = sched.board.map((l, i) => (i === 5 ? { ...l, amount: 200 } : l));

  // ORM write rejected:
  assert.throws(
    () => write(db, 'account.deferral', sched.id, { board: tamperedBoard }),
    /Recognition line amounts cannot be changed on an active schedule/,
  );

  // applyDiff rejected:
  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) => (d.id === sched.id ? { ...d, board: tamperedBoard } : d)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedDb), { author: 'Admin', isAdmin: true }),
    /Recognition line amounts cannot be changed on an active schedule/,
  );
});

test('editing a posted line rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-10-01', endDate: '2027-09-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);
  assert.equal(sched.board[0].posted, true);

  // Modifying date/amount/posted of posted line:
  const tamperedPostedDate = sched.board.map((l, i) => (i === 0 ? { ...l, date: '2026-10-15' } : l));
  assert.throws(
    () => write(db, 'account.deferral', sched.id, { board: tamperedPostedDate }),
    /Recognition line dates cannot be changed on an active schedule/,
  );

  const tamperedPostedAmount = sched.board.map((l, i) => (i === 0 ? { ...l, amount: 50 } : l));
  assert.throws(
    () => write(db, 'account.deferral', sched.id, { board: tamperedPostedAmount }),
    /Posted recognition lines cannot be modified or removed/,
  );

  // applyDiff rejected:
  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) => (d.id === sched.id ? { ...d, board: tamperedPostedDate } : d)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedDb), { author: 'Admin', isAdmin: true }),
    /Recognition line dates cannot be changed on an active schedule/,
  );
});

test('deleting a line on an active schedule rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);

  const deletedBoard = sched.board.slice(0, 11);

  // ORM write rejected:
  assert.throws(
    () => write(db, 'account.deferral', sched.id, { board: deletedBoard }),
    /Recognition lines cannot be added or removed from an active schedule/,
  );

  // applyDiff rejected:
  const deletedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) => (d.id === sched.id ? { ...d, board: deletedBoard } : d)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, deletedDb), { author: 'Admin', isAdmin: true }),
    /Recognition lines cannot be added or removed from an active schedule/,
  );
});

test('Cancel button diff accepted through applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  // Starts in future: 12 draft entries, 0 posted
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);

  const btn = deferredModels['account.deferral'].form.buttons.find((b) => b.label === 'Cancel');
  assert.ok(btn);
  const cancelledRes = btn.run(db, sched);
  const serverDb = applyDiff(db, diffDb(db, cancelledRes.db), { author: 'Admin', isAdmin: true });
  const serverSched = read(serverDb, 'account.deferral', sched.id);
  assert.equal(serverSched.state, 'cancel');
  assert.ok(serverSched.board.every((l) => l.cancelled === true));
  for (const line of serverSched.board) {
    const move = read(serverDb, 'account.move', line.move_id);
    assert.equal(move.state, 'cancel');
    assert.equal(move.auto_post, 'no');
  }
});

test('fieldReadonly locks deferral fields once not draft', () => {
  const fields = deferredModels['account.deferral'].fields;
  const lockedFields = ['board', 'amount', 'start_date', 'end_date', 'months', 'deferred_account_id', 'recognition_account_id', 'kind', 'company_id'];

  for (const f of lockedFields) {
    assert.equal(fieldReadonly(fields[f], { state: 'draft' }, {}), false, `${f} editable in draft`);
    assert.equal(fieldReadonly(fields[f], { state: 'running' }, {}), true, `${f} readonly in running`);
    assert.equal(fieldReadonly(fields[f], { state: 'done' }, {}), true, `${f} readonly in done`);
    assert.equal(fieldReadonly(fields[f], { state: 'cancel' }, {}), true, `${f} readonly in cancel`);
  }
});

test('postEntry rejects unknown state value', () => {
  const db = setupCompany(seed(), 'expense');
  assert.throws(
    () => postEntry(db, { journal: 'MISC', state: 'unknown', lines: [] }),
    /Entry state must be posted or draft/,
  );
});

test('appending a due line on an active schedule rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);

  const appendedBoard = [...sched.board, { date: '2027-12-31', amount: 100, posted: false, move_id: null }];

  assert.throws(
    () => write(db, 'account.deferral', sched.id, { board: appendedBoard }),
    /Recognition lines cannot be added or removed from an active schedule/,
  );

  const appendedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) => (d.id === sched.id ? { ...d, board: appendedBoard } : d)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, appendedDb), { author: 'Admin', isAdmin: true }),
    /Recognition lines cannot be added or removed from an active schedule/,
  );
});

test('changing an unposted line date on an active schedule rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);

  const tamperedDateBoard = sched.board.map((l, i) => (i === 5 ? { ...l, date: '2027-05-15' } : l));

  assert.throws(
    () => write(db, 'account.deferral', sched.id, { board: tamperedDateBoard }),
    /Recognition line dates cannot be changed on an active schedule/,
  );

  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) => (d.id === sched.id ? { ...d, board: tamperedDateBoard } : d)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedDb), { author: 'Admin', isAdmin: true }),
    /Recognition line dates cannot be changed on an active schedule/,
  );
});

test('relinking a line on an active schedule rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);
  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);

  const relinkedBoard = sched.board.map((l, i) => (i === 5 ? { ...l, move_id: sched.board[0].move_id } : l));

  assert.throws(
    () => write(db, 'account.deferral', sched.id, { board: relinkedBoard }),
    /Recognition lines cannot be relinked to another entry/,
  );

  const relinkedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) => (d.id === sched.id ? { ...d, board: relinkedBoard } : d)),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, relinkedDb), { author: 'Admin', isAdmin: true }),
    /Recognition lines cannot be relinked to another entry/,
  );
});

test('reverting credit note after rescaled draft auto-posts reverses interim move and restores recognition without rewriting posted move', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);

  const p = create(db, 'account.payment', {
    partner_id: 2,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 1200,
    date: '2026-11-16',
  });
  db = postPayment(p.db, read(p.db, 'account.payment', p.id));
  db = write(db, 'account.move', billDraft.id, { amount_paid: 1200 });

  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);
  assert.equal(sched.board.length, 12);
  assert.equal(sched.board[0].amount, 100);

  const cn = creditNote(db, read(db, 'account.move', billDraft.id), { date: '2026-11-20' });
  const cnId = cn.credit_note_id ?? cn.id;
  const cnDraft = read(cn.db, 'account.move', cnId);
  const cnWithPartial = write(cn.db, 'account.move', cnId, {
    invoice_line_ids: [{ ...cnDraft.invoice_line_ids[0], price_unit: 300 }],
  });
  db = postMove(cnWithPartial, cnId);

  let updatedSched = read(db, 'account.deferral', sched.id);
  assert.equal(updatedSched.board[0].amount, 75);
  const rescaledMoveId = updatedSched.board[0].move_id;
  assert.equal(read(db, 'account.move', rescaledMoveId).state, 'draft');

  t.mock.timers.setTime(new Date('2026-12-31T12:00:00Z').getTime());
  db = postAutoPostMoves(db, '2026-12-31');

  const moveM1 = read(db, 'account.move', rescaledMoveId);
  assert.equal(moveM1.state, 'posted');
  const moveM1Lines = JSON.stringify(moveM1.line_ids);

  const prevDb = db;
  db = write(db, 'account.move', cnId, { state: 'draft' });

  const serverDb = applyDiff(prevDb, diffDb(prevDb, db), { author: 'Admin', isAdmin: true });
  assert.ok(serverDb);

  const moveM1After = read(db, 'account.move', rescaledMoveId);
  assert.equal(moveM1After.state, 'posted', 'posted move is not rewritten to draft');
  assert.equal(JSON.stringify(moveM1After.line_ids), moveM1Lines, 'posted move lines are untouched');

  const moves = search(db, 'account.move');
  const reversalMove = moves.find((m) => m.reversed_entry_id === moveM1.id);
  assert.ok(reversalMove, 'reversal move exists');
  assert.equal(reversalMove.state, 'posted');

  const finalSched = read(db, 'account.deferral', sched.id);
  assert.equal(finalSched.board[0].amount, 100);
  assert.equal(finalSched.board[0].posted, true);
  assert.notEqual(finalSched.board[0].move_id, rescaledMoveId, 'board points to fresh move');

  const freshMove = read(db, 'account.move', finalSched.board[0].move_id);
  assert.equal(freshMove.state, 'posted');
  const freshMoveDebit = (freshMove.line_ids ?? []).reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  assert.equal(freshMoveDebit, 100);

  const expAccount = accountId(db, '600000');
  const month1Entries = [moveM1After, reversalMove, freshMove];
  const netMonth1 = month1Entries.reduce((net, m) => {
    const line = m.line_ids.find((l) => l.account_id === expAccount);
    return net + ((Number(line?.debit) || 0) - (Number(line?.credit) || 0));
  }, 0);
  assert.equal(netMonth1, 100, 'net recognition for Month 1 is exactly 100');

  const allDeferralMoves = moves.filter((m) => m.ref?.startsWith('Deferral of') || m.ref?.startsWith('Reset of') || m.reversed_entry_id === moveM1.id);
  const totalNet = allDeferralMoves.reduce((net, m) => {
    const line = m.line_ids.find((l) => l.account_id === expAccount);
    return net + ((Number(line?.debit) || 0) - (Number(line?.credit) || 0));
  }, 0);
  assert.equal(totalNet, 1200, 'total net recognition across all entries is 1200');

  assert.equal(finalSched.state, 'running');
});

test('credit note reset after a restored draft entry became due posts it and keeps schedule state consistent', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const billDraft = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(billDraft.db, billDraft.id);

  const p = create(db, 'account.payment', {
    partner_id: 2,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 1200,
    date: '2026-11-16',
  });
  db = postPayment(p.db, read(p.db, 'account.payment', p.id));
  db = write(db, 'account.move', billDraft.id, { amount_paid: 1200 });

  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === billDraft.id);

  const cn = creditNote(db, read(db, 'account.move', billDraft.id), { date: '2026-11-20' });
  const cnId = cn.credit_note_id ?? cn.id;
  const cnDraft = read(cn.db, 'account.move', cnId);
  const cnWithPartial = write(cn.db, 'account.move', cnId, {
    invoice_line_ids: [{ ...cnDraft.invoice_line_ids[0], price_unit: 300 }],
  });
  db = postMove(cnWithPartial, cnId);

  // Advance time to 2026-12-31 WITHOUT running the auto-post runner
  t.mock.timers.setTime(new Date('2026-12-31T12:00:00Z').getTime());

  const schedBeforeReset = read(db, 'account.deferral', sched.id);
  const m1Before = read(db, 'account.move', schedBeforeReset.board[0].move_id);
  assert.equal(m1Before.state, 'draft');

  const prevDb = db;
  db = write(db, 'account.move', cnId, { state: 'draft' });

  const serverDb = applyDiff(prevDb, diffDb(prevDb, db), { author: 'Admin', isAdmin: true });
  assert.ok(serverDb);

  const finalSched = read(db, 'account.deferral', sched.id);
  assert.equal(finalSched.board[0].amount, 100);
  assert.equal(finalSched.board[0].posted, true, 'due restored entry is posted on reset');

  const m1After = read(db, 'account.move', finalSched.board[0].move_id);
  assert.equal(m1After.state, 'posted', 'linked entry is posted');
  const m1Debit = (m1After.line_ids ?? []).reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  assert.equal(m1Debit, 100);

  for (let i = 1; i < 12; i++) {
    assert.equal(finalSched.board[i].posted, false);
    const m = read(db, 'account.move', finalSched.board[i].move_id);
    assert.equal(m.state, 'draft');
    assert.equal(m.auto_post, 'at_date');
  }

  assert.equal(finalSched.state, 'running');
});

test('appending a fake adjustment with unposted credit note rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const bill = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(bill.db, bill.id);
  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === bill.id);

  // Draft credit note (not posted)
  const cn = creditNote(db, read(db, 'account.move', bill.id), { date: '2026-11-20' });
  const cnId = cn.credit_note_id ?? cn.id;
  db = cn.db;

  const fakeAdj = {
    note_id: cnId,
    board_before: sched.board,
    state_before: sched.state,
    move_ids: [],
  };
  const rescaledBoard = sched.board.map((l) => ({ ...l, amount: 75 }));

  assert.throws(
    () => write(db, 'account.deferral', sched.id, {
      board: rescaledBoard,
      credit_adjustments: [...(sched.credit_adjustments ?? []), fakeAdj],
    }),
    /Referenced credit note must exist and be posted/,
  );

  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) =>
        d.id === sched.id ? { ...d, board: rescaledBoard, credit_adjustments: [...(sched.credit_adjustments ?? []), fakeAdj] } : d
      ),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedDb), { author: 'Admin', isAdmin: true }),
    /Referenced credit note must exist and be posted/,
  );
});

test('appending a fake adjustment with wrong source credit note rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const bill1 = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(bill1.db, bill1.id);
  const sched1 = search(db, 'account.deferral').find((d) => d.source_move_id === bill1.id);

  // Bill 2 and its credit note
  const bill2 = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200, lineName: 'Other Service' });
  db = postMove(bill2.db, bill2.id);
  const cn2 = creditNote(db, read(db, 'account.move', bill2.id), { date: '2026-11-20' });
  const cn2Id = cn2.credit_note_id ?? cn2.id;
  db = postMove(cn2.db, cn2Id);

  const fakeAdj = {
    note_id: cn2Id,
    board_before: sched1.board,
    state_before: sched1.state,
    move_ids: [],
  };
  const rescaledBoard = sched1.board.map((l) => ({ ...l, amount: 75 }));

  assert.throws(
    () => write(db, 'account.deferral', sched1.id, {
      board: rescaledBoard,
      credit_adjustments: [...(sched1.credit_adjustments ?? []), fakeAdj],
    }),
    /Referenced credit note must reverse the source document of this schedule/,
  );

  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) =>
        d.id === sched1.id ? { ...d, board: rescaledBoard, credit_adjustments: [...(sched1.credit_adjustments ?? []), fakeAdj] } : d
      ),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedDb), { author: 'Admin', isAdmin: true }),
    /Referenced credit note must reverse the source document of this schedule/,
  );
});

test('appending a duplicate credit adjustment rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const bill = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(bill.db, bill.id);

  // Pay bill
  const p = create(db, 'account.payment', {
    partner_id: 2,
    partner_type: 'supplier',
    payment_type: 'outbound',
    amount: 1200,
    date: '2026-11-16',
  });
  db = postPayment(p.db, read(p.db, 'account.payment', p.id));
  db = write(db, 'account.move', bill.id, { amount_paid: 1200 });

  const sched = search(db, 'account.deferral').find((d) => d.source_move_id === bill.id);

  // Post real credit note
  const cn = creditNote(db, read(db, 'account.move', bill.id), { date: '2026-11-20' });
  const cnId = cn.credit_note_id ?? cn.id;
  const cnDraft = read(cn.db, 'account.move', cnId);
  const cnWithPartial = write(cn.db, 'account.move', cnId, {
    invoice_line_ids: [{ ...cnDraft.invoice_line_ids[0], price_unit: 300 }],
  });
  db = postMove(cnWithPartial, cnId);

  const updatedSched = read(db, 'account.deferral', sched.id);
  assert.equal((updatedSched.credit_adjustments ?? []).length, 1);

  // Duplicate adjustment with same note_id
  const duplicateAdj = {
    note_id: cnId,
    board_before: updatedSched.board,
    state_before: updatedSched.state,
    move_ids: [],
  };
  const furtherRescaled = updatedSched.board.map((l) => ({ ...l, amount: 50 }));

  assert.throws(
    () => write(db, 'account.deferral', sched.id, {
      board: furtherRescaled,
      credit_adjustments: [...updatedSched.credit_adjustments, duplicateAdj],
    }),
    /Credit note is already referenced by an adjustment on this schedule/,
  );

  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) =>
        d.id === sched.id ? { ...d, board: furtherRescaled, credit_adjustments: [...updatedSched.credit_adjustments, duplicateAdj] } : d
      ),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedDb), { author: 'Admin', isAdmin: true }),
    /Credit note is already referenced by an adjustment on this schedule/,
  );
});

test('linking an unlinked line to another schedules entry rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  const bill1 = createDeferredBill(db, { startDate: '2026-12-01', endDate: '2027-11-30', amount: 1200 });
  db = postMove(bill1.db, bill1.id);
  const sched1 = search(db, 'account.deferral').find((d) => d.source_move_id === bill1.id);
  const move1 = sched1.board[0].move_id;

  // Create manual schedule with unlinked line
  const manCreated = create(db, 'account.deferral', {
    name: 'Manual Sched',
    kind: 'expense',
    amount: 100,
    start_date: '2026-12-01',
    end_date: '2026-12-31',
    months: 1,
    company_id: 1,
    deferred_account_id: accountId(db, '132000'),
    recognition_account_id: accountId(db, '600000'),
    board: [{ date: '2026-12-31', amount: 100, posted: false, move_id: null }],
    state: 'running',
  });
  db = manCreated.db;
  const manId = manCreated.id;

  // Attempt to link manSched line to bill1's move
  const linkedBoard = [{ date: '2026-12-31', amount: 100, posted: false, move_id: move1 }];

  assert.throws(
    () => write(db, 'account.deferral', manId, { board: linkedBoard }),
    /Recognition entry is already referenced by another recognition line/,
  );

  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) =>
        d.id === manId ? { ...d, board: linkedBoard } : d
      ),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedDb), { author: 'Admin', isAdmin: true }),
    /Recognition entry is already referenced by another recognition line/,
  );
});

test('linking an unlinked line to an unrelated entry with same total rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  // Unrelated entry with total 100
  const unrelated = postEntry(db, {
    journal: 'MISC',
    date: '2026-12-31',
    lines: [
      { account_id: accountId(db, '620000'), debit: 100 },
      { account_id: accountId(db, '230000'), credit: 100 },
    ],
  });
  db = unrelated.db;
  const unrelatedId = unrelated.id;

  const manCreated = create(db, 'account.deferral', {
    name: 'Manual Sched',
    kind: 'expense',
    amount: 100,
    start_date: '2026-12-01',
    end_date: '2026-12-31',
    months: 1,
    company_id: 1,
    deferred_account_id: accountId(db, '132000'),
    recognition_account_id: accountId(db, '600000'),
    board: [{ date: '2026-12-31', amount: 100, posted: false, move_id: null }],
    state: 'running',
  });
  db = manCreated.db;
  const manId = manCreated.id;

  const linkedBoard = [{ date: '2026-12-31', amount: 100, posted: false, move_id: unrelatedId }];

  assert.throws(
    () => write(db, 'account.deferral', manId, { board: linkedBoard }),
    /Linked recognition entry type does not match schedule/,
  );

  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) =>
        d.id === manId ? { ...d, board: linkedBoard } : d
      ),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedDb), { author: 'Admin', isAdmin: true }),
    /Linked recognition entry type does not match schedule/,
  );
});

test('linking an unlinked line to an entry with wrong accounts rejected through ORM write and applyDiff', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-16T12:00:00Z') });
  let db = setupCompany(seed(), 'expense');
  // Entry with deferred_entry_type: 'expense' but wrong accounts (e.g. 610000 instead of 600000)
  const wrongAccEntry = postEntry(db, {
    journal: 'MISC',
    date: '2026-12-31',
    deferred_entry_type: 'expense',
    lines: [
      { account_id: accountId(db, '610000'), debit: 100 },
      { account_id: accountId(db, '132000'), credit: 100 },
    ],
  });
  db = wrongAccEntry.db;
  const wrongAccId = wrongAccEntry.id;

  const manCreated = create(db, 'account.deferral', {
    name: 'Manual Sched',
    kind: 'expense',
    amount: 100,
    start_date: '2026-12-01',
    end_date: '2026-12-31',
    months: 1,
    company_id: 1,
    deferred_account_id: accountId(db, '132000'),
    recognition_account_id: accountId(db, '600000'),
    board: [{ date: '2026-12-31', amount: 100, posted: false, move_id: null }],
    state: 'running',
  });
  db = manCreated.db;
  const manId = manCreated.id;

  const linkedBoard = [{ date: '2026-12-31', amount: 100, posted: false, move_id: wrongAccId }];

  assert.throws(
    () => write(db, 'account.deferral', manId, { board: linkedBoard }),
    /Linked recognition entry lines do not match expected recognition accounts or amounts/,
  );

  const tamperedDb = {
    ...db,
    records: {
      ...db.records,
      'account.deferral': db.records['account.deferral'].map((d) =>
        d.id === manId ? { ...d, board: linkedBoard } : d
      ),
    },
  };
  assert.throws(
    () => applyDiff(db, diffDb(db, tamperedDb), { author: 'Admin', isAdmin: true }),
    /Linked recognition entry lines do not match expected recognition accounts or amounts/,
  );
});
