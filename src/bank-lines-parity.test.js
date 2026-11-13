import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { seed } from './seed.js';
import { applyFilters, create, groupRecords, matches, read, search, write, writeMany } from './orm.js';
import { models } from './models/index.js';
import { addDays, shiftMonth, today } from './models/common.js';
import { ensureBankSuspense } from './models/ledger.js';
import { importStatement, parseCamt, parseOfx } from './models/statements.js';
import { importCsvRows } from './csv.js';
import { cleanRecord } from './validate.js';
import { createCompany } from './models/company.js';

register(new URL('../scripts/jsx-loader.mjs', import.meta.url));
const { display } = await import('./ui.jsx');
const { List, colLabel, reorderSequenceUpdates, visibleListColumns } = await import('./views/List.jsx');

const LINE = 'account.bank.statement.line';

const findLiquidity = (db, type) => search(db, 'account.journal').find((j) => j.type === type && (j.company_id ?? 1) === 1);

function makeJournal(db, { code, name, type, currency_id = 1, account_type = 'asset_cash', acctCode }) {
  const acc = create(db, 'account.account', { code: acctCode, name: `${name} Account`, account_type, company_id: 1 });
  const suspense = ensureBankSuspense(acc.db, 1);
  const j = create(suspense.db, 'account.journal', { name, code, type, default_account_id: acc.id, suspense_account_id: suspense.id, currency_id, company_id: 1 });
  return { db: j.db, journalId: j.id, accountId: acc.id };
}

test('account.bank.statement.line list columns, optional columns, labels, badge, and drag reorder parity', () => {
  let db = seed();
  const def = models[LINE];
  const fields = def.fields;

  assert.equal(fields.sequence.widget, 'handle');
  assert.equal(def.defaults().sequence, 10);
  assert.deepEqual(fields.state.badge, { to_check: 'info', reconciled: 'success' });

  const initial = visibleListColumns(def, db, {});
  assert.deepEqual(initial.cols, ['sequence', 'date', 'payment_ref', 'partner_id', 'amount', 'journal_id', 'running_balance']);
  assert.deepEqual(
    initial.optionalCols.map(([k]) => k),
    ['bank_move_id', 'account_number', 'narration', 'ref', 'transaction_type', 'state'],
  );

  // Toggling all optional hidden columns shows them in Odoo 20 order
  const withAllOptional = visibleListColumns(def, db, {
    bank_move_id: true,
    account_number: true,
    narration: true,
    ref: true,
    transaction_type: true,
    state: true,
  });
  assert.deepEqual(withAllOptional.cols, [
    'sequence', 'date', 'payment_ref', 'partner_id', 'amount', 'journal_id', 'running_balance',
    'bank_move_id', 'account_number', 'narration', 'ref', 'transaction_type', 'state',
  ]);

  // List column labels use Journal / Journal Entry without mutating Bank Journal field label
  assert.equal(fields.journal_id.label, 'Bank Journal');
  assert.equal(colLabel(fields, 'journal_id', def.listLabels), 'Journal');
  assert.equal(colLabel(fields, 'bank_move_id', def.listLabels), 'Journal Entry');
  assert.equal(colLabel(fields, 'running_balance', def.listLabels), 'Running Balance');
  assert.equal(colLabel(fields, 'payment_ref', def.listLabels), 'Label');

  // Drag handle renders draggable rows only when unsorted & ungrouped
  const bnk = findLiquidity(db, 'bank');
  const l1 = create(db, LINE, { journal_id: bnk.id, date: '2026-04-10', sequence: 10, payment_ref: 'Alpha', amount: 100 }); db = l1.db;
  const l2 = create(db, LINE, { journal_id: bnk.id, date: '2026-04-10', sequence: 20, payment_ref: 'Beta', amount: 50 }); db = l2.db;
  const rows = [read(db, LINE, l1.id), read(db, LINE, l2.id)];

  const ungroupedHtml = renderToStaticMarkup(createElement(List, {
    db, model: LINE, records: rows, open: () => {}, selected: new Set(), setSelected: () => {}, groupBy: [], listLabels: def.listLabels,
  }));
  assert.match(ungroupedHtml, /class="drag-handle"/);
  assert.match(ungroupedHtml, /draggable="true"/);

  const groupedHtml = renderToStaticMarkup(createElement(List, {
    db, model: LINE, records: rows, open: () => {}, selected: new Set(), setSelected: () => {}, groupBy: ['journal_id'], listLabels: def.listLabels,
  }));
  assert.equal(/draggable="true"/.test(groupedHtml), false);

  // Reordering via drag handle updates sequence and def.sort order
  const updates = reorderSequenceUpdates(rows, l2.id, l1.id, 'sequence');
  db = writeMany(db, LINE, updates);
  const reordered = [read(db, LINE, l1.id), read(db, LINE, l2.id)].sort(def.sort);
  assert.deepEqual(reordered.map((r) => r.id), [l2.id, l1.id]);
});

