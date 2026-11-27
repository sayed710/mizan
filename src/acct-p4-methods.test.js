import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, unlink, write } from './orm.js';
import { seed } from './seed.js';
import { models } from './models/index.js';
import { postMove } from './models/accounting.js';
import { postPayment } from './models/pay.js';
import { accountId } from './models/ledger.js';
import { applyDiff, diffDb } from './sync.js';
import { migrate } from './migrations.js';

const sync = (db, next, opts) => applyDiff(db, diffDb(db, next), opts);

test('seeded payment methods and seeded bank/cash journal method lines', () => {
  const db = seed();
  assert.ok(models['account.payment.method'], 'account.payment.method model is registered');
  assert.ok(models['account.payment.method.line'], 'account.payment.method.line model is registered');

  const methods = search(db, 'account.payment.method');
  assert.equal(methods.length, 5);
  const summary = methods.map((m) => [m.name, m.code, m.payment_type]);
  assert.deepEqual(summary, [
    ['Manual', 'manual', 'inbound'],
    ['Manual', 'manual', 'outbound'],
    ['Checks', 'check_printing', 'outbound'],
    ['Electronic', 'electronic', 'inbound'],
    ['SEPA Credit Transfer', 'sepa_ct', 'outbound'],
  ]);

  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cash = search(db, 'account.journal').find((j) => j.code === 'CSH1');
  assert.equal(bank.inbound_payment_method_line_ids.length, 1);
  assert.equal(bank.inbound_payment_method_line_ids[0].name, 'Manual');
  assert.equal(read(db, 'account.payment.method', bank.inbound_payment_method_line_ids[0].payment_method_id).code, 'manual');

  assert.equal(bank.outbound_payment_method_line_ids.length, 2);
  assert.deepEqual(
    bank.outbound_payment_method_line_ids.map((l) => read(db, 'account.payment.method', l.payment_method_id).code),
    ['manual', 'check_printing'],
  );

  assert.equal(cash.inbound_payment_method_line_ids.length, 1);
  assert.equal(cash.outbound_payment_method_line_ids.length, 1);
  assert.equal(read(db, 'account.payment.method', cash.outbound_payment_method_line_ids[0].payment_method_id).code, 'manual');
});

test('new bank and cash journals get default method lines and tabs on the journal form', () => {
  let db = seed();
  const bankAcc = accountId(db, '101401');
  const cashAcc = accountId(db, '101501');
  const suspense = accountId(db, '101404');

  const bnk = create(db, 'account.journal', {
    name: 'Secondary Bank',
    code: 'BNK2',
    type: 'bank',
    company_id: 1,
    default_account_id: bankAcc,
    suspense_account_id: suspense,
  });
  db = bnk.db;
  const bnkRec = read(db, 'account.journal', bnk.id);
  assert.equal(bnkRec.inbound_payment_method_line_ids.length, 1);
  assert.equal(bnkRec.outbound_payment_method_line_ids.length, 2);
  assert.deepEqual(
    bnkRec.outbound_payment_method_line_ids.map((l) => read(db, 'account.payment.method', l.payment_method_id).code),
    ['manual', 'check_printing'],
  );

  const csh = create(db, 'account.journal', {
    name: 'Petty Cash',
    code: 'CSH2',
    type: 'cash',
    company_id: 1,
    default_account_id: cashAcc,
    suspense_account_id: suspense,
  });
  db = csh.db;
  const cshRec = read(db, 'account.journal', csh.id);
  assert.equal(cshRec.inbound_payment_method_line_ids.length, 1);
  assert.equal(cshRec.outbound_payment_method_line_ids.length, 1);
  assert.equal(read(db, 'account.payment.method', cshRec.outbound_payment_method_line_ids[0].payment_method_id).code, 'manual');

  const misc = create(db, 'account.journal', { name: 'Misc Test', code: 'MSC2', type: 'general' });
  const miscLines = search(misc.db, 'account.payment.method.line').filter((l) => l.journal_id === misc.id);
  assert.equal(miscLines.length, 0);

  // Editing journal outbound_payment_method_line_ids via journal form/ORM syncs lines and strips computed array
  const extraAccount = create(db, 'account.account', { code: '101466', name: 'Check Clearing', account_type: 'asset_current', reconcile: true, company_id: 1 });
  db = extraAccount.db;
  const outLines = read(db, 'account.journal', bnk.id).outbound_payment_method_line_ids;
  db = write(db, 'account.journal', bnk.id, {
    outbound_payment_method_line_ids: [
      { ...outLines[0], name: 'Wire / Manual' },
      { ...outLines[1], payment_account_id: extraAccount.id },
    ],
  });
  const updatedBnk = read(db, 'account.journal', bnk.id);
  assert.equal(updatedBnk.outbound_payment_method_line_ids[0].name, 'Wire / Manual');
  assert.equal(updatedBnk.outbound_payment_method_line_ids[1].payment_account_id, extraAccount.id);
  const rawJournal = db.records['account.journal'].find((j) => j.id === bnk.id);
  assert.equal('outbound_payment_method_line_ids' in rawJournal, false);
  assert.equal('inbound_payment_method_line_ids' in rawJournal, false);

  const bankTabs = models['account.journal'].form.tabs(bnkRec);
  const inTab = bankTabs.find((tab) => tab.label === 'Incoming Payments');
  const outTab = bankTabs.find((tab) => tab.label === 'Outgoing Payments');
  assert.ok(inTab.fields?.includes('inbound_payment_method_line_ids'));
  assert.ok(outTab.fields?.includes('outbound_payment_method_line_ids'));
});

