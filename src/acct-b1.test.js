import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { importStatement, importStatementLines, parseCamt, parseOfx, parseQif } from './models/statements.js';
import { seed } from './seed.js';

test('BANK-9: CAMT.053 reversal keeps the booked direction and takes the counterpart of the original operation', () => {
  const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Ntry><Amt Ccy="USD">150.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><RvslInd>true</RvslInd><BookgDt><Dt>2026-05-06</Dt></BookgDt><AcctSvcrRef>REV1</AcctSvcrRef><AddtlNtryInf>Reversal of incoming transfer</AddtlNtryInf>
<NtryDtls><TxDtls><CdtrAcct><Id><IBAN>IBAN-CREDITOR-1</IBAN></Id></CdtrAcct><DbtrAcct><Id><IBAN>IBAN-DEBTOR-1</IBAN></Id></DbtrAcct></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="USD">45.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><RvslInd>true</RvslInd><BookgDt><Dt>2026-05-07</Dt></BookgDt><AcctSvcrRef>REV2</AcctSvcrRef><AddtlNtryInf>Reversal of fee</AddtlNtryInf></Ntry>
<Ntry><Amt Ccy="USD">75.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><RvslInd>false</RvslInd><BookgDt><Dt>2026-05-08</Dt></BookgDt><AcctSvcrRef>NORM1</AcctSvcrRef><AddtlNtryInf>Normal credit</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

  const entries = parseCamt(xml, { details: true });
  assert.equal(entries.length, 3);
  // A booked credit that reverses an outgoing payment: cash comes in, the counterpart is the original creditor
  assert.equal(entries[0].amount, 150);
  assert.equal(entries[0].unique_import_id, 'REV1');
  assert.equal(entries[0].account_number, 'IBAN-CREDITOR-1');
  // A booked debit that reverses a credit: cash goes out
  assert.equal(entries[1].amount, -45);
  assert.equal(entries[1].unique_import_id, 'REV2');
  // Normal CRDT with RvslInd false remains positive
  assert.equal(entries[2].amount, 75);
  assert.equal(entries[2].unique_import_id, 'NORM1');
});

test('BANK-10: statement lines lacking unique_import_id are deduplicated by (date, payment_ref, amount)', () => {
  const initial = seed();
  const bankJournal = search(initial, 'account.journal').find((j) => j.type === 'bank').id;
  const defaults = { journal_id: bankJournal };

  const lines = [
    { date: '2026-05-10', amount: 500, payment_ref: 'Client wire transfer' },
    { date: '2026-05-11', amount: -50, payment_ref: 'Office supplies' },
    { date: '2026-05-12', amount: -10, payment_ref: 'Coffee' },
    { date: '2026-05-12', amount: -10, payment_ref: 'Coffee' },
  ];

  const first = importStatementLines(initial, lines, defaults);
  assert.equal(first.count, 4, 'First import imports all 4 lines');

  // Re-importing the same lines without unique_import_id must detect them as duplicates
  const second = importStatementLines(first.db, lines, defaults);
  assert.equal(second.count, 0, 'Re-importing identical lines without unique_import_id skips all duplicates');

  // If a third import has 3 coffee transactions (1 more than the 2 in db), only the extra one is imported
  const thirdLines = [
    { date: '2026-05-12', amount: -10, payment_ref: 'Coffee' },
    { date: '2026-05-12', amount: -10, payment_ref: 'Coffee' },
    { date: '2026-05-12', amount: -10, payment_ref: 'Coffee' },
  ];
  const third = importStatementLines(first.db, thirdLines, defaults);
  assert.equal(third.count, 1, 'Only the unseen transaction count is imported');
});

test('BANK-11: OFX statement import extracts CURDEF and validates against journal currency', () => {
  const ofxEur = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>EUR
<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260515<TRNAMT>250.00<FITID>OFX-EUR-1<NAME>European Client</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  // 1. parseOfx extracts currency from CURDEF
  const parsed = parseOfx(ofxEur);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].currency, 'EUR');

  // 2. Importing into a USD journal rejects the mismatch
  const initial = seed();
  const bankJournal = search(initial, 'account.journal').find((j) => j.type === 'bank');
  const defaults = { journal_id: bankJournal.id };

  assert.throws(
    () => importStatement(initial, 'foreign.ofx', ofxEur, defaults),
    /Statement currency does not match journal currency USD/
  );

  // 3. Importing with matching CURDEF USD succeeds
  const ofxUsd = ofxEur.replace('<CURDEF>EUR', '<CURDEF>USD').replace('OFX-EUR-1', 'OFX-USD-1');
  const res = importStatement(initial, 'usd.ofx', ofxUsd, defaults);
  assert.equal(res.count, 1);
});

