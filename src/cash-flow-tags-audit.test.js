import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { cashFlow } from './models/reports.js';
import { companyViewDb } from './companyView.js';

test('cash flow classifies loan movements by stored tag activity and reconciles cash per company', () => {
  let db = seed();
  const company = create(db, 'res.company', { name: 'Second company' }); db = company.db;
  const tag = create(db, 'account.account.tag', { name: 'Operating label', cash_flow_activity: 'financing' }); db = tag.db;
  const legacyTag = create(db, 'account.account.tag', { name: 'Operating legacy' }); db = legacyTag.db;
  const liability = create(db, 'account.account', { code: '271000', name: 'Borrowing', account_type: 'liability_current', tag_ids: [legacyTag.id, tag.id] }); db = liability.db;
  const cash = search(db, 'account.account').find((account) => account.code === '101401');
  const otherCash = create(db, 'account.account', { code: '101402', name: 'Bank', account_type: 'asset_cash', company_id: company.id }); db = otherCash.db;
  const otherLiability = create(db, 'account.account', { code: '271001', name: 'Borrowing', account_type: 'liability_current', company_id: company.id, tag_ids: [tag.id] }); db = otherLiability.db;
  const post = (companyId, date, debit, credit) => {
    const move = create(db, 'account.move', { move_type: 'entry', company_id: companyId, invoice_date: date, line_ids: [
      { account_id: companyId === 1 ? cash.id : otherCash.id, debit, credit }, { account_id: companyId === 1 ? liability.id : otherLiability.id, debit: credit, credit: debit },
    ] });
    db = postMove(move.db, move.id);
  };
  post(1, '2040-01-02', 1000, 0);
  post(1, '2040-01-03', 0, 250);
  post(company.id, '2040-01-02', 400, 0);
  const period = { from: '2040-01-01', to: '2040-01-31' };
  const reportFor = (id) => cashFlow(companyViewDb({ ...db, settings: { ...db.settings, current_company_id: id, allowed_company_ids: [id] } }), period);
  const first = reportFor(1);
  assert.deepEqual([first.operating, first.investing, first.financing, first.net], [0, 0, 750, 750]);
  assert.equal(first.net, first.closing - first.opening);
  const second = reportFor(company.id);
  assert.deepEqual([second.operating, second.investing, second.financing, second.net], [0, 0, 400, 400]);
  assert.equal(second.net, second.closing - second.opening);
});

test('cash flow does not classify an account using tag or account names', () => {
  let db = seed();
  const tag = create(db, 'account.account.tag', { name: 'Financing Activities' }); db = tag.db;
  const account = create(db, 'account.account', { code: '777700', name: 'Loan', account_type: 'liability_current', tag_ids: [tag.id] }); db = account.db;
  const cash = search(db, 'account.account').find((a) => a.code === '101401');
  const move = create(db, 'account.move', { move_type: 'entry', invoice_date: '2040-02-01', line_ids: [
    { account_id: cash.id, debit: 100 }, { account_id: account.id, credit: 100 },
  ] });
  db = postMove(move.db, move.id);
  const report = cashFlow(db, { from: '2040-02-01', to: '2040-02-01' });
  assert.deepEqual([report.operating, report.financing, report.unclassified, report.net], [0, 0, 100, 100]);
});
