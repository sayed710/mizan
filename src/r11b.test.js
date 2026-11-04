import './models/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { write } from './orm.js';
import { seed } from './seed.js';
import { accountId, postEntry } from './models/ledger.js';
import { taxReport } from './models/finance.js';

test('a manual item on a shared tax account stays out of the tax report until it has an explicit side', () => {
  let db = seed();
  const account = accountId(db, '251000');
  const purchase = db.records['account.tax'].find((tax) => tax.type_tax_use === 'purchase');
  db = write(db, 'account.tax', purchase.id, { account_id: account });
  const entry = postEntry(db, { journal: 'MISC', date: '2025-04-01', lines: [{ account_id: account, credit: 100 }, { account: '600000', debit: 100 }] });
  assert.equal(taxReport(entry.db, { from: '2025-04-01', to: '2025-04-01' }).output, 0);
  const tagged = postEntry(db, { journal: 'MISC', date: '2025-04-01', lines: [{ account_id: account, credit: 100, tax_side: 'sale' }, { account: '600000', debit: 100 }] });
  assert.equal(taxReport(tagged.db, { from: '2025-04-01', to: '2025-04-01' }).output, 100);
});

