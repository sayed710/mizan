import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { createCompany } from './models/company.js';
import { journalItems } from './models/ledger.js';
import { applyDiff, diffDb } from './sync.js';

const LINE = 'account.bank.statement.line';
const run = (db, id) => models[LINE].form.buttons.find((b) => b.label === 'Match').run(db, read(db, LINE, id)).db;
function setup(type = 'out_invoice') {
  const base = seed();
  const branch = createCompany(base, { name: 'Branch', currency_id: base.records['res.company'][0].currency_id });
  const bank = create(branch.db, 'account.account', { company_id: branch.id, code: '101401', name: 'Branch cash', account_type: 'asset_cash' });
  const journal = create(bank.db, 'account.journal', { company_id: branch.id, code: 'B2', name: 'Branch bank', type: 'bank', default_account_id: bank.id });
  const account = create(journal.db, 'account.account', { company_id: branch.id, code: '690777', name: 'Write-off', account_type: 'expense' });
  const invoice = create(account.db, 'account.move', { company_id: branch.id, move_type: type, partner_id: 3, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  const db = postMove(invoice.db, invoice.id);
  const line = create(db, LINE, { company_id: branch.id, journal_id: journal.id, date: '2026-01-02', payment_ref: 'Settlement', amount: type === 'in_invoice' ? -90 : 90, move_id: invoice.id, writeoff_account_id: account.id, writeoff_label: 'Agreed adjustment', writeoff_amount: 10 });
  return { ...line, company: branch.id, journal: journal.id, invoice: invoice.id, account: account.id, bank: bank.id };
}
for (const type of ['out_invoice', 'in_invoice']) test(`matching ${type} with an explicit write-off settles the invoice in its company`, () => {
  const x = setup(type);
  const done = run(x.db, x.id);
  const invoice = read(done, 'account.move', x.invoice);
  assert.equal(invoice.amount_residual, 0);
  assert.equal(invoice.payment_state, 'paid');
  const line = read(done, LINE, x.id);
  assert.equal(line.state, 'reconciled');
  assert.throws(() => write(done, LINE, x.id, { writeoff_amount: 5 }), /cannot be changed/);
  assert.throws(() => write(done, 'account.move', line.writeoff_move_id, { state: 'draft' }), /has to stay posted/);
  const added = search(done, 'account.move').filter((m) => !read(x.db, 'account.move', m.id));
  assert.ok(added.length >= 1);
  for (const entry of added) {
    assert.equal(entry.company_id, x.company);
    assert.equal(entry.journal_id, x.journal);
    assert.equal(entry.line_ids.reduce((sum, l) => sum + l.debit - l.credit, 0), 0);
  }
  const item = added.flatMap((m) => m.line_ids).find((l) => l.account_id === x.account);
  assert.equal(item.name, 'Agreed adjustment');
  assert.equal(type === 'out_invoice' ? item.debit : item.credit, 10);
  assert.equal(journalItems(done).filter((l) => !read(x.db, 'account.move', l.move_id) && l.account_id === x.bank).length, 1);
  const synced = applyDiff(x.db, diffDb(x.db, done), { isAdmin: true });
  assert.equal(read(synced, 'account.move', x.invoice).amount_residual, 0);
});
test('a smaller write-off only settles its stated amount', () => {
  const x = setup();
  const db = run(write(x.db, LINE, x.id, { writeoff_amount: 5 }), x.id);
  assert.equal(read(db, 'account.move', x.invoice).amount_residual, 5);
  assert.equal(read(db, LINE, x.id).state, 'reconciled');
});

test('foreign currency write-off uses the statement-date rate and clears the booked invoice balance', () => {
  let db = seed();
  const currency = create(db, 'res.currency', { name: 'TEST', rate_ids: [{ date: '2026-01-01', rate: 1 }, { date: '2026-01-02', rate: 2 }] });
  const inv = create(currency.db, 'account.move', { move_type: 'out_invoice', partner_id: 3, currency_id: currency.id, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
  db = postMove(inv.db, inv.id);
  const account = search(db, 'account.account').find((a) => a.code === '690000');
  const line = create(db, LINE, { date: '2026-01-02', payment_ref: 'Foreign', amount: 45, move_id: inv.id, writeoff_account_id: account.id, writeoff_label: 'Adjustment', writeoff_amount: 5 });
  db = run(line.db, line.id);
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 0);
  const entry = read(db, 'account.move', read(db, LINE, line.id).writeoff_move_id);
  assert.equal(entry.line_ids.find((l) => l.account_id === account.id).debit, 5);
  assert.equal(entry.line_ids.reduce((sum, l) => sum + l.debit - l.credit, 0), 0);
  const synced = applyDiff(line.db, diffDb(line.db, db), { isAdmin: true });
  assert.equal(read(synced, 'account.move', inv.id).amount_residual, 0);
});

test('write-off requires a valid local account, label, and a positive amount no larger than the remaining invoice', () => {
  const x = setup();
  const foreign = create(x.db, 'account.account', { company_id: 1, code: '690778', name: 'Foreign', account_type: 'expense' });
  for (const [values, error] of [[{ writeoff_account_id: foreign.id }, /another company/], [{ writeoff_label: '' }, /label/i], [{ writeoff_amount: -1 }, /amount/i], [{ writeoff_amount: 11 }, /remaining|exceed/i]]) {
    const db = write(foreign.db, LINE, x.id, values);
    assert.throws(() => run(db, x.id), error);
    assert.equal(read(db, 'account.move', x.invoice).amount_residual, 100);
  }
});
