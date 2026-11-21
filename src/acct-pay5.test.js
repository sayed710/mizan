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
    'res.partner.bank': [{ id: 1, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' }, { id: 2, account_number: 'FR7630006000011234567890189' }],
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
    'res.partner.bank': [...(db.records['res.partner.bank'] ?? []), { id: 100, account_number: 'DE89370400440532013000', bank_bic: 'COBADEFFXXX' }, { id: 101, account_number: 'FR7630006000011234567890189', partner_id: partner.id }],
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
