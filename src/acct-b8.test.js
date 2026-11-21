import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { accountId, isBalanced } from './models/ledger.js';
import { importStatement, parseCamt } from './models/statements.js';
import { autoReconcile } from './models/reconcile.js';
import { applyDiff, diffDb } from './sync.js';

const LINE = 'account.bank.statement.line';
const STMT = 'account.bank.statement';
const MODEL = 'account.reconcile.model';

const bankJournal = (db) => search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);

test('BANK-8: journalRunningBalances seeds from statement balance_start so running_balance matches the bank balance', () => {
  let db = seed();
  const journal = bankJournal(db);

  // 1. Statement with explicit opening balance 500 and two lines
  const s1 = create(db, STMT, {
    name: 'STMT/2026/001',
    journal_id: journal.id,
    date: '2026-04-10',
    balance_start: 500,
    balance_end_real: 650,
  });
  db = s1.db;
  const l1 = create(db, LINE, {
    statement_id: s1.id,
    journal_id: journal.id,
    date: '2026-04-05',
    sequence: 10,
    payment_ref: 'Customer receipt',
    amount: 200,
  });
  db = l1.db;
  const l2 = create(db, LINE, {
    statement_id: s1.id,
    journal_id: journal.id,
    date: '2026-04-06',
    sequence: 10,
    payment_ref: 'Bank fee',
    amount: -50,
  });
  db = l2.db;

  assert.equal(read(db, LINE, l1.id).running_balance, 700, 'first line running_balance = 500 + 200');
  assert.equal(read(db, LINE, l2.id).running_balance, 650, 'second line running_balance = 700 - 50 (matches statement ending balance)');

  // 2. Imported CAMT.053 statement with OPBD=1000 and CLBD=1150
  const camt = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-04-20</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">1150.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-04-21</Dt></Dt></Bal>
<Ntry><Amt Ccy="USD">150.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2026-04-21</Dt></BookgDt><AcctSvcrRef>B8-CAMT-1</AcctSvcrRef><AddtlNtryInf>Wire in</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
  const imp = importStatement(db, 'april.xml', camt, { journal_id: journal.id });
  db = imp.db;
  const camtLine = search(db, LINE).find((l) => l.unique_import_id === 'B8-CAMT-1');
  assert.equal(camtLine.running_balance, 1150, 'imported line running_balance equals statement balance_end_real');

  // 3. Updating statement balance_start via diffDb + applyDiff recomputes running_balance
  const updated = write(db, STMT, s1.id, { balance_start: 600 });
  const synced = applyDiff(db, diffDb(db, updated), { isAdmin: true });
  assert.equal(read(synced, LINE, l1.id).running_balance, 800);
  assert.equal(read(synced, LINE, l2.id).running_balance, 750);
  assert.equal('running_balance' in synced.records[LINE].find((l) => l.id === l1.id), false);
});

test('BANK-9: parseCamt keeps CdtDbtInd booked sign and applies RvslInd to counterpart party lookup (per Odoo/OCA)', () => {
  const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Ntry><Amt Ccy="USD">250.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><RvslInd>true</RvslInd><BookgDt><Dt>2026-05-10</Dt></BookgDt><AcctSvcrRef>B8-REV-CRDT</AcctSvcrRef><AddtlNtryInf>Reversal credit</AddtlNtryInf>
<NtryDtls><TxDtls><CdtrAcct><Id><IBAN>CR-ACCT-1</IBAN></Id></CdtrAcct><DbtrAcct><Id><IBAN>DB-ACCT-1</IBAN></Id></DbtrAcct></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="USD">80.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><RvslInd>1</RvslInd><BookgDt><Dt>2026-05-11</Dt></BookgDt><AcctSvcrRef>B8-REV-DBIT</AcctSvcrRef><AddtlNtryInf>Reversal debit</AddtlNtryInf>
<NtryDtls><TxDtls><CdtrAcct><Id><IBAN>CR-ACCT-2</IBAN></Id></CdtrAcct><DbtrAcct><Id><IBAN>DB-ACCT-2</IBAN></Id></DbtrAcct></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

  const entries = parseCamt(xml, { details: true });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].amount, 250);
  assert.equal(entries[0].account_number, 'CR-ACCT-1');
  assert.equal(entries[1].amount, -80);
  assert.equal(entries[1].account_number, 'DB-ACCT-2');
});