test('running_balance computes cumulative per-journal balance ordered by date, sequence, id and is never stored', () => {
  let db = {
    ...seed(),
    records: {
      ...seed().records,
      'account.bank.statement.line': [],
    },
  };
  const bnk1 = findLiquidity(db, 'bank');
  const cash = findLiquidity(db, 'cash');

  // Create out of chronological & sequence order on purpose
  const laterDate = create(db, LINE, { journal_id: bnk1.id, date: '2026-05-10', sequence: 10, payment_ref: 'Later', amount: 40 }); db = laterDate.db;
  const sameDateSeq20 = create(db, LINE, { journal_id: bnk1.id, date: '2026-05-05', sequence: 20, payment_ref: 'May 5 seq 20', amount: -25 }); db = sameDateSeq20.db;
  const sameDateSeq10a = create(db, LINE, { journal_id: bnk1.id, date: '2026-05-05', sequence: 10, payment_ref: 'May 5 seq 10 first', amount: 0.1 }); db = sameDateSeq10a.db;
  const sameDateSeq10b = create(db, LINE, { journal_id: bnk1.id, date: '2026-05-05', sequence: 10, payment_ref: 'May 5 seq 10 second', amount: 0.2 }); db = sameDateSeq10b.db;
  const earlierDate = create(db, LINE, { journal_id: bnk1.id, date: '2026-05-01', sequence: 10, payment_ref: 'Opening inflow', amount: 100 }); db = earlierDate.db;
  const otherJournal = create(db, LINE, { journal_id: cash.id, date: '2026-05-02', sequence: 10, payment_ref: 'Cash receipt', amount: 500 }); db = otherJournal.db;
  const archived = create(db, LINE, { journal_id: bnk1.id, date: '2026-05-03', sequence: 10, payment_ref: 'Archived', amount: 999, active: false }); db = archived.db;

  // Never stored on db.records or produced by cleanRecord
  for (const raw of db.records[LINE]) assert.equal('running_balance' in raw, false);
  assert.equal('running_balance' in cleanRecord(LINE, { date: '2026-05-01', payment_ref: 'X', amount: 10, journal_id: bnk1.id, running_balance: 999 }), false);

  // Ordered by date -> sequence -> id per journal
  assert.equal(read(db, LINE, earlierDate.id).running_balance, 100);
  assert.equal(read(db, LINE, sameDateSeq10a.id).running_balance, 100.1);
  assert.equal(read(db, LINE, sameDateSeq10b.id).running_balance, 100.3);
  assert.equal(read(db, LINE, sameDateSeq20.id).running_balance, 75.3);
  assert.equal(read(db, LINE, laterDate.id).running_balance, 115.3);
  assert.equal(read(db, LINE, otherJournal.id).running_balance, 500);
  assert.equal(read(db, LINE, archived.id).running_balance, null);

  // Changing sequence between same-date lines recomputes running_balance accordingly
  db = write(db, LINE, sameDateSeq20.id, { sequence: 5 });
  assert.equal(read(db, LINE, sameDateSeq20.id).running_balance, 75);
  assert.equal(read(db, LINE, sameDateSeq10a.id).running_balance, 75.1);
  assert.equal(read(db, LINE, sameDateSeq10b.id).running_balance, 75.3);
  assert.equal(read(db, LINE, laterDate.id).running_balance, 115.3);
});

test('foreign-currency journal statement lines display amounts and running balance in the journal currency', () => {
  let db = seed();
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  assert.ok(eur, 'EUR currency exists in seed');
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 0.8 }] });
  const fx = makeJournal(db, { code: 'BEUR', name: 'Bank EUR', type: 'bank', currency_id: eur.id, acctCode: '101491' });
  db = fx.db;

  const l1 = create(db, LINE, { journal_id: fx.journalId, date: '2026-06-01', sequence: 10, payment_ref: 'FX In', amount: 250 }); db = l1.db;
  const l2 = create(db, LINE, { journal_id: fx.journalId, date: '2026-06-02', sequence: 10, payment_ref: 'FX Out', amount: -50 }); db = l2.db;

  const fields = models[LINE].fields;
  const r2 = read(db, LINE, l2.id);
  assert.equal(r2.currency_id, eur.id);
  assert.equal(r2.running_balance, 200);
  assert.match(display(db, fields.amount, r2.amount, r2), /€/);
  assert.match(display(db, fields.running_balance, r2.running_balance, r2), /€/);

  // onchange updates currency_id when journal_id changes
  const usdBank = findLiquidity(db, 'bank');
  const changed = models[LINE].onchange({ journal_id: usdBank.id, company_id: 1 }, 'journal_id', db);
  assert.equal(changed.currency_id, read(db, 'account.journal', usdBank.id).currency_id ?? read(db, 'res.company', 1).currency_id);
});

