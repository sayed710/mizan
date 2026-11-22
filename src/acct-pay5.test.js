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
  assert.match(xml, /pain\.001\.001\.03/);
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

test('migration 62 seeds electronic and SEPA methods on databases already at version 61', async () => {
  const { migrate, SCHEMA_VERSION } = await import('./migrations.js');
  const { search } = await import('./orm.js');
  assert.equal(SCHEMA_VERSION, 62);
  const v61Db = {
    schema_version: 61,
    records: {
      'account.payment.method': [
        { id: 1, code: 'manual', payment_type: 'inbound', name: 'Manual' },
        { id: 2, code: 'manual', payment_type: 'outbound', name: 'Manual' },
        { id: 3, code: 'check_printing', payment_type: 'outbound', name: 'Checks' },
      ],
      'account.journal': [],
      'account.payment.method.line': [],
    },
    seq: { 'account.payment.method': 3 },
  };
  const upgraded = migrate(v61Db);
  assert.equal(upgraded.schema_version, 62);
  const methods = search(upgraded, 'account.payment.method');
  assert.equal(methods.length, 5);
  assert.ok(methods.some((m) => m.code === 'electronic' && m.payment_type === 'inbound'));
  assert.ok(methods.some((m) => m.code === 'sepa_ct' && m.payment_type === 'outbound'));
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
