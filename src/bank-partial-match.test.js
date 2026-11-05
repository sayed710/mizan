import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, read, search, write } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { agedBalance } from './models/finance.js';
import { journalItems } from './models/ledger.js';
import { applyDiff, diffDb } from './sync.js';

const LINE = 'account.bank.statement.line';
const run = (db, id, label) => models[LINE].form.buttons.find((b) => b.label === label).run(db, read(db, LINE, id)).db;
const invoice = (db, company, amount, term) => {
  const made = create(db, 'account.move', { company_id: company, move_type: 'out_invoice', partner_id: 1, invoice_date: '2026-01-01', invoice_payment_term_id: term, invoice_line_ids: [{ qty: 1, price_unit: amount, tax: 0 }] });
  return { db: postMove(made.db, made.id), id: made.id };
};
test('partial statement match settles the oldest installment and leaves the remainder aged', () => {
  let db = seed();
  const term = create(db, 'account.payment.term', { name: 'Halves', line_ids: [{ value_type: 'percent', value: 50, nb_days: 0, delay_type: 'days_after' }, { value_type: 'percent', value: 50, nb_days: 30, delay_type: 'days_after' }] });
  const inv = invoice(term.db, 1, 100, term.id);
  const bankJournal = search(db, 'account.journal').find((j) => j.type === 'bank' && (j.company_id ?? 1) === 1);
  const line = create(inv.db, LINE, { journal_id: bankJournal.id, date: '2026-01-20', payment_ref: 'partial', amount: 30, move_id: inv.id });
  db = run(line.db, line.id, 'Match');
  assert.equal(read(db, 'account.move', inv.id).amount_residual, 70);
  const aged = agedBalance(db, 'receivable', '2026-01-21').rows.find((r) => r.partner_id === 1);
  assert.equal(aged.total, 70);
  assert.equal(aged['1_30'], 20);
  assert.equal(aged.current, 50);
});
test('oversized company transaction can match another document without another bank item', () => {
  const base = seed();
  const company = createCompanyWithDefaultInvoiceJournals(base, { name: 'Branch', currency_id: base.records['res.company'][0].currency_id });
  const journal = create(company.db, 'account.journal', { company_id: company.id, name: 'Branch bank', code: 'BRB', type: 'bank', suspense_account_id: search(company.db, 'account.account').find((a) => a.code === '101404' && !a.company_id).id, default_account_id: search(company.db, 'account.account').find((a) => a.code === '101401').id });
  const first = invoice(journal.db, company.id, 100);
  const second = invoice(first.db, company.id, 50);
  const line = create(second.db, LINE, { company_id: company.id, journal_id: journal.id, date: '2026-01-20', payment_ref: 'two invoices', amount: 150, move_id: first.id });
  let db = run(line.db, line.id, 'Match');
  assert.equal(read(db, LINE, line.id).open_amount, 50);
  const synced = applyDiff(line.db, diffDb(line.db, db), { isAdmin: true });
  assert.equal(read(synced, LINE, line.id).open_amount, 50);
  assert.throws(() => write(db, LINE, line.id, { amount: 999 }), /cannot be changed/);
  assert.throws(() => write(db, LINE, line.id, { open_amount: 0, state: 'reconciled' }), /allocations must match/);
  assert.throws(() => write(db, 'account.move', read(db, LINE, line.id).bank_move_id, { state: 'draft' }), /has to stay posted/);
  db = write(db, LINE, line.id, { move_id: second.id });
  db = run(db, line.id, 'Match');
  assert.equal(read(db, LINE, line.id).open_amount, 0);
  assert.equal(read(db, LINE, line.id).state, 'reconciled');
  assert.equal(read(db, 'account.move', second.id).amount_residual, 0);
  const bank = read(db, 'account.journal', journal.id).default_account_id;
  const entries = journalItems(db).filter((l) => !read(line.db, 'account.move', l.move_id) && l.account_id === bank);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].debit, 150);
  for (const m of search(db, 'account.move').filter((m) => !read(line.db, 'account.move', m.id))) {
    assert.equal(m.company_id, company.id);
    assert.equal(m.journal_id, journal.id);
    assert.equal(m.line_ids.reduce((n, l) => n + l.debit - l.credit, 0), 0);
  }
});
