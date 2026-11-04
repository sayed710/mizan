import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create, search } from './orm.js';
import { models } from './models/index.js';
import { seed } from './seed.js';

test('statement file import uses journal company and skips repeated ids within the file', () => {
  const company = create(seed(), 'res.company', { name: 'Branch' });
  const journal = create(company.db, 'account.journal', { name: 'Branch bank', code: 'BB', type: 'bank', company_id: company.id });
  const file = '<BANKTRANLIST><STMTTRN><DTPOSTED>20260502<TRNAMT>10<FITID>same<NAME>Receipt</STMTTRN><STMTTRN><DTPOSTED>20260502<TRNAMT>10<FITID>same<NAME>Receipt</STMTTRN></BANKTRANLIST>';
  const run = models['account.bank.statement.line'].importFile.run;
  const result = run(journal.db, 'bank.ofx', file, { journal_id: journal.id });
  assert.equal(result.count, 1);
  const line = search(result.db, 'account.bank.statement.line').find((l) => l.unique_import_id === 'same');
  assert.equal(line.journal_id, journal.id);
  assert.equal(line.company_id, company.id);
  assert.equal(run(result.db, 'bank.ofx', file, { journal_id: journal.id }).count, 0);
});