test('payment defaults payment_method_line_id by sequence, filters domain, resets on journal/direction change, and requires it on post', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cash = search(db, 'account.journal').find((j) => j.code === 'CSH1');
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing',
  );
  const manualOutLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'manual',
  );
  // Make Checks first by sequence on BNK1 outbound
  db = write(db, 'account.payment.method.line', checkLine.id, { sequence: 1 });
  db = write(db, 'account.payment.method.line', manualOutLine.id, { sequence: 20 });

  const outPay = create(db, 'account.payment', {
    partner_id: 2,
    partner_type: 'supplier',
    payment_type: 'outbound',
    journal_id: bank.id,
    amount: 50,
    date: '2026-01-10',
  });
  db = outPay.db;
  const p = read(db, 'account.payment', outPay.id);
  assert.equal(p.payment_method_line_id, checkLine.id, 'default is first line by sequence');

  // Domain only includes lines of the payment journal and direction
  const domain = models['account.payment'].fields.payment_method_line_id.domain;
  const allLines = search(db, 'account.payment.method.line');
  const allowedIds = allLines.filter((l) => domain(l, p, db)).map((l) => l.id).sort((a, b) => a - b);
  assert.deepEqual(allowedIds, [checkLine.id, manualOutLine.id].sort((a, b) => a - b));

  // Changing direction resets payment_method_line_id
  const flipped = write(db, 'account.payment', p.id, { payment_type: 'inbound' });
  const flippedRec = read(flipped, 'account.payment', p.id);
  assert.equal(flippedRec.payment_method_line_id, bank.inbound_payment_method_line_ids[0].id);

  // Changing journal resets payment_method_line_id
  const moved = write(flipped, 'account.payment', p.id, { journal_id: cash.id });
  const movedRec = read(moved, 'account.payment', p.id);
  assert.equal(movedRec.payment_method_line_id, cash.inbound_payment_method_line_ids[0].id);

  // Required when posting on bank/cash journal
  const cleared = write(moved, 'account.payment', p.id, { payment_method_line_id: null });
  assert.throws(() => postPayment(cleared, read(cleared, 'account.payment', p.id)), /payment method/i);
  assert.throws(() => write(cleared, 'account.payment', p.id, { state: 'posted' }), /payment method/i);
});

