import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove, payMove } from './models/accounting.js';
import { importStatement } from './models/statements.js';
import { cashflowAnalysis } from './models/reports.js';
import { taxesByGrid } from './models/finance.js';
import { accountId } from './models/ledger.js';
const LINE = 'account.bank.statement.line';
const run = (db, model, id, label) => models[model].form.buttons.find((b) => b.label === label).run(db, read(db, model, id)).db;
const fxSetup = (rate = 0.8, rounding = 0.01) => {
  let db = seed();
  const fx = create(db, 'res.currency', { name: 'XYZ', rounding, rate_ids: [{ date: '2025-01-01', rate }] }); db = fx.db;
  const journal = search(db, 'account.journal').find((j) => j.code === 'BNK1');
  db = write(db, 'account.journal', journal.id, { currency_id: fx.id });
  return { db, fx: fx.id, journal: journal.id };
};
const invoice = (db, amount, currency_id) => {
  const m = create(db, 'account.move', { move_type: 'out_invoice', partner_id: 3, currency_id, invoice_date: '2025-01-01', invoice_line_ids: [{ qty: 1, price_unit: amount, tax: 0 }] });
  return { db: postMove(m.db, m.id), id: m.id };
};
const xml = (attr) => `<Document><BkToCstmrStmt><Ntry><Amt ${attr}>100</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2025-01-02</Dt></BookgDt><AcctSvcrRef>q6</AcctSvcrRef></Ntry></BkToCstmrStmt></Document>`;

