import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { applyRule, autoReconcile } from './models/reconcile.js';
import { partnerLedger } from './models/reports.js';
import { postMove } from './models/accounting.js';
import { importStatement } from './models/statements.js';
import { defaultTaxRepartitionLines } from './models/taxes.js';

test('reconciliation model posts tax and counterpart partner and maps a partner alone', () => {
  let db = seed();
  const taxAccount = search(db, 'account.account').find((a) => a.code === '131000');
  const tax = create(db, 'account.tax', { name: 'Input tax', amount: 14, amount_type: 'percent', price_include: true, ...defaultTaxRepartitionLines(taxAccount.id, []) }); db = tax.db;
  const line = create(db, 'account.bank.statement.line', { date: '2025-01-01', amount: -114, payment_ref: 'fee' }); db = line.db;
  db = applyRule(db, { name: 'fee', line_ids: [{ account_code: '600000', amount_type: 'percentage', amount: 100, tax_ids: [tax.id], partner_id: 3 }] }, read(db, 'account.bank.statement.line', line.id));
  const items = read(db, 'account.move', read(db, 'account.bank.statement.line', line.id).move_id).line_ids;
  assert.equal(items.find((l) => l.account_id === taxAccount.id).debit, 14);
  assert.equal(items.find((l) => read(db, 'account.account', l.account_id).code === '600000').debit, 100);
  assert.equal(items.find((l) => l.account_id === taxAccount.id).partner_id, 3);
  const mapping = create(db, 'account.reconcile.model', { name: 'mapping', auto_reconcile: true, match_label: 'contains', match_label_param: 'mapped', line_ids: [{ partner_id: 2 }] }); db = mapping.db;
  const next = create(db, 'account.bank.statement.line', { date: '2025-01-01', amount: 10, payment_ref: 'mapped' }); db = autoReconcile(next.db);
  assert.equal(read(db, 'account.bank.statement.line', next.id).partner_id, 2);
  assert.equal(read(db, 'account.bank.statement.line', next.id).state, 'to_check');
});

test('partner ledger retains foreign currency on invoice items', () => {
  let db = seed(); const eur = search(db, 'res.currency').find((c) => c.name === 'EUR');
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2025-01-01', rate: 0.8 }] });
  const partner = create(db, 'res.partner', { name: 'Ledger FX' }); db = partner.db;
  const invoice = create(db, 'account.move', { move_type: 'out_invoice', partner_id: partner.id, currency_id: eur.id, invoice_date: '2025-01-01', invoice_line_ids: [{ qty: 1, price_unit: 80, tax: 0 }] }); db = postMove(invoice.db, invoice.id);
  const line = partnerLedger(db, { from: '2025-01-01', to: '2025-01-01' }).find((r) => r.partner_id === partner.id).lines[0];
  assert.equal(line.currency_id, eur.id); assert.equal(line.amount_currency, 80); assert.equal(line.debit, 100);
});

test('CAMT currency is validated and foreign journal reconciliation converts at transaction date', () => {
  let db = seed(); const eur = search(db, 'res.currency').find((c) => c.name === 'EUR'); const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  const xml = '<Document><BkToCstmrStmt><Stmt><Ntry><Amt Ccy="EUR">100</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2025-01-01</Dt></BookgDt><AcctSvcrRef>fx-test</AcctSvcrRef></Ntry></Stmt></BkToCstmrStmt></Document>';
  assert.throws(() => importStatement(db, 'test.xml', xml, { journal_id: journal.id }), /currency/i);
  db = write(db, 'res.currency', eur.id, { rate_ids: [{ date: '2025-01-01', rate: 0.8 }] }); db = write(db, 'account.journal', journal.id, { currency_id: eur.id });
  db = importStatement(db, 'test.xml', xml, { journal_id: journal.id }).db;
  const line = search(db, 'account.bank.statement.line').find((l) => l.unique_import_id === 'fx-test'); assert.equal(line.amount, 100); assert.equal(line.currency_id, eur.id);
  db = applyRule(db, { name: 'book', line_ids: [{ account_code: '600000', amount_type: 'percentage', amount: 100 }] }, line);
  const items = read(db, 'account.move', read(db, 'account.bank.statement.line', line.id).move_id).line_ids;
  assert.deepEqual(items.map((l) => [l.debit, l.credit, l.currency_id, l.amount_currency]), [[125, 0, eur.id, 100], [0, 125, eur.id, -100]]);
});