test('payment_account_id override on method line is used for the outstanding line when posting', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const fallbackAcc = create(db, 'account.account', {
    code: '101488',
    name: 'Journal Fallback Receipts',
    account_type: 'asset_current',
    reconcile: true,
    company_id: 1,
  });
  db = fallbackAcc.db;
  const overrideAcc = create(db, 'account.account', {
    code: '101499',
    name: 'Method Override Receipts',
    account_type: 'asset_current',
    reconcile: true,
    company_id: 1,
  });
  db = overrideAcc.db;
  db = write(db, 'account.journal', bank.id, { outstanding_receipts_account_id: fallbackAcc.id });

  const inboundLineId = bank.inbound_payment_method_line_ids[0].id;
  db = write(db, 'account.payment.method.line', inboundLineId, { payment_account_id: overrideAcc.id });

  const p1 = create(db, 'account.payment', {
    partner_id: 1,
    partner_type: 'customer',
    payment_type: 'inbound',
    journal_id: bank.id,
    payment_method_line_id: inboundLineId,
    amount: 120,
    date: '2026-01-12',
  });
  db = postPayment(p1.db, read(p1.db, 'account.payment', p1.id));
  const posted1 = read(db, 'account.payment', p1.id);
  assert.equal(posted1.outstanding_account_id, overrideAcc.id);
  const move1 = read(db, 'account.move', posted1.move_id);
  assert.ok(move1.line_ids.some((l) => l.account_id === overrideAcc.id && l.debit === 120));

  // Clearing payment_account_id falls back to outstandingAccount()
  db = write(db, 'account.payment.method.line', inboundLineId, { payment_account_id: null });
  const p2 = create(db, 'account.payment', {
    partner_id: 1,
    partner_type: 'customer',
    payment_type: 'inbound',
    journal_id: bank.id,
    payment_method_line_id: inboundLineId,
    amount: 80,
    date: '2026-01-13',
  });
  db = postPayment(p2.db, read(p2.db, 'account.payment', p2.id));
  const posted2 = read(db, 'account.payment', p2.id);
  assert.equal(posted2.outstanding_account_id, fallbackAcc.id);
  const move2 = read(db, 'account.move', posted2.move_id);
  assert.ok(move2.line_ids.some((l) => l.account_id === fallbackAcc.id && l.debit === 80));

  // Invoice-linked payment via postPayment also uses payment_account_id override
  db = write(db, 'account.payment.method.line', inboundLineId, { payment_account_id: overrideAcc.id });
  const inv = create(db, 'account.move', {
    move_type: 'out_invoice',
    partner_id: 1,
    invoice_date: '2026-01-14',
    invoice_line_ids: [{ product_id: 1, qty: 1, price_unit: 50, tax: 0 }],
  });
  db = postMove(inv.db, inv.id);
  const p3 = create(db, 'account.payment', {
    partner_id: 1,
    partner_type: 'customer',
    payment_type: 'inbound',
    journal_id: bank.id,
    payment_method_line_id: inboundLineId,
    invoice_id: inv.id,
    amount: 50,
    date: '2026-01-15',
  });
  db = postPayment(p3.db, read(p3.db, 'account.payment', p3.id));
  const posted3 = read(db, 'account.payment', p3.id);
  assert.equal(posted3.outstanding_account_id, overrideAcc.id);
  assert.ok(read(db, 'account.move', posted3.move_id).line_ids.some((l) => l.account_id === overrideAcc.id && l.debit === 50));
});