test('CAMT import succeeds with strict field checking', () => {
  const script = `
    import assert from 'node:assert/strict';
    import { seed } from './src/seed.js';
    import { read, search } from './src/orm.js';
    import { importStatement } from './src/models/statements.js';
    const db = seed();
    const journal = search(db, 'account.journal').find((j) => j.type === 'bank' && !j.currency_id && (j.company_id ?? 1) === 1);
    assert.ok(journal);
    const currency = read(db, 'res.company', 1).currency_id;
    const name = read(db, 'res.currency', currency).name;
    const xml = '<Ntry><Amt Ccy="' + name + '">100</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2025-01-02</Dt></BookgDt><AcctSvcrRef>strict-camt</AcctSvcrRef></Ntry>';
    const result = importStatement(db, 'statement.xml', xml, { journal_id: journal.id });
    const line = search(result.db, 'account.bank.statement.line').find((l) => l.unique_import_id === 'strict-camt');
    assert.equal(result.count, 1);
    assert.equal(line.currency_id, currency);
    assert.equal(line.amount, 100);
    assert.equal(Object.hasOwn(line, 'currency'), false);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, MIZAN_STRICT_FIELDS: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test('CAMT import validates currency and stores declared fields', () => {
  const { db, journal, fx } = fxSetup();
  for (const attr of ['', 'Ccy=XYZ', 'Ccy="UNKNOWN"']) assert.throws(() => importStatement(db, 'x.xml', xml(attr), { journal_id: journal }), /currency/i);
  const nestedCurrency = xml('').replace('</Ntry>', '<Details><Amt Ccy="XYZ">5</Amt></Details></Ntry>');
  assert.throws(() => importStatement(db, 'x.xml', nestedCurrency, { journal_id: journal }), /currency/i);
  const result = importStatement(db, 'x.xml', xml('Ccy="XYZ"'), { journal_id: journal });
  const line = search(result.db, LINE).find((l) => l.unique_import_id === 'q6');
  assert.equal(line.currency_id, fx); assert.equal(Object.hasOwn(line, 'currency'), false);
});

test('same currency bank payment settles all foreign units', () => {
  let { db, journal, fx } = fxSetup(3); const inv = invoice(db, 10, fx); db = inv.db;
  const line = create(db, LINE, { payment_ref: 'Q6', date: '2025-01-02', amount: 10, journal_id: journal, move_id: inv.id });
  db = run(line.db, LINE, line.id, 'Match');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);
  assert.equal(read(db, LINE, line.id).open_amount, 0);
});

test('same currency bank payment settles invoices across successive allocations', () => {
  let { db, journal, fx } = fxSetup(3);
  const first = invoice(db, 1, fx);
  const second = invoice(first.db, 9, fx);
  const line = create(second.db, LINE, { payment_ref: 'Q6 partial', date: '2025-01-02', amount: 10, journal_id: journal, move_id: first.id });
  db = run(line.db, LINE, line.id, 'Match');
  assert.equal(read(db, 'account.move', first.id).amount_residual, 0);
  assert.equal(read(db, LINE, line.id).open_amount, 3);
  db = write(db, LINE, line.id, { move_id: second.id });
  db = run(db, LINE, line.id, 'Match');
  assert.equal(read(db, 'account.move', second.id).amount_residual, 0);
  assert.equal(read(db, LINE, line.id).open_amount, 0);
  assert.equal(read(db, LINE, line.id).state, 'reconciled');
  assert.deepEqual(read(db, LINE, line.id).allocations.map((allocation) => allocation.amount), [0.33, 3]);
});

test('write-off splits in journal currency units', () => {
  for (const amount of [1, -1]) {
    const { db, journal, fx } = fxSetup(1, 1);
    const rule = create(db, 'account.reconcile.model', { name: 'split', sequence: -100, rule_type: 'writeoff_suggestion', line_ids: [{ account_code: '600000', amount: 50 }, { account_code: '690000', amount: 50 }] });
    const line = create(rule.db, LINE, { payment_ref: 'Q6', date: '2025-01-02', amount, journal_id: journal });
    const result = run(line.db, LINE, line.id, 'Apply Reconciliation Model');
    const items = read(result, 'account.move', read(result, LINE, line.id).move_id).line_ids;
    assert.equal(read(result, LINE, line.id).state, 'reconciled');
    assert.ok(items.every((item) => item.currency_id === fx && Number.isInteger(item.amount_currency)));
    assert.equal(items.filter((item) => Math.sign(item.amount_currency) === Math.sign(amount)).reduce((sum, item) => sum + item.amount_currency, 0), amount);
    assert.equal(items.filter((item) => Math.sign(item.amount_currency) === -Math.sign(amount)).reduce((sum, item) => sum + item.amount_currency, 0), -amount);
    assert.equal(items.reduce((sum, l) => sum + l.amount_currency, 0), 0);
  }
});

test('taxed bank write-offs reach sale and purchase grids', () => {
  let db = seed(); const tag = create(db, 'account.account.tag', { name: 'Q6 grid', applicability: 'taxes' }); db = tag.db;
  const tax = create(db, 'account.tax', { name: 'Q6 tax', amount: 10, amount_type: 'percent', account_id: accountId(db, '131000'), tag_ids: [tag.id] }); db = tax.db;
  const rule = create(db, 'account.reconcile.model', { name: 'tax', sequence: -100, rule_type: 'writeoff_suggestion', line_ids: [{ account_code: '600000', amount: 100, tax_ids: [tax.id] }] }); db = rule.db;
  for (const amount of [110, -110]) {
    const line = create(db, LINE, { payment_ref: 'Q6', date: '2025-01-02', amount });
    db = run(line.db, LINE, line.id, 'Apply Reconciliation Model');
    const items = read(db, 'account.move', read(db, LINE, line.id).move_id).line_ids;
    assert.equal(items.find((l) => l.tax_grid_base).tax_side, amount > 0 ? 'sale' : 'purchase');
    const taxItem = items.find((l) => l.tax_name === 'Q6 tax');
    assert.equal(taxItem.tax_side, amount > 0 ? 'sale' : 'purchase');
    assert.deepEqual(taxItem.tax_tag_ids, [tag.id]);
    const grid = taxesByGrid(db, { from: '2025-01-02', to: '2025-01-02' }).find((r) => r.id === tag.id);
    assert.equal(grid.base, amount > 0 ? 100 : 200); assert.equal(grid.tax, amount > 0 ? 10 : 20);
  }
});

test('cashflow analysis converts foreign statement amounts', () => {
  let { db, journal, fx } = fxSetup();
  db = write(db, 'res.currency', fx, { rate_ids: [{ date: '2025-01-01', rate: 0.8 }, { date: '2025-02-01', rate: 0.5 }] });
  const line = create(db, LINE, { payment_ref: 'Q6', date: '2025-01-02', amount: 100, journal_id: journal });
  const outgoing = create(line.db, LINE, { payment_ref: 'Q6 outgoing', date: '2025-02-02', amount: -50, journal_id: journal });
  const [row, february] = cashflowAnalysis(outgoing.db, { from: '2025-01-01', to: '2025-02-28' }).rows;
  assert.equal(row.inflow, 125); assert.equal(row.journals.get(journal).net, 125);
  assert.equal(february.outflow, 100); assert.equal(february.net, -100);
  assert.equal(february.journals.get(journal).outflow, 100); assert.equal(february.journals.get(journal).net, -100);
});

test('invoice matching rule compares company values at statement date', () => {
  let { db, journal } = fxSetup(); const inv = invoice(db, 125); db = inv.db;
  const rule = create(db, 'account.reconcile.model', { name: 'match invoice', sequence: -100, rule_type: 'invoice_matching', line_ids: [] }); db = rule.db;
  const line = create(db, LINE, { payment_ref: 'Q6', date: '2025-01-02', amount: 100, journal_id: journal, partner_id: 3 });
  db = run(line.db, LINE, line.id, 'Apply Reconciliation Model');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);
  assert.equal(read(db, LINE, line.id).state, 'reconciled');
  assert.equal(read(db, LINE, line.id).open_amount, 0);
});

test('booked foreign bank amount survives later rate corrections', () => {
  for (const correctedRate of [0.5, 2]) {
    let { db, journal, fx } = fxSetup(); const inv = invoice(db, 50, fx); db = inv.db;
    const line = create(db, LINE, { payment_ref: 'Q6', date: '2025-01-02', amount: 100, journal_id: journal, move_id: inv.id });
    db = run(line.db, LINE, line.id, 'Match');
    const partiallyMatched = read(db, LINE, line.id);
    assert.equal(partiallyMatched.open_amount, 62.5);
    const bankMove = read(db, 'account.move', partiallyMatched.bank_move_id);
    const bankItem = bankMove.line_ids.find((item) => item.account_id === accountId(db, '101401'));
    assert.equal(bankItem.debit, 125);
    assert.equal(bankItem.amount_currency, 100);
    db = write(db, 'res.currency', fx, { rate_ids: [{ date: '2025-01-01', rate: correctedRate }] });
    db = run(db, LINE, line.id, 'Book to Account');
    const completed = read(db, LINE, line.id);
    assert.equal(completed.state, 'reconciled');
    assert.equal(completed.open_amount, 0);
    assert.equal(completed.bank_move_id, bankMove.id);
    assert.deepEqual(read(db, 'account.move', bankMove.id).line_ids, bankMove.line_ids);
    const remainder = read(db, 'account.move', completed.move_id).line_ids;
    assert.equal(remainder.find((item) => item.account_id === accountId(db, '101404')).amount_currency, 50);
  }
});

test('foreign payment matching books rate difference to exchange account', () => {
  for (const statementRate of [4, 1]) {
    let { db, journal, fx } = fxSetup(2); db = write(db, 'res.company', 1, { outstanding_receipts_account_id: accountId(db, '101402') });
    const inv = invoice(db, 100, fx); db = payMove(inv.db, inv.id, 100, '2025-01-02');
    const paymentMove = read(db, 'account.move', inv.id).payments.at(-1).move_id;
    const payment = search(db, 'account.payment').find((p) => p.move_id === paymentMove);
    db = write(db, 'res.currency', fx, { rate_ids: [{ date: '2025-01-01', rate: 2 }, { date: '2025-01-03', rate: statementRate }] });
    const line = create(db, LINE, { payment_ref: 'Q6', date: '2025-01-03', amount: 100, journal_id: journal, payment_id: payment.id });
    db = run(line.db, LINE, line.id, 'Match Payment');
    const matched = read(db, LINE, line.id);
    const items = read(db, 'account.move', matched.bank_move_id).line_ids;
    const bank = items.find((l) => l.account_id === accountId(db, '101401'));
    const outstanding = items.find((l) => l.account_id === accountId(db, '101402'));
    assert.equal(matched.state, 'reconciled');
    assert.equal(bank.debit, 100 / statementRate);
    assert.equal(bank.amount_currency, 100);
    assert.equal(outstanding.credit, 50);
    assert.equal(outstanding.amount_currency, -100);
    if (statementRate === 4) assert.equal(items.find((l) => l.account_id === accountId(db, '690100')).debit, 25);
    else assert.equal(items.find((l) => l.account_id === accountId(db, '450100')).credit, 50);
    assert.equal(items.reduce((sum, l) => sum + l.debit - l.credit, 0), 0);
  }
});