test('BANK-23: autoReconcile applies regex amount lines when regex matches and skips only non-matching lines', () => {
  let db = seed();
  const journal = bankJournal(db);
  const feeAcc = accountId(db, '600000');
  const miscAcc = accountId(db, '690000');

  // 1. Auto rule with regex line + 100% remainder line
  const rMixed = create(db, MODEL, {
    name: 'Auto Fee Regex + Remainder',
    sequence: 1,
    rule_type: 'writeoff_suggestion',
    trigger: 'auto_reconcile',
    match_label: 'contains',
    match_label_param: 'SETTLE',
    line_ids: [
      { sequence: 10, account_id: feeAcc, amount_type: 'regex', amount_string: String.raw`FEE=(\d+(?:\.\d{2})?)`, label: 'Extracted Fee' },
      { sequence: 20, account_id: miscAcc, amount_type: 'percentage', amount_string: '100', label: 'Remainder' },
    ],
  });
  db = rMixed.db;

  const lMatch = create(db, LINE, {
    journal_id: journal.id,
    date: '2026-06-01',
    payment_ref: 'SETTLE REF-1 FEE=12.50',
    amount: -100,
  });
  db = lMatch.db;

  const lPartialSkip = create(db, LINE, {
    journal_id: journal.id,
    date: '2026-06-02',
    payment_ref: 'SETTLE REF-2 NO-FEE',
    amount: -100,
  });
  db = lPartialSkip.db;

  // 2. Auto rule with regex-only line: reconciles when label matches, leaves to_check when it does not
  const rRegexOnly = create(db, MODEL, {
    name: 'Auto Regex Only',
    sequence: 2,
    rule_type: 'writeoff_suggestion',
    trigger: 'auto_reconcile',
    line_ids: [
      { sequence: 10, account_id: feeAcc, amount_type: 'regex', amount_string: String.raw`CHARGE (\d+)`, label: 'Regex Charge' },
    ],
  });
  db = rRegexOnly.db;

  const lOnlyMatch = create(db, LINE, {
    journal_id: journal.id,
    date: '2026-06-03',
    payment_ref: 'BANK CHARGE 30',
    amount: -30,
  });
  db = lOnlyMatch.db;

  const lOnlyNoMatch = create(db, LINE, {
    journal_id: journal.id,
    date: '2026-06-04',
    payment_ref: 'UNRELATED TRANSFER',
    amount: -30,
  });
  db = lOnlyNoMatch.db;

  const after = autoReconcile(db);

  // Matching mixed rule: reconciled with 12.50 on feeAcc and 87.50 on miscAcc
  const recMatch = read(after, LINE, lMatch.id);
  assert.equal(recMatch.state, 'reconciled');
  const moveMatch = read(after, 'account.move', recMatch.move_id);
  assert.ok(isBalanced(moveMatch.line_ids));
  assert.equal(moveMatch.line_ids.find((x) => x.account_id === feeAcc).debit, 12.5);
  assert.equal(moveMatch.line_ids.find((x) => x.account_id === miscAcc).debit, 87.5);

  // Mixed rule when regex line does not match: only the non-matching regex line is skipped, remainder takes 100
  const recPartialSkip = read(after, LINE, lPartialSkip.id);
  assert.equal(recPartialSkip.state, 'reconciled');
  const movePartialSkip = read(after, 'account.move', recPartialSkip.move_id);
  assert.equal(movePartialSkip.line_ids.some((x) => x.account_id === feeAcc), false);
  assert.equal(movePartialSkip.line_ids.find((x) => x.account_id === miscAcc).debit, 100);

  // Regex-only rule: matching label reconciles, non-matching label is skipped cleanly
  assert.equal(read(after, LINE, lOnlyMatch.id).state, 'reconciled');
  assert.equal(read(after, LINE, lOnlyNoMatch.id).state, 'to_check');
});