test('guards are enforced via ORM and via diffDb + applyDiff', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cash = search(db, 'account.journal').find((j) => j.code === 'CSH1');
  const misc = search(db, 'account.journal').find((j) => j.code === 'MISC');
  const manualInMethod = search(db, 'account.payment.method').find((m) => m.code === 'manual' && m.payment_type === 'inbound');
  const manualOutMethod = search(db, 'account.payment.method').find((m) => m.code === 'manual' && m.payment_type === 'outbound');

  // 1. Payment method line must belong to payment journal and direction
  const cashInLine = cash.inbound_payment_method_line_ids[0];
  const bankOutLine = bank.outbound_payment_method_line_ids[0];
  const bankInLine = bank.inbound_payment_method_line_ids[0];

  assert.throws(() => create(db, 'account.payment', {
    partner_id: 1, partner_type: 'customer', payment_type: 'inbound', journal_id: bank.id, payment_method_line_id: cashInLine.id, amount: 10,
  }), /journal/i);
  assert.throws(() => create(db, 'account.payment', {
    partner_id: 1, partner_type: 'customer', payment_type: 'inbound', journal_id: bank.id, payment_method_line_id: bankOutLine.id, amount: 10,
  }), /direction/i);

  const validDraft = create(db, 'account.payment', {
    partner_id: 1, partner_type: 'customer', payment_type: 'inbound', journal_id: bank.id, payment_method_line_id: bankInLine.id, amount: 10, date: '2026-01-10',
  });
  db = validDraft.db;
  const tamperedJournal = { ...db, records: { ...db.records, 'account.payment': db.records['account.payment'].map((p) => p.id === validDraft.id ? { ...p, payment_method_line_id: cashInLine.id } : p) } };
  assert.throws(() => sync(db, tamperedJournal), /journal/i);

  const tamperedDir = { ...db, records: { ...db.records, 'account.payment': db.records['account.payment'].map((p) => p.id === validDraft.id ? { ...p, payment_method_line_id: bankOutLine.id } : p) } };
  assert.throws(() => sync(db, tamperedDir), /direction/i);

  const tamperedClearPost = { ...db, records: { ...db.records, 'account.payment': db.records['account.payment'].map((p) => p.id === validDraft.id ? { ...p, state: 'posted', payment_method_line_id: null } : p) } };
  assert.throws(() => sync(db, tamperedClearPost), /payment method/i);

  // 2. Method line journal must be bank or cash (rejects misc and credit)
  assert.throws(() => create(db, 'account.payment.method.line', {
    name: 'Bad Misc Line', payment_method_id: manualInMethod.id, journal_id: misc.id,
  }), /bank and cash/i);
  const creditJournal = create(db, 'account.journal', {
    name: 'Credit Card', code: 'CRD9', type: 'credit', company_id: 1, default_account_id: accountId(db, '101401'), suspense_account_id: accountId(db, '101404'),
  });
  assert.throws(() => create(creditJournal.db, 'account.payment.method.line', {
    name: 'Bad Credit Line', payment_method_id: manualInMethod.id, journal_id: creditJournal.id,
  }), /bank and cash/i);

  const forgedLine = {
    ...db,
    records: {
      ...db.records,
      'account.payment.method.line': [...db.records['account.payment.method.line'], {
        id: 9001, name: 'Forged Misc Line', payment_method_id: manualInMethod.id, journal_id: misc.id, payment_type: 'inbound', sequence: 10, company_id: 1,
      }],
    },
  };
  assert.throws(() => sync(db, forgedLine), /bank and cash/i);

  // 3. payment_account_id must be active, reconcilable, and of the journal's company
  const nonReconcilable = create(db, 'account.account', { code: '101477', name: 'Non Reconcilable', account_type: 'asset_current', reconcile: false, company_id: 1 });
  db = nonReconcilable.db;
  const archivedAcc = create(db, 'account.account', { code: '101478', name: 'Archived Rec', account_type: 'asset_current', reconcile: true, active: false, company_id: 1 });
  db = archivedAcc.db;
  const otherCo = create(db, 'res.company', { name: 'Other Co', currency_id: db.settings.base_currency_id });
  db = otherCo.db;
  const foreignAcc = create(db, 'account.account', { code: '101479', name: 'Foreign Rec', account_type: 'asset_current', reconcile: true, company_id: otherCo.id });
  db = foreignAcc.db;

  assert.throws(() => write(db, 'account.payment.method.line', bankInLine.id, { payment_account_id: nonReconcilable.id }), /reconcilable/i);
  assert.throws(() => write(db, 'account.payment.method.line', bankInLine.id, { payment_account_id: archivedAcc.id }), /active/i);
  assert.throws(() => write(db, 'account.payment.method.line', bankInLine.id, { payment_account_id: foreignAcc.id }), /company/i);

  const forgedNonRec = { ...db, records: { ...db.records, 'account.payment.method.line': db.records['account.payment.method.line'].map((l) => l.id === bankInLine.id ? { ...l, payment_account_id: nonReconcilable.id } : l) } };
  assert.throws(() => sync(db, forgedNonRec), /reconcilable/i);

  const forgedForeign = { ...db, records: { ...db.records, 'account.payment.method.line': db.records['account.payment.method.line'].map((l) => l.id === bankInLine.id ? { ...l, payment_account_id: foreignAcc.id } : l) } };
  assert.throws(() => sync(db, forgedForeign), /company/i);

  // 4. Method line used by a posted payment cannot be deleted (ORM & sync), while unused line can
  const extraLine = create(db, 'account.payment.method.line', {
    name: 'Extra Outbound', payment_method_id: manualOutMethod.id, journal_id: bank.id, sequence: 30,
  });
  db = extraLine.db;
  const postedDb = postPayment(db, read(db, 'account.payment', validDraft.id));
  assert.throws(() => unlink(postedDb, 'account.payment.method.line', [bankInLine.id]), /posted payment/i);
  const deletedInDiff = {
    ...postedDb,
    records: {
      ...postedDb.records,
      'account.payment.method.line': postedDb.records['account.payment.method.line'].filter((l) => l.id !== bankInLine.id),
    },
  };
  assert.throws(() => sync(postedDb, deletedInDiff), /posted payment/i);

  assert.doesNotThrow(() => unlink(postedDb, 'account.payment.method.line', [extraLine.id]));
});