test('BANK-17: statement line auto-maps partner_id from account_number via res.partner.bank at import time', () => {
  const initial = seed();
  const bankJournal = search(initial, 'account.journal').find((j) => j.type === 'bank');
  const defaults = { journal_id: bankJournal.id };

  const partner = search(initial, 'res.partner')[1];
  const partnerBank = create(initial, 'res.partner.bank', {
    partner_id: partner.id,
    account_number: 'US99 BANK 8888 7777',
    company_id: 1,
  });

  const ofxWithAcct = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260520<TRNAMT>1200.00<FITID>OFX-PARTNER-1<NAME>Payment Ref<ACCTID>US99BANK88887777</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  const imported = importStatement(partnerBank.db, 'partner_test.ofx', ofxWithAcct, defaults);
  assert.equal(imported.count, 1);
  const line = search(imported.db, 'account.bank.statement.line').find((l) => l.unique_import_id === 'OFX-PARTNER-1');
  assert.ok(line);
  assert.equal(line.partner_id, partner.id, 'partner_id should be automatically mapped from res.partner.bank');
});

test('BANK-22: QIF bank statement import support', () => {
  const QIF = `!Type:Bank
D05/02/2026
T1,500.00
PNile Furniture
MINV/2026/00001
N1001
^
D05/03/2026
T-25,50
PBank fee
^`;

  // 1. parseQif parses basic transactions
  const basic = parseQif(QIF);
  assert.deepEqual(basic, [
    { date: '2026-05-02', amount: 1500, payment_ref: 'Nile Furniture - INV/2026/00001', unique_import_id: null },
    { date: '2026-05-03', amount: -25.5, payment_ref: 'Bank fee', unique_import_id: null },
  ]);

  // 2. parseQif with details parses narration and ref
  const detailed = parseQif(QIF, { details: true });
  assert.equal(detailed[0].narration, 'INV/2026/00001');
  assert.equal(detailed[0].ref, '1001');

  // 3. importStatement imports .qif files
  const initial = seed();
  const bankJournal = search(initial, 'account.journal').find((j) => j.type === 'bank');
  const defaults = { journal_id: bankJournal.id };
  const before = search(initial, 'account.bank.statement.line').length;

  const first = importStatement(initial, 'may.qif', QIF, defaults);
  assert.equal(first.count, 2);
  const lines = search(first.db, 'account.bank.statement.line');
  assert.equal(lines.length, before + 2);
  assert.ok(lines.slice(-2).every((l) => l.state === 'to_check'));

  // 4. Re-importing the same QIF file deduplicates and skips
  const second = importStatement(first.db, 'may.qif', QIF, defaults);
  assert.equal(second.count, 0);
});

test('QIF amounts read thousands commas, and an account number shared by two partners maps no partner', () => {
  const qif = '!Type:Bank\nD01/02/2026\nT1,234\nPA\n^\nD01/03/2026\nT-12,50\nPB\n^\n';
  assert.deepEqual(parseQif(qif).map((l) => l.amount), [1234, -12.5]);
  let db = seed();
  const partners = db.records['res.partner'].slice(0, 2);
  for (const p of partners) db = create(db, 'res.partner.bank', { partner_id: p.id, account_number: 'EG-SHARED-1' }).db;
  const journal = db.records['account.journal'].find((j) => j.type === 'bank');
  const out = importStatementLines(db, [{ date: '2026-01-05', amount: 10, payment_ref: 'X', account_number: 'EG-SHARED-1' }], { journal_id: journal.id });
  assert.equal(out.db.records['account.bank.statement.line'].at(-1).partner_id ?? null, null);
});

test('the journal own bank account on synced lines does not set the company as partner', () => {
  const initial = seed();
  const journal = search(initial, 'account.journal').find((j) => j.type === 'bank');
  const companyPartner = read(initial, 'res.company', 1).partner_id;
  const own = create(initial, 'res.partner.bank', { partner_id: companyPartner, account_number: 'EG-OWN-777', company_id: 1 });
  const db = write(own.db, 'account.journal', journal.id, { bank_account_id: own.id });
  const { db: next } = importStatementLines(db, [
    { unique_import_id: 'SYNC-1', date: '2026-05-01', amount: 50, payment_ref: 'Customer transfer', account_number: 'EG-OWN-777' },
  ], { journal_id: journal.id });
  const line = search(next, 'account.bank.statement.line').find((l) => l.unique_import_id === 'SYNC-1');
  assert.ok(line);
  assert.equal(line.partner_id ?? null, null);
});
