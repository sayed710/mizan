import { createCompanyWithDefaultInvoiceJournals } from './test-support/accounting-company.js';
import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, messagesOf, read, search, write } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { postBatch } from './models/payments.js';
import { reversePayment } from './models/pay.js';

test('outbound checks keep journal-specific sequential numbers on payments after reversal', () => {
  const base = seed();
  const branch = createCompanyWithDefaultInvoiceJournals(base, { name: 'Check branch', currency_id: base.records['res.company'][0].currency_id });
  let db = branch.db;
  for (const companyId of [1, branch.id]) {
    const bank = search(db, 'account.account').find((account) => account.code === '101401');
    const suspense = search(db, 'account.account').find((account) => account.code === '101404' && (!account.company_id || account.company_id === companyId)) ?? bank;
    const journal = create(db, 'account.journal', { name: 'Check journal', code: `CHK${companyId}`, type: 'bank', company_id: companyId, default_account_id: bank.id, suspense_account_id: suspense.id, check_next_number: 700 });
    db = journal.db;
    const issue = () => {
      const bill = create(db, 'account.move', { move_type: 'in_invoice', company_id: companyId, partner_id: 7, invoice_date: '2026-01-01', invoice_line_ids: [{ qty: 1, price_unit: 100, tax: 0 }] });
      db = postMove(bill.db, bill.id);
      const batch = create(db, 'account.batch.payment', { batch_type: 'outbound', journal_id: journal.id, date: '2026-01-02', lines: [{ move_id: bill.id, amount: 100 }] });
      db = postBatch(batch.db, read(batch.db, 'account.batch.payment', batch.id));
      return read(db, 'account.batch.payment', batch.id).lines[0];
    };
    const first = issue();
    assert.equal(first.check_number, 700);
    assert.equal(read(db, 'account.payment', first.payment_id).check_number, 700);
    db = reversePayment(db, read(db, 'account.payment', first.payment_id), '2026-01-03');
    assert.equal(read(db, 'account.payment', first.payment_id).check_number, 700);
    assert.ok(messagesOf(db, 'account.payment', first.payment_id).some((message) => /revers/i.test(message.body)));
    db = write(db, 'account.journal', journal.id, { check_next_number: 700 });
    const second = issue();
    assert.equal(second.check_number, 701);
    assert.equal(read(db, 'account.payment', second.payment_id).check_number, 701);
  }
});