test('migration adds seeded payment methods and default lines to existing bank and cash journals', () => {
  const base = seed();
  const bank = search(base, 'account.journal').find((j) => j.code === 'BNK1');
  const cash = search(base, 'account.journal').find((j) => j.code === 'CSH1');
  const legacyDb = {
    ...base,
    schema_version: 59,
    records: {
      ...base.records,
      'account.payment.method': [],
      'account.payment.method.line': [],
    },
    seq: {
      ...base.seq,
      'account.payment.method': 0,
      'account.payment.method.line': 0,
    },
  };

  const migrated = migrate(legacyDb);
  assert.equal(migrated.schema_version, 82);
  assert.equal(search(migrated, 'account.payment.method').length, 5);

  const migratedBank = read(migrated, 'account.journal', bank.id);
  const migratedCash = read(migrated, 'account.journal', cash.id);
  assert.equal(migratedBank.inbound_payment_method_line_ids.length, 1);
  assert.equal(migratedBank.outbound_payment_method_line_ids.length, 2);
  assert.deepEqual(
    migratedBank.outbound_payment_method_line_ids.map((l) => read(migrated, 'account.payment.method', l.payment_method_id).code),
    ['manual', 'check_printing'],
  );
  assert.equal(migratedCash.inbound_payment_method_line_ids.length, 1);
  assert.equal(migratedCash.outbound_payment_method_line_ids.length, 1);
  assert.equal(read(migrated, 'account.payment.method', migratedCash.outbound_payment_method_line_ids[0].payment_method_id).code, 'manual');

  // Idempotent on re-run
  assert.equal(migrate(migrated), migrated);
});

test('Bug 1: default internal transfers can be confirmed and preserve chosen method line', () => {
  let db = seed();
  const transferAcc = create(db, 'account.account', {
    code: '101450',
    name: 'Internal Transfers',
    account_type: 'asset_current',
    reconcile: true,
    company_id: 1,
  });
  db = write(transferAcc.db, 'res.company', 1, { transfer_account_id: transferAcc.id });

  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const cash = search(db, 'account.journal').find((j) => j.code === 'CSH1');

  // 1. Create internal transfer with default payment_type ('inbound')
  const transfer = create(db, 'account.payment', {
    is_internal_transfer: true,
    journal_id: bank.id,
    destination_journal_id: cash.id,
    amount: 100,
    date: '2026-01-20',
  });
  db = transfer.db;
  const initial = read(db, 'account.payment', transfer.id);
  assert.equal(initial.payment_type, 'inbound');

  // Confirm / post payment
  assert.doesNotThrow(() => {
    db = postPayment(db, initial);
  });
  const sourcePosted = read(db, 'account.payment', transfer.id);
  assert.equal(sourcePosted.state, 'posted');
  assert.equal(sourcePosted.payment_type, 'outbound');
  assert.ok(sourcePosted.payment_method_line_id);
  const sourceLine = read(db, 'account.payment.method.line', sourcePosted.payment_method_line_id);
  assert.equal(sourceLine.journal_id, bank.id);
  assert.equal(sourceLine.payment_type, 'outbound');

  // 2. Transfer with an explicit chosen outbound line (e.g. Checks) preserves that line when posted
  const checkLine = bank.outbound_payment_method_line_ids.find(
    (l) => read(db, 'account.payment.method', l.payment_method_id).code === 'check_printing',
  );
  assert.ok(checkLine);
  const transfer2 = create(db, 'account.payment', {
    is_internal_transfer: true,
    payment_type: 'outbound',
    journal_id: bank.id,
    destination_journal_id: cash.id,
    payment_method_line_id: checkLine.id,
    amount: 50,
    date: '2026-01-21',
  });
  db = transfer2.db;
  db = postPayment(db, read(db, 'account.payment', transfer2.id));
  const posted2 = read(db, 'account.payment', transfer2.id);
  assert.equal(posted2.payment_method_line_id, checkLine.id, 'preserves chosen outbound line');
});

