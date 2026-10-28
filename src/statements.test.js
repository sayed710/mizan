import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from './orm.js';
import { importStatement, parseCamt, parseOfx } from './models/statements.js';
import { seed } from './seed.js';

const OFX = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260502120000<TRNAMT>1500.00<FITID>A1<NAME>Nile Furniture<MEMO>INV/2026/00001
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260503<TRNAMT>-25,50<FITID>A2<NAME>Bank fee</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

const CAMT = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Ntry><Amt Ccy="EUR">200.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-05-04</Dt></BookgDt><AcctSvcrRef>C1</AcctSvcrRef>
<NtryDtls><TxDtls><RmtInf><Ustrd>Order S00012 &amp; more</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="EUR">80.10</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><DtTm>2026-05-05T10:00:00</DtTm></BookgDt><AddtlNtryInf>Rent May</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

test('OFX transactions parse with unclosed SGML tags and comma decimals', () => {
  assert.deepEqual(parseOfx(OFX), [
    { date: '2026-05-02', amount: 1500, payment_ref: 'Nile Furniture - INV/2026/00001', unique_import_id: 'A1' },
    { date: '2026-05-03', amount: -25.5, payment_ref: 'Bank fee', unique_import_id: 'A2' },
  ]);
});

test('CAMT.053 entries parse with debit sign, date-time and escaped references', () => {
  assert.deepEqual(parseCamt(CAMT), [
    { date: '2026-05-04', amount: 200, payment_ref: 'Order S00012 & more', unique_import_id: 'C1' },
    { date: '2026-05-05', amount: -80.1, payment_ref: 'Rent May', unique_import_id: null },
  ]);
});

test('importing creates lines to reconcile and skips transactions already imported', () => {
  const before = search(seed(), 'account.bank.statement.line').length;
  const first = importStatement(seed(), 'may.ofx', OFX);
  assert.equal(first.count, 2);
  const again = importStatement(first.db, 'may.ofx', OFX);
  assert.equal(again.count, 0);
  const lines = search(again.db, 'account.bank.statement.line');
  assert.equal(lines.length, before + 2);
  assert.ok(lines.slice(-2).every((l) => l.state === 'to_check'));
  assert.equal(importStatement(seed(), 'stmt.xml', CAMT).count, 2);
  assert.throws(() => importStatement(seed(), 'x.ofx', 'nothing'), /No transactions/);
});