test('search fields, Cash In/Out, Bank/Cash/Credit, Date/Last 12 Months filters, and groupBys work per Odoo 20', () => {
  let db = seed();
  const def = models[LINE];
  assert.ok(def.searchFields.includes('journal_id'));
  assert.deepEqual(def.groupBys, ['currency_id', 'company_id', 'journal_id', 'date']);

  const bnk = findLiquidity(db, 'bank');
  const cash = findLiquidity(db, 'cash');
  const cr = makeJournal(db, { code: 'CRD1', name: 'Amex Corporate', type: 'credit', acctCode: '211491', account_type: 'liability_credit_card' });
  db = cr.db;
  const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2026-01-01', rate: 0.8 }] });
  const fx = makeJournal(db, { code: 'BEU2', name: 'Euro Bank', type: 'bank', currency_id: eur.id, acctCode: '101492' });
  db = fx.db;

  const co2 = createCompany(db, { name: 'Second Co' }); db = co2.db;
  const co2Acc = create(db, 'account.account', { code: '101401', name: 'Bank Co2', account_type: 'asset_cash', company_id: co2.id }); db = co2Acc.db;
  const co2Suspense = ensureBankSuspense(db, co2.id); db = co2Suspense.db;
  const co2Bank = create(db, 'account.journal', { name: 'Co2 Bank', code: 'B2', type: 'bank', default_account_id: co2Acc.id, suspense_account_id: co2Suspense.id, company_id: co2.id }); db = co2Bank.db;

  const now = today();
  const sixMonthsAgo = shiftMonth(now, -6);
  const oldDate = addDays(shiftMonth(now, -13), -1);

  const inBank = create(db, LINE, { journal_id: bnk.id, date: now, payment_ref: 'Bank inflow', amount: 300 }); db = inBank.db;
  const outCash = create(db, LINE, { journal_id: cash.id, date: sixMonthsAgo, payment_ref: 'Cash payout', amount: -45 }); db = outCash.db;
  const outCredit = create(db, LINE, { journal_id: cr.journalId, date: oldDate, payment_ref: 'Card charge', amount: -120 }); db = outCredit.db;
  const inFx = create(db, LINE, { journal_id: fx.journalId, date: now, payment_ref: 'EUR wire', amount: 80 }); db = inFx.db;
  const inCo2 = create(db, LINE, { journal_id: co2Bank.id, company_id: co2.id, date: now, payment_ref: 'Co2 receipt', amount: 50 }); db = inCo2.db;

  const sample = [inBank.id, outCash.id, outCredit.id, inFx.id, inCo2.id].map((id) => read(db, LINE, id));

  // Search by Journal name
  const amexHits = sample.filter((r) => matches(db, LINE, r, ['Amex Corporate']));
  assert.deepEqual(amexHits.map((r) => r.id), [outCredit.id]);

  // Cash In / Cash Out OR group
  assert.deepEqual(applyFilters(LINE, sample, ['in'], db).map((r) => r.id), [inBank.id, inFx.id, inCo2.id]);
  assert.deepEqual(applyFilters(LINE, sample, ['out'], db).map((r) => r.id), [outCash.id, outCredit.id]);
  assert.equal(applyFilters(LINE, sample, ['in', 'out'], db).length, sample.length);

  // Bank / Cash / Credit OR group, ANDed with Cash In/Out
  assert.deepEqual(applyFilters(LINE, sample, ['bank'], db).map((r) => r.id), [inBank.id, inFx.id, inCo2.id]);
  assert.deepEqual(applyFilters(LINE, sample, ['cash'], db).map((r) => r.id), [outCash.id]);
  assert.deepEqual(applyFilters(LINE, sample, ['credit'], db).map((r) => r.id), [outCredit.id]);
  assert.deepEqual(applyFilters(LINE, sample, ['cash', 'credit'], db).map((r) => r.id), [outCash.id, outCredit.id]);
  assert.deepEqual(applyFilters(LINE, sample, ['bank', 'credit', 'out'], db).map((r) => r.id), [outCredit.id]);

  // Date filters: This Month, This Year, Last 12 Months
  const last12 = applyFilters(LINE, sample, ['date_last_12_months'], db).map((r) => r.id);
  assert.equal(last12.includes(inBank.id), true);
  assert.equal(last12.includes(outCash.id), true);
  assert.equal(last12.includes(outCredit.id), false);
  assert.equal(applyFilters(LINE, sample, ['date_month'], db).some((r) => r.id === inBank.id), true);
  assert.equal(applyFilters(LINE, sample, ['date_year'], db).some((r) => r.id === outCredit.id), false);

  // Group-bys: Currency, Company, Journal, Date
  for (const field of ['currency_id', 'company_id', 'journal_id', 'date']) {
    const groups = groupRecords(db, LINE, sample, field);
    assert.ok(groups.length >= 2, `expected >= 2 groups for ${field}`);
  }
});