test('Bug 2: existing draft bank payments can be posted after migration upgrade', () => {
  const base = seed();
  const bank = search(base, 'account.journal').find((j) => j.code === 'BNK1');
  const draftPayId = 9876;
  const legacyDb = {
    ...base,
    schema_version: 60,
    records: {
      ...base.records,
      'account.payment.method': [],
      'account.payment.method.line': [],
      'account.payment': [
        ...(base.records['account.payment'] ?? []),
        {
          id: draftPayId,
          name: '/',
          payment_type: 'inbound',
          partner_type: 'customer',
          partner_id: 1,
          journal_id: bank.id,
          amount: 150,
          date: '2026-01-15',
          state: 'draft',
          company_id: 1,
        },
      ],
    },
    seq: {
      ...base.seq,
      'account.payment.method': 0,
      'account.payment.method.line': 0,
      'account.payment': Math.max(base.seq['account.payment'] ?? 0, draftPayId),
    },
  };

  const migrated = migrate(legacyDb);
  const migratedPay = read(migrated, 'account.payment', draftPayId);
  assert.ok(migratedPay.payment_method_line_id, 'migrated draft payment has payment_method_line_id');
  assert.doesNotThrow(() => {
    postPayment(migrated, migratedPay);
  });
});

test('Bug 3: editing a journal does not delete its archived method lines', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const outLines = bank.outbound_payment_method_line_ids;
  assert.ok(outLines.length >= 2);
  const lineToArchive = outLines[1];

  // Archive the line
  db = write(db, 'account.payment.method.line', lineToArchive.id, { active: false });
  const archivedBefore = search(db, 'account.payment.method.line', { includeArchived: true }).find((l) => l.id === lineToArchive.id);
  assert.equal(archivedBefore.active, false);

  // Read journal's visible method lines
  const visibleOutLines = read(db, 'account.journal', bank.id).outbound_payment_method_line_ids;
  assert.ok(!visibleOutLines.some((l) => l.id === lineToArchive.id));

  // Edit the journal with visible lines
  db = write(db, 'account.journal', bank.id, {
    outbound_payment_method_line_ids: [
      { ...visibleOutLines[0], name: 'Manual Outbound Renamed' },
    ],
  });

  // Archived line must not have been deleted
  const archivedAfter = search(db, 'account.payment.method.line', { includeArchived: true }).find((l) => l.id === lineToArchive.id);
  assert.ok(archivedAfter, 'archived method line must still exist');
  assert.equal(archivedAfter.active, false);
});

test('Bug 4: journal method line edits and new journals are saved through applyDiff', () => {
  let db = seed();
  const bank = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const inLine = bank.inbound_payment_method_line_ids[0];
  const outLines = bank.outbound_payment_method_line_ids;

  const extraAccount = create(db, 'account.account', {
    code: '101477',
    name: 'Diff Method Line Account',
    account_type: 'asset_current',
    reconcile: true,
    company_id: 1,
  });
  db = extraAccount.db;

  // 1. Edit method lines via applyDiff
  const diff = {
    upserts: {
      'account.journal': [{
        ...read(db, 'account.journal', bank.id),
        inbound_payment_method_line_ids: [
          { ...inLine, name: 'Custom Inbound Name' },
        ],
        outbound_payment_method_line_ids: [
          { ...outLines[0], name: 'Custom Outbound Manual', payment_account_id: extraAccount.id },
          outLines[1],
        ],
      }],
    },
  };
  const synced = applyDiff(db, diff);
  const syncedBank = read(synced, 'account.journal', bank.id);
  assert.equal(syncedBank.inbound_payment_method_line_ids[0].name, 'Custom Inbound Name');
  assert.equal(syncedBank.outbound_payment_method_line_ids[0].name, 'Custom Outbound Manual');
  assert.equal(syncedBank.outbound_payment_method_line_ids[0].payment_account_id, extraAccount.id);

  // 2. New bank journal via applyDiff gets default method lines
  const newJournalDiff = {
    upserts: {
      'account.journal': [{
        id: 9988,
        name: 'Diff Bank',
        code: 'DBK',
        type: 'bank',
        company_id: 1,
        default_account_id: bank.default_account_id,
        suspense_account_id: bank.suspense_account_id,
        bank_statements_source: 'undefined',
      }],
    },
  };
  const syncedWithNew = applyDiff(synced, newJournalDiff);
  const newBank = read(syncedWithNew, 'account.journal', 9988);
  assert.equal(newBank.inbound_payment_method_line_ids.length, 1);
  assert.equal(newBank.outbound_payment_method_line_ids.length, 2);
});


