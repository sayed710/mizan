import './models/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SEEDED_PAYMENT_METHODS, defaultMethodSpecsForJournal, paymentMethodModels } from './models/paymentmethod.js';

async function addJournalMethods(db) {
  const { read, write } = await import('./orm.js');
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  const journal = read(db, 'account.journal', bank.id);
  const electronic = db.records['account.payment.method'].find((m) => m.code === 'electronic');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  return write(db, 'account.journal', bank.id, {
    inbound_payment_method_line_ids: [...journal.inbound_payment_method_line_ids, { name: electronic.name, payment_method_id: electronic.id }],
    outbound_payment_method_line_ids: [...journal.outbound_payment_method_line_ids, { name: sepa.name, payment_method_id: sepa.id }],
  });
}

test('electronic and SEPA methods are seeded and available on bank journals', async () => {
  for (const [code, direction] of [['electronic', 'inbound'], ['sepa_ct', 'outbound']]) {
    assert.ok(SEEDED_PAYMENT_METHODS.some((m) => m.code === code && m.payment_type === direction));
    assert.ok(!defaultMethodSpecsForJournal('bank').some((m) => m.code === code && m.payment_type === direction));
    assert.ok(paymentMethodModels['account.payment.method'].fields.code.options.some(([value]) => value === code));
    assert.ok(!defaultMethodSpecsForJournal('cash').some((m) => m.code === code));
  }
  const { seed } = await import('./seed.js');
  const db = seed();
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  for (const code of ['electronic', 'sepa_ct']) {
    const method = db.records['account.payment.method'].find((m) => m.code === code);
    assert.ok(!db.records['account.payment.method.line'].some((line) => line.journal_id === bank.id && line.payment_method_id === method.id));
  }
  const configured = await addJournalMethods(db);
  for (const code of ['electronic', 'sepa_ct']) {
    const method = configured.records['account.payment.method'].find((m) => m.code === code);
    assert.ok(configured.records['account.payment.method.line'].some((line) => line.journal_id === bank.id && line.payment_method_id === method.id));
  }
});

test('SEPA XML validates IBANs and reports transaction totals', async () => {
  const { buildSepaXml } = await import('./models/sepa.js');
  const input = { id: 'BATCH-1', createdAt: '2026-11-21T12:00:00', date: '2026-11-21', debtor: { name: 'Company & Co', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' }, payments: [
    { id: 'P1', amount: 10.25, name: 'First', iban: 'FR7630006000011234567890189', memo: 'A & B' },
    { id: 'P2', amount: 2.1, name: 'Second', iban: 'DE89370400440532013000', memo: 'Invoice' },
  ] };
  const xml = buildSepaXml(input);
  assert.match(xml, /pain\.001\.001\.09/);
  assert.match(xml, /<BICFI>COBADEFFXXX<\/BICFI>/);
  assert.match(xml, /<ReqdExctnDt><Dt>2026-11-21<\/Dt><\/ReqdExctnDt>/);
  assert.match(xml, /<NbOfTxs>2<\/NbOfTxs>/);
  assert.match(xml, /<CtrlSum>12\.35<\/CtrlSum>/);
  assert.equal((xml.match(/<CdtTrfTxInf>/g) ?? []).length, 2);
  assert.match(xml, /Company &amp; Co/);
  assert.match(xml, /A &amp; B/);
  assert.throws(() => buildSepaXml({ ...input, debtor: { ...input.debtor, iban: 'DE00370400440532013000' } }), /invalid.*IBAN/i);
  assert.throws(() => buildSepaXml({ ...input, payments: [{ ...input.payments[0], iban: '' }] }), /recipient IBAN/i);
});