test('CSV, OFX, and CAMT.053 import populate account_number, narration, ref, and transaction_type', () => {
  let db = seed();
  const bnk = findLiquidity(db, 'bank');

  // 1) CSV import via importCsvRows (both field labels and names work)
  const csvResult = importCsvRows(db, LINE, { journal_id: bnk.id }, [
    ['Date', 'Label', 'Amount', 'Account Number', 'Notes', 'Reference', 'Transaction Type'],
    ['2026-07-01', 'CSV Wire', '1250', 'US99-001122', 'Invoice batch settlement', 'REF-CSV-01', 'CREDIT'],
  ], models[LINE].listLabels);
  db = csvResult.db;
  const csvLine = search(db, LINE).find((l) => l.payment_ref === 'CSV Wire');
  assert.equal(csvLine.account_number, 'US99-001122');
  assert.equal(csvLine.narration, 'Invoice batch settlement');
  assert.equal(csvLine.ref, 'REF-CSV-01');
  assert.equal(csvLine.transaction_type, 'CREDIT');

  // 2) OFX import (default parseOfx unchanged, importStatement fills details)
  const ofx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260702
<TRNAMT>-88.50
<FITID>OFX-PARITY-1
<REFNUM>CHK-4402
<NAME>Hosting Co
<MEMO>Monthly server fee
<BANKACCTTO><ACCTID>99887766</ACCTID></BANKACCTTO>
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  assert.deepEqual(Object.keys(parseOfx(ofx)[0]), ['date', 'amount', 'payment_ref', 'unique_import_id']);
  const ofxRes = importStatement(db, 'bank.ofx', ofx, { journal_id: bnk.id });
  db = ofxRes.db;
  const ofxLine = search(db, LINE).find((l) => l.unique_import_id === 'OFX-PARITY-1');
  assert.equal(ofxLine.account_number, '99887766');
  assert.equal(ofxLine.narration, 'Monthly server fee');
  assert.equal(ofxLine.ref, 'CHK-4402');
  assert.equal(ofxLine.transaction_type, 'DEBIT');

  // 3) CAMT.053 import (default parseCamt unchanged, importStatement fills details)
  const camt = `<Document><BkToCstmrStmt><Stmt><Ntry>
<Amt Ccy="USD">420.00</Amt><CdtDbtInd>CRDT</CdtDbtInd>
<BookgDt><Dt>2026-07-03</Dt></BookgDt>
<AcctSvcrRef>CAMT-PARITY-1</AcctSvcrRef>
<NtryRef>NTRY-900</NtryRef>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>RCDT</Cd><SubFmlyCd>ESCT</SubFmlyCd></Fmly></Domn></BkTxCd>
<NtryDtls><TxDtls>
<Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs>
<RltdPties><DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct></RltdPties>
<RmtInf><Ustrd>SEPA receipt INV-77</Ustrd></RmtInf>
<AddtlTxInf>SEPA Instant Credit</AddtlTxInf>
</TxDtls></NtryDtls>
</Ntry></Stmt></BkToCstmrStmt></Document>`;
  assert.deepEqual(Object.keys(parseCamt(camt)[0]), ['date', 'currency', 'amount', 'payment_ref', 'unique_import_id']);
  const camtRes = importStatement(db, 'camt053.xml', camt, { journal_id: bnk.id });
  db = camtRes.db;
  const camtLine = search(db, LINE).find((l) => l.unique_import_id === 'CAMT-PARITY-1');
  assert.equal(camtLine.account_number, 'DE89370400440532013000');
  assert.equal(camtLine.narration, 'SEPA Instant Credit');
  assert.equal(camtLine.ref, 'NTRY-900');
  assert.equal(camtLine.transaction_type, 'PMNT-RCDT-ESCT');
});

test('all new bank transactions labels and filter captions have Arabic i18n translations', () => {
  const i18nSource = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
  for (const label of [
    'Running Balance', 'Transaction Type', 'Cash In', 'Cash Out', 'Last 12 Months',
    'Account Number', 'Notes', 'Reference', 'Journal Entry', 'Journal',
    'Bank', 'Cash', 'Credit', 'Date: This Month', 'Date: This Year',
  ]) {
    assert.ok(
      i18nSource.includes(`'${label}':`) || i18nSource.includes(`"${label}":`) || i18nSource.includes(`${label}:`),
      `Expected Arabic translation key for ${label}`,
    );
  }
});