test('Qodo PR #190: seeding default lines ignores the active company and never duplicates another company\'s lines', async () => {
  const { setActiveCompany, getActiveCompany } = await import('./orm.js');
  const { migratePaymentMethods } = await import('./models/paymentmethod.js');
  const db = migratePaymentMethods(seed());
  const lines = (d) => (d.records['account.payment.method.line'] ?? []).length;
  const before = lines(db);
  assert.ok(before > 0, 'the seed has bank/cash journal method lines');
  const previous = getActiveCompany();
  setActiveCompany(999);
  try {
    assert.equal(lines(migratePaymentMethods(db)), before, 'no duplicate default lines while another company is active');
  } finally {
    setActiveCompany(previous);
  }
});

test('Qodo PR #190: a shared journal\'s method lines all carry its company, so no company can own lines hidden from another', () => {
  let db = seed();
  const bnk = create(db, 'account.journal', {
    name: 'Shared Bank', code: 'SHB', type: 'bank', company_id: null,
    default_account_id: accountId(db, '101401'), suspense_account_id: accountId(db, '101404'),
  });
  db = bnk.db;
  const own = (d) => (d.records['account.payment.method.line'] ?? []).filter((l) => l.journal_id === bnk.id);
  assert.ok(own(db).length > 0);
  assert.ok(own(db).every((l) => l.company_id == null), 'default lines of a company-less journal are shared like the journal');

  const manualIn = search(db, 'account.payment.method').find((m) => m.code === 'manual' && m.payment_type === 'inbound');
  const added = create(db, 'account.payment.method.line', { journal_id: bnk.id, payment_method_id: manualIn.id, name: 'Other company line' });
  assert.equal(read(added.db, 'account.payment.method.line', added.id).company_id, null, 'a new line takes its journal company');
  const foreign = { ...added.db, records: { ...added.db.records, 'account.payment.method.line': added.db.records['account.payment.method.line'].map((l) => (l.id === added.id ? { ...l, company_id: 2 } : l)) } };
  assert.throws(() => sync(db, foreign), /journal company/, 'a line of another company on a shared journal is refused on a plain diff');
});

test('Qodo PR #190: shared bank journal offers its Checks line to every company, and a company change saves with inline rows', async () => {
  const { viewRecords } = await import('./companyView.js');
  const { setCompanies } = await import('./models/company.js');
  let db = seed();
  const company2 = create(db, 'res.company', { name: 'Second Co', currency_id: read(db, 'res.company', 1).currency_id });
  db = company2.db;
  const bnk = create(db, 'account.journal', {
    name: 'Shared Bank', code: 'SHB', type: 'bank', company_id: null,
    default_account_id: accountId(db, '101401'), suspense_account_id: accountId(db, '101404'),
  });
  db = bnk.db;
  const asCompany2 = setCompanies(db, { current: company2.id, allowed: [company2.id] });
  const outbound = viewRecords(asCompany2, 'account.payment.method.line').filter((l) => l.journal_id === bnk.id && l.payment_type === 'outbound');
  assert.deepEqual(outbound.map((l) => read(db, 'account.payment.method', l.payment_method_id).code).sort(), ['check_printing', 'manual']);

  const journal = read(db, 'account.journal', bnk.id);
  const moved = { ...journal, company_id: 1, outbound_payment_method_line_ids: journal.outbound_payment_method_line_ids.map((l) => ({ ...l, sequence: l.sequence + 1 })) };
  const next = write(db, 'account.journal', bnk.id, { company_id: 1, outbound_payment_method_line_ids: moved.outbound_payment_method_line_ids });
  const lines = (next.records['account.payment.method.line'] ?? []).filter((l) => l.journal_id === bnk.id);
  assert.ok(lines.length > 0 && lines.every((l) => l.company_id === 1), 'lines follow the journal to its new company');
  const synced = sync(db, next);
  assert.ok((synced.records['account.payment.method.line'] ?? []).filter((l) => l.journal_id === bnk.id).every((l) => l.company_id === 1));
});