test('a SEPA batch produces a downloadable XML and rejects non-EUR payments', async () => {
  const { generateSepaFile } = await import('./models/payments.js');
  const db = { records: {
    'account.journal': [{ id: 1, bank_account_id: 1, company_id: 1 }],
    'res.partner.bank': [{ id: 1, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' }, { id: 2, account_number: 'FR7630006000011234567890189', partner_id: 1, allow_out_payment: true }],
    'res.company': [{ id: 1, name: 'Company', currency_id: 1 }],
    'res.currency': [{ id: 1, name: 'EUR' }, { id: 2, name: 'USD' }],
    'res.partner': [{ id: 1, name: 'Supplier' }],
    'account.payment.method': [{ id: 1, code: 'sepa_ct', payment_type: 'outbound' }],
    'account.payment.method.line': [{ id: 1, payment_method_id: 1 }],
    'account.payment': [{ id: 1, payment_method_line_id: 1, partner_id: 1, partner_bank_id: 2, amount: 12, memo: 'Bill', currency_id: 1 }],
  } };
  const batch = { id: 1, name: 'BATCH-1', date: '2026-11-21', journal_id: 1, company_id: 1, lines: [{ payment_id: 1 }] };
  assert.match(generateSepaFile(db, batch).content, /<Ustrd>Bill<\/Ustrd>/);
  const usd = { ...db, records: { ...db.records, 'res.company': [{ id: 1, name: 'Company', currency_id: 2 }], 'account.payment': [{ ...db.records['account.payment'][0], currency_id: 2 }] } };
  assert.throws(() => generateSepaFile(usd, batch), /EUR/);
});

test('IBAN country lengths are enforced even for a valid checksum', async () => {
  const { isValidIban } = await import('./models/sepa.js');
  assert.equal(isValidIban('DE813704004405320130000'), false);
  assert.equal(isValidIban('DE89370400440532013000'), true);
});

test('a forged SEPA batch posting without its file is rejected through sync', async () => {
  const { seed } = await import('./seed.js');
  const { diffDb, applyDiff } = await import('./sync.js');
  const db = await addJournalMethods(seed());
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  const line = db.records['account.payment.method.line'].find((l) => l.payment_method_id === sepa.id);
  const before = { ...db, records: { ...db.records, 'account.payment': [...(db.records['account.payment'] ?? []), { id: 999, payment_type: 'outbound', payment_method_line_id: line.id }], 'account.batch.payment': [{ id: 1, name: 'New', state: 'draft', batch_type: 'outbound', lines: [{ payment_id: 999 }] }] }, seq: { ...db.seq, 'account.payment': 999, 'account.batch.payment': 1 } };
  const forged = { ...before, records: { ...before.records, 'account.batch.payment': [{ ...before.records['account.batch.payment'][0], state: 'posted' }] } };
  assert.throws(() => applyDiff(before, diffDb(before, forged), { isAdmin: true }), /SEPA.*file/i);
});


test('validating SEPA payments stores a stable file and rejects invalid account data', async () => {
  const { seed } = await import('./seed.js');
  const { read } = await import('./orm.js');
  const { postBatch, paymentModels } = await import('./models/payments.js');
  let db = await addJournalMethods(seed());
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  const method = db.records['account.payment.method.line'].find((l) => l.journal_id === bank.id && l.payment_method_id === sepa.id);
  const partner = db.records['res.partner'][0];
  const batch = { id: 100, name: 'BATCH-1', state: 'draft', batch_type: 'outbound', date: '2026-11-21', company_id: 1, journal_id: bank.id, lines: [{ payment_id: 100, amount: 12 }] };
  db = { ...db, records: { ...db.records,
    'res.company': db.records['res.company'].map((c) => c.id === 1 ? { ...c, currency_id: eur.id } : c),
    'account.journal': db.records['account.journal'].map((j) => j.id === bank.id ? { ...j, bank_account_id: 100, currency_id: eur.id } : j),
    'res.partner.bank': [...(db.records['res.partner.bank'] ?? []), { id: 100, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' }, { id: 101, account_number: 'FR7630006000011234567890189', partner_id: partner.id, allow_out_payment: true }],
    'account.move': [...db.records['account.move'], { id: 100, state: 'posted', move_type: 'entry', line_ids: [], company_id: 1 }],
    'account.payment': [...(db.records['account.payment'] ?? []), { id: 100, state: 'posted', move_id: 100, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner.id, partner_bank_id: 101, payment_method_line_id: method.id, amount: 12, currency_id: eur.id, memo: 'Invoice 42' }],
    'account.batch.payment': [batch],
  }, seq: { ...db.seq, 'account.batch.payment': 100, 'account.payment': 100, 'account.move': 100, 'res.partner.bank': 101 } };
  const noDebtor = { ...db, records: { ...db.records, 'res.partner.bank': db.records['res.partner.bank'].map((b) => b.id === 100 ? { ...b, account_number: '' } : b) } };
  assert.throws(() => postBatch(noDebtor, batch), /journal account has no IBAN/);
  const noCreditor = { ...db, records: { ...db.records, 'res.partner.bank': db.records['res.partner.bank'].map((b) => b.id === 101 ? { ...b, account_number: '' } : b) } };
  assert.throws(() => postBatch(noCreditor, batch), /recipient IBAN/);
  const invalidCreditor = { ...db, records: { ...db.records, 'res.partner.bank': db.records['res.partner.bank'].map((b) => b.id === 101 ? { ...b, account_number: 'FR0030006000011234567890189' } : b) } };
  assert.throws(() => postBatch(invalidCreditor, batch), /invalid recipient IBAN/);
  const invalidDebtor = { ...db, records: { ...db.records, 'res.partner.bank': db.records['res.partner.bank'].map((b) => b.id === 100 ? { ...b, account_number: 'DE00370400440532013000' } : b) } };
  assert.throws(() => postBatch(invalidDebtor, batch), /invalid IBAN/);
  const nonEur = { ...db, records: { ...db.records, 'res.currency': db.records['res.currency'].map((c) => c.id === eur.id ? { ...c, name: 'USD' } : c) } };
  assert.throws(() => postBatch(nonEur, batch), /EUR/);
  const manual = db.records['account.payment.method.line'].find((l) => l.journal_id === bank.id && read(db, 'account.payment.method', l.payment_method_id)?.code === 'manual' && l.payment_type === 'outbound');
  const mixed = { ...db, records: { ...db.records, 'account.payment': [...db.records['account.payment'], { ...db.records['account.payment'].find((p) => p.id === 100), id: 101, payment_method_line_id: manual.id }] } };
  assert.throws(() => postBatch(mixed, { ...batch, lines: [...batch.lines, { payment_id: 101, amount: 12 }] }), /Every payment must use SEPA/);
  const electronic = db.records['account.payment.method'].find((m) => m.code === 'electronic');
  const electronicLine = db.records['account.payment.method.line'].find((l) => l.journal_id === bank.id && l.payment_method_id === electronic.id);
  const inboundBatch = { ...batch, batch_type: 'inbound' };
  const inbound = { ...db, records: { ...db.records, 'account.batch.payment': [inboundBatch], 'account.payment': db.records['account.payment'].map((p) => p.id === 100 ? { ...p, payment_type: 'inbound', partner_type: 'customer', payment_method_line_id: electronicLine.id } : p) } };
  assert.equal(read(postBatch(inbound, inboundBatch), 'account.batch.payment', 100).state, 'posted');
  const result = postBatch(db, batch);
  const posted = read(result, 'account.batch.payment', 100);
  assert.equal(posted.state, 'posted');
  assert.match(posted.sepa_file, /<Ustrd>Invoice 42<\/Ustrd>/);
  const download = paymentModels['account.batch.payment'].form.buttons.find((b) => b.label === 'Generate SEPA file');
  assert.equal(download.run(result, posted).download.content, posted.sepa_file);
  const { diffDb, applyDiff } = await import('./sync.js');
  const synced = applyDiff(db, diffDb(db, result), { isAdmin: true });
  assert.equal(read(synced, 'account.batch.payment', 100).sepa_file, posted.sepa_file);
  const forgedOnPost = { ...result, records: { ...result.records, 'account.batch.payment': [{ ...posted, sepa_file: posted.sepa_file.replace('Invoice 42', 'Different') }] } };
  assert.throws(() => applyDiff(db, diffDb(db, forgedOnPost), { isAdmin: true }), /SEPA file does not match/);
  const forged = { ...result, records: { ...result.records, 'account.batch.payment': [{ ...posted, sepa_file: 'tampered' }] } };
  assert.throws(() => applyDiff(result, diffDb(result, forged), { isAdmin: true }), /SEPA file cannot be changed/);
});

test('migration 64 seeds electronic and SEPA methods on databases already at version 63', async () => {
  const { migrate, SCHEMA_VERSION } = await import('./migrations.js');
  const { search } = await import('./orm.js');
  assert.equal(SCHEMA_VERSION, 81);
  const v63Db = {
    schema_version: 63,
    records: {
      'account.payment.method': [
        { id: 1, code: 'manual', payment_type: 'inbound', name: 'Manual' },
        { id: 2, code: 'manual', payment_type: 'outbound', name: 'Manual' },
        { id: 3, code: 'check_printing', payment_type: 'outbound', name: 'Checks' },
      ],
      'account.journal': [
        { id: 1, name: 'Legacy Bank', code: 'BNK1', type: 'bank' },
        { id: 2, name: 'Explicit Legacy Bank', code: 'BNK2', type: 'bank', sepa_pain_version: 'pain.001.001.03' },
        { id: 3, name: 'Cash', code: 'CSH1', type: 'cash' },
      ],
      'account.payment.method.line': [],
    },
    seq: { 'account.payment.method': 3 },
  };
  const upgraded = migrate(v63Db);
  assert.equal(upgraded.schema_version, 81);
  const methods = search(upgraded, 'account.payment.method');
  assert.equal(methods.length, 5);
  assert.ok(methods.some((m) => m.code === 'electronic' && m.payment_type === 'inbound'));
  assert.ok(methods.some((m) => m.code === 'sepa_ct' && m.payment_type === 'outbound'));
  assert.equal(upgraded.records['account.journal'].find((j) => j.id === 1).sepa_pain_version, 'pain.001.001.09');
  assert.equal(upgraded.records['account.journal'].find((j) => j.id === 2).sepa_pain_version, 'pain.001.001.03');
  assert.equal(upgraded.records['account.journal'].find((j) => j.id === 3).sepa_pain_version, undefined);
});

test('reversing a payment from a posted SEPA batch cancels the line and leaves file intact', async () => {
  const { seed } = await import('./seed.js');
  const { read } = await import('./orm.js');
  const { postBatch, paymentModels } = await import('./models/payments.js');
  const { reversePayment } = await import('./models/pay.js');
  let db = await addJournalMethods(seed());
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  const method = db.records['account.payment.method.line'].find((l) => l.journal_id === bank.id && l.payment_method_id === sepa.id);
  const partner = db.records['res.partner'][0];
  const batch = { id: 200, name: 'BATCH-REV', state: 'draft', batch_type: 'outbound', date: '2026-11-21', company_id: 1, journal_id: bank.id, lines: [{ payment_id: 200, amount: 25 }] };
  db = { ...db, records: { ...db.records,
    'res.company': db.records['res.company'].map((c) => c.id === 1 ? { ...c, currency_id: eur.id } : c),
    'account.journal': db.records['account.journal'].map((j) => j.id === bank.id ? { ...j, bank_account_id: 200, currency_id: eur.id } : j),
    'res.partner.bank': [...(db.records['res.partner.bank'] ?? []), { id: 200, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' }, { id: 201, account_number: 'FR7630006000011234567890189', partner_id: partner.id, allow_out_payment: true }],
    'account.move': [...db.records['account.move'], { id: 200, name: 'ENTRY/200', state: 'posted', move_type: 'entry', date: '2026-11-21', line_ids: [{ id: 2001, account_id: bank.default_account_id ?? 1, debit: 0, credit: 25 }, { id: 2002, account_id: 2, debit: 25, credit: 0 }], company_id: 1 }],
    'account.payment': [...(db.records['account.payment'] ?? []), { id: 200, name: 'PAY/200', state: 'posted', move_id: 200, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner.id, partner_bank_id: 201, payment_method_line_id: method.id, amount: 25, currency_id: eur.id, memo: 'To Reverse', date: '2026-11-21' }],
    'account.batch.payment': [batch],
  }, seq: { ...db.seq, 'account.batch.payment': 200, 'account.payment': 200, 'account.move': 200, 'res.partner.bank': 201 } };

  const postedDb = postBatch(db, batch);
  const postedBatch = read(postedDb, 'account.batch.payment', 200);
  assert.equal(postedBatch.state, 'posted');
  assert.ok(postedBatch.sepa_file);

  const payment = read(postedDb, 'account.payment', 200);
  const reversedDb = reversePayment(postedDb, payment, '2026-11-22');
  const revPayment = read(reversedDb, 'account.payment', 200);
  assert.equal(revPayment.state, 'reversed');

  const afterBatch = read(reversedDb, 'account.batch.payment', 200);
  assert.equal(afterBatch.state, 'posted');
  assert.equal(afterBatch.sepa_file, postedBatch.sepa_file, 'SEPA file remains unchanged');
  assert.equal(afterBatch.lines[0].cancelled, true);

  // Sync / diff applies cleanly without sepaBatchGuard throwing
  const { applyDiff } = await import('./sync.js');
  const batchDiff = { upserts: { 'account.batch.payment': [afterBatch] }, deletes: {} };
  const synced = applyDiff(postedDb, batchDiff, { isAdmin: true });
  assert.equal(read(synced, 'account.batch.payment', 200).lines[0].cancelled, true);

  // Modifying amounts on lines after post is still rejected
  const tamperedAmount = { ...afterBatch, lines: [{ ...afterBatch.lines[0], amount: 999 }] };
  assert.throws(() => applyDiff(postedDb, { upserts: { 'account.batch.payment': [tamperedAmount] }, deletes: {} }, { isAdmin: true }), /validated SEPA batch cannot be changed/);

  // Original file is preserved for audit, but marked ineligible for download when transfer is cancelled
  assert.equal(read(reversedDb, 'account.batch.payment', 200).sepa_file_eligible, false);
  const downloadBtn = paymentModels['account.batch.payment'].form.buttons.find((b) => b.label === 'Generate SEPA file');
  const replaceBtn = paymentModels['account.batch.payment'].form.buttons.find((b) => b.label === 'Generate Replacement SEPA file');
  assert.equal(downloadBtn.when(postedBatch), true);
  assert.equal(downloadBtn.when(afterBatch), false, 'Original file is ineligible for download');
  assert.throws(() => downloadBtn.run(reversedDb, afterBatch), /ineligible for download/);
  assert.equal(replaceBtn.when(afterBatch), false, 'No remaining transfers to generate');
});

test('a partially reversed SEPA batch marks original file ineligible and generates replacement without reversed transfer', async () => {
  const { seed } = await import('./seed.js');
  const { read } = await import('./orm.js');
  const { postBatch, paymentModels } = await import('./models/payments.js');
  const { reversePayment } = await import('./models/pay.js');
  let db = await addJournalMethods(seed());
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  const method = db.records['account.payment.method.line'].find((l) => l.journal_id === bank.id && l.payment_method_id === sepa.id);
  const partner1 = db.records['res.partner'][0];
  const partner2 = db.records['res.partner'][1];
  const batch = { id: 250, name: 'BATCH-MULTI', state: 'draft', batch_type: 'outbound', date: '2026-11-21', company_id: 1, journal_id: bank.id, lines: [{ payment_id: 251, amount: 30 }, { payment_id: 252, amount: 45 }] };
  db = { ...db, records: { ...db.records,
    'res.company': db.records['res.company'].map((c) => c.id === 1 ? { ...c, currency_id: eur.id } : c),
    'account.journal': db.records['account.journal'].map((j) => j.id === bank.id ? { ...j, bank_account_id: 250, currency_id: eur.id } : j),
    'res.partner.bank': [
      ...(db.records['res.partner.bank'] ?? []),
      { id: 250, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' },
      { id: 251, account_number: 'FR7630006000011234567890189', partner_id: partner1.id, allow_out_payment: true },
      { id: 252, account_number: 'IT60X0542811101000000123456', partner_id: partner2.id, allow_out_payment: true },
    ],
    'account.move': [
      ...db.records['account.move'],
      { id: 251, name: 'ENTRY/251', state: 'posted', move_type: 'entry', date: '2026-11-21', line_ids: [{ id: 2511, account_id: bank.default_account_id ?? 1, debit: 0, credit: 30 }, { id: 2512, account_id: 2, debit: 30, credit: 0 }], company_id: 1 },
      { id: 252, name: 'ENTRY/252', state: 'posted', move_type: 'entry', date: '2026-11-21', line_ids: [{ id: 2521, account_id: bank.default_account_id ?? 1, debit: 0, credit: 45 }, { id: 2522, account_id: 2, debit: 45, credit: 0 }], company_id: 1 },
    ],
    'account.payment': [
      ...(db.records['account.payment'] ?? []),
      { id: 251, name: 'PAY/251', state: 'posted', move_id: 251, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner1.id, partner_bank_id: 251, payment_method_line_id: method.id, amount: 30, currency_id: eur.id, memo: 'Bill 1', date: '2026-11-21' },
      { id: 252, name: 'PAY/252', state: 'posted', move_id: 252, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner2.id, partner_bank_id: 252, payment_method_line_id: method.id, amount: 45, currency_id: eur.id, memo: 'Bill 2', date: '2026-11-21' },
    ],
    'account.batch.payment': [batch],
  }, seq: { ...db.seq, 'account.batch.payment': 250, 'account.payment': 252, 'account.move': 252, 'res.partner.bank': 252 } };

  const postedDb = postBatch(db, batch);
  const postedBatch = read(postedDb, 'account.batch.payment', 250);
  assert.equal(postedBatch.state, 'posted');
  assert.match(postedBatch.sepa_file, /<EndToEndId>251<\/EndToEndId>/);
  assert.match(postedBatch.sepa_file, /<EndToEndId>252<\/EndToEndId>/);
  assert.equal(read(postedDb, 'account.batch.payment', 250).sepa_file_eligible, true);

  const downloadBtn = paymentModels['account.batch.payment'].form.buttons.find((b) => b.label === 'Generate SEPA file');
  const replaceBtn = paymentModels['account.batch.payment'].form.buttons.find((b) => b.label === 'Generate Replacement SEPA file');
  assert.equal(downloadBtn.when(postedBatch), true);
  assert.equal(replaceBtn.when(postedBatch), false);

  // Reverse payment 251
  const payment1 = read(postedDb, 'account.payment', 251);
  const reversedDb = reversePayment(postedDb, payment1, '2026-11-22');
  const afterBatch = read(reversedDb, 'account.batch.payment', 250);

  // Line 251 cancelled, line 252 remains active
  assert.equal(afterBatch.lines[0].cancelled, true);
  assert.equal(afterBatch.lines[1].cancelled, false);

  // Audit record intact, but ineligible for direct download
  assert.equal(afterBatch.sepa_file, postedBatch.sepa_file, 'Original SEPA file is preserved');
  assert.equal(afterBatch.sepa_file_eligible, false, 'Marked ineligible for download');
  assert.equal(downloadBtn.when(afterBatch), false);
  assert.throws(() => downloadBtn.run(reversedDb, afterBatch), /ineligible for download/);

  // Replacement generation provides remaining active transfers
  assert.equal(replaceBtn.when(afterBatch), true);
  const replacement = replaceBtn.run(reversedDb, afterBatch);
  assert.ok(replacement.download);
  assert.match(replacement.download.content, /<EndToEndId>252<\/EndToEndId>/);
  assert.ok(!replacement.download.content.includes('<EndToEndId>251</EndToEndId>'), 'Reversed transfer omitted from active bank file');
  assert.match(replacement.download.content, /<NbOfTxs>1<\/NbOfTxs>/);
  assert.match(replacement.download.content, /<CtrlSum>45\.00<\/CtrlSum>/);
});

test('existing and invoice-linked payments reject missing, inactive, mismatched, or outbound-disabled banks', async () => {
  const { seed } = await import('./seed.js');
  const { postBatch, generateSepaFile } = await import('./models/payments.js');
  let db = await addJournalMethods(seed());
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  const method = db.records['account.payment.method.line'].find((l) => l.journal_id === bank.id && l.payment_method_id === sepa.id);
  const partnerA = db.records['res.partner'][0];
  const partnerB = db.records['res.partner'][1];

  const baseDb = { ...db, records: { ...db.records,
    'res.company': db.records['res.company'].map((c) => c.id === 1 ? { ...c, currency_id: eur.id } : c),
    'account.journal': db.records['account.journal'].map((j) => j.id === bank.id ? { ...j, bank_account_id: 300, currency_id: eur.id } : j),
    'res.partner.bank': [
      ...(db.records['res.partner.bank'] ?? []),
      { id: 300, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' },
      { id: 301, account_number: 'FR7630006000011234567890189', partner_id: partnerA.id, active: true, allow_out_payment: true, company_id: 1 },
      { id: 302, account_number: 'FR7630006000011234567890189', partner_id: partnerA.id, active: false, allow_out_payment: true, company_id: 1 },
      { id: 303, account_number: 'FR7630006000011234567890189', partner_id: partnerB.id, active: true, allow_out_payment: true, company_id: 1 },
      { id: 304, account_number: 'FR7630006000011234567890189', partner_id: partnerA.id, active: true, allow_out_payment: false, company_id: 1 },
    ],
    'account.move': [...db.records['account.move'], { id: 300, state: 'posted', move_type: 'entry', line_ids: [], company_id: 1 }],
  } };

  const makeBatch = (paymentBankId) => ({
    db: {
      ...baseDb,
      records: {
        ...baseDb.records,
        'account.payment': [{ id: 300, state: 'posted', move_id: 300, invoice_id: 1, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partnerA.id, partner_bank_id: paymentBankId, payment_method_line_id: method.id, amount: 50, currency_id: eur.id, memo: 'Test' }],
        'account.batch.payment': [{ id: 300, name: 'BATCH-300', state: 'draft', batch_type: 'outbound', date: '2026-11-21', company_id: 1, journal_id: bank.id, lines: [{ payment_id: 300, amount: 50 }] }],
      },
    },
    batch: { id: 300, name: 'BATCH-300', state: 'draft', batch_type: 'outbound', date: '2026-11-21', company_id: 1, journal_id: bank.id, lines: [{ payment_id: 300, amount: 50 }] },
  });

  // 1. Missing bank account
  const { db: missingDb, batch: missingBatch } = makeBatch(null);
  assert.throws(() => postBatch(missingDb, missingBatch), /invalid or inactive/);
  assert.throws(() => generateSepaFile(missingDb, missingBatch), /invalid or inactive/);

  // 2. Inactive bank account
  const { db: inactiveDb, batch: inactiveBatch } = makeBatch(302);
  assert.throws(() => postBatch(inactiveDb, inactiveBatch), /invalid or inactive/);
  assert.throws(() => generateSepaFile(inactiveDb, inactiveBatch), /invalid or inactive/);

  // 3. Mismatched partner bank account
  const { db: mismatchDb, batch: mismatchBatch } = makeBatch(303);
  assert.throws(() => postBatch(mismatchDb, mismatchBatch), /does not belong to the partner/);
  assert.throws(() => generateSepaFile(mismatchDb, mismatchBatch), /does not belong to the partner/);

  // 4. Outbound disabled bank account
  const { db: disabledDb, batch: disabledBatch } = makeBatch(304);
  assert.throws(() => postBatch(disabledDb, disabledBatch), /does not allow outbound payments/);
  assert.throws(() => generateSepaFile(disabledDb, disabledBatch), /does not allow outbound payments/);

  // 5. Eligible bank succeeds
  const { db: validDb, batch: validBatch } = makeBatch(301);
  assert.doesNotThrow(() => postBatch(validDb, validBatch));
});

test('buildSepaXml and isSepaCountry reject non-SEPA IBANs even with valid checksum', async () => {
  const { buildSepaXml, isValidIban, isSepaCountry } = await import('./models/sepa.js');
  const brazilIban = 'BR850000000000000000000000001';
  assert.equal(isValidIban(brazilIban), true, 'Brazilian IBAN has valid length and checksum');
  assert.equal(isSepaCountry('BR'), false, 'Brazil is outside the SEPA scheme');
  assert.equal(isSepaCountry('DE'), true, 'Germany is inside the SEPA scheme');

  const baseInput = {
    id: 'BATCH-SEPA', createdAt: '2026-11-21T12:00:00', date: '2026-11-21',
    debtor: { name: 'Debtor Corp', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
    payments: [{ id: 'P1', amount: 100, name: 'Vendor', iban: 'FR7630006000011234567890189', memo: 'Payment' }],
  };

  // Recipient in non-SEPA country (Brazil)
  assert.throws(
    () => buildSepaXml({ ...baseInput, payments: [{ ...baseInput.payments[0], iban: brazilIban }] }),
    /not in the SEPA zone/i,
  );

  // Debtor in non-SEPA country (Brazil)
  assert.throws(
    () => buildSepaXml({ ...baseInput, debtor: { ...baseInput.debtor, iban: brazilIban } }),
    /not in the SEPA zone/i,
  );
});

test('buildSepaXml validates EPC SEPA length limits with field-specific errors', async () => {
  const { buildSepaXml } = await import('./models/sepa.js');
  const baseInput = {
    id: 'BATCH-1', createdAt: '2026-11-21T12:00:00', date: '2026-11-21',
    debtor: { name: 'Company Name', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
    payments: [{ id: 'P1', amount: 10, name: 'Creditor Name', iban: 'FR7630006000011234567890189', memo: 'Short memo' }],
  };

  // Batch reference > 35 chars
  assert.throws(
    () => buildSepaXml({ ...baseInput, id: 'A'.repeat(36) }),
    /Batch reference cannot exceed 35 characters/,
  );

  // Debtor name > 70 chars
  assert.throws(
    () => buildSepaXml({ ...baseInput, debtor: { ...baseInput.debtor, name: 'D'.repeat(71) } }),
    /Debtor name cannot exceed 70 characters/,
  );

  // Payment reference > 35 chars
  assert.throws(
    () => buildSepaXml({ ...baseInput, payments: [{ ...baseInput.payments[0], id: 'P'.repeat(36) }] }),
    /Payment reference cannot exceed 35 characters/,
  );

  // Creditor name > 70 chars
  assert.throws(
    () => buildSepaXml({ ...baseInput, payments: [{ ...baseInput.payments[0], name: 'C'.repeat(71) }] }),
    /Creditor name cannot exceed 70 characters/,
  );

  // Remittance information > 140 chars
  assert.throws(
    () => buildSepaXml({ ...baseInput, payments: [{ ...baseInput.payments[0], memo: 'M'.repeat(141) }] }),
    /Remittance information cannot exceed 140 characters/,
  );
});

test('EPC409-09 non-EEA countries AL, MD, ME, MK, RS are valid SEPA debtor and recipient countries', async () => {
  const { isSepaCountry, buildSepaXml, isValidIban } = await import('./models/sepa.js');
  const validIbans = {
    AL: 'AL14111111111111111111111111',
    MD: 'MD3311111111111111111111',
    ME: 'ME79111111111111111111',
    MK: 'MK96111111111111111',
    RS: 'RS89111111111111111111',
  };
  for (const [code, iban] of Object.entries(validIbans)) {
    assert.equal(isSepaCountry(code), true, `${code} is a SEPA country`);
    assert.equal(isSepaCountry(code.toLowerCase()), true, `${code} case-insensitive check`);
    assert.equal(isValidIban(iban), true, `${iban} is valid`);

    // Recipient path
    const xmlRecipient = buildSepaXml({
      id: `BATCH-${code}-R`, createdAt: '2026-11-21T12:00:00', date: '2026-11-21',
      debtor: { name: 'German Debtor', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
      payments: [{ id: `P-${code}`, amount: 50, name: `Supplier ${code}`, iban, memo: `Inv-${code}` }],
    });
    assert.match(xmlRecipient, new RegExp(iban));

    // Debtor path
    const xmlDebtor = buildSepaXml({
      id: `BATCH-${code}-D`, createdAt: '2026-11-21T12:00:00', date: '2026-11-21',
      debtor: { name: `Debtor ${code}`, iban, bic: `${code}BADEFFXXX` },
      payments: [{ id: 'P-DE', amount: 50, name: 'German Creditor', iban: 'DE89370400440532013000', memo: 'Payment' }],
    });
    assert.match(xmlDebtor, new RegExp(iban));
  }
});

test('replacement files receive distinct persisted MsgId and PmtInfId within 35 chars while preserving original file for audit', async () => {
  const { seed } = await import('./seed.js');
  const { read } = await import('./orm.js');
  const { postBatch, paymentModels, formatReplacementIdentifier } = await import('./models/payments.js');
  const { reversePayment } = await import('./models/pay.js');
  let db = await addJournalMethods(seed());
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  const method = db.records['account.payment.method.line'].find((l) => l.journal_id === bank.id && l.payment_method_id === sepa.id);
  const partner1 = db.records['res.partner'][0];
  const partner2 = db.records['res.partner'][1];
  const partner3 = db.records['res.partner'][2] ?? partner1;

  // 35-character batch reference: maximum permitted by SEPA EPC rules
  const longBatchName = 'SEPA-BATCH-20261122-000000000000001';
  assert.equal(longBatchName.length, 35);

  const batch = {
    id: 300,
    name: longBatchName,
    state: 'draft',
    batch_type: 'outbound',
    date: '2026-11-20',
    company_id: 1,
    journal_id: bank.id,
    lines: [
      { payment_id: 301, amount: 20 },
      { payment_id: 302, amount: 30 },
      { payment_id: 303, amount: 40 },
    ],
  };

  db = {
    ...db,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, currency_id: eur.id } : c)),
      'account.journal': db.records['account.journal'].map((j) => (j.id === bank.id ? { ...j, bank_account_id: 300, currency_id: eur.id } : j)),
      'res.partner.bank': [
        ...(db.records['res.partner.bank'] ?? []),
        { id: 300, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' },
        { id: 301, account_number: 'FR7630006000011234567890189', partner_id: partner1.id, allow_out_payment: true },
        { id: 302, account_number: 'IT60X0542811101000000123456', partner_id: partner2.id, allow_out_payment: true },
        { id: 303, account_number: 'ES9121000418450200051332', partner_id: partner3.id, allow_out_payment: true },
      ],
      'account.move': [
        ...db.records['account.move'],
        { id: 301, name: 'ENTRY/301', state: 'posted', move_type: 'entry', date: '2026-11-20', line_ids: [{ id: 3011, account_id: bank.default_account_id ?? 1, debit: 0, credit: 20 }, { id: 3012, account_id: 2, debit: 20, credit: 0 }], company_id: 1 },
        { id: 302, name: 'ENTRY/302', state: 'posted', move_type: 'entry', date: '2026-11-20', line_ids: [{ id: 3021, account_id: bank.default_account_id ?? 1, debit: 0, credit: 30 }, { id: 3022, account_id: 2, debit: 30, credit: 0 }], company_id: 1 },
        { id: 303, name: 'ENTRY/303', state: 'posted', move_type: 'entry', date: '2026-11-20', line_ids: [{ id: 3031, account_id: bank.default_account_id ?? 1, debit: 0, credit: 40 }, { id: 3032, account_id: 2, debit: 40, credit: 0 }], company_id: 1 },
      ],
      'account.payment': [
        ...(db.records['account.payment'] ?? []),
        { id: 301, name: 'PAY/301', state: 'posted', move_id: 301, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner1.id, partner_bank_id: 301, payment_method_line_id: method.id, amount: 20, currency_id: eur.id, memo: 'Bill 1', date: '2026-11-20' },
        { id: 302, name: 'PAY/302', state: 'posted', move_id: 302, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner2.id, partner_bank_id: 302, payment_method_line_id: method.id, amount: 30, currency_id: eur.id, memo: 'Bill 2', date: '2026-11-20' },
        { id: 303, name: 'PAY/303', state: 'posted', move_id: 303, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner3.id, partner_bank_id: 303, payment_method_line_id: method.id, amount: 40, currency_id: eur.id, memo: 'Bill 3', date: '2026-11-20' },
      ],
      'account.batch.payment': [batch],
    },
    seq: { ...db.seq, 'account.batch.payment': 300, 'account.payment': 303, 'account.move': 303, 'res.partner.bank': 303 },
  };

  const postedDb = postBatch(db, batch);
  const postedBatch = read(postedDb, 'account.batch.payment', 300);
  assert.equal(postedBatch.state, 'posted');

  // Original file uses the original batch name as both MsgId and PmtInfId
  assert.match(postedBatch.sepa_file, new RegExp(`<MsgId>${longBatchName}</MsgId>`));
  assert.match(postedBatch.sepa_file, new RegExp(`<PmtInfId>${longBatchName}</PmtInfId>`));

  // Cancel payment 301
  const reversedDb = reversePayment(postedDb, read(postedDb, 'account.payment', 301), '2026-11-21');
  const batchAfterCancel1 = read(reversedDb, 'account.batch.payment', 300);

  const replaceBtn = paymentModels['account.batch.payment'].form.buttons.find((b) => b.label === 'Generate Replacement SEPA file');
  assert.equal(replaceBtn.when(batchAfterCancel1), true);

  // Generate 1st replacement
  const replacement1 = replaceBtn.run(reversedDb, batchAfterCancel1);
  assert.ok(replacement1.download);

  // Replacement identifier is distinct from original and fits within 35 characters
  const rep1Id = formatReplacementIdentifier(longBatchName, 1);
  assert.ok(rep1Id.length <= 35, `Replacement 1 identifier length ${rep1Id.length} must be <= 35`);
  assert.notEqual(rep1Id, longBatchName, 'Replacement identifier must differ from original batch name');
  assert.match(replacement1.download.content, new RegExp(`<MsgId>${rep1Id}</MsgId>`));
  assert.match(replacement1.download.content, new RegExp(`<PmtInfId>${rep1Id}</PmtInfId>`));

  // The original file and original batch name remain strictly preserved for audit
  const persistedBatch1 = read(replacement1.db, 'account.batch.payment', 300);
  assert.equal(persistedBatch1.name, longBatchName, 'Batch reference stays unchanged');
  assert.equal(persistedBatch1.sepa_file, postedBatch.sepa_file, 'Original SEPA file is untouched');
  assert.match(persistedBatch1.sepa_file, new RegExp(`<MsgId>${longBatchName}</MsgId>`), 'Original file MsgId unchanged');
  assert.equal(persistedBatch1.replacement_identifier, rep1Id, 'Replacement identifier is persisted');
  assert.equal(persistedBatch1.replacement_sequence, 1);

  // Cancel payment 302 and generate 2nd replacement
  const reversedDb2 = reversePayment(replacement1.db, read(replacement1.db, 'account.payment', 302), '2026-11-22');
  const batchAfterCancel2 = read(reversedDb2, 'account.batch.payment', 300);
  const replacement2 = replaceBtn.run(reversedDb2, batchAfterCancel2);

  const rep2Id = formatReplacementIdentifier(longBatchName, 2);
  assert.ok(rep2Id.length <= 35, `Replacement 2 identifier length ${rep2Id.length} must be <= 35`);
  assert.notEqual(rep2Id, rep1Id, 'Second replacement gets a distinct identifier');
  assert.match(replacement2.download.content, new RegExp(`<MsgId>${rep2Id}</MsgId>`));
  assert.match(replacement2.download.content, new RegExp(`<PmtInfId>${rep2Id}</PmtInfId>`));

  const persistedBatch2 = read(replacement2.db, 'account.batch.payment', 300);
  assert.equal(persistedBatch2.replacement_identifier, rep2Id, 'Latest replacement identifier is persisted');
  assert.equal(persistedBatch2.replacement_sequence, 2);
  assert.equal(persistedBatch2.sepa_file, postedBatch.sepa_file, 'Original audit file remains preserved');
});

test('cancellation well after original execution date produces an eligible current or future date without modifying batch date', async () => {
  const { seed } = await import('./seed.js');
  const { read } = await import('./orm.js');
  const { postBatch, paymentModels } = await import('./models/payments.js');
  const { reversePayment } = await import('./models/pay.js');
  const { addDays, today } = await import('./models/common.js');
  let db = await addJournalMethods(seed());
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  const method = db.records['account.payment.method.line'].find((l) => l.journal_id === bank.id && l.payment_method_id === sepa.id);
  const partner1 = db.records['res.partner'][0];
  const partner2 = db.records['res.partner'][1];

  // Batch posted 60 days before today
  const historicalDate = addDays(today(), -60);
  const batch = {
    id: 400,
    name: 'BATCH-HISTORICAL',
    state: 'draft',
    batch_type: 'outbound',
    date: historicalDate,
    company_id: 1,
    journal_id: bank.id,
    lines: [
      { payment_id: 401, amount: 50 },
      { payment_id: 402, amount: 75 },
    ],
  };

  db = {
    ...db,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, currency_id: eur.id } : c)),
      'account.journal': db.records['account.journal'].map((j) => (j.id === bank.id ? { ...j, bank_account_id: 400, currency_id: eur.id } : j)),
      'res.partner.bank': [
        ...(db.records['res.partner.bank'] ?? []),
        { id: 400, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' },
        { id: 401, account_number: 'FR7630006000011234567890189', partner_id: partner1.id, allow_out_payment: true },
        { id: 402, account_number: 'IT60X0542811101000000123456', partner_id: partner2.id, allow_out_payment: true },
      ],
      'account.move': [
        ...db.records['account.move'],
        { id: 401, name: 'ENTRY/401', state: 'posted', move_type: 'entry', date: historicalDate, line_ids: [{ id: 4011, account_id: bank.default_account_id ?? 1, debit: 0, credit: 50 }, { id: 4012, account_id: 2, debit: 50, credit: 0 }], company_id: 1 },
        { id: 402, name: 'ENTRY/402', state: 'posted', move_type: 'entry', date: historicalDate, line_ids: [{ id: 4021, account_id: bank.default_account_id ?? 1, debit: 0, credit: 75 }, { id: 4022, account_id: 2, debit: 75, credit: 0 }], company_id: 1 },
      ],
      'account.payment': [
        ...(db.records['account.payment'] ?? []),
        { id: 401, name: 'PAY/401', state: 'posted', move_id: 401, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner1.id, partner_bank_id: 401, payment_method_line_id: method.id, amount: 50, currency_id: eur.id, memo: 'Bill 1', date: historicalDate },
        { id: 402, name: 'PAY/402', state: 'posted', move_id: 402, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner2.id, partner_bank_id: 402, payment_method_line_id: method.id, amount: 75, currency_id: eur.id, memo: 'Bill 2', date: historicalDate },
      ],
      'account.batch.payment': [batch],
    },
    seq: { ...db.seq, 'account.batch.payment': 400, 'account.payment': 402, 'account.move': 402, 'res.partner.bank': 402 },
  };

  const postedDb = postBatch(db, batch);
  const postedBatch = read(postedDb, 'account.batch.payment', 400);
  assert.equal(postedBatch.date, historicalDate);
  assert.match(postedBatch.sepa_file, new RegExp(`<ReqdExctnDt><Dt>${historicalDate}</Dt></ReqdExctnDt>`));

  // Cancellation occurs well after the original execution date (today)
  const reversedDb = reversePayment(postedDb, read(postedDb, 'account.payment', 401), today());
  const afterCancel = read(reversedDb, 'account.batch.payment', 400);

  const replaceBtn = paymentModels['account.batch.payment'].form.buttons.find((b) => b.label === 'Generate Replacement SEPA file');

  // 1. Without supplying a date, an eligible current/future date (today) is chosen automatically
  const autoReplacement = replaceBtn.run(reversedDb, afterCancel);
  assert.match(autoReplacement.download.content, new RegExp(`<ReqdExctnDt><Dt>${today()}</Dt></ReqdExctnDt>`));
  assert.ok(!autoReplacement.download.content.includes(`<Dt>${historicalDate}</Dt>`), 'Old execution date is not retained');

  // The original batch record's date and original file remain unchanged for audit
  const persistedAuto = read(autoReplacement.db, 'account.batch.payment', 400);
  assert.equal(persistedAuto.date, historicalDate, 'Posted batch date must not be changed');
  assert.equal(persistedAuto.sepa_file, postedBatch.sepa_file, 'Original stored file must not be changed');
  assert.match(persistedAuto.sepa_file, new RegExp(`<ReqdExctnDt><Dt>${historicalDate}</Dt></ReqdExctnDt>`));

  // 2. Supplying a valid future date uses that date
  const futureDate = addDays(today(), 5);
  const explicitReplacement = replaceBtn.run(reversedDb, afterCancel, { executionDate: futureDate });
  assert.match(explicitReplacement.download.content, new RegExp(`<ReqdExctnDt><Dt>${futureDate}</Dt></ReqdExctnDt>`));

  // 3. Supplying an invalid past execution date throws
  const pastDate = addDays(today(), -5);
  assert.throws(
    () => replaceBtn.run(reversedDb, afterCancel, { executionDate: pastDate }),
    /valid current or future date/i,
  );
});

test('synchronized edits to replacement bank files and metadata are rejected unless validly generated', async () => {
  const { seed } = await import('./seed.js');
  const { read } = await import('./orm.js');
  const { postBatch, paymentModels, formatReplacementIdentifier } = await import('./models/payments.js');
  const { reversePayment } = await import('./models/pay.js');
  const { diffDb, applyDiff } = await import('./sync.js');
  const { today } = await import('./models/common.js');
  let db = await addJournalMethods(seed());
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  const method = db.records['account.payment.method.line'].find((l) => l.journal_id === bank.id && l.payment_method_id === sepa.id);
  const partner1 = db.records['res.partner'][0];
  const partner2 = db.records['res.partner'][1];

  const batch = {
    id: 500,
    name: 'BATCH-FORGE-TEST',
    state: 'draft',
    batch_type: 'outbound',
    date: today(),
    company_id: 1,
    journal_id: bank.id,
    lines: [
      { payment_id: 501, amount: 20 },
      { payment_id: 502, amount: 30 },
    ],
  };

  db = {
    ...db,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, currency_id: eur.id } : c)),
      'account.journal': db.records['account.journal'].map((j) => (j.id === bank.id ? { ...j, bank_account_id: 500, currency_id: eur.id } : j)),
      'res.partner.bank': [
        ...(db.records['res.partner.bank'] ?? []),
        { id: 500, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' },
        { id: 501, account_number: 'FR7630006000011234567890189', partner_id: partner1.id, allow_out_payment: true },
        { id: 502, account_number: 'IT60X0542811101000000123456', partner_id: partner2.id, allow_out_payment: true },
      ],
      'account.move': [
        ...db.records['account.move'],
        { id: 501, name: 'ENTRY/501', state: 'posted', move_type: 'entry', date: today(), line_ids: [{ id: 5011, account_id: bank.default_account_id ?? 1, debit: 0, credit: 20 }, { id: 5012, account_id: 2, debit: 20, credit: 0 }], company_id: 1 },
        { id: 502, name: 'ENTRY/502', state: 'posted', move_type: 'entry', date: today(), line_ids: [{ id: 5021, account_id: bank.default_account_id ?? 1, debit: 0, credit: 30 }, { id: 5022, account_id: 2, debit: 30, credit: 0 }], company_id: 1 },
      ],
      'account.payment': [
        ...(db.records['account.payment'] ?? []),
        { id: 501, name: 'PAY/501', state: 'posted', move_id: 501, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner1.id, partner_bank_id: 501, payment_method_line_id: method.id, amount: 20, currency_id: eur.id, memo: 'Bill 1', date: today() },
        { id: 502, name: 'PAY/502', state: 'posted', move_id: 502, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner2.id, partner_bank_id: 502, payment_method_line_id: method.id, amount: 30, currency_id: eur.id, memo: 'Bill 2', date: today() },
      ],
      'account.batch.payment': [batch],
    },
    seq: { ...db.seq, 'account.batch.payment': 500, 'account.payment': 502, 'account.move': 502, 'res.partner.bank': 502 },
  };

  const postedDb = postBatch(db, batch);
  const postedBatch = read(postedDb, 'account.batch.payment', 500);

  // 1. Direct replacement edits before cancellation are rejected
  const forgedOnUncancelled = {
    ...postedDb,
    records: {
      ...postedDb.records,
      'account.batch.payment': [{ ...postedBatch, replacement_sequence: 1, replacement_identifier: 'FORGED-1', replacement_sepa_file: '<fake/>' }],
    },
  };
  assert.throws(() => applyDiff(postedDb, diffDb(postedDb, forgedOnUncancelled), { isAdmin: true }), /validated SEPA batch cannot be changed/);

  // Cancel payment 501
  const reversedDb = reversePayment(postedDb, read(postedDb, 'account.payment', 501), today());
  const batchAfterCancel = read(reversedDb, 'account.batch.payment', 500);

  // 2. Direct edit forging replacement XML is rejected
  const forgedXml = {
    ...reversedDb,
    records: {
      ...reversedDb.records,
      'account.batch.payment': [{
        ...batchAfterCancel,
        replacement_sequence: 1,
        replacement_identifier: formatReplacementIdentifier(batchAfterCancel.name, 1),
        replacement_date: today(),
        replacement_sepa_file: '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"><CreDtTm>2026-11-22T00:00:00.000Z</CreDtTm><tampered/></Document>',
      }],
    },
  };
  assert.throws(() => applyDiff(reversedDb, diffDb(reversedDb, forgedXml), { isAdmin: true }), /SEPA file does not match/);

  // 3. Direct edit jumping sequence is rejected
  const forgedSeq = {
    ...reversedDb,
    records: {
      ...reversedDb.records,
      'account.batch.payment': [{
        ...batchAfterCancel,
        replacement_sequence: 5,
        replacement_identifier: formatReplacementIdentifier(batchAfterCancel.name, 5),
        replacement_date: today(),
        replacement_sepa_file: '<Document/>',
      }],
    },
  };
  assert.throws(() => applyDiff(reversedDb, diffDb(reversedDb, forgedSeq), { isAdmin: true }), /validated SEPA batch cannot be changed/);

  // 4. Direct edit forging identifier is rejected
  const forgedId = {
    ...reversedDb,
    records: {
      ...reversedDb.records,
      'account.batch.payment': [{
        ...batchAfterCancel,
        replacement_sequence: 1,
        replacement_identifier: 'MALICIOUS_IDENTIFIER',
        replacement_date: today(),
        replacement_sepa_file: '<Document/>',
      }],
    },
  };
  assert.throws(() => applyDiff(reversedDb, diffDb(reversedDb, forgedId), { isAdmin: true }), /validated SEPA batch cannot be changed/);

  // 5. Legitimate replacement button generates and persists properly
  const replaceBtn = paymentModels['account.batch.payment'].form.buttons.find((b) => b.label === 'Generate Replacement SEPA file');
  const legitimate = replaceBtn.run(reversedDb, batchAfterCancel);
  assert.ok(legitimate.download);
  const legitimateBatch = read(legitimate.db, 'account.batch.payment', 500);
  assert.equal(legitimateBatch.replacement_sequence, 1);
  assert.equal(legitimateBatch.replacement_identifier, formatReplacementIdentifier(batch.name, 1));
  assert.equal(legitimateBatch.replacement_sepa_file, legitimate.download.content);

  // 6. Direct edit tampering with already generated replacement file is rejected
  const tamperedReplacement = {
    ...legitimate.db,
    records: {
      ...legitimate.db.records,
      'account.batch.payment': [{ ...legitimateBatch, replacement_sepa_file: 'tampered-xml' }],
    },
  };
  assert.throws(() => applyDiff(legitimate.db, diffDb(legitimate.db, tamperedReplacement), { isAdmin: true }), /validated SEPA batch cannot be changed/);
});

test('past replacement execution date does not block subsequent payment reversals and defaults to today on next replacement', async () => {
  const { seed } = await import('./seed.js');
  const { read } = await import('./orm.js');
  const { postBatch, paymentModels, formatReplacementIdentifier } = await import('./models/payments.js');
  const { buildSepaXml } = await import('./models/sepa.js');
  const { reversePayment } = await import('./models/pay.js');
  const { addDays, today } = await import('./models/common.js');
  let db = await addJournalMethods(seed());
  const bank = db.records['account.journal'].find((j) => j.type === 'bank');
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  const method = db.records['account.payment.method.line'].find((l) => l.journal_id === bank.id && l.payment_method_id === sepa.id);
  const partner1 = db.records['res.partner'][0];
  const partner2 = db.records['res.partner'][1];
  const partner3 = db.records['res.partner'][2];

  const pastDate = addDays(today(), -5);

  const batch = {
    id: 600,
    name: 'BATCH-EXPIRED-DATE',
    state: 'draft',
    batch_type: 'outbound',
    date: pastDate,
    company_id: 1,
    journal_id: bank.id,
    lines: [
      { payment_id: 601, amount: 10 },
      { payment_id: 602, amount: 20 },
      { payment_id: 603, amount: 30 },
    ],
  };

  db = {
    ...db,
    records: {
      ...db.records,
      'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, currency_id: eur.id } : c)),
      'account.journal': db.records['account.journal'].map((j) => (j.id === bank.id ? { ...j, bank_account_id: 600, currency_id: eur.id } : j)),
      'res.partner.bank': [
        ...(db.records['res.partner.bank'] ?? []),
        { id: 600, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' },
        { id: 601, account_number: 'FR7630006000011234567890189', partner_id: partner1.id, allow_out_payment: true },
        { id: 602, account_number: 'IT60X0542811101000000123456', partner_id: partner2.id, allow_out_payment: true },
        { id: 603, account_number: 'ES9121000418450200051332', partner_id: partner3.id, allow_out_payment: true },
      ],
      'account.move': [
        ...db.records['account.move'],
        { id: 601, name: 'ENTRY/601', state: 'posted', move_type: 'entry', date: pastDate, line_ids: [{ id: 6011, account_id: bank.default_account_id ?? 1, debit: 0, credit: 10 }, { id: 6012, account_id: 2, debit: 10, credit: 0 }], company_id: 1 },
        { id: 602, name: 'ENTRY/602', state: 'posted', move_type: 'entry', date: pastDate, line_ids: [{ id: 6021, account_id: bank.default_account_id ?? 1, debit: 0, credit: 20 }, { id: 6022, account_id: 2, debit: 20, credit: 0 }], company_id: 1 },
        { id: 603, name: 'ENTRY/603', state: 'posted', move_type: 'entry', date: pastDate, line_ids: [{ id: 6031, account_id: bank.default_account_id ?? 1, debit: 0, credit: 30 }, { id: 6032, account_id: 2, debit: 30, credit: 0 }], company_id: 1 },
      ],
      'account.payment': [
        ...(db.records['account.payment'] ?? []),
        { id: 601, name: 'PAY/601', state: 'posted', move_id: 601, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner1.id, partner_bank_id: 601, payment_method_line_id: method.id, amount: 10, currency_id: eur.id, memo: 'Bill 1', date: pastDate },
        { id: 602, name: 'PAY/602', state: 'posted', move_id: 602, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner2.id, partner_bank_id: 602, payment_method_line_id: method.id, amount: 20, currency_id: eur.id, memo: 'Bill 2', date: pastDate },
        { id: 603, name: 'PAY/603', state: 'posted', move_id: 603, company_id: 1, journal_id: bank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner3.id, partner_bank_id: 603, payment_method_line_id: method.id, amount: 30, currency_id: eur.id, memo: 'Bill 3', date: pastDate },
      ],
      'account.batch.payment': [batch],
    },
    seq: { ...db.seq, 'account.batch.payment': 600, 'account.payment': 603, 'account.move': 603, 'res.partner.bank': 603 },
  };

  const postedDb = postBatch(db, batch);

  // Cancel 601 in the past
  const reversedDb1 = reversePayment(postedDb, read(postedDb, 'account.payment', 601), pastDate);
  const batchCancel1 = read(reversedDb1, 'account.batch.payment', 600);

  // Set an expired replacement date (simulating a replacement created on a previous day)
  const replaceBtn = paymentModels['account.batch.payment'].form.buttons.find((b) => b.label === 'Generate Replacement SEPA file');
  const pastTimestamp = '2026-11-17T10:00:00.000Z';
  const file1 = buildSepaXml({
    id: formatReplacementIdentifier(batch.name, 1),
    createdAt: pastTimestamp,
    date: pastDate,
    debtor: { name: 'Company', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
    payments: [
      { id: '602', amount: 20, name: partner2.name, iban: 'IT60X0542811101000000123456', memo: 'Bill 2' },
      { id: '603', amount: 30, name: partner3.name, iban: 'ES9121000418450200051332', memo: 'Bill 3' },
    ],
  });

  // Manually put the batch into the historical state (as if it was generated in the past)
  const dbWithHistoricalReplacement = {
    ...reversedDb1,
    records: {
      ...reversedDb1.records,
      'account.batch.payment': [{
        ...batchCancel1,
        replacement_identifier: formatReplacementIdentifier(batch.name, 1),
        replacement_sequence: 1,
        replacement_date: pastDate,
        replacement_sepa_file: file1,
      }],
    },
  };

  // Reversing payment 602 today must NOT be blocked by the expired replacement_date
  const reversedDb2 = reversePayment(dbWithHistoricalReplacement, read(dbWithHistoricalReplacement, 'account.payment', 602), today());
  const batchCancel2 = read(reversedDb2, 'account.batch.payment', 600);
  assert.equal(batchCancel2.lines[0].cancelled, true);
  assert.equal(batchCancel2.lines[1].cancelled, true);
  assert.equal(batchCancel2.lines[2].cancelled, false);
  assert.equal(batchCancel2.replacement_date, pastDate, 'Unrelated write leaves historical replacement_date intact');

  // Generating a second replacement defaults the expired stored replacement_date to today
  const replacement2 = replaceBtn.run(reversedDb2, batchCancel2);
  assert.ok(replacement2.download);
  assert.match(replacement2.download.content, new RegExp(`<ReqdExctnDt><Dt>${today()}</Dt></ReqdExctnDt>`));

  const persistedBatch2 = read(replacement2.db, 'account.batch.payment', 600);
  assert.equal(persistedBatch2.replacement_sequence, 2);
  assert.equal(persistedBatch2.replacement_date, today());
  assert.equal(persistedBatch2.replacement_identifier, formatReplacementIdentifier(batch.name, 2));

  // Explicitly requesting an expired date still throws
  assert.throws(
    () => replaceBtn.run(reversedDb2, batchCancel2, { executionDate: pastDate }),
    /valid current or future date/i,
  );
});

test('bank journal exposes sepa_pain_version defaulting to pain.001.001.09 and SEPA XML supports .09 and .03 variants', async () => {
  const { seed } = await import('./seed.js');
  const { create, read, write } = await import('./orm.js');
  const { models } = await import('./models/index.js');
  const { buildSepaXml } = await import('./models/sepa.js');
  const { postBatch, paymentModels } = await import('./models/payments.js');
  const { reversePayment } = await import('./models/pay.js');
  const { diffDb, applyDiff } = await import('./sync.js');
  const { today } = await import('./models/common.js');

  const journalModel = models['account.journal'];
  const painField = journalModel.fields.sepa_pain_version;
  assert.equal(painField?.type, 'selection', 'sepa_pain_version is a selection field');
  const optionKeys = painField.options.map(([k]) => k);
  assert.ok(optionKeys.includes('pain.001.001.03'), 'offers pain.001.001.03');
  assert.ok(optionKeys.includes('pain.001.001.09'), 'offers pain.001.001.09');

  let db = await addJournalMethods(seed());
  const seededBank = db.records['account.journal'].find((j) => j.type === 'bank');
  assert.equal(seededBank.sepa_pain_version, 'pain.001.001.09', 'seeded bank journal defaults to pain.001.001.09');

  const createdBank = create(db, 'account.journal', {
    name: 'Euro Bank',
    code: 'EUR1',
    type: 'bank',
    company_id: 1,
    suspense_account_id: seededBank.suspense_account_id,
  });
  assert.equal(read(createdBank.db, 'account.journal', createdBank.id).sepa_pain_version, 'pain.001.001.09', 'new bank journal defaults to pain.001.001.09');
  assert.equal(
    journalModel.onchange({ type: 'bank' }, 'type', db).sepa_pain_version,
    'pain.001.001.09',
    'changing journal type to bank defaults sepa_pain_version to pain.001.001.09',
  );

  const outTab = journalModel.form.tabs(seededBank).find((tab) => tab.label === 'Outgoing Payments');
  const outTabFields = [...(outTab.fields ?? []), ...(outTab.groups ?? []).flatMap((g) => Array.isArray(g) ? g : g.fields ?? [])];
  assert.ok(outTabFields.includes('sepa_pain_version'), 'Outgoing Payments tab displays sepa_pain_version');

  // Guard rejects invalid pain version via diffDb + applyDiff and via ORM write/create
  const forgedVersionDb = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.id === seededBank.id ? { ...j, sepa_pain_version: 'pain.001.001.99' } : j)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedVersionDb), { isAdmin: true }), /sepa_pain_version|SEPA Pain Version/i);
  assert.throws(() => write(db, 'account.journal', seededBank.id, { sepa_pain_version: 'pain.001.001.99' }), /Select a valid SEPA Pain Version/);
  const forgedNonBankDb = {
    ...db,
    records: {
      ...db.records,
      'account.journal': db.records['account.journal'].map((j) => (j.type === 'cash' ? { ...j, sepa_pain_version: 'pain.001.001.09' } : j)),
    },
  };
  assert.throws(() => applyDiff(db, diffDb(db, forgedNonBankDb), { isAdmin: true }), /only valid for bank journals/i);

  // One canonical builder produces both .09 and .03 from the same batch data
  const sample = {
    id: 'BATCH-VAR',
    createdAt: '2026-11-22T08:00:00.000Z',
    date: '2026-11-22',
    debtor: { name: 'Debtor Ltd', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
    payments: [{ id: 'P1', amount: 42.5, name: 'Creditor GmbH', iban: 'FR7630006000011234567890189', memo: 'Inv 1' }],
  };
  const xml09 = buildSepaXml({ ...sample, painVersion: 'pain.001.001.09' });
  assert.match(xml09, /xmlns="urn:iso:std:iso:20022:tech:xsd:pain\.001\.001\.09"/);
  assert.match(xml09, /<DbtrAgt><FinInstnId><BICFI>COBADEFFXXX<\/BICFI><\/FinInstnId><\/DbtrAgt>/);
  assert.ok(!xml09.includes('<BIC>'), '.09 uses BICFI, not BIC');
  assert.match(xml09, /<ReqdExctnDt><Dt>2026-11-22<\/Dt><\/ReqdExctnDt>/);

  const xml03 = buildSepaXml({ ...sample, painVersion: 'pain.001.001.03' });
  assert.match(xml03, /xmlns="urn:iso:std:iso:20022:tech:xsd:pain\.001\.001\.03"/);
  assert.match(xml03, /<DbtrAgt><FinInstnId><BIC>COBADEFFXXX<\/BIC><\/FinInstnId><\/DbtrAgt>/);
  assert.ok(!xml03.includes('<BICFI>'), '.03 uses BIC, not BICFI');
  assert.match(xml03, /<ReqdExctnDt>2026-11-22<\/ReqdExctnDt>/);
  assert.ok(!xml03.includes('<Dt>'), '.03 places date directly inside ReqdExctnDt');

  assert.throws(() => buildSepaXml({ ...sample, painVersion: 'pain.001.001.99' }), /Unsupported SEPA pain version/);

  // Generated XML follows journal's sepa_pain_version (both .09 default and .03) and guard verifies version match
  const eur = db.records['res.currency'].find((c) => c.name === 'EUR');
  const sepa = db.records['account.payment.method'].find((m) => m.code === 'sepa_ct');
  const method = db.records['account.payment.method.line'].find((l) => l.journal_id === seededBank.id && l.payment_method_id === sepa.id);
  const partner1 = db.records['res.partner'][0];
  const partner2 = db.records['res.partner'][1];
  const execDate = today();

  const makeScenario = (painVersion, baseId) => {
    const batch = {
      id: baseId,
      name: `BATCH-${baseId}`,
      state: 'draft',
      batch_type: 'outbound',
      date: execDate,
      company_id: 1,
      journal_id: seededBank.id,
      lines: [
        { payment_id: baseId + 1, amount: 15 },
        { payment_id: baseId + 2, amount: 25 },
      ],
    };
    let sdb = {
      ...db,
      records: {
        ...db.records,
        'res.company': db.records['res.company'].map((c) => (c.id === 1 ? { ...c, currency_id: eur.id } : c)),
        'res.partner.bank': [
          ...(db.records['res.partner.bank'] ?? []),
          { id: baseId, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX', company_id: 1, partner_id: db.records['res.company'][0].partner_id },
          { id: baseId + 1, account_number: 'FR7630006000011234567890189', partner_id: partner1.id, allow_out_payment: true },
          { id: baseId + 2, account_number: 'IT60X0542811101000000123456', partner_id: partner2.id, allow_out_payment: true },
        ],
        'account.move': [
          ...db.records['account.move'],
          { id: baseId + 1, name: `ENTRY/${baseId + 1}`, state: 'posted', move_type: 'entry', date: execDate, line_ids: [{ id: baseId * 10 + 1, account_id: seededBank.default_account_id ?? 1, debit: 0, credit: 15 }, { id: baseId * 10 + 2, account_id: 2, debit: 15, credit: 0 }], company_id: 1 },
          { id: baseId + 2, name: `ENTRY/${baseId + 2}`, state: 'posted', move_type: 'entry', date: execDate, line_ids: [{ id: baseId * 10 + 3, account_id: seededBank.default_account_id ?? 1, debit: 0, credit: 25 }, { id: baseId * 10 + 4, account_id: 2, debit: 25, credit: 0 }], company_id: 1 },
        ],
        'account.payment': [
          ...(db.records['account.payment'] ?? []),
          { id: baseId + 1, name: `PAY/${baseId + 1}`, state: 'posted', move_id: baseId + 1, company_id: 1, journal_id: seededBank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner1.id, partner_bank_id: baseId + 1, payment_method_line_id: method.id, amount: 15, currency_id: eur.id, memo: 'Bill A', date: execDate },
          { id: baseId + 2, name: `PAY/${baseId + 2}`, state: 'posted', move_id: baseId + 2, company_id: 1, journal_id: seededBank.id, payment_type: 'outbound', partner_type: 'supplier', partner_id: partner2.id, partner_bank_id: baseId + 2, payment_method_line_id: method.id, amount: 25, currency_id: eur.id, memo: 'Bill B', date: execDate },
        ],
        'account.batch.payment': [batch],
      },
      seq: { ...db.seq, 'account.batch.payment': baseId, 'account.payment': baseId + 2, 'account.move': baseId + 2, 'res.partner.bank': baseId + 2 },
    };
    sdb = write(sdb, 'account.journal', seededBank.id, { sepa_pain_version: painVersion, bank_account_id: baseId, currency_id: eur.id });
    return { sdb, batch };
  };

  // Scenario A: pain.001.001.09
  const { sdb: db09, batch: b09 } = makeScenario('pain.001.001.09', 700);
  const posted09 = postBatch(db09, b09);
  const rec09 = read(posted09, 'account.batch.payment', 700);
  assert.match(rec09.sepa_file, /pain\.001\.001\.09/);
  assert.match(rec09.sepa_file, /<BICFI>COBADEFFXXX<\/BICFI>/);
  assert.match(rec09.sepa_file, new RegExp(`<ReqdExctnDt><Dt>${execDate}</Dt></ReqdExctnDt>`));
  assert.doesNotThrow(() => applyDiff(db09, diffDb(db09, posted09), { isAdmin: true }));

  // Forging a .03 XML when journal is .09 is rejected by sync guard
  const createdAt09 = rec09.sepa_file.match(/<CreDtTm>([^<]+)<\/CreDtTm>/)[1];
  const wrongVersionXml = buildSepaXml({
    id: rec09.name,
    createdAt: createdAt09,
    date: execDate,
    painVersion: 'pain.001.001.03',
    debtor: { name: db09.records['res.company'][0].name, iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' },
    payments: [
      { id: '701', amount: 15, name: partner1.name, iban: 'FR7630006000011234567890189', memo: 'Bill A' },
      { id: '702', amount: 25, name: partner2.name, iban: 'IT60X0542811101000000123456', memo: 'Bill B' },
    ],
  });
  const forgedWrongVersion = {
    ...posted09,
    records: { ...posted09.records, 'account.batch.payment': [{ ...rec09, sepa_file: wrongVersionXml }] },
  };
  assert.throws(() => applyDiff(db09, diffDb(db09, forgedWrongVersion), { isAdmin: true }), /SEPA file does not match/);

  // Replacement preserves .09
  const rev09 = reversePayment(posted09, read(posted09, 'account.payment', 701), execDate);
  const replaceBtn = paymentModels['account.batch.payment'].form.buttons.find((b) => b.label === 'Generate Replacement SEPA file');
  const rep09 = replaceBtn.run(rev09, read(rev09, 'account.batch.payment', 700));
  assert.match(rep09.download.content, /pain\.001\.001\.09/);
  assert.match(rep09.download.content, /<BICFI>COBADEFFXXX<\/BICFI>/);

  // Scenario B: pain.001.001.03
  const { sdb: db03, batch: b03 } = makeScenario('pain.001.001.03', 800);
  const posted03 = postBatch(db03, b03);
  const rec03 = read(posted03, 'account.batch.payment', 800);
  assert.match(rec03.sepa_file, /pain\.001\.001\.03/);
  assert.match(rec03.sepa_file, /<BIC>COBADEFFXXX<\/BIC>/);
  assert.match(rec03.sepa_file, new RegExp(`<ReqdExctnDt>${execDate}</ReqdExctnDt>`));
  assert.doesNotThrow(() => applyDiff(db03, diffDb(db03, posted03), { isAdmin: true }));

  const rev03 = reversePayment(posted03, read(posted03, 'account.payment', 801), execDate);
  const rep03 = replaceBtn.run(rev03, read(rev03, 'account.batch.payment', 800));
  assert.match(rep03.download.content, /pain\.001\.001\.03/);
  assert.match(rep03.download.content, /<BIC>COBADEFFXXX<\/BIC>/);
});

test('direct ORM writes converting journal type normalize sepa_pain_version in the write path and preserve guards', async () => {
  const { seed } = await import('./seed.js');
  const { create, read, unlink, write } = await import('./orm.js');
  const { models } = await import('./models/index.js');
  const { DEFAULT_SEPA_PAIN_VERSION } = await import('./models/sepa.js');

  const journalModel = models['account.journal'];
  assert.equal(typeof journalModel.prepareWrite, 'function', 'account.journal defines prepareWrite in the write path');

  const db = await addJournalMethods(seed());
  const seededBank = db.records['account.journal'].find((j) => j.type === 'bank');
  const seededCash = db.records['account.journal'].find((j) => j.type === 'cash');
  const seededMisc = db.records['account.journal'].find((j) => j.type === 'general');

  // prepareWrite hook normalizes values directly
  const prepBank = journalModel.prepareWrite(db, { type: 'bank' }, seededCash);
  assert.equal(prepBank.vals.sepa_pain_version, DEFAULT_SEPA_PAIN_VERSION, 'prepareWrite assigns default version when changing to bank');

  const prepCash = journalModel.prepareWrite(db, { type: 'cash' }, seededBank);
  assert.equal(prepCash.vals.sepa_pain_version, null, 'prepareWrite clears version when changing to non-bank');

  const prepExplicitNonBank = journalModel.prepareWrite(db, { type: 'cash', sepa_pain_version: 'pain.001.001.09' }, seededBank);
  assert.equal(prepExplicitNonBank.vals.sepa_pain_version, 'pain.001.001.09', 'prepareWrite preserves explicitly supplied version on non-bank for guard check');

  // 1. Direct ORM write converting cash/general to bank without explicit version gets saved default
  const dbToBank = write(db, 'account.journal', seededCash.id, { type: 'bank' });
  const convertedBank = read(dbToBank, 'account.journal', seededCash.id);
  assert.equal(convertedBank.type, 'bank');
  assert.equal(convertedBank.sepa_pain_version, 'pain.001.001.09', 'converting cash journal to bank saves default sepa_pain_version');

  const dbMiscToBank = write(db, 'account.journal', seededMisc.id, { type: 'bank', suspense_account_id: seededBank.suspense_account_id });
  const convertedMiscBank = read(dbMiscToBank, 'account.journal', seededMisc.id);
  assert.equal(convertedMiscBank.type, 'bank');
  assert.equal(convertedMiscBank.sepa_pain_version, 'pain.001.001.09', 'converting general journal to bank saves default sepa_pain_version');

  // Direct ORM write converting to bank with explicit version preserves explicit version
  const dbCustomBank = write(db, 'account.journal', seededCash.id, { type: 'bank', sepa_pain_version: 'pain.001.001.03' });
  assert.equal(read(dbCustomBank, 'account.journal', seededCash.id).sepa_pain_version, 'pain.001.001.03', 'explicitly supplied version is saved');

  // 2. Direct ORM write converting bank to non-bank clears sepa_pain_version before guard validation
  const standaloneBank = create(db, 'account.journal', {
    name: 'Standalone Bank',
    code: 'STB1',
    type: 'bank',
    company_id: 1,
    suspense_account_id: seededBank.suspense_account_id,
  });
  const dbToCash = write(standaloneBank.db, 'account.journal', standaloneBank.id, { type: 'cash' });
  const convertedCash = read(dbToCash, 'account.journal', standaloneBank.id);
  assert.equal(convertedCash.type, 'cash');
  assert.equal(convertedCash.sepa_pain_version, null, 'converting bank journal to cash clears sepa_pain_version');

  const unlinkedDb = unlink(
    standaloneBank.db,
    'account.payment.method.line',
    standaloneBank.db.records['account.payment.method.line'].filter((l) => l.journal_id === standaloneBank.id).map((l) => l.id),
  );
  const dbToGeneral = write(unlinkedDb, 'account.journal', standaloneBank.id, {
    type: 'general',
    suspense_account_id: null,
  });
  const convertedGeneral = read(dbToGeneral, 'account.journal', standaloneBank.id);
  assert.equal(convertedGeneral.type, 'general');
  assert.equal(convertedGeneral.sepa_pain_version, null, 'converting bank journal to general clears sepa_pain_version');

  // 3. Guard against explicitly setting sepa_pain_version on non-bank is preserved
  assert.throws(
    () => write(standaloneBank.db, 'account.journal', standaloneBank.id, { type: 'cash', sepa_pain_version: 'pain.001.001.09' }),
    /SEPA Pain Version is only valid for bank journals/i,
    'rejects explicitly supplying sepa_pain_version when changing bank to cash',
  );
  assert.throws(
    () => write(db, 'account.journal', seededCash.id, { sepa_pain_version: 'pain.001.001.09' }),
    /SEPA Pain Version is only valid for bank journals/i,
    'rejects setting sepa_pain_version directly on a cash journal',
  );
});
