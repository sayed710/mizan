import test from 'node:test';
import assert from 'node:assert/strict';
import './models/index.js';
import { create, search } from './orm.js';
import { seed } from './seed.js';
import { postMove } from './models/accounting.js';
import { accountCashFlowActivity, cashFlow } from './models/reports.js';
import { companyViewDb } from './companyView.js';
import { migrate } from './migrations.js';

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

test('migration classifies legacy accounts using code and name defaults', () => {
  let db = seed();
  const cases = [
    ['159901', 'Equipment', 'expense', 'investing', 11],
    ['309901', 'Capital', 'expense', 'financing', 22],
    ['260000', 'Debt', 'expense', 'financing', 33],
    ['779901', 'Business Loan', 'liability_current', 'financing', 44],
    ['159902', 'Loan equipment', 'liability_current', 'investing', 55],
  ];
  const ids = [];
  for (const [code, name, account_type, , amount] of cases) {
    const id = (db.seq['account.account'] ?? 0) + 1;
    const legacyAccount = { id, code, name, account_type, tag_ids: [] };
    db = {
      ...db,
      records: { ...db.records, 'account.account': [...db.records['account.account'], legacyAccount] },
      seq: { ...db.seq, 'account.account': id },
    };
    ids.push(id);
    const cash = search(db, 'account.account').find((item) => item.code === '101401');
    const move = create(db, 'account.move', { move_type: 'entry', invoice_date: '2040-03-05', line_ids: [
      { account_id: id, credit: amount }, { account_id: cash.id, debit: amount },
    ] });
    db = postMove(move.db, move.id);
  }
  const migrated = migrate({ ...db, schema_version: 18 });
  const accounts = search(migrated, 'account.account');
  assert.deepEqual(ids.map((id) => accountCashFlowActivity(migrated, accounts.find((account) => account.id === id))), cases.map((entry) => entry[3]));
  const report = cashFlow(migrated, { from: '2040-03-05', to: '2040-03-05' });
  assert.deepEqual([report.operating, report.investing, report.financing, report.unclassified], [0, 66, 99, 0]);
});

test('migration preserves legacy cash-flow categories by account type without changing existing tags', () => {
  let db = seed();
  const other = create(db, 'account.account.tag', { name: 'Other classification' });
  const explicit = create(other.db, 'account.account.tag', { name: 'Custom category', cash_flow_activity: 'financing' });
  const definitions = [
    ['771001', 'asset_fixed', [], 100],
    ['771002', 'equity', [], -200],
    ['771003', 'liability_non_current', [other.id], -300],
    ['771004', 'expense', [], 40],
    ['771005', 'asset_fixed', [explicit.id], 50],
  ];
  db = explicit.db;
  for (const [code, account_type, tag_ids, amount] of definitions) {
    const account = create(db, 'account.account', { code, name: 'Legacy account', account_type, tag_ids });
    const cash = search(account.db, 'account.account').find((item) => item.code === '101401');
    const move = create(account.db, 'account.move', { move_type: 'entry', invoice_date: '2040-03-01', line_ids: [
      { account_id: account.id, debit: amount > 0 ? amount : 0, credit: amount < 0 ? -amount : 0 },
      { account_id: cash.id, debit: amount < 0 ? -amount : 0, credit: amount > 0 ? amount : 0 },
    ] });
    db = postMove(move.db, move.id);
  }
  const old = { ...db, schema_version: 18 };
  const migrated = migrate(old);
  const period = { from: '2040-03-01', to: '2040-03-01' };
  const report = cashFlow(migrated, period);
  assert.deepEqual([report.operating, report.investing, report.financing, report.unclassified], [-40, -100, 450, 0]);
  const loan = search(migrated, 'account.account').find((account) => account.code === '771003');
  assert.ok(loan.tag_ids.includes(other.id));
  const overridden = search(migrated, 'account.account').find((account) => account.code === '771005');
  assert.deepEqual(overridden.tag_ids, [explicit.id]);
  assert.equal(migrate(migrated), migrated);
  const fresh = create(migrated, 'account.account', { code: '771006', name: 'New fixed asset', account_type: 'asset_fixed' });
  const cash = search(fresh.db, 'account.account').find((item) => item.code === '101401');
  const move = create(fresh.db, 'account.move', { move_type: 'entry', invoice_date: '2040-03-02', line_ids: [
    { account_id: fresh.id, debit: 25, credit: 0 }, { account_id: cash.id, debit: 0, credit: 25 },
  ] });
  assert.equal(cashFlow(postMove(move.db, move.id), { from: '2040-03-02', to: '2040-03-02' }).unclassified, -25);
});
